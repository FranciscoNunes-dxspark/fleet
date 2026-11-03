// Which parser reads which runner's report, pinned by version: a reporter's format changes between
// major versions, so each runner says which of its versions Drill has been checked against (the
// fixtures in test/fixtures, one per version), and a version outside them is read with the nearest
// one's parser and said so. Pure.
import { parseJest, parseVitest } from './jestlike.js';
import { parseSpec, parseTap } from './nodetest.js';
import { parsePlaywright } from './playwright.js';
import { parseTrx } from './trx.js';

export const RUNNERS = ['vitest', 'jest', 'node', 'playwright', 'dotnet'];

export const RUNNER_NAMES = { vitest: 'Vitest', jest: 'Jest', node: 'node --test', playwright: 'Playwright', dotnet: 'dotnet test' };

// The versions each parser is pinned to: majors, except Playwright's, whose format moves with its
// minor versions (1.40 and on). dotnet test's TRX is the test platform's, whatever the SDK.
export const PINS = {
  vitest: { versions: [1, 2, 3], parse: parseVitest, format: 'JSON reporter' },
  jest: { versions: [29, 30], parse: parseJest, format: '--json' },
  node: { versions: [22], parse: parseTap, format: 'TAP', spec: parseSpec },
  playwright: { versions: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49], minor: true, parse: parsePlaywright, format: 'JSON reporter' },
  dotnet: { versions: null, parse: parseTrx, format: 'TRX' },
};

/** A version's major (or for Playwright its minor) number, or null. */
function step(runner, version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return null;
  return PINS[runner]?.minor ? (Number(m[1]) === 1 ? Number(m[2]) : 1000) : Number(m[1]);
}

/**
 * The parser for `runner` at `version` (null when it couldn't be told): { parse, pin, note }. `pin`
 * names the version read as ("Vitest 3", "Playwright 1.49"); `note` says when that isn't the version
 * the project has.
 */
export function parserFor(runner, version) {
  const p = PINS[runner];
  if (!p) throw new Error(`Drill doesn't run ${runner}.`);
  const name = RUNNER_NAMES[runner];
  if (!p.versions) return { parse: p.parse, pin: `${name} (${p.format})`, note: null };
  const label = (v) => (p.minor ? `1.${v}` : String(v));
  const want = step(runner, version);
  if (want == null) return { parse: p.parse, pin: `${name} ${label(p.versions.at(-1))}`, note: version ? null : `Couldn't tell which ${name} this is: reading it as ${name} ${label(p.versions.at(-1))}.` };
  if (p.versions.includes(want)) return { parse: p.parse, pin: `${name} ${label(want)}`, note: null };
  const nearest = want > p.versions.at(-1) ? p.versions.at(-1) : p.versions[0];
  // Playwright past 1.49 has kept its JSON report as it was: read it as 1.49's, quietly.
  if (p.minor && want > nearest && want < 1000) return { parse: p.parse, pin: `${name} 1.${nearest}`, note: null };
  return { parse: p.parse, pin: `${name} ${label(nearest)}`, note: `${name} ${version} is newer than the ${name} ${label(nearest)} Drill knows: reading its report as that one's.`.replace('newer', want > nearest ? 'newer' : 'older') };
}
