// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
import { basename, isAbsolute, join } from 'node:path';
import { contextIn, copiedNote, notMine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { RUNNER_NAMES } from './parsers/index.js';
import { countLine, countTests, duration } from './model.js';
import { filesBySuiteOf, inSuite, mergeTests, runSuites } from './session.js';
import { recordRun } from './flaky.js';
import { classesIn, testsTouching } from './changed.js';
import { editorCommand, editorSetting } from './editor.js';
import { quote, safeFile } from './runners.js';
import { failureText, findTest, placeOf, testContext } from './share.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fullName = (t) => [...t.suite, t.name].join(' › ');

/** Finds the folder's suites again (detect.js), and the flaky history; then runs everything unless `run` is false. */
export async function load(ctx, { run = ctx.config.runOnStart !== false } = {}) {
  const root = ctx.cwd();
  const r = await ctx.task(
    `Looking for tests in ${basename(root) || root}`,
    async () => {
      const data = await ctx.provider.detect(root);
      ctx.setData(data);
      ctx.setHistory(ctx.provider.loadHistory(root));
      const lines = data.suites.map((s) => `${RUNNER_NAMES[s.runner]}${s.dir ? ` in ${s.dir}` : ''}${s.target ? ` (${s.target})` : ''}${s.version ? ` ${s.version}` : ''}${s.url ? `, against ${s.url}` : ''}`);
      return { stdout: [...lines, ...data.notes].join('\n') || 'No tests found.' };
    },
    { label: 'Looking' },
  );
  if (!r.ok) return false;
  if (run && ctx.data.suites.length) return runAll(ctx);
  return true;
}

/**
 * One run, shown as it goes: the runners' own output into the Output view, the tests merged into
 * what's shown (all of them replace it; some replace theirs), the flaky history added to. `pick` is
 * { tests } or { filesBySuite } or nothing for everything.
 */
async function runWith(ctx, title, pick = {}) {
  const data = ctx.data;
  if (!data) return ctx.note('Still looking for the tests.', 'error') ?? false;
  if (!data.suites.length) return ctx.note('No tests here: /move to a project, or say where they are in drill.json.', 'error') ?? false;
  const root = ctx.cwd();
  ctx.output.reset(title);
  let out = null;
  const r = await ctx.task(
    title,
    async (signal) => {
      out = await runSuites(ctx.provider, {
        root,
        suites: data.suites,
        tests: pick.tests ?? null,
        filesBySuite: pick.filesBySuite ?? null,
        signal,
        onData: ctx.output.write,
        onSuite: (s, phase) => phase === 'start' && ctx.progress(`${RUNNER_NAMES[s.runner]}${s.dir ? ` in ${s.dir}` : ''}`),
      });
      const prev = ctx.run;
      const whole = !pick.tests && !pick.filesBySuite;
      const tests = whole || !prev ? out.tests : mergeTests(prev.tests, out.tests, { rerunFiles: pick.filesBySuite ? new Set(out.tests.map((t) => t.file)) : null });
      const results = { ...(whole ? {} : prev?.results), ...Object.fromEntries(out.results.map((x) => [x.suite, x])) };
      ctx.setRun({ tests, results, counts: countTests(tests), at: Date.now() });
      const history = recordRun(ctx.history, out.tests);
      ctx.setHistory(history);
      ctx.provider.saveHistory(root, history);
      const lines = out.results.map((x) => `${RUNNER_NAMES[x.runner]}${x.dir ? ` in ${x.dir}` : ''}: ${x.ran ? countLine(countTests(x.tests)) : "couldn't run"}${x.duration ? ` in ${duration(x.duration)}` : ''}`);
      return { stdout: lines.join('\n') || 'Nothing to run.' };
    },
    { label: 'Running tests' },
  );
  if (!r.ok) return false;
  // What couldn't run says why, on a line of its own: the app down, a runner missing.
  for (const x of out.results.filter((x) => !x.ran)) ctx.note(`${RUNNER_NAMES[x.runner]}${x.dir ? ` in ${x.dir}` : ''} couldn't run\n${x.error}`, 'error');
  for (const x of out.results.filter((x) => x.note)) ctx.note(x.note);
  const c = out.counts;
  ctx.logActivity(`Ran ${plural(c.total, 'test')} in ${basename(root) || root}: ${countLine(c)}`, c.failed ? 'change' : 'info');
  if (c.failed && ctx.view() !== 'tree' && ctx.view() !== 'flaky') ctx.setView('failures');
  return true;
}

/** ctrl+r and /run: every suite, every test. */
export const runAll = (ctx) => runWith(ctx, 'Run every test');

/** R and /run failed: the tests that failed last time, again. */
export function runFailed(ctx) {
  const failed = (ctx.run?.tests ?? []).filter((t) => t.status === 'failed');
  if (!failed.length) return ctx.note(ctx.run ? 'Nothing failed.' : 'Nothing has run yet: ctrl+r runs everything.') ?? false;
  return runWith(ctx, `Run the ${plural(failed.length, 'failed test')} again`, { tests: failed });
}

/** r: some tests (a test, a file's, a suite's) again. */
export function runTests(ctx, tests, what = null) {
  if (!tests?.length) return ctx.note('No test there to run.', 'error') ?? false;
  return runWith(ctx, `Run ${what ?? (tests.length === 1 ? fullName(tests[0]) : plural(tests.length, 'test'))}`, { tests });
}

/**
 * c and /run changed: the test files touching what git says changed (changed.js), each run by the
 * suite that ran it last (or the one its name and place say).
 */
export async function runChanged(ctx, paths = null) {
  const root = ctx.cwd();
  let files = paths;
  if (!files) {
    const changed = await ctx.provider.changed(root);
    if (changed.error) return ctx.note(changed.error, 'error') ?? false;
    files = changed.files;
  }
  if (!files.length) return ctx.note('Nothing has changed (git status is clean).') ?? false;
  const testFiles = await ctx.provider.testFiles(root);
  const touching = testsTouching(files, testFiles);
  const filesBySuite = filesBySuiteOf(ctx.data?.suites ?? [], touching.map((t) => t.path), { known: ctx.run?.tests ?? [], classesOf: (p) => classesIn(testFiles.find((f) => f.path === p)?.text) });
  const changedWhat = files.length === 1 ? files[0] : plural(files.length, 'changed file');
  if (!filesBySuite.size) return ctx.note(`No test touches ${changedWhat}.`) ?? false;
  return runWith(ctx, `Run the tests touching ${changedWhat} (${plural(touching.length, 'test file')})`, { filesBySuite });
}

/** w and /watch: run the tests touching a file whenever one is saved; again, stop. */
export function toggleWatch(ctx, on = null) {
  const watching = ctx.watching();
  if (on === false || (on === null && watching)) {
    if (!watching) return ctx.note('Not watching.') ?? false;
    ctx.setWatching(null);
    ctx.note('Stopped watching.');
    return true;
  }
  if (watching) return ctx.note('Watching already: w stops it.') ?? false;
  const root = ctx.cwd();
  // A change while a run is going waits for it, and the changes that came meanwhile run together.
  let waiting = new Set();
  const onChange = (paths) => {
    for (const p of paths) waiting.add(p);
    if (ctx.isBusy()) return setTimeout(() => onChange([]), 500);
    const these = [...waiting];
    waiting = new Set();
    if (these.length) runChanged(ctx, these);
  };
  try {
    const stop = ctx.provider.watch(root, onChange, { ignore: ctx.data?.config?.watch?.ignore ?? [] });
    ctx.setWatching(stop);
  } catch (e) {
    return ctx.note(firstLine(e.message), 'error') ?? false;
  }
  ctx.note(`Watching ${basename(root) || root}: a saved file runs the tests touching it (w stops).`, 'ok');
  return true;
}

/** ↵ on a frame: its file at its line in the editor (the setting, DRILL_EDITOR, VISUAL or EDITOR). */
export function openFrame(ctx, frame) {
  const root = ctx.cwd();
  const file = isAbsolute(frame.file) || /^[A-Za-z]:[\\/]/.test(frame.file) ? frame.file : join(root, ...frame.file.split('/'));
  const editor = editorSetting(ctx.config);
  if (!editor) return ctx.note('No editor set: /editor code (or set EDITOR) says which one opens files.', 'error') ?? false;
  const cmd = editorCommand(editor, file, frame.line, { column: frame.column });
  if (!cmd) return ctx.note(`${editor} and ${frame.file} can't go in a command line as they are.`, 'error') ?? false;
  if (cmd.terminal) {
    ctx.copy(cmd.command, cmd.command);
    return ctx.note(`${basename(editor.split(' ')[0])} runs in a terminal, and Drill is drawing on this one: copied the command to run it in another.`) ?? true;
  }
  ctx.note(`Opening ${frame.file}:${frame.line} in ${basename(editor.split(' ')[0])}`);
  ctx.provider.launch(cmd.command, { cwd: root }).catch((e) => ctx.note(`The editor didn't start: ${firstLine(e.message)}`, 'error'));
  return true;
}

/** o: a Playwright failure's trace, in Playwright's trace viewer (npx playwright show-trace). */
export function showTrace(ctx, t) {
  if (t?.runner !== 'playwright') return ctx.note('Only a Playwright test has a trace.', 'error') ?? false;
  const trace = t.attachments?.find((a) => a.name === 'trace');
  if (!trace) return ctx.note('No trace for this test: trace: "retain-on-failure" (or "on-first-retry") in playwright.config keeps one.', 'error') ?? false;
  if (!safeFile(trace.path)) return ctx.note(`${trace.path} can't go in a command line as it is.`, 'error') ?? false;
  if (!ctx.provider.exists(trace.path)) return ctx.note(`${trace.path} isn't there any more (the next run replaces test-results).`, 'error') ?? false;
  const suite = ctx.data?.suites.find((s) => inSuite(s, t)) ?? ctx.data?.suites.find((s) => s.runner === 'playwright');
  const command = `${suite?.exec ?? 'npx --no'} playwright show-trace ${quote(trace.path)}`;
  ctx.note(`Opening the trace of ${t.name}`);
  ctx.provider.launch(command, { cwd: suite?.cwd ?? ctx.cwd() }).catch((e) => ctx.note(`The trace viewer didn't start: ${firstLine(e.message)}`, 'error'));
  return true;
}

/** t: a test (a failure's place and message) for Splice, which blames the file at that line. */
export function share(ctx, t) {
  if (!t) return ctx.note('No test there.', 'error') ?? false;
  const data = testContext(t);
  if (!data.file || (t.runner === 'dotnet' && !placeOf(t))) return ctx.note(`${t.name} has no file Drill knows (TRX names only its class): run it to see its frames.`, 'error') ?? false;
  const line = takeLine('test', data);
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** /take: a `test` context (Drill's own, or another's) runs that test again; any other says whose it is. */
export async function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  if (context.kind !== 'test') return ctx.note(notMine('drill', context), 'error') ?? false;
  const t = findTest(ctx.run?.tests ?? [], context.data);
  if (t) return runTests(ctx, [t]);
  // Not in what has run: its file, by the suite that holds it.
  const file = String(context.data.file ?? '');
  const filesBySuite = filesBySuiteOf(ctx.data?.suites ?? [], [file]);
  if (!filesBySuite.size) return ctx.note(`No suite here runs ${file || 'that test'}.`, 'error') ?? false;
  return runWith(ctx, `Run ${file}`, { filesBySuite });
}

/** ↵ on a test that didn't fail (or y's text for one that did): what it is, in the viewer. */
export function showTest(ctx, t) {
  if (t.failure) return ctx.showText(fullName(t), failureText(t));
  const where = placeOf(t);
  ctx.showText(fullName(t), [`${t.status === 'passed' ? 'Passed' : 'Skipped'}${t.flaky ? ' on a retry (flaky)' : ''} in ${duration(t.duration)}`, `${t.runner} · ${where?.file ?? t.file}${where?.line ? `:${where.line}` : ''}`, ...(t.fqn ? [`dotnet test --filter "FullyQualifiedName=${t.fqn}"`] : [])].join('\n'));
}

/** /runners: the suites found, how each is run and which parser reads its report. */
export function runners(ctx) {
  const d = ctx.data;
  if (!d) return ctx.note('Still looking for the tests.') ?? false;
  const lines = [];
  for (const s of d.suites) {
    const res = ctx.run?.results?.[s.id];
    lines.push(`${RUNNER_NAMES[s.runner]}${s.dir ? ` in ${s.dir}` : ''}${s.target ? ` (${s.target})` : ''}`, `  found in    ${s.from}`, `  version     ${s.version ?? res?.version ?? 'asked when it runs'}${res?.pin ? `, read as ${res.pin}` : ''}`);
    if (s.url) lines.push(`  e2e against ${s.url} (asked before each run; Bosun runs the app)`);
    if (res?.command) lines.push(`  last run    ${res.command}`);
    if (res && !res.ran) lines.push(`  couldn't run: ${firstLine(res.error)}`);
    lines.push('');
  }
  if (!d.suites.length) lines.push('No tests found.');
  lines.push(...d.notes, `A drill.json in ${basename(d.root) || d.root} names the runners instead: { "runners": [{ "runner": "vitest", "cwd": "web" }], "e2e": { "url": "http://localhost:3000" } }`);
  ctx.showText('Runners', lines.join('\n'));
  return true;
}

/** /env [name]: the project's environment; a name switches every app of the family to it. */
export function env(ctx, name = '') {
  if (!name.trim()) return ctx.note(describeEnvironments(ctx.cwd()));
  const r = setEnvironment(ctx.cwd(), name, { by: 'drill' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production)' : ''}, for every app.`, 'ok');
  return true;
}

/** /move <folder>: another project: a path, or a folder beside this one or in it. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Testing ${dir}. /move <folder> goes to another (one beside this, in it, or a path).`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Drill is in ${basename(target)} already.`);
  ctx.moveTo(target);
  return load(ctx);
}

/** ! and /shell: a shell command in the folder, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !npm ls vitest', 'error') ?? false;
  const r = await ctx.task(command, (signal) => ctx.provider.shell(command, { cwd: ctx.cwd(), signal }), { label: 'Running' });
  return r.ok;
}

/** /run [all|failed|changed|<file or test>]: what to run. */
export function runCommand(ctx, what = '') {
  const w = what.trim();
  if (!w || /^all$/i.test(w)) return runAll(ctx);
  if (/^failed$/i.test(w)) return runFailed(ctx);
  if (/^changed$/i.test(w)) return runChanged(ctx);
  const tests = ctx.run?.tests ?? [];
  const inFile = tests.filter((t) => t.file === w || t.source === w);
  if (inFile.length) return runTests(ctx, inFile, w);
  const named = tests.filter((t) => fullName(t).toLowerCase().includes(w.toLowerCase()));
  if (named.length) return runTests(ctx, named, named.length === 1 ? fullName(named[0]) : `${plural(named.length, 'test')} matching "${w}"`);
  const filesBySuite = filesBySuiteOf(ctx.data?.suites ?? [], [w]);
  if (filesBySuite.size && !/\s/.test(w)) return runWith(ctx, `Run ${w}`, { filesBySuite });
  return ctx.note(`No test or file "${w}". /run all, failed, changed, a file, or part of a test's name.`, 'error') ?? false;
}

/** /editor [command]: the editor ↵ on a frame opens; alone, says which. */
export function editor(ctx, value = '') {
  const v = value.trim();
  if (!v) return ctx.note(`Editor: ${editorSetting(ctx.config) ?? 'none'}${ctx.config.editor ? '' : ' (from the environment)'}. /editor code (or subl, idea, vim…) sets it; /editor default goes back to EDITOR.`);
  const next = { ...ctx.config };
  if (v === 'default') delete next.editor;
  else next.editor = v;
  ctx.setConfig(next);
  ctx.note(`Editor: ${v}`, 'ok');
  return true;
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  ctx.showText(
    'Settings',
    [
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Editor           ${editorSetting(c) ?? 'none'}${c.editor ? '' : ' (DRILL_EDITOR, VISUAL or EDITOR)'}       /editor <command>`,
      `Run on start     ${on(c.runOnStart)}       "runOnStart" in the file`,
      `Family moods     ${on(c.familyMoods)}       "familyMoods" in the file`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}; the flaky history in its history folder, per project.`,
    ].join('\n'),
  );
  return true;
}
