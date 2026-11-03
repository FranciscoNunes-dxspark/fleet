# Lantern

<img src="assets/logo.svg" alt="Flit, the Lantern moth" width="96" align="right">

A web page audited in the terminal. Lantern opens a URL in a headless Chrome, measures it and lists what is wrong, worst first, the way Bilge lists vulnerable packages: Core Web Vitals, what the page weighs and what holds up its first paint, accessibility with [axe-core](https://github.com/dequelabs/axe-core), the SEO basics, broken links and console errors, and the security headers, cookies and certificate. It puts the same page in two environments side by side ("staging LCP is 1.8 s, prod 2.9 s"), shows its requests as a waterfall, and checks the domains the pages are on: DNS, redirects, https and the certificate's days left.

It drives a Chrome, Edge or Chromium already on the machine over the DevTools protocol; nothing is bundled and there's no Puppeteer. Without one it says so plainly and still runs everything that needs no browser: the headers, the certificate, the domains, and what the page's HTML says.

```
lantern                         # this folder's pages (lantern.json, .fleet/project.json)
lantern --demo                  # a made-up shop and its staging copy: nothing is fetched
lantern audit https://shop.example/ --fail-on a11y:serious,perf:lcp>2.5s
lantern audit --sarif lantern.sarif      # every page of the chosen environment, SARIF for code scanning
lantern security --json         # headers, cookies, mixed content, source maps, certificates: the family's security JSON
lantern domains shop.example    # DNS, redirects from http:// and the bare domain, https, the certificate
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder.

Lantern is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/lantern`), or download the executable from the releases.

## The pages

The pages to audit come from two places, both read on opening and with `/pages`:

- `lantern.json` in the folder: `{ "pages": ["https://shop.example/", { "name": "checkout", "url": "https://shop.example/checkout" }], "domains": ["shop.example"] }` (`domains` adds hosts to the Domains view).
- The project's environments in `.fleet/project.json`, the file every app of the family reads: each environment's `lantern` section names its page, `{ "url": "https://staging.shop.example/" }`, or several, `{ "urls": [ … ] }`. Each page is listed with its environment, and Compare pairs a page with the same path in another environment.

```json
{
  "default": "staging",
  "environments": {
    "staging": { "lantern": { "url": "https://staging.shop.example/" } },
    "prod": { "prod": true, "lantern": { "urls": ["https://shop.example/", "https://shop.example/checkout"] } }
  }
}
```

`/open <url>` audits any other page and keeps it in the list for the session. The last three audits of each page are kept in `~/.lantern/runs.json`, so the list shows the last numbers on opening and Compare can set today's against the last time's.

## What it checks

