// First run: nothing to connect to yet. Before the app starts, ask whether it's your team's Keel
// (signed in through the browser, remote.js) or Azure DevOps directly (which organization, and how
// to sign in), and save the answers in the .env file Keel reads (the checkout's, or ~/.keel/.env
// for the standalone executable), so the next start goes straight in. Plain prompts, not Ink:
// the server's config reads the environment on import, so this has to happen first.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_SERVER, serverUrlFrom } from './remote.js';

const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const coral = (s) => `\x1b[38;2;255;138;101m${s}\x1b[39m`;

/**
 * An organization address from what someone typed: a full address (dev.azure.com, an old
 * visualstudio.com one, or an Azure DevOps Server collection), or just the organization's name.
 * Null when it can't be one.
 */
export function orgUrlFrom(text) {
  const s = String(text ?? '').trim().replace(/\/+$/, '');
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)) return `https://dev.azure.com/${s}`;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname.toLowerCase() === 'dev.azure.com') return parts[0] ? `https://dev.azure.com/${parts[0]}` : null;
  if (/\.visualstudio\.com$/i.test(u.hostname)) return `https://${u.hostname.toLowerCase()}`;
  return `${u.origin}${parts.length ? `/${parts.join('/')}` : ''}`;
}

/**
 * A .env file's text with these KEY=value lines set: each replaces that key's line where the file
 * has one (an empty AZDO_ORG_URL= copied from .env.example, say), else goes at the end.
 */
export function withSettings(text, lines) {
  let out = String(text ?? '');
  const added = [];
  for (const line of lines) {
    const re = new RegExp(`^${line.slice(0, line.indexOf('='))}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, () => line);
    else added.push(line);
  }
  if (!added.length) return out;
  const gap = !out ? '' : out.endsWith('\n') ? '\n' : '\n\n';
  return `${out}${gap}# Saved by keel on first run.\n${added.join('\n')}\n`;
}

/** Sets these KEY=value lines in the .env file (made if missing) and in `env`. */
export function saveEnvSettings(envFile, lines, env = process.env) {
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  // Only you should read it when it holds a token.
  fs.writeFileSync(envFile, withSettings(before, lines), { mode: 0o600 });
  for (const line of lines) env[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
}

/** Reads a line without echoing it (a token), showing • for each character typed. */
function askHidden(input, output, question) {
  output.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(Object.assign(new Error('Cancelled'), { cancelled: true }));
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          output.write('•');
        }
      }
      return undefined;
    };
    input.on('data', onData);
  });
}

/**
 * Asks what to connect to and saves the answers to `envFile` and `env`. Returns 'keel' (your
 * team's Keel: KEEL_SERVER is saved, and signing in comes next), 'saved' (an Azure DevOps
 * organization and how to sign in to it), or 'demo' (nothing saved).
 */
export async function firstRunSetup({ envFile, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  output.write(`\n${coral(bold('Keel'))} ${bold("isn't set up yet.")}\n`);
  output.write(dim(`Your answers are saved in ${envFile}; edit or delete it to change them.\n\n`));
  const rl = createInterface({ input, output, terminal: !!input.isTTY });
  // Ctrl+C leaves without saving anything.
  rl.on('SIGINT', () => {
    output.write('\n');
    process.exit(130);
  });
  let open = true;
  const close = () => {
    if (open) rl.close();
    open = false;
  };
  const lines = [];
  let signIn;
  try {
    output.write(`${bold('Connect to')}\n  1  your team's Keel ${dim('(sign in with your Keel account, in the browser)')}\n  2  Azure DevOps directly ${dim('(your Azure CLI sign-in, or a personal access token)')}\n  3  the demo ${dim('(no sign-in)')}\n`);
    let to;
    for (;;) {
      to = (await rl.question(`› ${dim('[1]')} `)).trim() || '1';
      if (['1', '2', '3'].includes(to)) break;
    }
    if (to === '3') return 'demo';
    if (to === '1') {
      let server;
      for (;;) {
        const answer = await rl.question(`\n${bold('Keel address')} ${dim(DEFAULT_SERVER ? `(empty for ${DEFAULT_SERVER.replace(/^https:\/\//, '')})` : '(https://keel.example.com)')}\n› `);
        server = serverUrlFrom(answer.trim() || DEFAULT_SERVER);
        if (server) break;
        output.write(dim("That doesn't look like a Keel address (https://keel.example.com). Try again.\n"));
      }
      close();
      saveEnvSettings(envFile, [`KEEL_SERVER=${server}`], env);
      return 'keel';
    }
    let orgUrl;
    for (;;) {
      const answer = await rl.question(`\n${bold('Azure DevOps organization')} ${dim('(https://dev.azure.com/your-org, or its name)')}\n› `);
      orgUrl = orgUrlFrom(answer);
      if (orgUrl) break;
      output.write(dim("That doesn't look like an organization address. Try again.\n"));
    }
    lines.push(`AZDO_ORG_URL=${orgUrl}`);
    output.write(`\n${bold('Sign in with')}\n  1  your Azure CLI sign-in ${dim('(az login; no token stored)')}\n  2  a personal access token ${dim('(saved in that file)')}\n`);
    for (;;) {
      const choice = (await rl.question(`› ${dim('[1]')} `)).trim() || '1';
      if (choice === '1' || choice === '2') {
        signIn = choice === '1' ? 'az' : 'pat';
        break;
      }
    }
    if (signIn === 'az') lines.push('AZDO_AUTH=az');
    else {
      output.write(dim('Scopes: Code (Read & write), Work Items (Read & write), Build (Read & execute), Release (Read, write, execute & manage), Project and Team (Read), Identity (Read).\n'));
      let pat = '';
      while (!pat) {
        // In a terminal the token isn't shown as it's typed: the line reader is closed first, so
        // nothing else reads (and echoes) those keys.
        if (input.isTTY) {
          close();
          pat = (await askHidden(input, output, `${bold('Personal access token')} › `)).trim();
        } else pat = (await rl.question(`${bold('Personal access token')} › `)).trim();
      }
      lines.push(`AZDO_PAT=${pat}`);
    }
  } finally {
    close();
  }

  saveEnvSettings(envFile, lines, env);
  output.write(`\n${coral('●')} Saved. ${dim(signIn === 'az' ? 'Keel signs in with az: run az login first if you haven’t.' : 'Starting Keel…')}\n`);
  return 'saved';
}
