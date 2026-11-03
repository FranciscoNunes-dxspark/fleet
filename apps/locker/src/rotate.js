// /rotate: a vault secret rotated end to end, as one checklist shown while it runs: a new value
// (generated unless one is pasted), set as a new version, the App Service apps and slots whose
// settings refer to it found, those reading its latest version restarted (asking first) and those
// pinned to a version handed to Sonar, the restarted ones checked until they answer, and the previous
// version disabled once they do. Each step goes in the family's activity log by name; the value goes
// only to Key Vault. The pure parts are exported for the tests.
import { randomBytes } from 'node:crypto';
import { copiedNote } from '@fleet/kit/family.js';
import { theme } from './theme.js';
import { label } from './azure/arm.js';
import { isReference, parseReference } from './keys.js';
import { mapLimited } from './load.js';
import { sonarLine } from './share.js';
import { productionOk } from './actions.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (s) => String(s ?? '').split('\n')[0];

/** A new secret value: 32 random bytes, base64url (43 characters a URL, a .env file and a shell all take as they are). */
export const newValue = () => randomBytes(32).toString('base64url');

/**
 * The settings and connection strings of an app (`settings`, `strings` as provider.settings and
 * connectionStrings give them) that are Key Vault references to `secret` in `vault`:
 * [{ key, version }], version null for one that reads the latest version.
 */
export function referencesTo({ settings = {}, strings = {} }, vault, secret) {
  const out = [];
  const look = (key, value) => {
    if (!isReference(value)) return;
    const ref = parseReference(value);
    if (ref && !ref.problem && ref.vault === String(vault).toLowerCase() && ref.secret.toLowerCase() === String(secret).toLowerCase()) out.push({ key, version: ref.version });
  };
  for (const [key, value] of Object.entries(settings)) look(key, value);
  for (const [name, s] of Object.entries(strings)) look(`ConnectionStrings:${name}`, s?.value);
  return out;
}

/** The address an app's health is checked at: its default host name and `path` (/ when there's none). */
export function healthUrl(site, path) {
  if (!site?.hostName) return null;
  const p = String(path ?? '').trim() || '/';
  return `https://${site.hostName}${p.startsWith('/') ? p : `/${p}`}`;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const stop = () => (clearTimeout(t), reject(Object.assign(new Error('Cancelled'), { cancelled: true })));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Asks `probe(url)` every `every` ms until it answers 2xx or `timeout` ms have gone:
 * { ok, status, tries, error? }. `onTry(answer, tries)` hears each answer.
 */
export async function waitHealthy(probe, url, { signal, every = 3000, timeout = 120_000, onTry, now = Date.now } = {}) {
  const end = now() + timeout;
  let tries = 0;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const answer = await probe(url, { signal });
    tries++;
    onTry?.(answer, tries);
    if (answer.status >= 200 && answer.status < 300) return { ok: true, status: answer.status, tries };
    if (now() + every > end) return { ok: false, status: answer.status, tries, ...(answer.error ? { error: answer.error } : {}) };
    await sleep(every, signal);
  }
}

const MARKS = {
  waiting: { text: '·', tone: 'dim' },
  running: { text: '▸', tone: 'accent' },
  done: { text: '✓', tone: 'add' },
  skipped: { text: '–', tone: 'dim' },
  failed: { text: '✗', tone: 'del' },
  cancelled: { text: '✗', tone: 'warn' },
};

/** The checklist as the viewer draws it ({ lines }) and as text (y copies it): a step a line, what it found under it. */
export function checklist(steps) {
  const lines = [];
  const text = [];
  for (const s of steps) {
    const m = MARKS[s.state] ?? MARKS.waiting;
    lines.push([{ text: `${m.text} `, color: theme[m.tone], bold: true }, { text: s.title, bold: s.state === 'running', color: s.state === 'waiting' || s.state === 'skipped' ? theme.dim : undefined }]);
    text.push(`${m.text} ${s.title}`);
    for (const l of s.lines ?? []) {
      lines.push([{ text: `    ${l}`, color: theme.dim }]);
      text.push(`    ${l}`);
    }
  }
  return { lines, text: text.join('\n') };
}

