// Everything Lantern reads and does goes through one object: `createLantern()` here for real pages,
// demo.js's `demoLantern()` with the same interface for --demo and the tests.
//
//   pages(dir)                       the pages and hosts a folder names (pages.js)
//   browser({ override })         the Chrome found ({ path }) or null
//   audit(url, { runs, override, signal, onProgress, name, env })   a page's result (audit.js's assemble)
//   security(url, { signal })        the kit's checkSite: headers, cookies, certificate, mixed content, source maps
//   domain(host, { signal })         the kit's checkDomain: DNS, redirects, https, the certificate
//   run(command, { cwd, signal })    a shell command (! and /run)
//   writeFile(path, text)
//
// Without a browser, `audit` still runs the security checks and reads the HTML for the basics, and its
// result says why there are no lab numbers.
import { writeFileSync } from 'node:fs';
import { run as runCommand } from '@fleet/kit/run.js';
import { checkDomain, checkSite, fetchPage, redirectChain } from '@fleet/kit/webchecks.js';
import { assemble, isBroken, linksToCheck } from './audit.js';
import { runPage } from './browser.js';
import { connectCdp } from './cdp.js';
import { findChrome, launchChrome } from './chrome.js';
import { htmlFacts } from './html.js';
import { readPages } from './pages.js';

export const NO_BROWSER = 'No Chrome, Edge or Chromium on this machine (or at the path in the settings): no lab numbers or accessibility check, only what the page\'s headers, certificate and HTML say. Install one, or /chrome <path>.';

/** axe-core's source, to put in the page: the package's own `source`, which the Bun build carries inside the executable. */
export async function axeSource() {
  const mod = await import('axe-core');
  return (mod.default ?? mod).source;
}

/** Runs `jobs` (functions returning promises) `n` at a time; resolves their results in order. */
async function pool(jobs, n) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

/** The links of a page that are broken (audit.js's isBroken): HEAD, then GET where HEAD isn't allowed. */
export async function checkLinks(links, { fetchImpl = globalThis.fetch, signal, timeout = 6000 } = {}) {
  const results = await pool(
    links.map((url) => async () => {
      let res = await fetchPage(url, { fetchImpl, method: 'HEAD', signal, timeout });
      if (res.status === 405 || res.status === 501 || res.status === 403) res = await fetchPage(url, { fetchImpl, signal, timeout });
      return { url, status: res.status ?? null, ...(res.error ? { error: res.error } : {}) };
    }),
    6,
  );
  return { checked: links.length, broken: results.filter(isBroken) };
}

export function createLantern({ fetchImpl = globalThis.fetch, resolver, probe, find = findChrome, launch = launchChrome, connect = connectCdp, axe = axeSource, now = () => Date.now() } = {}) {
  const web = { fetchImpl, ...(probe ? { probe } : {}) };
  return {
    name: 'real',
    pages: (dir) => readPages(dir),
    browser({ override } = {}) {
      const path = find({ override });
      return path ? { path } : null;
    },
    async audit(url, { runs = 3, override, signal, onProgress = () => {}, name, env, links: wantLinks = true } = {}) {
      const browser = find({ override });
      onProgress('checking headers and the certificate');
      const security = await checkSite(url, { ...web, signal });
      const raw = [];
      let facts = null;
      let note;
      if (browser) {
        const chrome = await launch(browser);
        let client;
        try {
          client = await connect(chrome.wsUrl);
          const source = await axe();
          for (let i = 0; i < runs; i++) {
            onProgress(`run ${i + 1} of ${runs} in Chrome`);
            // axe-core goes in on the last run only: it is big, and the vitals of the others stay clean of it.
            raw.push(await runPage(client, url, { signal, axeSource: i === runs - 1 ? source : null }).catch((e) => {
              if (signal?.aborted) throw e;
              return { error: e.message };
            }));
          }
        } finally {
          client?.close();
          chrome.close();
        }
      } else {
        note = NO_BROWSER;
        const end = (await redirectChain(url, { fetchImpl, signal })).at(-1);
        if (end?.res?.body) facts = htmlFacts(end.res.body, end.url);
      }
      const pageFacts = raw.find((r) => !r.error)?.facts ?? facts;
      let links = null;
      if (wantLinks && pageFacts?.links?.length) {
        onProgress('checking the links');
        links = await checkLinks(linksToCheck(pageFacts.links, url), { fetchImpl, signal });
      }
      return assemble({ url, name, env, runs: raw, facts, links, security, chrome: browser ?? null, note, at: now() });
    },
    security: (url, { signal } = {}) => checkSite(url, { ...web, signal }),
    domain: (host, { signal } = {}) => checkDomain(host, { ...web, ...(resolver ? { resolver } : {}), signal }),
    run: (command, opts) => runCommand(command, opts),
    writeFile: (path, text) => writeFileSync(path, text),
  };
}
