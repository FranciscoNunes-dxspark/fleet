// Spoke, Helm's ship's cat: only the one-line face and what it says, as there is no room for a drawing.

/** Who the pet is; the mood lines say it from here. */
export const PET = { name: 'Spoke', kind: "ship's cat" };

/** A one-line face for the top line and the status line. */
export const FACES = {
  idle: '(=•.•=)',
  look: '(=◔.◔=)',
  happy: '(=^.^=)',
  worried: '(=◉.◉=)',
  sleep: '(=-.-=)',
};

/**
 * How the pet feels right now: `state` is { running, none (no PowerShell) }, `last` the newest result
 * { ok, at } (a run that wrote an error, or one that was stopped, is not ok).
 */
export function moodFor({ state = {}, last, now = Date.now() }) {
  if (state.none) return 'sleep';
  if (state.running) return 'look';
  if (last && !last.ok && now - last.at < 8000) return 'worried';
  if (last?.ok && now - last.at < 4000) return 'happy';
  return 'idle';
}

/** A sentence for the welcome line. */
export function moodLine(mood, state = {}) {
  if (state.none) return `${PET.name} is curled up: no PowerShell found. Install pwsh (PowerShell 7).`;
  return `${PET.name} the ${PET.kind} here. F5 runs the script, F1 lists the keys.`;
}
