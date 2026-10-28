// Every user-facing operation, written once: keys in the views and slash commands both call
// these with `ctx` (built in ui/App.jsx). Questions before anything that can't be undone live here.
import { sonarArgs } from './sonar.js';
import { branch, diffText, isGithubPr, summaryText, summaryWeek } from './format.js';
import { fieldValues, filterFields, splitFilter, withField } from './filters.js';
import { approvalsFor, deployChoices, downloadChoices, isGithubRelease, stageStatus } from './releases.js';
import { runText } from './runs.js';
import { doneChanges } from './board.js';
import { closedText, commitsText, flakyText, insightsText, totalsText } from './reports.js';
import { compareForSonar, deploys, familyChoices, prContext, runForSplice, timelineText } from './kin.js';
import { APP_NAMES, contextIn, copiedNote, describeContext, notMine, projectAt, projectWiring, readActivity, takeLine } from '@fleet/kit/family.js';

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const prName = (pr) => `!${pr.id} ${short(pr.title)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What Keel changed in Azure DevOps goes into the family's activity log (family.js logActivity, through
// App's ctx), for /timeline here and in the other apps: what and where, never a comment or a token.
const did = (ctx, text, kind) => ctx.logActivity?.(text, kind);
const inRepo = (pr) => (pr.repoName ? ` in ${pr.repoName}` : '');

const MERGE_STRATEGY = { squash: 'squash merge', noFastForward: 'merge commit', rebase: 'rebase', rebaseMerge: 'rebase with a merge commit' };

/** Opens the selection (or `url`) in the browser. */
export function open(ctx, url = ctx.current().webUrl) {
  if (!url) return ctx.note('Nothing to open here.');
  ctx.openUrl(url);
  ctx.note(`Opened in your browser: ${url}`);
}

/** S on a production monitor: Sonar, Keel's sibling Azure console, on the app behind it, at its problems. */
export async function sonar(ctx, m = ctx.current().monitor) {
  if (!m?.url) return ctx.note('Pick a production monitor first: Sonar opens on the app behind its address.', 'error');
  try {
    const r = await ctx.openSonar(sonarArgs(m));
    if (r.how === 'tab') ctx.note(`Opened Sonar on ${m.name} in a new tab`);
    else ctx.note(`Copied ${r.command}\nRun it in another terminal to open Sonar on ${m.name}. Sonar: https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/sonar`);
  } catch (e) {
    ctx.note(`Couldn't open Sonar: ${e.message}`, 'error');
  }
}

/** "2", "2d", "1w" or nothing (a day) → days; null when it isn't one of those. */
export function parseDays(text) {
  const m = String(text ?? '').trim().toLowerCase().match(/^(\d+)?\s*(d|day|days|w|week|weeks)?$/);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  return /^w/.test(m[2] ?? '') ? n * 7 : n;
}

export async function snooze(ctx, item = ctx.current().item, text = '') {
  if (!item) return ctx.note('Pick something in the Inbox to snooze.', 'error');
  const days = parseDays(text);
  if (!days) return ctx.note('Snooze for how long? /snooze 2d, or /snooze 1w.', 'error');
  await ctx.task(`Snooze "${short(item.title)}"`, async () => {
    await ctx.service.snooze(item.key, days);
    await ctx.reload();
    return [`Hidden from the Inbox for ${plural(days, 'day')}, or until it changes.`];
  }, { label: 'Snoozing' });
}

export async function unsnoozeAll(ctx) {
  const n = ctx.data.attention?.snoozedCount ?? 0;
  if (!n) return ctx.note('Nothing is snoozed.');
  await ctx.task('Bring back everything snoozed', async () => {
    await ctx.service.clearSnoozes();
    await ctx.reload();
    return [`${plural(n, 'item')} back in the Inbox.`];
  }, { label: 'Unsnoozing' });
}

const VOTE_TITLE = { 10: 'Approve', 5: 'Approve with suggestions', 0: 'Reset your vote on', '-5': 'Wait for the author on', '-10': 'Reject' };

export async function vote(ctx, pr = ctx.current().pr, value) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  // GitHub turns down a review from the pull request's author.
  if (isGithubPr(pr) && pr.isMine) return ctx.note(`GitHub doesn't let you review your own pull request.\nAsk someone to review !${pr.id} there: o opens it.`, 'error');
  if (value === -10) {
    const ok = await ctx.confirm({ title: `Reject ${prName(pr)}?`, detail: 'It stays blocked until you change your vote.', danger: true, options: [{ label: 'Yes, reject it', value: true }, { label: 'No', value: false }] });
    if (!ok) return;
  }
  await ctx.task(`${VOTE_TITLE[value]} ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'vote', vote: value });
    did(ctx, `${VOTE_TITLE[value]} ${prName(pr)}${inRepo(pr)}`, 'review');
    await ctx.reload();
    return [value === 10 ? 'Approved.' : value === 0 ? 'Your vote is cleared.' : 'Vote recorded.'];
  }, { label: 'Voting' });
}

export async function complete(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  if (pr.isDraft) return ctx.note(`${prName(pr)} is a draft: p publishes it first, then it needs approving.`, 'error');
  if (pr.hasConflicts) return ctx.note(`${prName(pr)} has merge conflicts: fix them before completing it.`, 'error');
  // Held while its checks (tests, builds) run, and after they fail, as the web app holds it.
  if (pr.flow?.waiting?.kind === 'checks') return ctx.note(`${prName(pr)}'s checks are still running: complete it once they pass, or m to merge it by itself then.`, 'error');
  if (pr.flow?.waiting?.kind === 'checks-failed') return ctx.note(`${prName(pr)}'s checks failed: fix them before completing it. o shows them on GitHub.`, 'error');
  const ac = ctx.meta?.autoComplete ?? {};
  const how = [
    pr.reviewState === 'approved' ? null : 'Not approved yet, so branch policies may refuse it',
    MERGE_STRATEGY[ac.mergeStrategy] ?? 'merge commit',
    ac.deleteSourceBranch ? 'delete the source branch' : 'keep the source branch',
    ac.transitionWorkItems ? 'close linked work items' : null,
  ].filter(Boolean).join(' · ');
  const ok = await ctx.confirm({
    title: `Complete ${prName(pr)} into ${branch(pr.targetBranch)}?`,
    detail: how,
    options: [{ label: 'Yes, complete it', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`Complete ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'complete', mergeStrategy: ac.mergeStrategy, deleteSourceBranch: !!ac.deleteSourceBranch, transitionWorkItems: !!ac.transitionWorkItems });
    did(ctx, `Completed ${prName(pr)} into ${branch(pr.targetBranch)}${inRepo(pr)}`, 'merge');
    await ctx.reload();
    return [`Completed into ${branch(pr.targetBranch)}.`];
  }, { label: 'Completing' });
}

/** p, /publish: a draft goes up for review. */
export async function publish(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  if (!pr.isDraft) return ctx.note(`${prName(pr)} isn't a draft: it's already up for review.`);
  await ctx.task(`Publish ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'publish' });
    did(ctx, `Published ${prName(pr)}${inRepo(pr)} for review`, 'review');
    await ctx.reload();
    return ['Published: its reviewers are asked to review it now.'];
  }, { label: 'Publishing' });
}

