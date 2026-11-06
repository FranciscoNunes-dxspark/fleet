// Go or no-go for what's about to reach a production environment: one verdict, green, amber or
// red, from what Keel already knows about the batch waiting to ship and the place it goes to. Red
// means something is broken now (production down, the repo's pipeline failing, a new critical
// advisory); amber means ship with your eyes open (a high-risk pull request, flaky tests, work not
// done, production degraded, the last deploy failed, a new high advisory). It never blocks a
// decision: Waiting to ship and the approvals show it next to Approve. Pure, so the rules are
// tested with hand-built fixtures (test/readiness.test.js).
import { RISK_WEIGHTS } from './risk.js';

/** Work item state categories that count as done for shipping: finished, or fixed and waiting on a check. */
export const DONE_CATEGORIES = ['Completed', 'Removed', 'Resolved'];

// Reasons as templates the web app translates (t(text, params), locales/pt/readiness.js) and the
// terminal could fill (reasonText in risk.js does the same for risk).
export const REASONS = {
  productionDown: '{name} is down right now',
  productionDegraded: '{name} is degraded right now',
  pipelineFailing: '{pipeline} is failing on {branch}',
  pipelineUnstable: '{pipeline} is unstable on {branch}',
  advisoryCritical: '{n} new critical security advisories in {repo}',
  advisoryCriticalOne: '{package} {version} in {repo} has a new critical security advisory',
  advisoryHigh: '{n} new high-severity security advisories in {repo}',
  advisoryHighOne: '{package} {version} in {repo} has a new high-severity security advisory',
  riskHigh: '{n} pull requests going out are high risk, the highest !{id} at {score} of 100',
  riskHighOne: '!{id} going out is high risk: {score} of 100',
  flaky: '{n} flaky tests on {where}',
  flakyOne: '{test} is flaky on {where}',
  workOpen: '{n} work items going out are not done ({ids})',
  workOpenOne: '{type} {id} going out is still {state}',
  lastFailed: 'The last deploy, {label}, did not succeed',
  batchUnknown: "What's going out couldn't be read, so its pull requests and work items aren't judged",
};

const listed = (xs, n = 3) => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n}` : xs.join(', '));

/**
 * The verdict for one environment. `target` is a Waiting to ship row (service.undeployed): its
 * waiting count, workItems, lastFailed, and error/unknown when the batch couldn't be read.
 * `risks` are the batch's pull requests scored (domain/risk.js: { id, score, level }); `pipelines`
 * the repo's pipeline rows ({ definition: { name }, branch, health }); `flaky` the flaky tests on
 * those pipelines ({ shortName, pipeline: { name } }); `advisories` the repo's new advisories
 * ({ package, version, severity }); `monitors` this environment's production monitors ({ name, state });
 * `repo` its name. Returns { verdict, reasons: [{ id, tone, text, params }] }, red reasons first;
 * a reason's tone is red, amber or info (info never changes the verdict).
 */
export function judgeReadiness({ target = {}, risks = [], pipelines = [], flaky = [], advisories = [], monitors = [], repo = '', weights = RISK_WEIGHTS }) {
  const reasons = [];
  const add = (id, tone, params = {}, one = false) => reasons.push({ id, tone, text: REASONS[one ? `${id}One` : id], params });

  for (const m of monitors) {
    if (m.state === 'down') add('productionDown', 'red', { name: m.name });
    else if (m.state === 'degraded') add('productionDegraded', 'amber', { name: m.name });
  }

  for (const p of pipelines) {
    const params = { pipeline: p.definition?.name || p.name || '?', branch: p.branch || '?' };
    if (p.health === 'failing') add('pipelineFailing', 'red', params);
    else if (p.health === 'unstable') add('pipelineUnstable', 'amber', params);
  }

  for (const [severity, tone] of [['critical', 'red'], ['high', 'amber']]) {
    const hits = advisories.filter((a) => a.severity === severity);
    if (!hits.length) continue;
    const id = severity === 'critical' ? 'advisoryCritical' : 'advisoryHigh';
    add(id, tone, { n: hits.length, package: hits[0].package, version: hits[0].version, repo }, hits.length === 1);
  }

  if (target.lastFailed) add('lastFailed', 'amber', { label: target.lastFailed.label || target.lastFailed.id });

  const readable = !target.error && !target.unknown && !target.unlinked && !target.diverged && !target.missingBranch;
  if (readable) {
    const high = risks.filter((r) => r.score >= weights.high).sort((a, b) => b.score - a.score);
    if (high.length) add('riskHigh', 'amber', { n: high.length, id: high[0].id, score: high[0].score }, high.length === 1);

    const open = (target.workItems || []).filter((w) => !DONE_CATEGORIES.includes(w.stateCategory));
    if (open.length) add('workOpen', 'amber', { n: open.length, ids: listed(open.map((w) => `#${w.id}`)), id: `#${open[0].id}`, type: open[0].type || '', state: open[0].state || '' }, open.length === 1);
  } else if (target.waiting !== 0) {
    add('batchUnknown', 'info');
  }

  if (flaky.length) {
    const where = listed([...new Set(flaky.map((f) => f.pipeline?.name).filter(Boolean))], 2);
    add('flaky', 'amber', { n: flaky.length, test: flaky[0].shortName || flaky[0].name, where }, flaky.length === 1);
  }

  const order = { red: 0, amber: 1, info: 2 };
  reasons.sort((a, b) => order[a.tone] - order[b.tone]);
  const verdict = reasons.some((r) => r.tone === 'red') ? 'red' : reasons.some((r) => r.tone === 'amber') ? 'amber' : 'green';
  return { verdict, reasons };
}

const PROD_STAGE = /\b(prod|production|prd|live)\b/i;

/**
 * Which production environment a pending approval decides about, as a target key
 * (domain/production.js targetKeyOf), or null. A classic release approval matches the target of
 * its release definition and stage (a post-deployment one has already deployed: none). A YAML
 * check matches the target of the pipeline its run belongs to, when the stage it waits at looks
 * like production or isn't known: a pipeline's earlier stages (QA, Staging) aren't its production.
 * `builds` are the raw runs (to find a YAML run's pipeline).
 */
export function approvalTarget(a, targets, builds = []) {
  if (a.kind === 'release') {
    if (a.postDeploy) return null;
    const stage = String(a.stage || '').replace(/ \(after deployment\)$/, '');
    const t = targets.find((x) => x.type === 'release' && x.projectId === a.projectId
      && (a.definitionId != null ? x.definitionId === a.definitionId : x.definitionName === a.pipeline)
      && (!x.stage || x.stage === stage));
    return t?.key || null;
  }
  if (a.stage && !PROD_STAGE.test(a.stage)) return null;
  const run = a.run?.id != null ? builds.find((b) => b.id === a.run.id) : null;
  const t = targets.find((x) => x.type === 'pipeline' && x.projectId === a.projectId
    && (run ? x.definitionId === run.definition?.id : x.definitionName === a.pipeline));
  return t?.key || null;
}
