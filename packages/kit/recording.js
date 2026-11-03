// Recording a runbook: while Fleet records (ctrl+b R), each app adds the prompt lines it runs (slash
// commands, and the family:v1 lines it takes) to one file in the family's folder, so Fleet can save
// them as a runbook whose steps run. Recording is on while ~/.family/recording.json exists; it says
// which project, and since when. A line starting `!` (a shell command, raw SQL or git) is never kept,
// and every line goes through redactSecrets, as the activity log's do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { familyDir, redactSecrets } from './family.js';

const STATE = 'recording.json';
const LINES = 'recording.jsonl';

/** What's being recorded: { project, since } or null. */
export function recordingState({ home = familyDir() } = {}) {
  try {
    return JSON.parse(readFileSync(join(home, STATE), 'utf8'));
  } catch {
    return null;
  }
}

/** Starts recording for `project` (a folder), forgetting what an earlier recording kept. */
export function startRecording(project, { home = familyDir(), now = Date.now() } = {}) {
  mkdirSync(home, { recursive: true });
  rmSync(join(home, LINES), { force: true });
  writeFileSync(join(home, STATE), JSON.stringify({ project: resolve(project), since: now }));
}

/** Stops recording: the lines kept ([{ at, app, line }], oldest first), and nothing recorded after. */
export function stopRecording({ home = familyDir() } = {}) {
  const lines = recordedLines({ home });
  rmSync(join(home, STATE), { force: true });
  rmSync(join(home, LINES), { force: true });
  return lines;
}

/** The lines recorded so far, oldest first. */
export function recordedLines({ home = familyDir() } = {}) {
  let text = '';
  try {
    text = readFileSync(join(home, LINES), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Each app calls this with every prompt line it runs (after it's run, not as it's typed). Kept only
 * while recording, and only a slash command or a /take line; never throws.
 */
export function recordCommand(app, line, { home = familyDir(), now = Date.now() } = {}) {
  try {
    const text = String(line ?? '').trim();
    if (!text.startsWith('/') || !existsSync(join(home, STATE))) return;
    appendFileSync(join(home, LINES), JSON.stringify({ at: now, app, line: redactSecrets(text).slice(0, 2000) }) + '\n');
  } catch {}
}