| Category | What | Rules |
|---|---|---|
| Performance | Core Web Vitals in the lab: LCP, CLS, INP (from a scripted click and key), TTFB, and FCP, against Google's thresholds (needs improvement is medium, poor is high) | `lcp-slow`, `cls-high`, `inp-slow`, `ttfb-slow`, `fcp-slow` |
| | What the page weighs over the wire (over 3 MB, or 1 MB of JavaScript) | `page-heavy`, `script-heavy` |
| | Scripts in `<head>` without `async`/`defer`, and stylesheets, that block the first paint | `render-blocking` |
| | Images without `width` and `height` (they shift the page), JPEG, PNG or GIF over 100 kB (WebP or AVIF would be a quarter to half) | `image-no-dimensions`, `image-old-format` |
| Accessibility | axe-core run in the page: each violation with its element's selector, the WCAG criterion and the fix. axe's impact critical, serious, moderate, minor is shown as CRIT, HIGH, MED, LOW | axe's rule ids (`color-contrast`, `image-alt`…) |
| SEO and basics | The title (missing, or not 10 to 60 characters), meta description, canonical link, `noindex`, `lang` on `<html>`, the viewport tag, an `<h1>` | `title-missing`, `title-length`, `description-missing`, `canonical-missing`, `noindex`, `lang-missing`, `viewport-missing`, `h1-missing` |
| | Links on the page that answer 404, 410 or 5xx, or nothing (the same site's first, forty at most; a HEAD each) | `broken-link` |
| | Errors in the console and uncaught exceptions while it loaded | `console-error` |
| Security | Content-Security-Policy, Strict-Transport-Security (and under 180 days), X-Content-Type-Options, frame protection (X-Frame-Options or CSP `frame-ancestors`), Referrer-Policy | `csp-missing`, `hsts-missing`, `hsts-short`, `xcto-missing`, `framing-allowed`, `referrer-policy-missing` |
| | Cookies without Secure, a session's without HttpOnly, without SameSite (never their values) | `cookie-not-secure`, `cookie-not-httponly`, `cookie-no-samesite`, `cookie-samesite-none-insecure` |
| | `Server` with a version, `X-Powered-By` and ASP.NET's version headers | `server-version`, `powered-by` |
| | An https page loading scripts, styles, frames (medium) or images (low) over http | `mixed-content` |
| | Source maps served in production: a script's `sourceMappingURL` that answers with a map, an inline one, or a `.map` beside it that does | `source-map-served` |
| | The certificate: expired, under 30 days left (high under 7), not naming the host, self-signed, untrusted; plain http not sent to https | `cert-expired`, `cert-expiring`, `cert-hostname-mismatch`, `cert-self-signed`, `cert-untrusted`, `no-https-redirect` |

Lab numbers are noisy: each page is measured three times (`/runs` changes it) and the median shown, labelled as lab numbers. They come from one headless Chrome on one machine, at a desktop size, with the cache off, not from visitors (field data).

The security checks are the kit's (`@fleet/kit/webchecks.js`), the same as Sonar's `/domains`: they need no browser.

## Views

`1` Pages · `2` Findings · `3` Compare · `4` Waterfall · `5` Domains · `6` Log. `tab` goes round. Nothing is audited on opening: `a` audits the page under the cursor.

### Pages

Each page with its environment (the chosen one's in the accent), its name and URL, and its last audit: LCP, CLS and INP coloured by Google's thresholds (green good, yellow needs improvement, red poor), and its findings by severity.

| Key | |
|---|---|
| `↵` or `l` | Its findings (auditing it first when it hasn't been) |
| `a` | Audit it: three runs in a headless Chrome, axe-core on the last, its links, headers and certificate |
| `alt+a` | Audit every page |
| `s` | Only the security checks (no browser needed), shown as text |
| `c` | Compare it with the same page in another environment |
| `w` | Its requests, in the Waterfall |
| `o` | Open it in the browser |
| `t` | Copy it as a `page` context (its URL and how many findings), for another Lantern's (or Fleet's) `/take` |
| `y` | Copy its URL |

### Findings

Everything found on the selected page, worst first: severity, category, what, and the element's selector (or the rule). Above the list, its lab numbers, or why there are none.

| Key | |
|---|---|
| `↵` or `l` | What it is, the element (and the others like it), the WCAG criterion, what was seen, why it matters and the fix |
| `f` | Category: all, performance, accessibility, SEO and basics, security |
| `s` | Severity: all, or critical, high, medium, low and worse |
| `x` | Ignore this rule on this page (asks; kept in the settings as `ignore`, `rule:url`; `/unignore` puts it back) |
| `o` | Open axe's page on the rule, or the URL it is about |
| `y` | Copy the element's selector (or the URL) |
| `a` | Audit the page again |

### Compare

The same page in two environments, or two runs of it, side by side: a sentence ("staging LCP is 1.8 s, prod 2.9 s; INP <16 ms against 240 ms"), then each vital, the weight, the requests and the findings by category, with the change from one to the other (red worse, green better).

| Key | |
|---|---|
| `e` | The other side: the next environment |
| `p` | The previous run of the selected page against its latest |
| `a` | Audit both sides again |
| `y` | Copy the comparison |

`/compare prod` compares the selected page with prod's, `/compare staging prod` the two, `/compare <url> <url>` any two pages, `/compare last` the last two runs.

### Waterfall

The selected page's requests in the order they went: status, type, name, size, and a bar from when each started to when it finished, on one scale; `▼` marks LCP. A redirect is a row of its own.

| Key | |
|---|---|
| `↵` | Hand the request to Hail as a `request` context (method and URL, what came back; no headers, as the browser's carried cookies) |
| `l` | What it was: status, type, size, timing |
| `o` | Open it in the browser |
| `y` | Copy its URL |

### Domains

The hosts the pages are on (and `lantern.json`'s `domains`), each checked by `/domains` (or `r` here): its address or CNAME, whether https is enforced, the certificate's days left and what was found.

| Key | |
|---|---|
| `↵` or `l` | Its records (A, AAAA, CNAME, CAA, MX), the redirects from `http://` and from the bare domain (`www.` taken off), https, the certificate, and the findings |
| `r` | Check them all again |
| `y` | Copy the host |

| Rule | |
|---|---|
| `missing-caa` (low) | No CAA record on the host or a parent: any CA may issue certificates for it |
| `dns-no-address` (high) | No A, AAAA or CNAME record |
| `dangling-cname` (high) | A CNAME to a name that no longer resolves: whoever claims it serves your domain |
| `no-https-redirect` (high) | `http://` doesn't end on https |
| `https-unreachable` (high) | https doesn't answer at all |
| `redirect-downgrade` (medium) | A redirect from https back to http |
| `redirect-chain-long` (low) | More than three redirects before the page |
| `bare-domain-unreachable` (low) | The domain without `www.` doesn't answer |
| `cert-expiring`, `cert-expired`… | As the page's certificate checks |

## Commands

| Command | |
|---|---|
| `/audit [page\|url\|all]` | Audit a page (the selected one), a URL, or every page |
| `/open <url>` | Audit a URL the folder doesn't name |
| `/security [page\|url]` | Only the checks that need no browser |
| `/domains [host]` | The domain checks, for every host or one |
| `/compare [a] [b\|last]` | The Compare view on two environments, two URLs, or the last two runs |
| `/pages` | Read the pages again |
| `/unignore [rule\|all]` | Put an ignored finding back |
| `/chrome [path\|auto]` | The browser to drive; alone, which was found (`LANTERN_CHROME` names one too) |
| `/runs [n]` | How many times each page is measured (3) |
| `/sarif [file]` | Every audited page's findings as SARIF |
| `/report [file]` | The audited pages as Markdown |
| `/env [name]` | The project's environment; a name switches every app (and selects its page here) |
| `/take <context>` | A `page` context: its URL, audited |
| `/move [folder]` | Another folder's pages |
| `/run <command>`, `!` | A shell command in the folder |
| `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/last`, `/help`, `/quit` | As in every app of the fleet |

## In a pipeline

```
lantern audit [url…|folder] [--runs n] [--fail-on terms] [--json] [--sarif [file]] [--env name|--all] [--no-links]
lantern security [url…|folder] [--fail-on level] [--json] [--sarif [file]]
lantern domains [host…|folder] [--fail-on level] [--json] [--sarif [file]]
```

With no URL, the folder's pages: the chosen environment's when the pages name environments (`--env` another, `--all` every one), and `lantern.json`'s.

`lantern audit --fail-on` takes comma-separated terms, any of which fails the run (exit 1): a level for every finding (`high`, the default), a category at a level (`a11y:serious`, `security:medium`, `seo:low`; axe's critical, serious, moderate, minor are critical, high, medium, low), or a lab metric past a value (`perf:lcp>2.5s`, `perf:cls>0.1`, `perf:inp>200ms`, `perf:ttfb>800ms`, `perf:weight>2mb`). `none` never fails. `--json` gives each page's vitals, every run's numbers (`samples`), the weight, the findings and what failed.

`lantern security --json` and `lantern domains --json` print the family's security JSON (`{ app, check, target, at, counts, findings }`, `domains` adding a summary per host), which `fleet security` adds up. `--sarif` writes SARIF for GitHub's or Azure DevOps' code scanning; each finding is about a URL, so it points at the repository's root with the URL in its message. Exit codes: 0 fine, 1 failing, 2 couldn't run.

## Settings

`~/.lantern/config.json` (`LANTERN_HOME` moves it): `theme`, `accent`, `mouse`, `chrome` (a browser's path), `runs`, `checkLinks` (`false` sends no request to a page's links), `ignore` (`rule` or `rule:url`), `checkForUpdates`, `autoUpdate`, `familyMoods`. `/settings` shows them.

## The family

Lantern takes a `page` context (`/take`, or pasted): it audits that URL. `t` on a page copies one, with how many findings it has. `↵` in the Waterfall hands a request to Hail. Audits and domain checks go to the family's activity log (the URL and the counts); Flit the moth's mood to the others. `/env` switches the whole family's environment.
