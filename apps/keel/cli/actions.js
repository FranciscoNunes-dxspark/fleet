// Every user-facing operation, written once: keys in the views and slash commands both call
// these with `ctx` (built in ui/App.jsx). Questions before anything that can't be undone live here.
import { branch, summaryText, summaryWeek } from './format.js';

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const prName = (pr) => `!${pr.id} ${short(pr.title)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const MERGE_STRATEGY = { squash: 'squash merge', noFastForward: 'merge commit', rebase: 'rebase', rebaseMerge: 'rebase with a merge commit' };

/** Opens the selection (or `url`) in the browser. */
export function open(ctx, url = ctx.current().webUrl) {
  if (!url) return ctx.note('Nothing to open here.');
  ctx.openUrl(url);
  ctx.note(`Opened in your browser: ${url}`);
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
  if (value === -10) {
    const ok = await ctx.confirm({ title: `Reject ${prName(pr)}?`, detail: 'It stays blocked until you change your vote.', danger: true, options: [{ label: 'Yes, reject it', value: true }, { label: 'No', value: false }] });
    if (!ok) return;
  }
  await ctx.task(`${VOTE_TITLE[value]} ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'vote', vote: value });
    await ctx.reload();
    return [value === 10 ? 'Approved.' : value === 0 ? 'Your vote is cleared.' : 'Vote recorded.'];
  }, { label: 'Voting' });
}

export async function complete(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  if (pr.isDraft) return ctx.note(`${prName(pr)} is a draft: publish it first.`, 'error');
  if (pr.hasConflicts) return ctx.note(`${prName(pr)} has merge conflicts: fix them before completing it.`, 'error');
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
    await ctx.reload();
    return [`Completed into ${branch(pr.targetBranch)}.`];
  }, { label: 'Completing' });
}

export async function autoComplete(ctx, pr = ctx.current().pr) {
  if (!pr) return ctx.note('Pick a pull request first.', 'error');
  const enabled = !pr.autoComplete;
  await ctx.task(`${enabled ? 'Set' : 'Cancel'} auto-complete on ${prName(pr)}`, async () => {
    await ctx.service.prAction(pr.projectId, pr.repoId, pr.id, { type: 'autoComplete', enabled });
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
    if (id) ctx.showWorkItem(id, project.org);
    return [`${type} ${id ?? ''} created${where === 'sprint' ? ` in ${sprint}` : ' in the backlog'}.`];
  }, { label: 'Creating' });
}

/** /wi 4107: jumps to that work item. */
export function showWorkItem(ctx, text) {
  const id = Number(String(text).replace(/^#/, ''));
  if (!Number.isInteger(id) || !ctx.showWorkItem(id)) return ctx.note(`No open work item #${String(text).replace(/^#/, '')} in your tracked projects. o on the Inbox or the web app finds closed ones.`, 'error');
}