/**
 * /rotate <secret> (and r on a vault secret). `every` and `timeout` are the health check's (ms).
 * Resolves true when the new version was set, whatever came after.
 */
export async function rotateSecret(ctx, name, { every = 3000, timeout = 120_000 } = {}) {
  const vault = ctx.data.vault;
  if (!vault) return ctx.note(ctx.data.azure ? 'Pick a key vault first: /vault.' : 'Locker has no key vault to rotate in: Azure could not be read (/refresh tries again).', 'error') ?? false;
  if (!String(name ?? '').trim()) return ctx.note('/rotate needs a secret: /rotate <secret>.', 'error') ?? false;
  const secret = ctx.findSecret(name);
  if (!secret) return false;
  const s = secret.name;
  const what = `${s} in ${vault.name}`;

  const steps = [
    { id: 'value', title: 'A new value', state: 'waiting' },
    { id: 'set', title: `A new version of ${what}`, state: 'waiting' },
    { id: 'apps', title: 'The apps that read it', state: 'waiting' },
    { id: 'health', title: 'The restarted apps answer again', state: 'waiting' },
    { id: 'previous', title: 'The previous version disabled', state: 'waiting' },
  ];
  const step = (id) => steps.find((x) => x.id === id);
  // Closing the checklist cancels what is running; after that it isn't shown again.
  let closed = false;
  const show = () => {
    if (closed) return;
    const { lines, text } = checklist(steps);
    ctx.showText(`Rotating ${what}`, text, {
      lines: [[{ text: 'esc stops it (what is done stays done)', color: theme.dim }], ...lines],
      follow: true,
      onClose: () => {
        closed = true;
        ctx.cancel();
      },
    });
  };
  const set = (id, state, lines) => {
    Object.assign(step(id), { state }, lines ? { lines } : {});
    show();
  };
  const log = (text) => ctx.log(`Rotation of ${what}: ${text}`, 'secret');
  show();

  // (a) The value: generated, unless one is pasted.
  set('value', 'running');
  const how = await ctx.confirm({
    title: `A new value for ${what}`,
    detail: 'Generated: 32 random bytes, base64url. Or paste the one a provider gave you (a new API key, say).',
    options: [
      { label: 'Generate one', value: 'generate' },
      { label: 'Paste one, typed hidden', value: 'paste' },
      { label: 'Cancel', value: null },
    ],
  });
  if (!how) return stop('value');
  let value = how === 'generate' ? newValue() : await ctx.askSecret({ title: `The new value of ${what}`, detail: 'Typed hidden; ↵ goes on, esc cancels.' });
  if (value == null) return stop('value');
  if (!value) {
    set('value', 'failed', ['An empty value: nothing was set.']);
    return false;
  }
  set('value', 'done', [how === 'generate' ? 'Generated: 32 random bytes' : 'Pasted']);

  // (b) A new version, asked about, as e asks.
  set('set', 'running');
  const yes = await ctx.confirm({ title: `Set a new version of ${what}?`, detail: 'Whatever reads its latest version gets the new value once it reads it again; the old version stays until the last step.', danger: true });
  if (!yes || !(await productionOk(ctx, `Set a new version of ${what}`))) {
    value = null;
    return stop('set');
  }

  let previous = null;
  let version = null;
  let found = { latest: [], pinned: [], unread: [] };
  const restarted = [];
  const healthy = [];
  const unhealthy = [];
  const r = await ctx.task(
    `Rotating ${what}`,
    async (signal) => {
      try {
        // The version being replaced: the one to disable at the end.
        previous = (await ctx.provider.versions(vault, s, { signal }).catch((e) => (e.cancelled ? Promise.reject(e) : [])))[0] ?? null;
        version = (await ctx.provider.setSecret(vault, s, value, { signal }))?.version ?? null;
        value = null;
        log('set a new version');
        set('set', 'done', [`Version ${version ? version.slice(0, 8) : '(new)'}${previous ? `, after ${previous.version.slice(0, 8)}` : ''}`]);

        // (c) Who reads it: every app and slot of the subscription, six at a time.
        set('apps', 'running', ['Reading the apps\' settings…']);
        found = await whoReads(ctx, vault, s, signal);
        const lines = [
          ...found.latest.map((f) => `${label(f.site)}: ${f.keys.join(', ')} (the latest version)`),
          ...found.pinned.map((f) => `${label(f.site)}: ${f.keys.map((k) => `${k.key} pinned to ${k.version.slice(0, 8)}`).join(', ')}`),
          ...(found.unread.length ? [`Couldn't read ${plural(found.unread.length, 'app')}: ${found.unread.map(label).join(', ')}`] : []),
        ];
        if (!found.latest.length && !found.pinned.length) {
          set('apps', 'done', [...lines, 'No app or slot here refers to it.']);
        } else {
          set('apps', 'running', lines);
          // A reference to the latest version is read again within a day on its own; a restart reads it now.
          if (found.latest.length) {
            const names = found.latest.map((f) => label(f.site));
            const go = await ctx.confirm({ title: `Restart ${names.join(', ')} so ${names.length === 1 ? 'it reads' : 'they read'} the new version now?`, detail: 'App Service reads a reference to the latest version again within a day on its own; a restart reads it now.' });
            if (go && (await productionOk(ctx, `Restart ${names.join(', ')}`))) {
              for (const f of found.latest) {
                await ctx.provider.restart(f.site, { signal });
                restarted.push(f.site);
                log(`restarted ${label(f.site)}`);
              }
              lines.push(`Restarted ${names.join(', ')}`);
            } else lines.push('Not restarted: they read the new version within a day');
          }
          // Sonar changes app settings, not Locker: what to change is said here, and handed over at the end.
          for (const f of found.pinned) for (const k of f.keys) lines.push(`In Sonar, set ${label(f.site)}'s ${k.key} to ${pinnedReference(vault, s, version)}`);
          set('apps', 'done', lines);
        }

        // (d) The restarted apps answer again.
        if (!restarted.length) set('health', 'skipped', [found.latest.length ? 'Nothing was restarted.' : 'Nothing to restart.']);
        else {
          const path = ctx.env?.healthPath ?? '/';
          const said = restarted.map((site) => ({ site, line: `${label(site)}: waiting` }));
          const draw = () => set('health', 'running', said.map((x) => x.line));
          draw();
          for (const x of said) {
            const url = healthUrl(x.site, path);
            if (!url) {
              x.line = `${label(x.site)}: no address to check`;
              unhealthy.push(x.site);
              draw();
              continue;
            }
            const h = await waitHealthy(ctx.provider.probe, url, { signal, every, timeout, onTry: (a, n) => ((x.line = `${label(x.site)}: ${a.status || a.error || 'no answer'} at ${url}${n > 1 ? ` (try ${n})` : ''}`), draw()) });
            if (h.ok) {
              healthy.push(x.site);
              x.line = `${label(x.site)} answered ${h.status} at ${url}`;
              log(`${label(x.site)} answered ${h.status} after its restart`);
            } else {
              unhealthy.push(x.site);
              x.line = `${label(x.site)} didn't answer 2xx within ${Math.round(timeout / 1000)} s (${h.status || h.error || 'no answer'}) at ${url}`;
              log(`${label(x.site)} didn't answer after its restart`);
            }
            draw();
          }
          set('health', unhealthy.length ? 'failed' : 'done', said.map((x) => x.line));
        }

        // (e) The previous version, once the apps answer: what still reads it fails after this.
        if (!previous) set('previous', 'skipped', ['Its versions couldn\'t be listed: Key Vault keeps the old one enabled.']);
        else if (unhealthy.length) set('previous', 'skipped', ['Kept: not every restarted app answered. x in the Vault view, or the portal, disables it later.']);
        else {
          set('previous', 'running');
          const pinnedOld = found.pinned.flatMap((f) => f.keys.filter((k) => k.version.toLowerCase() === previous.version.toLowerCase()).map((k) => `${label(f.site)}'s ${k.key}`));
          const off = await ctx.confirm({
            title: `Disable ${s}'s previous version (${previous.version.slice(0, 8)}) in ${vault.name}?`,
            detail: pinnedOld.length ? `${pinnedOld.join(', ')} still ${pinnedOld.length === 1 ? 'reads' : 'read'} it, and fail${pinnedOld.length === 1 ? 's' : ''} until changed in Sonar.` : 'Nothing Locker found reads it any more; it stays as a version, disabled.',
            danger: true,
          });
          if (off && (await productionOk(ctx, `Disable ${s}'s previous version in ${vault.name}`))) {
            await ctx.provider.enableSecret(vault, s, false, { signal, version: previous.version });
            log(`disabled the previous version ${previous.version.slice(0, 8)}`);
            set('previous', 'done', [`Disabled ${previous.version.slice(0, 8)}`]);
          } else set('previous', 'skipped', ['Kept enabled']);
        }
        return { stdout: summary() };
      } catch (caught) {
        // A fetch stopped by esc says so in its own words: here it is a cancel like any other.
        const e = signal.aborted && !caught.cancelled ? Object.assign(new Error('Cancelled'), { cancelled: true }) : caught;
        const now = steps.find((x) => x.state === 'running');
        if (now) set(now.id, e.cancelled ? 'cancelled' : 'failed', [...(now.lines ?? []), e.cancelled ? 'Stopped' : firstLine(e.message)]);
        for (const x of steps) if (x.state === 'waiting') x.state = 'skipped';
        show();
        if (e.cancelled && version) log('stopped after the new version was set');
        throw e;
      }
    },
    { label: 'Rotating', reload: { vault: vault.name } },
  );
  // The hand-off last, so in Fleet the switch to Sonar comes once Locker is done.
  if (found.pinned.length) {
    const line = sonarLine(found.pinned[0].site);
    ctx.copy(line, 'a line for Sonar');
    ctx.note(`${copiedNote('sonar', line)}\nThere, set ${found.pinned.map((f) => f.keys.map((k) => `${label(f.site)}'s ${k.key}`).join(', ')).join(', ')} to ${pinnedReference(vault, s, version)}.`, 'ok');
  }
  return r.ok || Boolean(version);

  function stop(id) {
    set(id, 'cancelled', ['Nothing was changed.']);
    for (const x of steps) if (x.state === 'waiting') x.state = 'skipped';
    show();
    ctx.note(`Rotating ${what}: stopped, nothing was changed.`);
    return false;
  }

  function summary() {
    return [
      `A new version of ${what}`,
      found.latest.length || found.pinned.length ? `${plural(found.latest.length + found.pinned.length, 'app')} refer to it${restarted.length ? `; restarted ${restarted.map(label).join(', ')}` : ''}${unhealthy.length ? `; not answering: ${unhealthy.map(label).join(', ')}` : ''}` : 'No app refers to it',
      ...(found.pinned.length ? [`Pinned to a version, for Sonar: ${found.pinned.map((f) => label(f.site)).join(', ')}`] : []),
      `Previous version: ${step('previous').state === 'done' ? 'disabled' : 'kept'}`,
    ].join('\n');
  }
}

/** The reference a pinned setting should name after the rotation (no value in it: an address). */
function pinnedReference(vault, secret, version) {
  return `@Microsoft.KeyVault(SecretUri=${vault.uri}secrets/${secret}/${version ?? '<the new version>'})`;
}

/** Every app and slot whose settings refer to `secret`: { latest: [{ site, keys }], pinned: [{ site, keys: [{ key, version }] }], unread: [site] }. */
async function whoReads(ctx, vault, secret, signal) {
  const sites = ctx.data.azure?.sites ?? [];
  const read = await mapLimited(sites, 6, async (site) => {
    try {
      const [settings, strings] = await Promise.all([ctx.provider.settings(site, { signal }), ctx.provider.connectionStrings(site, { signal }).catch(() => ({}))]);
      return { site, refs: referencesTo({ settings, strings }, vault.name, secret) };
    } catch (e) {
      if (e.cancelled || signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      return { site, unread: true };
    }
  });
  return {
    latest: read.filter((x) => x.refs?.some((r) => !r.version)).map((x) => ({ site: x.site, keys: x.refs.filter((r) => !r.version).map((r) => r.key) })),
    pinned: read.filter((x) => x.refs?.some((r) => r.version)).map((x) => ({ site: x.site, keys: x.refs.filter((r) => r.version) })),
    unread: read.filter((x) => x.unread).map((x) => x.site),
  };
}