export async function autoComplete(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  const enabled = !pr.autoComplete;
  await ctx.task(`${enabled ? 'Set' : 'Cancel'} auto-complete on ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'autoComplete', enabled });
    did(ctx, `${enabled ? 'Set' : 'Cancelled'} auto-complete on ${prName(pr)}${inRepo(pr)}`, 'review');
    await ctx.reload();
    return [enabled ? 'It completes by itself once policies pass.' : 'Auto-complete is off.'];
  }, { label: 'Saving' });
}

/** /comment: on the selected pull request, or work item. */
export async function comment(ctx, pr = ctx.current().pr, text = '') {
  const w = !pr && ctx.current().workItem;
  if (!pr && !w) return ctx.note('Pick a pull request or work item first.', 'error');
  if (!text.trim()) return ctx.prefill('/comment ');
  if (w) return commentWorkItem(ctx, w, text);
  await ctx.task(`Comment on ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'comment', content: text.trim() });
    return [short(text.trim(), 120)];
  }, { label: 'Commenting' });
}

export async function runPipeline(ctx, row = ctx.current().pipeline, text = '') {
  if (!row) return ctx.note('Pick a pipeline first.', 'error');
  const on = text.trim() || branch(row.branch) || '';
  const ok = await ctx.confirm({
    title: `Run ${row.definition.name}${on ? ` on ${on}` : ''}?`,
    options: [{ label: 'Yes, run it', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`Run ${row.definition.name}${on ? ` on ${on}` : ''}`, async () => {
    const run = await ctx.service.queueBuild(row.projectId, row.definition.id, on || undefined);
    did(ctx, `Ran ${row.definition.name}${on ? ` on ${on}` : ''}${run?.id ? ` (run ${run.id})` : ''}`, 'pipeline');
    await ctx.reload();
    return [`${run?.id ? `Queued run ${run.id}` : 'Queued'}. It shows under Latest runs once Azure DevOps starts it.`];
  }, { label: 'Queuing' });
}

export async function cancelRun(ctx, row = ctx.current().pipeline) {
  if (!row) return ctx.note('Pick a pipeline first.', 'error');
  const run = row.running?.[0];
  if (!run) return ctx.note(`${row.definition.name} has nothing queued or running.`);
  const ok = await ctx.confirm({
    title: `Cancel ${row.definition.name} ${run.buildNumber} on ${branch(run.sourceBranch)}?`,
    danger: true,
    options: [{ label: 'Yes, cancel the run', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`Cancel ${row.definition.name} ${run.buildNumber}`, async () => {
    await ctx.service.cancelBuild(row.projectId, run.id);
    did(ctx, `Cancelled ${row.definition.name} ${run.buildNumber}`, 'pipeline');
    await ctx.reload();
    return ['Canceled.'];
  }, { label: 'Canceling' });
}

/** Approve or reject the stage an Inbox approval item waits on. */
export async function decide(ctx, item = ctx.current().item, status, text = '') {
  if (item?.kind !== 'approval') return ctx.note('Pick an approval in the Inbox first.', 'error');
  const approve = status === 'approved';
  const ok = await ctx.confirm({
    title: `${approve ? 'Approve' : 'Reject'} ${short(item.title.replace(/^Approve /, ''))}?`,
    detail: item.reasons[0]?.text,
    danger: !approve,
    options: [{ label: approve ? 'Yes, approve it' : 'Yes, reject it', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`${approve ? 'Approve' : 'Reject'} ${short(item.title.replace(/^Approve /, ''))}`, async () => {
    const pending = await ctx.service.approvals();
    const a = pending.find((x) => x.key === item.target.key && (!item.org || !x.org || x.org === item.org));
    if (!a) throw new Error('That approval is no longer pending. It may have been handled already.');
    await ctx.service.decideApproval(a.kind, a.id, { status, comment: text.trim() || undefined }, a.org);
    did(ctx, `${approve ? 'Approved' : 'Rejected'} ${short(item.title.replace(/^Approve /, ''))}`, 'deploy');
    await ctx.reload();
    return [approve ? 'Approved: the deployment carries on.' : 'Rejected: the deployment stops there.'];
  }, { label: approve ? 'Approving' : 'Rejecting' });
}

/** ↵ in the Inbox: a pull request, work item, pipeline or production monitor opens in its tab, anything else in the browser. */
export function follow(ctx, item = ctx.current().item) {
  if (!item) return;
  const t = item.target ?? {};
  if (t.type === 'pr' && ctx.showPr(t, item.org)) return;
  if (t.type === 'pipeline' && ctx.showPipeline(t.key, item.org)) return;
  if (t.type === 'workitem' && ctx.showWorkItem(t.id, item.org)) return;
  if (t.type === 'production') return ctx.showTab('production');
  if (item.kind === 'approval') return ctx.note('a approves it, x rejects it, o opens it in the browser.');
  open(ctx, item.webUrl);
}

/** /pr 817: jumps to that pull request. */
export function showPr(ctx, text) {
  const id = Number(String(text).replace(/^!/, ''));
  const pr = Number.isInteger(id) && ctx.data.prs?.find((p) => p.id === id);
  if (!pr) return ctx.note(`No active pull request !${text.replace(/^!/, '')} in your tracked repos.`, 'error');
  ctx.showPr(pr, pr.org);
}

// ---- Settings (ui/SettingsView.jsx; rows and patches in settings.js)

/** Saves a change to Keel's settings (shared with the web app), then reads everything again. */
export async function saveSettings(ctx, title, patch, done) {
  await ctx.task(title, async () => {
    await ctx.service.saveSettings(patch);
    await ctx.reloadAll();
    return [done];
  }, { label: 'Saving' });
}

/** How the downloaded app treats new versions, saved in this computer's .env; it counts from the next start. */
export async function setUpdateMode(ctx, mode) {
  const { updateLines, UPDATE_LABEL } = await import('./settings.js');
  await ctx.task(`Updates: ${UPDATE_LABEL[mode].toLowerCase()}`, async () => {
    ctx.saveEnv(updateLines(mode));
    return [`Saved in ${ctx.envFile}. It counts from the next time you open Keel.`];
  }, { label: 'Saving' });
}

/** The mouse on or off on this computer (KEEL_MOUSE in its .env), at once. */
export async function setMouse(ctx, on) {
  await ctx.task(`Mouse ${on ? 'on' : 'off'}`, async () => {
    ctx.saveEnv([`KEEL_MOUSE=${on ? 1 : 0}`]);
    return [on ? 'Click, double-click, scroll, and drag to copy.' : "Off: the terminal selects and copies by itself again. Saved in this computer's .env."];
  }, { label: 'Saving' });
}

/** Family moods on or off on this computer (KEEL_FAMILY_MOODS in its .env), at once. */
export async function setFamilyMoods(ctx, on) {
  await ctx.task(`Family moods ${on ? 'on' : 'off'}`, async () => {
    ctx.saveEnv([`KEEL_FAMILY_MOODS=${on ? 1 : 0}`]);
    return [on ? 'Pinch tells the other apps how it feels, and says when one of them is worried or pleased.' : "Off: Pinch keeps its mood to itself and doesn't read theirs. Saved in this computer's .env."];
  }, { label: 'Saving' });
}

/** /addorg <address>: another Azure DevOps organization, or a GitHub owner (github.com, or --github). */
export async function addOrg(ctx, text = '') {
  const github = /(^|\s)--github(\s|$)/.test(text);
  const url = text.replace(/(^|\s)--github(\s|$)/, ' ').trim();
  if (!url) return ctx.prefill('/addorg ');
  await ctx.task(`Add ${url}`, async () => {
    const org = await ctx.orgAdmin.add({ url, kind: github ? 'github' : undefined });
    // Through a Keel server, everyone links their own token for it on the web.
    if (ctx.server) return [`${org.name} added to Keel at ${ctx.server}, for everyone. Each person links their token for it there, under Settings → Organizations; then open Keel again.`];
    const how = org.kind === 'github' ? 'It signs in with GITHUB_TOKEN, or else your GitHub CLI sign-in (gh auth login).' : 'It signs in the same way as your other organization.';
    return [`${org.name} added. Open Keel again to see it, then track its projects here. ${how}`];
  }, { label: 'Adding' });
}

/** Takes an added organization out of Keel (asks first). The primary one comes from .env. */
export async function removeOrg(ctx, org) {
  if (org.primary) return ctx.note(ctx.server ? `${org.name} is the primary organization of Keel at ${ctx.server}; it can't be removed.` : `${org.name} is the organization in ${ctx.envFile}; change it there.`, 'error');
  const detail = ctx.server ? 'Its projects stop showing for everyone using Keel there. You can add it back with /addorg.' : 'Its projects stop showing, here and in the web app. You can add it back with /addorg.';
  const ok = await ctx.confirm({ title: `Remove ${org.name} from Keel?`, detail, danger: true, options: [{ label: 'Yes, remove it', value: true }, { label: 'No', value: false }] });
  if (!ok) return;
  await ctx.task(`Remove ${org.name}`, async () => {
    await ctx.orgAdmin.remove(org.key);
    return ['Removed. It disappears the next time you open Keel.'];
  }, { label: 'Removing' });
}

// ---- Signing in to a Keel server (remote.js)

/** /logout: signs this terminal out of the Keel server (asks first), forgets its token, and quits. */
export async function logout(ctx) {
  if (!ctx.server) return ctx.note('This Keel works on its own, not signed in to a Keel server: there is nothing to sign out of.', 'error');
  const ok = await ctx.confirm({ title: `Sign this terminal out of Keel at ${ctx.server}?`, detail: 'Keel closes. Next time, keel login signs in again.', options: [{ label: 'Yes, sign out', value: true }, { label: 'No', value: false }] });
  if (!ok) return;
  const done = await ctx.task('Sign out', async () => {
    // Already signed out on the web: still forget it here.
    await ctx.logout().catch((e) => {
      if (e.code !== 'signin-required' && e.status !== 401) throw e;
    });
    ctx.saveEnv(['KEEL_SERVER=', 'KEEL_TOKEN=']);
    return ['Signed out.'];
  }, { label: 'Signing out' });
  if (done.ok) ctx.quit();
}

/** d in Pull requests: pick one of its changed files and read what changed in it, without the browser. */
export async function prChanges(ctx, pr = ctx.current().pr) {
  if (!pr) return;
  const full = await ctx.task(`Files of ${prName(pr)}`, async () => ({ files: (await ctx.service.pullRequest(pr.projectId, pr.repoId, pr.id)).files }), { label: 'Reading the files', quiet: true });
  const files = full.value?.files?.items ?? [];
  if (!full.ok) return;
  if (!files.length) return ctx.note(`${prName(pr)} has no file changes${full.value?.files?.error ? `: ${full.value.files.error}` : ''}.`, 'error');
  const file = await ctx.confirm({
    title: `Which file of ${prName(pr)}?`,
    detail: `${plural(files.length, 'file')} changed${full.value.files.truncated ? ' (the first ones)' : ''}.`,
    options: [...files.map((f) => ({ label: `${(f.kind ?? '').slice(0, 1).toUpperCase()} ${f.path}`, value: f })), { label: 'Leave it', value: null }],
  });
  if (!file) return;
  await ctx.task(`Changes in ${file.path}`, async () => {
    const d = await ctx.service.prFileDiff(pr.projectId, pr.repoId, pr.id, file);
    ctx.showText(`${prName(pr)}: ${file.path.split('/').pop()}`, diffText(file, d), { diff: true });
    return [];
  }, { label: 'Reading the changes', quiet: true });
}

/** /summary [last|-N|YYYY-MM-DD]: one week's summary, as the web app's, in the viewer. */
export async function showSummary(ctx, text = '') {
  const week = summaryWeek(text);
  if (week == null) return ctx.note('Which week? /summary for this one, /summary last, /summary -3 (up to 26 back), or a date: /summary 2026-10-06.', 'error');
  await ctx.task(`Weekly summary${week ? ` for the week of ${week}` : ''}`, async () => {
    const s = await ctx.service.summary(week || undefined);
    const body = summaryText(s);
    const title = body.split('\n')[0];
    ctx.showText(title, body);
    return [title];
  }, { label: 'Reading the week', quiet: true });
}

// ---- Work items (ui/WorkItemsView.jsx)

const wiName = (w) => `${w.type} ${w.id} "${short(w.title, 50)}"`;

/** Saves `changes` to a work item (as the web app's inline edits do), then reads everything again. */
async function updateWorkItem(ctx, w, title, changes, done, label = 'Saving') {
  await ctx.task(title, async () => {
    await ctx.service.workItemAction(w.id, { type: 'update', changes }, w.org);
    did(ctx, `${title}${w.title ? ` "${short(w.title, 50)}"` : ''}`, 'workitem');
    await ctx.reload();
    return [done];
  }, { label });
}

/** s: moves a work item to another of its type's states, picked from a list (or `name`, typed). */
export async function setState(ctx, w = ctx.current().workItem, name = '') {
  if (!w) return ctx.note('Pick a work item first.', 'error');
  let states;
  try {
    states = (await ctx.service.workItem(w.id, w.org)).allowedStates.filter((s) => s.category !== 'Removed' || name);
  } catch (e) {
    return ctx.note(`Couldn't read ${w.type} ${w.id}: ${e.message.split('\n')[0]}`, 'error');
  }
  let state = name.trim() ? states.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())?.name : null;
  if (name.trim() && !state) return ctx.note(`${w.type} has no state "${name.trim()}". It has ${states.map((s) => s.name).join(', ')}.`, 'error');
  if (!state) {
    state = await ctx.confirm({
      title: `Move ${wiName(w)} to`,
      detail: `It's ${w.state} now.`,
      options: [...states.filter((s) => s.name !== w.state).map((s) => ({ label: s.name, value: s.name })), { label: 'Leave it', value: null }],
    });
    if (!state) return;
  }
  await updateWorkItem(ctx, w, `${w.type} ${w.id} → ${state}`, { state }, `${short(w.title)} is ${state} now.`, 'Moving');
}

/** i, /take, /assign <person>, /unassign: who a work item is assigned to. `who` is 'me', 'nobody' or part of a name. */
export async function assign(ctx, w = ctx.current().workItem, who = '') {
  if (!w) return ctx.note('Pick a work item first.', 'error');
  const q = who.trim().toLowerCase();
  if (!q) return ctx.prefill('/assign ');
  const { me, people = [] } = ctx.data.workItems ?? {};
  let person = null;
  if (q === 'me') person = me;
  else if (q !== 'nobody') {
    const found = people.filter((p) => !p.isContainer && [p.displayName, p.uniqueName].some((s) => String(s ?? '').toLowerCase().includes(q)));
    if (found.length !== 1) return ctx.note(found.length ? `"${who.trim()}" could be ${found.slice(0, 4).map((p) => p.displayName).join(', ')}. Type more of the name.` : `Nobody called "${who.trim()}" works in your tracked projects.`, 'error');
    [person] = found;
  }
  if (!person && q === 'me') return ctx.note("Keel doesn't know who you are in Azure DevOps yet: r reads it again.", 'error');
  if ((person?.id ?? null) === (w.assignedTo?.id ?? null)) return ctx.note(`${wiName(w)} is already ${person ? `assigned to ${person.displayName}` : 'unassigned'}.`);
  await updateWorkItem(
    ctx,
    w,
    person ? `Assign ${w.type} ${w.id} to ${q === 'me' ? 'you' : person.displayName}` : `Unassign ${w.type} ${w.id}`,
    { assignedTo: person ? person.uniqueName : '' },
    person ? `${short(w.title)} is ${q === 'me' ? 'yours' : `${person.displayName}'s`} now.` : `${short(w.title)} is unassigned.`,
  );
}

/** b: the blocked tag on or off (Keel's Settings name the tag, as in the web app). */
export async function toggleBlocked(ctx, w = ctx.current().workItem) {
  if (!w) return ctx.note('Pick a work item first.', 'error');
  const tag = ctx.meta?.blockedTag || 'Blocked';
  const has = (w.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase());
  if (!has && w.state?.toLowerCase() === tag.toLowerCase()) return ctx.note(`${wiName(w)} is in the ${w.state} state: s moves it out.`);
  const tags = has ? w.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...(w.tags ?? []), tag];
  await updateWorkItem(ctx, w, `${has ? 'Unblock' : 'Block'} ${w.type} ${w.id}`, { tags }, has ? `The ${tag} tag is off.` : `Tagged ${tag}: it shows as blocked here, on the web and in the Inbox.`);
}

/** /priority 1-4. */
export async function setPriority(ctx, w = ctx.current().workItem, text = '') {
  if (!w) return ctx.note('Pick a work item first.', 'error');
  const n = Number(text.trim());
  if (![1, 2, 3, 4].includes(n)) return ctx.note('Priority is 1 (most urgent) to 4: /priority 2.', 'error');
  await updateWorkItem(ctx, w, `${w.type} ${w.id}: priority ${n}`, { priority: n }, `Priority ${n}.`);
}

/** /comment on a work item. */
export async function commentWorkItem(ctx, w, text) {
  await ctx.task(`Comment on ${w.type} ${w.id}`, async () => {
    await ctx.service.workItemAction(w.id, { type: 'comment', text: text.trim() }, w.org);
    return [short(text.trim(), 120)];
  }, { label: 'Commenting' });
}

/**
 * /new <type> <title>: a work item in the selected one's project (or the only tracked one), for
 * its first team, in the current sprint or the backlog (asks which).
 */
export async function newWorkItem(ctx, text = '') {
  const [, typed = '', title = ''] = text.trim().match(/^(\S+)\s*([\s\S]*)$/) ?? [];
  if (!typed) return ctx.prefill('/new ');
  let options;
  try {
    options = await ctx.service.newWorkItemOptions();
  } catch (e) {
    return ctx.note(`Couldn't read your projects' work item types: ${e.message.split('\n')[0]}`, 'error');
  }
  const sel = ctx.current().workItem;
  const project = options.find((p) => sel && p.id === sel.projectId && (!sel.org || !p.org || p.org === sel.org)) ?? (options.length === 1 ? options[0] : null);
  if (!project) return ctx.note(options.length ? 'Pick a work item in the project it belongs to first (Work items tab), then /new.' : 'No tracked project has work items.', 'error');
  const type = project.types.find((t) => t.toLowerCase() === typed.toLowerCase()) ?? project.types.find((t) => t.toLowerCase().startsWith(typed.toLowerCase()));
  if (!type) return ctx.note(`${project.name} has no work item type "${typed}". It has ${project.types.join(', ')}.`, 'error');
  if (!title.trim()) return ctx.prefill(`/new ${type} `);
  const team = project.teams[0];
  const sprint = team?.iteration?.name;
  const where = await ctx.confirm({
    title: `Create ${type} "${short(title.trim())}" in ${project.name}${team ? ` (${team.name})` : ''}?`,
    options: [...(sprint ? [{ label: `Yes, in ${sprint}`, value: 'sprint' }] : []), { label: 'Yes, in the backlog', value: 'backlog' }, { label: 'No', value: null }],
  });
  if (!where) return;
  await ctx.task(`Create ${type} "${short(title.trim())}"`, async () => {
    const created = await ctx.service.createWorkItem({ projectId: project.id, type, title: title.trim(), teamId: team?.id, iteration: where });
    await ctx.reload();
    const id = created?.id ?? created;
    did(ctx, `Created ${type} ${id ?? ''} "${short(title.trim(), 50)}" in ${project.name}`, 'workitem');
    if (id) ctx.showWorkItem(id, project.org);
    return [`${type} ${id ?? ''} created${where === 'sprint' ? ` in ${sprint}` : ' in the backlog'}.`];
  }, { label: 'Creating' });
}

/** /wi 4107: jumps to that work item. */
export function showWorkItem(ctx, text) {
  const id = Number(String(text).replace(/^#/, ''));
  if (!Number.isInteger(id) || !ctx.showWorkItem(id)) return ctx.note(`No open work item #${String(text).replace(/^#/, '')} in your tracked projects. o on the Inbox or the web app finds closed ones.`, 'error');
}

// ---- Releases (ui/ReleasesView.jsx; how they read in releases.js)

/** GitHub releases are made on GitHub: the release pipelines' actions don't apply to a repo's row. */
const onGithub = (ctx, def) => {
  if (!isGithubRelease(def)) return false;
  ctx.note(`${def.name} is a GitHub repo: its releases are made on GitHub. alt+d downloads a file, o opens its releases.`, 'error');
  return true;
};

/** n, /release: a new release of the pipeline from its artifacts' latest versions (asks first). */
export async function createRelease(ctx, def = ctx.current().release, text = '') {
  if (!def) return ctx.note('Pick a release pipeline first (Releases tab).', 'error');
  if (onGithub(ctx, def)) return;
  const ok = await ctx.confirm({
    title: `Create a release of ${def.name}?`,
    detail: 'From the latest version of each artifact. Stages set to deploy automatically start by themselves.',
    options: [{ label: 'Yes, create it', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`Create a release of ${def.name}`, async () => {
    const r = await ctx.service.createRelease(def.projectId, def.id, text.trim() || undefined);
    did(ctx, `Created ${r?.name ?? 'a release'} of ${def.name}`, 'deploy');
    await ctx.reload();
    return [`${r?.name ?? 'A release'} created. d deploys it to a stage.`];
  }, { label: 'Creating' });
}

/**
 * d, /stage [name]: deploys (or redeploys) a recent release to a stage, both picked from lists.
 * Approvals and gates on the stage still apply, as on the web.
 */
export async function deployStage(ctx, def = ctx.current().release, name = '') {
  if (!def) return ctx.note('Pick a release pipeline first (Releases tab).', 'error');
  if (onGithub(ctx, def)) return;
  if (!def.releases.length) return ctx.note(`${def.name} has no releases yet: n creates one.`, 'error');
  const stages = [...def.stages].sort((x, y) => x.rank - y.rank);
  let stage = name.trim() ? stages.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) : null;
  if (name.trim() && !stage) return ctx.note(`${def.name} has no stage "${name.trim()}". It has ${stages.map((s) => s.name).join(', ')}.`, 'error');
  if (!stage) {
    stage = await ctx.confirm({
      title: `Deploy ${def.name} to which stage?`,
      options: [...stages.map((s) => ({ label: `${s.name} · ${s.latest ? `${s.latest.releaseName} ${stageStatus(s.latest.status).label}` : 'never deployed'}`, value: s })), { label: 'Leave it', value: null }],
    });
    if (!stage) return;
  }
  const choices = deployChoices(def, stage);
  if (!choices.length) return ctx.note(`None of ${def.name}'s recent releases include ${stage.name}.`, 'error');
  const pick = await ctx.confirm({
    title: `Deploy which release to ${stage.name}?`,
    detail: 'Approvals and gates on that stage still apply.',
    danger: /prod|production|prd|live/i.test(stage.name),
    options: [...choices.map((c) => ({ label: c.label, value: c })), { label: 'Leave it', value: null }],
  });
  if (!pick) return;
  const verb = def.releases.find((r) => r.id === pick.release.id)?.stages.find((s) => s.id === pick.environmentId)?.status === 'succeeded' ? 'Redeploy' : 'Deploy';
  await ctx.task(`${verb} ${pick.release.name} to ${stage.name}`, async () => {
    await ctx.service.deployReleaseStage(def.projectId, pick.release.id, pick.environmentId);
    did(ctx, `${verb}ed ${pick.release.name} of ${def.name} to ${stage.name}`, 'deploy');
    await ctx.reload();
    return [`${pick.release.name} is deploying to ${stage.name}. Its approvals, if any, show up here and in the Inbox.`];
  }, { label: 'Deploying' });
}

/** g in Releases, on a GitHub repo: picks a release, then one of its files, and downloads it in the browser. */
export async function downloadReleaseFile(ctx, repo = ctx.current().release) {
  if (!isGithubRelease(repo)) return ctx.note('Pick a GitHub repo first (Releases tab, below the release pipelines): alt+d downloads a file from its releases.', 'error');
  const choices = downloadChoices(repo);
  if (!choices.length) return ctx.note(`${repo.name}'s releases have no files attached. o opens them on GitHub.`);
  const release = choices.length === 1 ? choices[0] : await ctx.confirm({
    title: `Download from which release of ${repo.name}?`,
    options: [...choices.map((c) => ({ label: c.label, value: c })), { label: 'Leave it', value: null }],
  });
  if (!release) return;
  const file = await ctx.confirm({
    title: `Download which file of ${release.release.tag}?`,
    detail: 'It downloads in your browser, which has to be signed in to GitHub for a private repo.',
    options: [...release.files.map((f) => ({ label: f.label, value: f })), { label: 'Leave it', value: null }],
  });
  if (!file) return;
  ctx.openUrl(file.asset.url);
  ctx.note(`Downloading ${file.asset.name} in your browser: ${file.asset.url}`);
}

/** a / x in Releases, /deploy and /stop there: approve or reject what a stage of the pipeline waits on. */
export async function decideRelease(ctx, def = ctx.current().release, status, text = '') {
  if (!def) return ctx.note('Pick a release pipeline first (Releases tab).', 'error');
  if (onGithub(ctx, def)) return;
  const pending = approvalsFor(def, ctx.current().releaseApprovals);
  if (!pending.length) return ctx.note(`Nothing in ${def.name} waits for an approval.`);
  let a = pending[0];
  if (pending.length > 1) {
    a = await ctx.confirm({ title: `Which deployment of ${def.name}?`, options: [...pending.map((p) => ({ label: `${p.run?.name ?? 'A release'} to ${p.stage}`, value: p })), { label: 'Leave it', value: null }] });
    if (!a) return;
  }
  if (!a.canDecide) return ctx.note(`Azure DevOps doesn't let you decide on ${a.run?.name ?? 'it'} to ${a.stage}: ${(a.approvers ?? []).map((p) => p.displayName).join(', ') || 'someone else'} does.`, 'error');
  const approve = status === 'approved';
  const what = `${a.run?.name ?? 'the release'} to ${a.stage}`;
  const ok = await ctx.confirm({
    title: `${approve ? 'Approve' : 'Reject'} ${what}?`,
    detail: a.instructions || undefined,
    danger: !approve,
    options: [{ label: approve ? 'Yes, approve it' : 'Yes, reject it', value: true }, { label: 'No', value: false }],
  });
  if (!ok) return;
  await ctx.task(`${approve ? 'Approve' : 'Reject'} ${what}`, async () => {
    await ctx.service.decideApproval(a.kind, a.id, { status, comment: text.trim() || undefined }, a.org);
    did(ctx, `${approve ? 'Approved' : 'Rejected'} ${what} of ${def.name}`, 'deploy');
    await ctx.reload();
    return [approve ? 'Approved: the deployment carries on.' : 'Rejected: the deployment stops there.'];
  }, { label: approve ? 'Approving' : 'Rejecting' });
}

// ---- A pipeline run in full (runs.js)

/**
 * l in Pipelines, /logs [run]: a run in the viewer, the one running or else the latest, or the
 * recent one named by its number. Its stages and steps, the failed steps' logs, tests and commits.
 */
export async function showRun(ctx, row = ctx.current().pipeline, text = '') {
  if (!row) return ctx.note('Pick a pipeline first.', 'error');
  const want = text.trim();
  await ctx.task(`Run of ${row.definition.name}${want ? ` ${want}` : ''}`, async () => {
    let run = row.running?.[0] ?? row.lastRun ?? row.latest;
    if (want) {
      const { runs } = await ctx.service.pipelineRuns(row.projectId, row.definition.id);
      run = runs.find((r) => r.buildNumber === want || String(r.id) === want);
      if (!run) throw new Error(`${row.definition.name} has no recent run ${want}. Its latest: ${runs.slice(0, 5).map((r) => r.buildNumber).join(', ') || 'none'}.`);
    }
    if (!run) throw new Error(`${row.definition.name} hasn't run yet: n runs it.`);
    const details = await ctx.service.runDetails(row.projectId, run.id);
    const { title, text: body } = runText(row, run, details);
    ctx.showText(title, body);
    return [title];
  }, { label: 'Reading the run', quiet: true });
}

// ---- The board (ui/BoardView.jsx; columns and cards in board.js)

/** < and > on the board, m to pick: a card to another column (its board column and the state that maps to it). */
export async function moveCard(ctx, w, column) {
  if (!w || !column) return;
  if (!column.accepts(w)) return ctx.note(`${wiName(w)} can't go in "${column.label}" on this board.`, 'error');
  const changes = column.changesFor(w);
  await ctx.task(`${w.type} ${w.id} → ${column.label}`, async () => {
    await ctx.service.workItemAction(w.id, { type: 'update', changes }, w.org);
    did(ctx, `${w.type} ${w.id} "${short(w.title, 50)}" → ${column.label}${changes.state ? `, ${changes.state}` : ''}`, 'workitem');
    await ctx.reload();
    return [`${short(w.title)} is in ${column.label}${changes.state ? `, ${changes.state}` : ''}.`];
  }, { label: 'Moving' });
}

/** space on a card in a split column: Done in that column, or back to Doing. */
export async function toggleCardDone(ctx, data, w, column) {
  if (!w || !column?.split) return ctx.note(`${column?.label ?? 'This column'} isn't split into Doing and Done.`);
  const done = !w.board?.done;
  await ctx.task(`${w.type} ${w.id}: ${done ? 'done' : 'doing'} in ${column.label}`, async () => {
    await ctx.service.workItemAction(w.id, { type: 'update', changes: doneChanges(data, w) }, w.org);
    await ctx.reload();
    return [done ? `Done in ${column.label}: ready for the next column.` : `Back to Doing in ${column.label}.`];
  }, { label: 'Saving' });
}

// ---- Reports in the viewer (reports.js)

/** Reads a report and shows it in the viewer; its first line is the title. */
async function report(ctx, title, label, read) {
  await ctx.task(title, async () => {
    const body = await read();
    ctx.showText(title, body);
    return [body.split('\n')[0]];
  }, { label, quiet: true });
}

/** A number of days from `text` within [min, max], `fallback` when empty; null when it isn't one. */
export function parseDaysArg(text, fallback, min, max) {
  const t = String(text ?? '').trim().replace(/d(ays?)?$/i, '');
  if (!t) return fallback;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** /insights [days]: pull request flow, and delivery to production (the four DORA measures). */
export async function showInsights(ctx, text = '') {
  const days = parseDaysArg(text, 30, 7, 180);
  if (days == null) return ctx.note('Over how many days? /insights 30 (7 to 180).', 'error');
  await report(ctx, `Insights, the last ${days} days`, 'Reading the numbers', async () => {
    const [ins, del] = await Promise.all([ctx.service.insights(days), ctx.service.delivery(Math.min(90, days))]);
    return insightsText(ins, del);
  });
}

/** /flaky: tests that fail now and then and pass again without a fix. */
export async function showFlaky(ctx) {
  await report(ctx, 'Flaky tests', 'Reading the test results', async () => flakyText(await ctx.service.flakyTests()));
}

/** /closed [7|30|90]: pull requests completed or abandoned lately. */
export async function showClosed(ctx, text = '') {
  const days = parseDaysArg(text, 7, 1, 90);
  if (days == null) return ctx.note('Over how many days? /closed 7, /closed 30 or /closed 90.', 'error');
  await report(ctx, `Pull requests closed in the last ${days} days`, 'Reading closed pull requests', async () => closedText(await ctx.service.closedPullRequests(days)));
}

/** /commits [repo] [days]: the default branch's commits, every tracked repo or those whose name has `repo` in it. */
export async function showCommits(ctx, text = '') {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const daysWord = words.length && /^\d+d?$/i.test(words.at(-1)) ? words.pop() : '';
  const days = parseDaysArg(daysWord, 7, 1, 90);
  if (days == null) return ctx.note('Over how many days? /commits 14, or /commits <repo> 14 (1 to 90).', 'error');
  const repo = words.join(' ').toLowerCase();
  await report(ctx, `Commits${repo ? ` in ${repo}` : ''}, the last ${days} days`, 'Reading commits', async () => {
    const c = await ctx.service.commits({ days });
    const commits = repo ? c.commits.filter((x) => x.repoName.toLowerCase().includes(repo)) : c.commits;
    if (repo && !commits.length) throw new Error(`No commits in the last ${days} days in a tracked repo called "${repo}".`);
    return commitsText({ ...c, commits });
  });
}

/** /totals: each site's platform totals. */
export async function showTotals(ctx) {
  await report(ctx, 'Platform totals', 'Reading platform totals', async () => totalsText(await ctx.service.platformTotals(), Date.now(), ctx.service.monitors().labels()));
}

// ---- Filters by field (filters.js)

/**
 * F, /filter: narrows the list on screen by a field (who has it, its type, tag, project…), picked
 * from the values in it with how many have each, as the web app's dropdowns do. It goes into the
 * tab's /find text, so /find with nothing clears it.
 */
export async function pickFilter(ctx) {
  const src = ctx.filterSource();
  const fields = src ? filterFields(src.tab) : [];
  if (!fields.length) return ctx.note('This list has nothing to filter by: /find <text> searches it.');
  const current = ctx.currentFilter();
  const now = Object.fromEntries(splitFilter(current, src.tab).fields.map((f) => [f.key, f.value]));
  const key = await ctx.confirm({
    title: 'Filter by',
    detail: current ? `Now: ${current}` : undefined,
    options: [
      ...fields.map(([k, f]) => ({ label: `${f.label}${now[k] ? `: ${now[k]}` : ''}`, value: k })),
      ...(current ? [{ label: 'Clear the filter', value: '*' }] : []),
      { label: 'Leave it', value: null },
    ],
  });
  if (!key) return;
  if (key === '*') return ctx.find('');
  const f = fields.find(([k]) => k === key)[1];
  const values = fieldValues(src.tab, key, src.items).slice(0, 9);
  const picked = await ctx.confirm({
    title: f.label,
    options: [
      { label: f.people ? 'Anyone' : 'Any', value: '' },
      ...(f.people ? [{ label: 'Me', value: 'me' }, { label: 'Nobody', value: 'none' }] : []),
      ...values.map((v) => ({ label: `${v.value} (${v.count})`, value: v.value })),
      { label: 'Leave it', value: null },
    ],
  });
  if (picked == null) return;
  ctx.find(withField(current, src.tab, key, picked || null));
}

// ---- The family (the kit's family.js; Keel's own part in kin.js)

/** Copies `line`, a command for a sibling app or apps, saying which and where to paste it (inside Fleet, Fleet takes it there). */
export function copyFor(ctx, apps, line) {
  ctx.copy(line, `a line for ${[].concat(apps).map((x) => APP_NAMES[x]).join(' or ')}`);
  ctx.note(copiedNote(apps, line), 'ok');
}

/** alt+y on a pull request: `/take pullrequest` for Splice, which shows what its branch adds to the one it goes into. */
export function prForSplice(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  copyFor(ctx, 'splice', takeLine('pullrequest', prContext(pr)));
}

/** The run a hand-off is about: the latest that finished, else the latest. */
const lastRunOf = (row) => row.lastRun ?? row.latest ?? null;

/**
 * alt+y on a pipeline: its latest run for Splice. A failure that names a file and line (a stack frame, an
 * error's path:line) goes as `/take file` there, else the commit it built as `/take commit`.
 */
export async function runForSpliceKey(ctx, row = ctx.current().pipeline) {
  if (!row) return ctx.note('Pick a pipeline first.', 'error');
  const run = lastRunOf(row);
  if (!run) return ctx.note(`${row.definition.name} hasn't run yet: nothing to hand to Splice.`, 'error');
  let details;
  try {
    details = await ctx.service.runDetails(row.projectId, run.id);
  } catch (e) {
    return ctx.note(`Couldn't read ${row.definition.name} ${run.buildNumber}: ${e.message.split('\n')[0]}`, 'error');
  }
  const got = runForSplice(row, run, details);
  if (!got) return ctx.note(`${row.definition.name} ${run.buildNumber} names no file and built no commit Keel knows of: nothing to hand to Splice.`, 'error');
  copyFor(ctx, 'splice', got.line);
  if (got.failure?.message) ctx.note(`It failed at ${got.failure.step}: ${got.failure.message}`);
}

/** alt+s on a pipeline that deploys: the commit its latest run built, as `/take commit` for Sonar, which finds the deployments that carry it. */
export function runForSonar(ctx, row = ctx.current().pipeline) {
  if (!row) return ctx.note('Pick a pipeline first.', 'error');
  if (!deploys(row, ctx.data.production?.monitors)) return ctx.note(`${row.definition.name} doesn't deploy anywhere Keel knows of (no production monitor is linked to it): alt+y hands its run to Splice instead.`, 'error');
  const run = lastRunOf(row);
  if (!run?.commit) return ctx.note(`${row.definition.name} has no run with a commit to look for.`, 'error');
  copyFor(ctx, 'sonar', takeLine('commit', { ...(row.repoName ? { repo: row.repoName } : {}), hash: run.commit, subject: `${row.definition.name} ${run.buildNumber}` }));
}

/** alt+k on a production monitor: Sonar's `/compare-window` at the deploy its "failures up since …" issue names (else its latest deploy). */
export function compareInSonar(ctx, m = ctx.current().monitor) {
  if (!m) return ctx.note('Pick a production monitor first.', 'error');
  const got = compareForSonar(m);
  if (!got) return ctx.note(`${m.name} has no deploy Keel knows of to compare around.`, 'error');
  copyFor(ctx, 'sonar', got.line);
  if (!got.issue) ctx.note(`No failures went up after a deploy of ${m.name}: that compares around its latest, ${got.deploy.label}. In Sonar, pick its app first.`);
  else ctx.note(`Around ${got.deploy.label}. In Sonar, pick ${m.name}'s app first.`);
}

/**
 * /take <context> (or a family:v1:… line on its own at the prompt): what a sibling copied for Keel. A
 * commit lists the pull requests and pipeline runs that carry it; a pull request or a pipeline opens in
 * its tab. Anything else is said to be for the app that takes it.
 */
export async function take(ctx, text) {
  const c = contextIn(text);
  if (!c) return ctx.note("That isn't a line one of the other apps copied: /take takes the family:v1:… that Splice copies for Keel (alt+y on a commit). /take on its own takes the work item.", 'error');
  if (c.kind === 'commit') return carriersOf(ctx, c.data);
  if (c.kind === 'pullrequest') return takePr(ctx, c.data);
  if (c.kind === 'pipeline') return takePipeline(ctx, c.data);
  return ctx.note(notMine('keel', c), 'error');
}

const RUN_ICON = { succeeded: '✓', failed: '✗', canceled: '⊘', declined: '⊘', partiallySucceeded: '◐' };

/** /take commit: the pull requests and runs that carry it, in a list; picking one opens it here (or in the browser). */
async function carriersOf(ctx, { hash, repo, subject }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(hash ?? ''))) return ctx.note(`${hash || 'That'} isn't a commit hash Keel can look for (7 characters at least).`, 'error');
  const shortHash = String(hash).slice(0, 10);
  const what = `${shortHash}${subject ? ` ${short(subject, 50)}` : ''}`;
  let found;
  const r = await ctx.task(`Pull requests and runs with ${what}`, async () => {
    try {
      found = await ctx.service.commitUsage(hash, { repo });
    } catch (e) {
      if (ctx.server && e.status === 404) throw new Error(`Your team's Keel at ${ctx.server} can't look a commit up yet: it's older than this terminal. Once it's updated, /take commit works.`);
      throw e;
    }
    if (!found.prs.length && !found.runs.length) return [`No pull request (active, or closed in the last 30 days) or pipeline run in your tracked repos has it.`];
    return [`${plural(found.prs.length, 'pull request')} and ${plural(found.runs.length, 'run')} carry it.`];
  }, { label: 'Looking for the commit' });
  if (!r.ok || !(found?.prs.length || found?.runs.length)) return;
  const prOptions = found.prs.slice(0, 8).map((p) => ({ label: `!${p.id} ${short(p.title, 50)} · ${p.status === 'completed' ? 'merged' : p.status} · ${p.repoName} (${branch(p.sourceBranch)} → ${branch(p.targetBranch)})`, value: { pr: p } }));
  const runOptions = found.runs.slice(0, 8).map((b) => ({ label: `${RUN_ICON[b.result] ?? '●'} ${b.definition.name} ${b.buildNumber} · ${b.status === 'completed' ? b.result : b.status} · ${branch(b.sourceBranch)}`, value: { run: b } }));
  const pick = await ctx.confirm({
    title: what,
    detail: "Pick one to open it: an active pull request or a tracked pipeline's run here, the rest in the browser.",
    options: [...prOptions, ...runOptions, { label: 'Leave it', value: null }],
  });
  if (!pick) return;
  if (pick.pr) {
    const p = pick.pr;
    if (p.status === 'active' && ctx.showPr({ projectId: p.projectId, repoId: p.repoId, id: p.id }, p.org)) return;
    return open(ctx, p.webUrl);
  }
  const b = pick.run;
  const row = ctx.data.pipelines?.find((x) => x.projectId === b.projectId && x.definition.id === b.definition.id && (!b.org || !x.org || x.org === b.org));
  if (!row) return open(ctx, b.webUrl);
  ctx.showPipeline(row.key, row.org);
  return showRun(ctx, row, String(b.id));
}

/** /take pullrequest: it, in Pull requests, when it's active in a tracked repo; else in the browser. */
function takePr(ctx, data) {
  const pr = ctx.data.prs?.find((p) => p.id === Number(data.id) && (!data.repo || p.repoName === data.repo) && (!data.org || !p.org || p.org === data.org));
  if (pr && ctx.showPr(pr, pr.org)) return ctx.note(`Taking ${describeContext({ kind: 'pullrequest', data })}`);
  if (data.url) return open(ctx, data.url);
  ctx.note(`!${data.id} isn't an active pull request in your tracked repos.`, 'error');
}

/** /take pipeline: it, in Pipelines, and its run in full when it names one. */
function takePipeline(ctx, data) {
  const row = ctx.data.pipelines?.find((r) => (data.definitionId ? r.definition.id === Number(data.definitionId) : r.definition.name === data.definition) && (!data.project || r.projectName === data.project) && (!data.org || !r.org || r.org === data.org));
  if (!row) return data.url ? open(ctx, data.url) : ctx.note(`${data.definition ?? 'That pipeline'} isn't one of your tracked pipelines.`, 'error');
  ctx.showPipeline(row.key, row.org);
  if (data.runId || data.run) return showRun(ctx, row, String(data.runId ?? data.run));
}

/** /family: what the folder Keel was started in is to the other apps, each a line for one's prompt; picking one copies it. */
export async function family(ctx) {
  const project = projectAt(ctx.cwd());
  const choices = familyChoices(project);
  if (!choices.length) return ctx.note(`${project.dir} is nothing the other apps open: no git checkout, nothing for Bosun to run, no .http files, no databases in appsettings*.json or .env.`);
  const pick = await ctx.confirm({
    title: `What ${project.dir} is to the other apps`,
    detail: "Pick one to copy its line for that app's prompt.",
    options: [...choices.map((c) => ({ label: `${APP_NAMES[c.app].padEnd(7)}${c.line}  ${c.what}`, value: c })), { label: 'Leave it', value: null }],
  });
  if (pick) copyFor(ctx, pick.app, pick.line);
}

/**
 * /timeline [here]: what the family's apps did that changed something (family.js readActivity: Splice's
 * pushes, Trawl's writes, Keel's votes and runs…), newest first, in the viewer; `here` keeps the folder
 * Keel was started in (and what names no folder).
 */
export function timeline(ctx, text = '') {
  if (!ctx.familyHome) return ctx.note("The family's activity log isn't kept here.", 'error');
  const here = /^here$/i.test(text.trim());
  const list = readActivity({ dir: ctx.familyHome, project: here ? ctx.cwd() : undefined, limit: 500 });
  ctx.showText(`Timeline${here ? ` of ${ctx.cwd()}` : ': the family'} (${list.length})`, timelineText(list));
}

/** /wiring: what the folder Keel was started in points at (family.js projectWiring: addresses, hosts, ports, connection strings, secrets masked), by file. */
export function wiring(ctx) {
  const dir = ctx.cwd();
  const found = projectWiring(dir);
  if (!found.length) return ctx.note(`Nothing in ${dir} points anywhere Keel can see: no addresses, hosts, ports or connection strings in appsettings*.json, .env files or http-client env files.`);
  const bySource = new Map();
  for (const w of found) {
    if (!bySource.has(w.source)) bySource.set(w.source, []);
    bySource.get(w.source).push(w);
  }
  const out = [];
  for (const [source, list] of bySource) {
    const keyW = Math.min(40, Math.max(...list.map((w) => w.key.length)));
    if (out.length) out.push('');
    out.push(source);
    for (const w of list) out.push(`  ${w.key.padEnd(keyW)}  ${w.value}`);
  }
  ctx.showText(`What ${dir} points at (${found.length})`, out.join('\n'));
}
