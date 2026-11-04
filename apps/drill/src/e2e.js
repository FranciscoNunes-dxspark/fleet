// Before end-to-end tests: is the app they test up? Bosun runs the project's dev server, and Drill never
// starts a copy of its own. Bosun keeps its crew to itself (its recordings are its own format), so Drill
// asks the app's address directly, with a plain request, and adds what Bosun's mood says (the family's
// moods, readMoods), which names how many of its processes run. Pure, but for `checkApp`'s request.

/**
 * Whether something answers at `url`: { up, status?, error? }. Any HTTP answer counts, a 404 or a 500
 * too (the server is there, which is what the tests need); a refused connection or a timeout doesn't.
 */
export async function checkApp(url, { fetchImpl = fetch, timeout = 3000, signal } = {}) {
  const own = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, own]) : own;
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: both });
    // The body isn't wanted; let it go.
    res.body?.cancel?.().catch?.(() => {});
    return { up: true, status: res.status };
  } catch (e) {
    const code = e?.cause?.code ?? e?.code;
    return { up: false, error: own.aborted ? `no answer in ${timeout / 1000}s` : code === 'ECONNREFUSED' ? 'connection refused' : String(e?.cause?.message ?? e?.message ?? e).split('\n')[0] };
  }
}

/** What Bosun's mood says, for the note (its reason: "all 3 running", "api crashed"), or null when it has said nothing lately. */
export function bosunSays(moods) {
  const m = (moods ?? []).find((x) => x.app === 'bosun');
  return m ? `Bosun ${m.mood === 'happy' ? 'says' : `is ${m.mood}`}: ${m.reason}` : null;
}

/** The sentence when the app isn't up: where it was asked, why not, what Bosun says, and what to do. */
export function appDown(url, check, moods) {
  const said = bosunSays(moods);
  return [
    `The app at ${url} isn't answering (${check.error ?? 'no answer'}), so the end-to-end tests weren't run.`,
    said ? `${said}.` : 'Bosun has said nothing lately.',
    'Start it in Bosun, then run them again: Drill doesn\'t start a copy of its own.',
  ].join(' ');
}
