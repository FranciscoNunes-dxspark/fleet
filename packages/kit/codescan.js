// Bilge's Code view and `bilge code`, and Splice's look through a repository's history: a look through a folder's own files, not its packages, for what an
// attacker would look for first: secrets written into the code, code that runs what it's given (eval,
// a shell, SQL built from strings), TLS checks turned off, unsafe deserialisation, a Dockerfile that
// runs as root, a .env that git would commit, a workflow that puts an issue's title into a shell. It is
// a static read with patterns, no more: it runs nothing and sends nothing anywhere.
//
// Everything is pure but `scanCode`, which walks the disk. A secret that's found is never kept: a
// finding's `excerpt` has it cut down to its first characters (`redact`), so neither the view, the
// report, the JSON nor the family's log ever holds one.
//
// bilge-ignore-file: the rules below name what they look for.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { rank } from './osv.js';

// Folders that aren't the project's own code: installed packages, builds, tools' caches.
export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', 'vendor', '.next', '.nuxt', '.output', 'target', '__pycache__', '.venv', 'venv', '.terraform', '.idea', '.vs', '.vscode', '.gradle', '.cache', '.yarn', '.pnpm-store', 'bower_components', 'jspm_packages', 'TestResults']);
// Files read for their bytes, not their text, and lock files (their integrity hashes look like keys).
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|dll|exe|so|dylib|o|a|lib|pdb|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|sqlite3?|db|bin|dat|nupkg|snupkg|map)$/i;
const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'packages.lock.json', 'composer.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum']);
const MAX_BYTES = 512 * 1024;
const MAX_LINE = 2000;
export const MAX_FILES = 20000;

const JS = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro)$/i;
const CS = /\.(cs|vb|fs)$/i;
const PY = /\.py$/i;
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|cs|vb|fs|py|rb|php|go|java|kt|scala|rs|swift|ps1|psm1|sh|bash|zsh)$/i;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)azure-pipelines[^/]*\.ya?ml$/i;
const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[^/]*)?$|\.dockerfile$/i;
const TESTISH = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__fixtures__|testdata|mocks?|__mocks__|examples?|samples?|demo)\/|\.(test|spec|stories)\.[^/]+$|(^|\/)demo\.[^/]+$/i;

// A value that only stands in for a secret: a variable, a template's hole, an obvious example.
const PLACEHOLDER = /^(\$\{|\$\(|\{\{|<|%|\$[A-Z_]|process\.env|os\.environ|env\(|Environment\.|Configuration\[|config\.|settings\.|xx+|\*+|\.\.\.|your|my[-_]?|example|placeholder|dummy|sample|redacted|replace|change[-_]?me|todo|none|null|undefined|true|false|password|secret|test|fake|foo|bar)/i;
const placeholder = (v) => !v || PLACEHOLDER.test(v) || /^(.)\1+$/.test(v);

/** `secret` cut to its first characters, so a finding shows which one without holding it. */
export const redact = (secret) => (secret.length <= 6 ? '•'.repeat(secret.length) : `${secret.slice(0, 4)}${'•'.repeat(Math.min(8, secret.length - 4))}`);

// ——— Frontend environment leaks ———
//
// A bundler inlines every variable with one of these prefixes into the JavaScript it sends to the
// browser (Vite's import.meta.env, Next's and Nuxt's public config, Create React App, Expo, Gatsby,
// Vue CLI, Storybook, SvelteKit's and Astro's public env): its value is read by anyone who opens the
// site's sources. A secret in one has leaked as soon as the site is built.

/** The prefixes a bundler inlines into the browser's code, longest first (NEXT_PUBLIC_ before PUBLIC_). */
export const FRONTEND_PREFIXES = ['NEXT_PUBLIC_', 'NUXT_PUBLIC_', 'EXPO_PUBLIC_', 'REACT_APP_', 'STORYBOOK_', 'VUE_APP_', 'GATSBY_', 'VITE_', 'PUBLIC_'];
const FE = `(?:${FRONTEND_PREFIXES.join('|')})`;
/** The prefix of `name` a bundler inlines (`VITE_`), or null. */
export const frontendPrefix = (name) => FRONTEND_PREFIXES.find((p) => String(name ?? '').startsWith(p)) ?? null;

// Names that say a secret, in what follows the prefix (VITE_STRIPE_SECRET_KEY → STRIPE_SECRET_KEY).
const SECRET_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|PWD|SERVICE_?ROLE|CREDENTIAL|SIGNING_?KEY|MASTER_?KEY|ADMIN_?(?:KEY|TOKEN)|AUTH_?TOKEN|REFRESH_?TOKEN|BEARER/i;
// Names that say an identifier or an address, public by nature: for the entropy test, never against a known key format.
const PUBLIC_NAME = /PUBLISHABLE|ANON|SITE_?KEY|DSN|MEASUREMENT|SEARCH_?(?:ONLY_?)?(?:API_?)?KEY|PUBLIC_?KEY|(?:^|_)(?:ID|URL|URI|HOST|DOMAIN|ORIGIN|ENDPOINT|PATH|VERSION|SHA|COMMIT|HASH|BUILD|ENV|MODE|REGION|BUCKET|NAME|LOCALE)$/i;

const JWT = /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const jwtRole = (v) => {
  if (!JWT.test(v)) return null;
  try {
    return JSON.parse(Buffer.from(v.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))?.role ?? null;
  } catch {
    return null;
  }
};

/**
 * Keys made to be in the browser, never a leak however they look: `{ id, title, why, test(name, value) }`.
 * Each one's secret half (Stripe's sk_, Supabase's service_role key, Mapbox's sk.) is still a leak.
 */
export const PUBLIC_BY_DESIGN = [
  { id: 'publishable-key', title: 'Stripe or Clerk publishable key', why: 'pk_live_ and pk_test_ keys are made for the browser; the secret half is the sk_ one.', test: (n, v) => /^pk_(?:live|test)_/.test(v) },
  { id: 'google-browser-key', title: 'Firebase web or Google Maps browser key', why: 'It names the project to Google and every visitor sends it; restrict it to your sites (HTTP referrers) and its APIs in the Cloud console.', test: (n, v) => /^AIza[0-9A-Za-z_-]{35}$/.test(v) },
  { id: 'supabase-anon', title: 'Supabase anon or publishable key', why: 'Row-level security guards the data from it; the service_role (or sb_secret_) key is the one to keep out.', test: (n, v) => /^sb_publishable_/.test(v) || jwtRole(v) === 'anon' },
  { id: 'sentry-dsn', title: 'Sentry DSN', why: 'A DSN only lets a client send events to its project.', test: (n, v) => /^https?:\/\/[0-9a-f]{32}@[\w.-]+(?::\d+)?\/\d+$/i.test(v) },
  { id: 'mapbox-public', title: 'Mapbox public token', why: 'pk. tokens are made for the browser (restrict them to your sites in Mapbox); sk. tokens are secret.', test: (n, v) => /^pk\.eyJ/.test(v) },
  { id: 'posthog-project', title: 'PostHog project key', why: 'A phc_ key only sends events; the personal phx_ key is secret.', test: (n, v) => /^phc_/.test(v) },
  { id: 'site-key', title: 'reCAPTCHA, Turnstile or hCaptcha site key', why: 'The site key goes in the page; its secret key stays on the server.', test: (n) => /SITE_?KEY$/i.test(n) },
  { id: 'search-only-key', title: 'Algolia or Meilisearch search-only key', why: 'A search-only key can only search the indexes it was given.', test: (n) => /SEARCH_?(?:ONLY_?)?(?:API_?)?KEY$/i.test(n) },
];

// Values some services hand out as secrets, which the general rules leave to their context.
const SECRET_VALUES = [
  { title: 'Supabase service_role key', test: (v) => /^sb_secret_/.test(v) || jwtRole(v) === 'service_role' },
  { title: 'Stripe secret key', test: (v) => /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/.test(v) },
  { title: 'Mapbox secret token', test: (v) => /^sk\.eyJ/.test(v) },
  { title: 'PostHog personal key', test: (v) => /^phx_/.test(v) },
];

// A value that only refers to another: a workflow's ${{ secrets.X }}, a shell's $X or ${X}, process.env.X.
const REFERENCE = /^(?:\$\{\{\s*(secrets|vars|env|inputs|steps|needs|github)\.([\w.-]+)\s*\}\}|\$\{([A-Za-z_]\w*)(?:[:?-][^}]*)?\}|\$([A-Za-z_]\w*)|(?:process\.env|import\.meta\.env)\.([A-Za-z_]\w*)|%([A-Za-z_]\w*)%)/;

/** `what` after a or an, as it is said (an AWS key, an npm token, a Stripe key). */
const aOrAn = (what) => `${/^(?:[aeiou]|npm\b)/i.test(what) ? 'an' : 'a'} ${what}`;

/** Shannon entropy of `v`, in bits a character. */
const entropy = (v) => {
  const n = new Map();
  for (const c of v) n.set(c, (n.get(c) ?? 0) + 1);
  let e = 0;
  for (const k of n.values()) e -= (k / v.length) * Math.log2(k / v.length);
  return e;
};

/** Whether `v` reads as made by a random generator: long, a key's alphabet only, mixed case and digits, high entropy; or 32+ hex digits that aren't a UUID. */
export function looksRandom(v) {
  const s = String(v ?? '');
  if (s.length < 20 || s.length > 1024 || !/^[A-Za-z0-9+/=_.~-]+$/.test(s)) return false;
  if (/^[0-9a-f-]+$/i.test(s)) return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) && s.replace(/-/g, '').length >= 32 && entropy(s) >= 3.4;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length;
  return classes >= 3 && entropy(s) >= Math.min(4, Math.log2(s.length) - 0.5);
}

/**
 * Whether a variable the bundler sends to the browser holds a secret. Pure, and the one judge for
 * every app (Bilge's Code view through the `frontend-secret` rule, Locker's key table and hygiene,
 * Ballast's look at built files). `name` is the variable (`VITE_STRIPE_KEY`), `value` as written
 * (quotes taken off; a reference such as `${{ secrets.X }}` or `process.env.X` is judged by what it
 * names). Null when the name has no browser prefix, or the value is empty, a placeholder or a key made
 * to be public (`PUBLIC_BY_DESIGN`); otherwise `{ prefix, name, reason, what }`: `reason` is `shape`
 * (a known key format), `reference` (fed from a secret), `name` (named like a secret) or `entropy`
 * (random enough to be a key), `what` a few words for it. The value is never in the answer.
 */
export function frontendLeak(name, value) {
  const n = String(name ?? '').trim();
  const prefix = frontendPrefix(n);
  if (!prefix) return null;
  const rest = n.slice(prefix.length);
  let v = String(value ?? '').trim();
  if (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  if (!v) return null;
  const said = (reason, what) => ({ prefix, name: n, reason, what });
  const ref = REFERENCE.exec(v);
  if (ref) {
    const named = ref[2] ?? ref[3] ?? ref[4] ?? ref[5] ?? ref[6] ?? '';
    if (PUBLIC_NAME.test(named) || PUBLIC_NAME.test(rest) || PUBLIC_BY_DESIGN.some((p) => p.test(n, '') || p.test(named, ''))) return null;
    if (ref[1] === 'secrets') return said('reference', `a value from the pipeline's secrets (${named})`);
    if (SECRET_NAME.test(named) || SECRET_NAME.test(rest)) return said('reference', `a value from ${named}, named like a secret`);
    return null;
  }
  if (placeholder(v) || /\$\{|\{\{|^<.*>$/.test(v)) return null;
  if (PUBLIC_BY_DESIGN.some((p) => p.test(n, v))) return null;
  const known = SECRET_VALUES.find((s) => s.test(v));
  if (known) return said('shape', aOrAn(known.title));
  for (const r of secretShapes()) {
    const m = r.pattern.exec(v);
    // A title starting with a plain word reads in lower case (a password in a URL); a name keeps its capital (a GitHub token).
    if (m && (!r.accept || r.accept(m, v))) return said('shape', aOrAn(r.title.replace(/^(?:Private|Password|Hard-coded|Secret)\b/, (w) => w.toLowerCase())));
  }
  if (SECRET_NAME.test(rest) && v.length >= 6 && !/^\d+$/.test(v) && !/^[a-z]+(?:[._ -][a-z]+)*$/i.test(v)) return said('name', 'a value named like a secret');
  if (!PUBLIC_NAME.test(rest) && !v.includes('://') && looksRandom(v)) return said('entropy', 'a random-looking value, as keys are');
  return null;
}

// The secret-shaped rules that read any text (not the ones for one kind of file), once RULES is made.
let shapes = null;
const secretShapes = () => (shapes ??= RULES.filter((r) => r.kind === 'secret' && !r.files));

// The files that set a browser variable: .env files, and the configs that put one in the build
// (Vite's define, next.config's env, Nuxt's and Astro's configs, Expo's app.json, package.json's
// scripts, a Dockerfile's ARG and ENV, compose's build args and environment, a workflow's env).
const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/;
const FRONTEND_CONFIG = /(^|\/)(?:(?:vite|vitest|next|nuxt|astro|svelte|remix|webpack|rsbuild|rspack|quasar|vue|react-router)\.config\.[mc]?[jt]s|app\.config\.[jt]s|app\.json|eas\.json|package\.json|(?:docker-)?compose[^/]*\.ya?ml|netlify\.toml|vercel\.json|turbo\.json)$/i;
const FRONTEND_FILES = { test: (p) => FRONTEND_CONFIG.test(p) || DOCKERFILE.test(p) || WORKFLOW.test(p) };
const FRONTEND_NEEDS = FRONTEND_PREFIXES.map((p) => p.toLowerCase());
const FRONTEND_WHY = 'The bundler writes this variable into the JavaScript every visitor downloads: anyone can read it in the site\'s sources, so it is no longer a secret.';
const FRONTEND_FIX = 'Keep it on the server: drop the browser prefix and read it in an API route or server function, and rotate it, as every build since it was set has published it. A key made for the browser (a publishable or anon key) is fine here.';

// The rules, each `{ id, kind, severity, title, why, fix, pattern, needs?, files?, secret?, accept?, code?, alongside? }`:
// `pattern` is tried on each line of a file whose path `files` matches (any file without it); `needs`
// are words in lower case one of which every match holds (the line, lowered, is looked through for them
// first, so it must be true of every line the pattern can match: test/codescan.test.js checks it on
// the tests' lines); `secret` is the group holding a secret (0 for the whole match), redacted in the
// excerpt; `accept(m, line)` can turn a match down; `code` rules skip lines that are only a comment;
// an `alongside` secret rule is found besides the line's other secret, not instead of it.
export const RULES = [
  // Secrets: a key or password written into a file is anyone's who can read the repository, and its history keeps it after it's removed.
  { id: 'private-key', kind: 'secret', severity: 'critical', title: 'Private key', needs: ['private key'], pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, secret: 0, why: 'A private key in the repository lets anyone who can read it act as its owner.', fix: 'Remove it, make a new key pair (this one is out), and load the key from a secret store or a file git ignores.' },
  { id: 'aws-key', kind: 'secret', severity: 'critical', title: 'AWS access key', needs: ['akia', 'asia'], pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, secret: 1, why: 'An AWS access key id; its secret is usually close by.', fix: 'Deactivate the key in IAM, make a new one and read it from the environment or a secret store.' },
  { id: 'github-token', kind: 'secret', severity: 'critical', title: 'GitHub token', needs: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'], pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, secret: 1, why: 'A GitHub token acts as the account that made it.', fix: 'Revoke it on GitHub (Settings, Developer settings) and keep the new one in a secret store.' },
  { id: 'anthropic-key', kind: 'secret', severity: 'critical', title: 'Anthropic API key', needs: ['sk-ant-'], pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/, secret: 1, why: 'An API key spends its account\'s money.', fix: 'Delete it in the Console, make a new one and read it from the environment.' },
  { id: 'openai-key', kind: 'secret', severity: 'high', title: 'OpenAI API key', needs: ['sk-'], pattern: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})/, secret: 1, accept: (m) => !m[1].startsWith('sk-ant-'), why: 'An API key spends its account\'s money.', fix: 'Revoke it, make a new one and read it from the environment.' },
  { id: 'stripe-key', kind: 'secret', severity: 'critical', title: 'Stripe live key', needs: ['_live_'], pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})/, secret: 1, why: 'A live Stripe key moves real money.', fix: 'Roll it in the Stripe dashboard and keep the new one in a secret store.' },
  { id: 'slack-token', kind: 'secret', severity: 'high', title: 'Slack token', needs: ['xox'], pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/, secret: 1, why: 'A Slack token reads and posts as its app or user.', fix: 'Revoke it in the app\'s settings and keep the new one in a secret store.' },
  { id: 'slack-webhook', kind: 'secret', severity: 'medium', title: 'Slack webhook', needs: ['hooks.slack.com'], pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,})/, secret: 1, why: 'Anyone with the URL can post into the channel.', fix: 'Remove the webhook in Slack and keep the new URL out of the code.' },
  { id: 'google-key', kind: 'secret', severity: 'high', title: 'Google API key', needs: ['aiza'], pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/, secret: 1, why: 'A Google API key is billed to its project; unrestricted, anyone can use it.', fix: 'Restrict or delete it in the Cloud console and read the new one from configuration.' },
  { id: 'azure-storage-key', kind: 'secret', severity: 'critical', title: 'Azure storage account key', needs: ['accountkey='], pattern: /AccountKey=([A-Za-z0-9+/]{40,}={0,2})/, secret: 1, why: 'An account key is full control of the storage account.', fix: 'Rotate the key in the portal, then use a managed identity or a SAS kept in Key Vault.' },
  { id: 'azure-sas', kind: 'secret', severity: 'high', title: 'Azure SAS token', needs: ['sig='], pattern: /[?&](sig=[A-Za-z0-9%+/]{30,}={0,2})/, secret: 1, accept: (m, line) => /\bsv=|\bse=|\bsp=/.test(line), why: 'A shared access signature grants what it says to anyone holding it, until it expires.', fix: 'Rotate the key that signed it and hand out short-lived SAS tokens at run time.' },
  { id: 'npm-token', kind: 'secret', severity: 'critical', title: 'npm token', needs: ['npm_', '_authtoken='], pattern: /\b(npm_[A-Za-z0-9]{36})\b|_authToken=([A-Za-z0-9_-]{20,})/, secret: 1, accept: (m) => !placeholder(m[1] ?? m[2]), why: 'An npm token can publish the account\'s packages.', fix: 'Revoke it on npmjs.com and use ${NPM_TOKEN} in .npmrc instead.' },
  { id: 'jwt', kind: 'secret', severity: 'medium', title: 'JSON web token', needs: ['eyj'], pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/, secret: 1, why: 'A signed token in the code may still be valid, for whoever finds it.', fix: 'Remove it; if it was real, revoke it or rotate the key that signed it.' },
  { id: 'url-credentials', kind: 'secret', severity: 'high', title: 'Password in a URL', needs: ['://'], pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/"'`]+:([^\s@/"'`]{3,})@[^\s"'`]+/i, secret: 1, accept: (m) => !placeholder(m[1]), why: 'A connection URL with its password in it.', fix: 'Read the password, or the whole URL, from the environment or a secret store.' },
  { id: 'connection-password', kind: 'secret', severity: 'high', title: 'Password in a connection string', needs: ['password', 'pwd'], pattern: /\b(?:Password|Pwd)\s*=\s*([^;"'\s]{4,})/i, secret: 1, accept: (m, line) => /(Server|Data Source|Host|User ?Id|Uid|Database|Initial Catalog)\s*=/i.test(line) && !placeholder(m[1]), why: 'A database password in a connection string.', fix: 'Use integrated or managed-identity sign-in, or read the password from a secret store (user secrets, Key Vault).' },
  { id: 'hardcoded-secret', kind: 'secret', severity: 'medium', title: 'Hard-coded secret', needs: ['password', 'passwd', 'pwd', 'secret', 'api', 'token', 'private'], pattern: /\b[\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[\w-]*["']?\s*(?::=|=>|[:=])\s*["'`]([^"'`\s]{8,})["'`]/i, secret: 1, accept: (m) => !placeholder(m[1]) && !/^[a-z]+(?:[._ -][a-z]+)*$/i.test(m[1]) && !/^[A-Z][A-Z0-9_]+$/.test(m[1]), why: 'A value named like a secret, written into the code.', fix: 'Read it from the environment or a secret store, and rotate it if it was real.' },
  { id: 'docker-secret', kind: 'secret', severity: 'high', title: 'Secret in a Dockerfile', needs: ['password', 'secret', 'token', 'api', 'private'], files: DOCKERFILE, pattern: /^\s*(?:ENV|ARG)\s+[\w]*(?:PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)[\w]*(?:\s*=\s*|\s+)(\S+)/i, secret: 1, accept: (m) => !placeholder(m[1].replace(/^["']|["']$/g, '')), why: 'ENV and ARG values are kept in the image\'s layers and history, for anyone who pulls it.', fix: 'Pass it at run time, or use a build secret (RUN --mount=type=secret).' },
  // A secret in a variable the bundler sends to the browser (frontendLeak judges it). It is a leak of
  // its own, so it is found alongside the line's other secret: a Stripe key in a committed .env is in
  // the repository and, under VITE_, in every visitor's browser too.
  { id: 'frontend-secret', kind: 'secret', severity: 'high', title: 'Secret in a browser variable', alongside: true, needs: FRONTEND_NEEDS, files: ENV_FILE, pattern: new RegExp(`^\\s*(?:export\\s+)?(${FE}[A-Za-z0-9_]*)\\s*=\\s*(["'\`]?)(.*?)\\2\\s*(?:#.*)?$`), secret: 3, accept: (m) => Boolean(frontendLeak(m[1], m[3])), why: FRONTEND_WHY, fix: FRONTEND_FIX },
  { id: 'frontend-secret', kind: 'secret', severity: 'high', title: 'Secret in a browser variable', alongside: true, needs: FRONTEND_NEEDS, files: FRONTEND_FILES, pattern: new RegExp(`(?<![\\w$])(?:import\\.meta\\.env\\.|process\\.env\\.)?(${FE}[A-Za-z0-9_]*)["'\`]?\\s*(?:[:=]|\\s+(?=[^\\s:=]))\\s*(?:JSON\\.stringify\\(\\s*)?(?:(["'\`])([^"'\`]*)\\2|(\\$\\{\\{[^}]*\\}\\}|[^\\s"'\`,;)}\\]]+))`), secret: 3, accept: (m) => Boolean(frontendLeak(m[1], m[3] ?? m[4])), why: FRONTEND_WHY, fix: FRONTEND_FIX },

  // Code that runs what it's given.
  { id: 'eval', kind: 'code', severity: 'high', title: 'eval or new Function', needs: ['eval', 'function'], files: JS, code: true, pattern: /(?<![\w.$])(?:eval\s*\(|new\s+Function\s*\()/, why: 'Code made from a string runs whatever reaches that string.', fix: 'Parse the data (JSON.parse) or look the behaviour up in a table rather than running text.' },
  { id: 'shell-injection', kind: 'code', severity: 'high', title: 'Command line built from values', needs: ['exec'], files: JS, code: true, pattern: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$.]*\s*\+)/, why: 'exec runs a shell: a value with ; or $( ) in it runs commands of its own.', fix: 'Use execFile or spawn with the arguments as an array, no shell.' },
  { id: 'shell-injection', kind: 'code', severity: 'high', title: 'Shell command from Python', needs: ['os.system', 'os.popen', 'subprocess'], files: PY, code: true, pattern: /\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.\w+\([^)]*shell\s*=\s*True/, why: 'A shell runs whatever a value slips into the command.', fix: 'subprocess.run with a list of arguments and shell=False.' },
  { id: 'sql-injection', kind: 'code', severity: 'high', title: 'SQL built from values', needs: ['select', 'insert', 'update', 'delete'], files: CODE, code: true, pattern: /["'`]\s*(?:SELECT\b[^"'`]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^\n]*?(?:\$\{|\{[A-Za-z_][\w.]*\}|["'`]\s*\+\s*[A-Za-z_$])/i, why: 'A value put into the SQL text changes the query: the oldest injection there is.', fix: 'Pass values as parameters (@id, $1, ?) and keep the SQL text fixed.' },
  { id: 'xss-sink', kind: 'code', severity: 'medium', title: 'HTML written from values', needs: ['innerhtml', 'outerhtml', 'document.write', 'v-html'], files: JS, code: true, pattern: /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|dangerouslySetInnerHTML|document\.write(?:ln)?\s*\(|\bv-html\s*=/, accept: (m, line) => !/=\s*["'`]\s*["'`]\s*;?\s*$/.test(line), why: 'Text put in as HTML runs any script it carries (cross-site scripting).', fix: 'Set textContent, let the framework escape it, or sanitise it (DOMPurify) first.' },
  { id: 'unsafe-deserialise', kind: 'code', severity: 'high', title: 'Unsafe deserialisation', needs: ['pickle', 'yaml.load', 'binaryformatter', 'typenamehandling', 'unserialize', 'marshal.load', 'objectinputstream'], files: /\.(py|cs|vb|java|php|rb)$/i, code: true, pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)|\bBinaryFormatter\b|TypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects)|\bunserialize\s*\(|\bMarshal\.load\b|\bObjectInputStream\b/, why: 'Reading objects from untrusted bytes can run code chosen by whoever wrote them.', fix: 'Read plain data (JSON, yaml.safe_load, System.Text.Json) and build the objects yourself.' },

  // Protections turned off.
  { id: 'tls-off', kind: 'code', severity: 'high', title: 'TLS certificate checks off', needs: ['rejectunauthorized', 'node_tls', 'verify', 'servercertificate'], files: CODE, code: true, pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0|\bverify\s*=\s*False\b|ServerCertificate(?:Custom)?ValidationCallback\s*=[^;]*=>\s*true|DangerousAcceptAnyServerCertificateValidator|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)/, why: 'Without checking the certificate, anyone on the network can read and change the traffic.', fix: 'Leave the checks on; trust a private CA with NODE_EXTRA_CA_CERTS or the machine\'s store instead.' },
  { id: 'tls-off', kind: 'config', severity: 'high', title: 'TLS certificate checks off', needs: ['strict-ssl', 'enablestrictssl', 'node_tls', 'curl'], files: /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.env[^/]*|Dockerfile[^/]*)$/i, pattern: /strict-ssl\s*=\s*false|enableStrictSsl:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|\bcurl\b[^\n]*\s(?:-k|--insecure)\b/i, why: 'Without checking the certificate, anyone on the network can change what is downloaded.', fix: 'Turn the checks back on and trust the proxy\'s CA (cafile=, NODE_EXTRA_CA_CERTS) instead.' },
  { id: 'jwt-unverified', kind: 'code', severity: 'medium', title: 'Token not fully checked', needs: ['algorithms', 'validate', 'require', 'verify_signature'], files: CODE, code: true, pattern: /algorithms\s*:\s*\[[^\]]*["']none["']|Validate(?:IssuerSigningKey|Lifetime|Issuer|Audience)\s*=\s*false|RequireSignedTokens\s*=\s*false|RequireExpirationTime\s*=\s*false|verify_signature["']?\s*:\s*False/, why: 'A token that isn\'t checked can be made by anyone, or used for ever.', fix: 'Check the signature, issuer, audience and expiry, and accept only the algorithm you sign with.' },
  { id: 'cors-any', kind: 'code', severity: 'medium', title: 'CORS open to any origin', needs: ['origin'], files: CODE, code: true, pattern: /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|\.AllowAnyOrigin\s*\(\s*\)|origin\s*:\s*(?:true|["']\*["'])/, why: 'Any website can call the API from its visitors\' browsers.', fix: 'List the origins that may call it.' },
  { id: 'weak-hash', kind: 'code', severity: 'low', title: 'MD5 or SHA-1', needs: ['md5', 'sha1'], files: CODE, code: true, pattern: /createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|\b(?:MD5|SHA1)\.(?:Create|HashData)\s*\(|new\s+(?:MD5|SHA1)(?:CryptoServiceProvider|Managed)\b/, why: 'Both can be made to collide: fine for a cache key, not for a password, a signature or an integrity check.', fix: 'SHA-256 or better; for passwords, bcrypt, scrypt, Argon2 or PBKDF2.' },
  { id: 'insecure-random', kind: 'code', severity: 'low', title: 'Math.random for a secret', needs: ['math.random'], files: JS, code: true, pattern: /Math\.random\s*\(/, accept: (m, line) => /token|secret|password|passwd|salt|nonce|otp|session|api[_-]?key|reset/i.test(line), why: 'Math.random can be predicted; a token made from it can be guessed.', fix: 'crypto.randomBytes, crypto.randomUUID or crypto.getRandomValues.' },

  // Pipelines and the build.
  { id: 'workflow-injection', kind: 'config', severity: 'high', title: 'Untrusted text in a workflow\'s script', needs: ['github.'], files: WORKFLOW, pattern: /\$\{\{\s*(?:github\.event\.(?:issue|pull_request|comment|review|review_comment|discussion|head_commit|commits)[^}]*\.(?:title|body|name|message|label|ref|email)|github\.head_ref)\s*\}\}/, why: 'Whoever opens the issue or pull request writes that text; inside run: it is part of the script, and runs.', fix: 'Pass it through env: (TITLE: ${{ … }}) and use "$TITLE" in the script.' },
  { id: 'workflow-target', kind: 'config', severity: 'medium', title: 'pull_request_target', needs: ['pull_request_target'], files: WORKFLOW, pattern: /^\s*pull_request_target\s*:|^\s*on\s*:.*\bpull_request_target\b/, why: 'It runs with the repository\'s secrets on a fork\'s pull request; checking out its code runs a stranger\'s code with them.', fix: 'Use pull_request, or never check out or run the pull request\'s code in it.' },
  { id: 'curl-pipe-shell', kind: 'config', severity: 'medium', title: 'Downloaded script piped to a shell', needs: ['curl', 'wget'], pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, why: 'Whatever the server sends runs, unchecked.', fix: 'Download it, check its checksum or signature, then run it.' },
  { id: 'docker-latest', kind: 'config', severity: 'low', title: 'Base image without a fixed version', needs: ['from'], files: DOCKERFILE, pattern: /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s:@]+(?::latest)?)(?:\s+AS\s+\S+)?\s*$/i, accept: (m) => m[1] !== 'scratch' && !/^\$\{?\w/.test(m[1]), why: 'A build picks up whatever the image is today, advisories and all, and can\'t be repeated.', fix: 'Name a version, or better a digest (image:tag@sha256:…).' },
  { id: 'docker-add-url', kind: 'config', severity: 'low', title: 'ADD from a URL', needs: ['add'], files: DOCKERFILE, pattern: /^\s*ADD\s+(?:--\S+\s+)*https?:\/\//i, why: 'The file isn\'t checked against anything.', fix: 'ADD --checksum=sha256:…, or RUN curl and check it.' },
];

/** The rules about browser variables alone: what an ignored .env is read for, and what Ballast reads built files' sources for. */
export const FRONTEND_RULES = RULES.filter((r) => r.id === 'frontend-secret');

/** Whether a line is only a comment, in the languages the code rules read. */
const commentOnly = (line) => /^\s*(?:\/\/|#(?!!)|\*|\/\*|<!--|--|')/.test(line);

/** The severity one step down, for what's found in tests, fixtures and examples. */
const softer = (s) => ({ critical: 'high', high: 'medium', medium: 'low' })[s] ?? s;

// For the rules a file is read with (`mine`, of `rules`), once: `words`, a pattern finding any of their
// `needs`, and `starting`, each first letter's words with the rules that need them.
const needsCache = new WeakMap();
function needsOf(rules, mine) {
  let byRules = needsCache.get(rules);
  if (!byRules) needsCache.set(rules, (byRules = new Map()));
  const key = rules.map((r) => (mine.includes(r) ? 1 : 0)).join('');
  let found = byRules.get(key);
  if (found) return found;
  const byWord = new Map();
  for (const r of mine) for (const w of r.needs ?? []) byWord.set(w, [...(byWord.get(w) ?? []), r]);
  const starting = new Map();
  for (const [w, its] of byWord) starting.set(w[0], [...(starting.get(w[0]) ?? []), [w, its]]);
  // Grouped by first letter, which the pattern looks at once rather than once a word.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [...starting].map(([c, ws]) => `${esc(c)}(?:${ws.map(([w]) => esc(w.slice(1))).join('|')})`);
  found = { words: alternatives.length ? new RegExp(alternatives.join('|'), 'g') : null, starting };
  byRules.set(key, found);
  return found;
}

/**
 * The findings in one file's text (`path` relative and /-separated): [{ key, rule, kind, severity,
 * title, why, fix, path, where (the path, as findings.js reads it), line, excerpt, test }]. A line saying `bilge-ignore` (or the line above it)
 * is skipped, and a file saying `bilge-ignore-file` in its first lines is skipped whole.
 */
export function scanText(path, text, { rules = RULES } = {}) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  if (lines.slice(0, 15).some((l) => l.includes('bilge-ignore-file'))) return out;
  const test = TESTISH.test(path);
  const mine = rules.filter((r) => !r.files || r.files.test(path));
  if (!mine.length) return out;
  // Each rule is tried only on the lines holding one of its `needs` (found for every rule at once, in
  // one pass over the text lowered): most rules are left with few lines or none, and their patterns on
  // every line were most of the time spent in a big repository.
  const lower = String(text).toLowerCase();
  const { words, starting } = needsOf(rules, mine);
  const onLines = new Map();
  // The lines some rule is to be tried on: every line while a rule has no `needs`.
  const any = new Uint8Array(lines.length).fill(mine.every((r) => r.needs) ? 0 : 1);
  if (words) {
    let line = 0;
    let lineEnd = lower.indexOf('\n');
    words.lastIndex = 0;
    for (let m = words.exec(lower); m; m = words.exec(lower)) {
      const at = m.index;
      while (lineEnd >= 0 && lineEnd < at) (line++, (lineEnd = lower.indexOf('\n', lineEnd + 1)));
      // Every word starting here, not only the one the pattern matched ('sk-' as well as 'sk-ant-').
      for (const [w, its] of starting.get(lower[at])) {
        if (!lower.startsWith(w, at)) continue;
        for (const r of its) {
          let on = onLines.get(r);
          if (!on) onLines.set(r, (on = new Uint8Array(lines.length)));
          on[line] = 1;
        }
        any[line] = 1;
      }
      words.lastIndex = at + 1;
    }
  }
  const ignores = lower.includes('bilge-ignore');
  lines.forEach((line, i) => {
    if (!any[i] || line.length > MAX_LINE || (ignores && (/bilge-ignore/.test(line) || /bilge-ignore/.test(lines[i - 1] ?? '')))) return;
    // One secret a line: the rules are in order, the most particular first.
    let secretFound = false;
    for (const r of mine) {
      if (r.needs && !onLines.get(r)?.[i]) continue;
      if (r.code && commentOnly(line)) continue;
      if (secretFound && r.kind === 'secret' && !r.alongside) continue;
      const m = r.pattern.exec(line);
      if (!m || (r.accept && !r.accept(m, line))) continue;
      if (r.kind === 'secret' && !r.alongside) secretFound = true;
      const secret = r.secret === undefined ? null : (m[r.secret] ?? m[r.secret + 1] ?? m[0]);
      let excerpt = line.trim();
      if (secret) excerpt = excerpt.split(secret).join(redact(secret));
      if (excerpt.length > 160) excerpt = `${excerpt.slice(0, 157)}…`;
      out.push({ key: `${r.id}:${path}:${i + 1}`, rule: r.id, where: path, kind: r.kind, severity: test ? softer(r.severity) : r.severity, title: r.title, why: r.why, fix: r.fix, path, line: i + 1, excerpt, test });
    }
  });
  return out;
}

/** The findings about a Dockerfile as a whole: it never says USER, or its last USER is root. */
export function dockerFindings(path, text) {
  if (!DOCKERFILE.test(path)) return [];
  const users = [...String(text).matchAll(/^\s*USER\s+(\S+)/gim)].map((m) => m[1]);
  const last = users.at(-1);
  if (last && !/^(root|0)(:|$)/.test(last)) return [];
  const line = last ? String(text).split(/\r?\n/).findIndex((l) => /^\s*USER\s+(root|0)\b/i.test(l)) + 1 : 1;
  return [{ key: `docker-root:${path}`, rule: 'docker-root', where: path, kind: 'config', severity: 'medium', title: 'Container runs as root', why: 'A process that breaks out of the app is root in the container, and closer to the host.', fix: 'Add a user and switch to it before CMD: RUN adduser -D app && USER app (or USER node, USER app on the official images).', path, line, excerpt: last ? `USER ${last}` : 'no USER line', test: TESTISH.test(path) }];
}

/** A .gitignore's patterns as tests on a path (relative, /-separated). Enough of git's rules for what's checked here, not all of them. */
export function gitignored(text) {
  const rules = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      let p = (negate ? l.slice(1) : l).replace(/\/$/, '');
      const anchored = p.includes('/') && !p.startsWith('**/');
      p = p.replace(/^\//, '').replace(/^\*\*\//, '');
      const re = new RegExp(`${anchored ? '^' : '(^|/)'}${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}(/|$)`);
      return { negate, re };
    });
  return (path) => rules.reduce((hit, r) => (r.re.test(path) ? !r.negate : hit), false);
}

// A .env (and .env.production, .env.local…) that isn't an example of one (ENV_FILE is above).
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults?|tmpl)$/i;
const KEY_STORE = /\.(pfx|p12|jks|keystore)$/i;

/** The findings about a file being there at all: a .env git would commit, a key store. `ignored(path)` says whether git ignores it. */
export function fileFindings(path, { ignored = () => false } = {}) {
  const out = [];
  const test = TESTISH.test(path);
  if (ENV_FILE.test(path) && !ENV_EXAMPLE.test(path) && !ignored(path)) {
    out.push({ key: `env-committed:${path}`, rule: 'env-committed', where: path, kind: 'config', severity: test ? 'medium' : 'high', title: '.env file git doesn\'t ignore', why: 'A .env holds the secrets the app runs with; not ignored, the next git add puts them in the repository.', fix: 'Add .env* (and !.env.example) to .gitignore; if it was committed, rotate what it holds and remove it (git rm --cached).', path, line: 0, excerpt: path, test });
  }
  if (KEY_STORE.test(path)) {
    out.push({ key: `key-store:${path}`, rule: 'key-store', where: path, kind: 'secret', severity: test ? 'medium' : 'high', title: 'Certificate with its private key', why: 'A .pfx, .p12 or keystore carries the private key; its password is often weak or beside it.', fix: 'Keep it in Key Vault or a secret store and load it at run time.', path, line: 0, excerpt: path, test });
  }
  return out;
}

// ——— Translation coverage ———
//
// Unlike the rules above, this reads across files: the keys code passes to t() (and its kin) against
// the translations in a locale folder (locales/pt/*.js, i18n/pt.json, Strings.pt-PT.resx), so a pass
// over the whole folder (`i18nCollector`, fed every file by scanCode) finds what no line alone can: a
// key some language has no translation for, a translation nothing uses any more, and text in JSX
// that never went through t(). The defaults follow Keel's web app (English text as the key, European
// Portuguese in client/src/locales/pt/); Bilge's settings change them.

/** The translation check's defaults: the folders translations live in, the functions code translates with, the language the code is written in. */
export const I18N_DEFAULTS = { locales: ['locales', 'locale', 'i18n', 'lang', 'langs', 'translations', 'messages'], functions: ['t', 'tj', '$t', 'i18n.t'], source: 'en' };

const LANG = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;
// Files whose keys are used (and whose strings may name a key): code, Razor views.
const UI_CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|cs|vb|cshtml|razor)$/i;
const JSX = /\.(jsx|tsx)$/i;

/**
 * The language a file of translations is for, or null: `<locales>/<lang>/<any>.{js,ts,json}`,
 * `<locales>/<lang>.{js,ts,json}` (`locales` the folder names), and `Name.<lang>.resx`, a `Name.resx`
 * being the source language's.
 */
export function localeOf(path, { locales = I18N_DEFAULTS.locales, source = I18N_DEFAULTS.source } = {}) {
  const parts = String(path).split('/');
  const name = parts.at(-1);
  const resx = /^[^.]+(?:\.[^.]+)*?(?:\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?))?\.resx$/i.exec(name);
  if (resx) return resx[1] ?? source;
  if (!/\.(json|[mc]?[jt]s)$/i.test(name)) return null;
  const folders = new Set(locales.map((l) => l.toLowerCase()));
  let at = -1;
  parts.forEach((p, i) => {
    if (i < parts.length - 1 && folders.has(p.toLowerCase())) at = i;
  });
  if (at < 0) return null;
  const rest = parts.slice(at + 1);
  const lang = rest.length === 1 ? name.replace(/\.[^.]+$/, '') : rest[0];
  return LANG.test(lang) ? lang : null;
}

const unescape = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, c) => (c[0] === 'u' && c.length > 1 ? String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16)) : c[0] === 'x' && c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r' })[c] ?? c));
// A key and a string compared for use: placeholders as one, whatever their names ({n} and ${count}).
const usageForm = (s) => s.replace(/\$\{[^}]*\}|\{\{?\s*[\w.]*\s*\}?\}/g, '{}');

/** A translation file's entries: [{ key, line, empty }]. JSON nested keys are joined with dots; a JS file's `'key': 'value'` lines; a .resx's <data name="…">. */
export function translationEntries(path, text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  if (/\.resx$/i.test(path)) {
    const data = /<data\s+name="([^"]+)"[^>]*>/g;
    lines.forEach((l, i) => {
      for (const m of l.matchAll(data)) {
        // Forms' own entries ($this.Text, >>button1.Name) aren't text to translate.
        if (/^[$>]|\.(?:Name|Type|Parent|ZOrder|Location|Size|TabIndex|Anchor)$/.test(m[1])) continue;
        const rest = lines.slice(i, i + 4).join('\n');
        out.push({ key: m[1], line: i + 1, empty: /<value\s*\/>|<value>\s*<\/value>/.test(rest.split('</data>')[0]) });
      }
    });
    return out;
  }
  if (/\.json$/i.test(path)) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return out;
    }
    // The line of each key: the first `"leaf":` from its parent's line on.
    const scan = (quoted, from) => {
      for (let i = from; i < lines.length; i++) if (lines[i].includes(`${quoted}`) && /:/.test(lines[i].slice(lines[i].indexOf(quoted) + quoted.length))) return i;
      return from;
    };
    // Looking every key up from its parent's line was a pass over the file for each key: a flat file
    // of 6,000 keys took close to a second. So the lines are indexed once, by the strings they hold
    // with a colon after them. A key without quotes, backslashes or JSON's punctuation in it can only
    // be found as a whole string token, so the index gives the same line, but on a line with an
    // escaped quote (`"say \"no": …` holds `"no"`), which is looked through as before; any other key too.
    let index = null;
    const odd = [];
    const indexed = () => {
      if (index) return index;
      index = new Map();
      lines.forEach((l, i) => {
        if (!l.includes(':')) return;
        if (l.includes('\\"')) return void odd.push(i);
        for (const [token] of l.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
          const at = index.get(token);
          if (at?.at(-1) === i || !/:/.test(l.slice(l.indexOf(token) + token.length))) continue;
          if (at) at.push(i);
          else index.set(token, [i]);
        }
      });
      return index;
    };
    const lineOf = (leaf, from) => {
      const quoted = JSON.stringify(leaf);
      if (/["\\,:[\]{}]|^\s|\s$/.test(leaf) || !leaf) return scan(quoted, from);
      const at = indexed().get(quoted) ?? [];
      // The first of its lines at or after `from`.
      const first = (list) => {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] < from) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      const i = first(at);
      const found = i < at.length ? at[i] : Infinity;
      for (let j = first(odd); j < odd.length && odd[j] < found; j++) {
        const l = lines[odd[j]];
        if (l.includes(quoted) && /:/.test(l.slice(l.indexOf(quoted) + quoted.length))) return odd[j];
      }
      return found === Infinity ? from : found;
    };
    const walk = (obj, prefix, from) => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        const at = lineOf(k, from);
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key, at);
        else out.push({ key, line: at + 1, empty: v === '' || v == null });
      }
    };
    if (doc && typeof doc === 'object') walk(doc, '', 0);
    return out;
  }
  const entry = /^\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*))\s*:\s*(?:(['"`])((?:\\.|(?!\4)[^\\])*)\4|(['"`]))?/;
  lines.forEach((l, i) => {
    const m = entry.exec(l);
    // A key with a string value (or one starting on this line); not `case 'x':` nor a nested object.
    if (!m || (!m[4] && !m[6]) || /^\s*(case|default)\b/.test(l)) return;
    out.push({ key: unescape(m[2] ?? m[3]), line: i + 1, empty: m[4] ? m[5] === '' : false });
  });
  return out;
}

const jsString = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const quoted = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;

/** The keys a line of code translates: [string], from `fn('…')` for each of `functions`, and .NET's `Localizer["…"]`. */
function usesIn(line, functions) {
  const out = [];
  for (const m of line.matchAll(functions)) {
    const s = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (s !== undefined && !(m[3] !== undefined && m[3].includes('${'))) out.push(unescape(s));
  }
  return out;
}

// Text in JSX a person reads: between tags, or in an attribute people read.
const TAG_TEXT = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*)?)\s*>([^<>{}]+)(?=<|\{|$)/g;
// Markup whose text is code, a command or a unit, not words to translate.
const CODE_TAG = /^(?:code|kbd|pre|samp|var)$/i;
const AFTER_EXPR = /\}([^<>{}]+)(?=<\/[A-Za-z])/g;
const SEEN_ATTR = /\b(?:placeholder|title|alt|aria-label|label|tooltip|helperText)="([^"]*)"/g;
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', middot: '·', rarr: '→', larr: '←', copy: '©' };

const plainForm = (s) => s.replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? ' ').replace(/\s+/g, ' ').trim();

/** Whether `s` could be words at all: letters, not a unit or an abbreviation (ms, kB), not one token of code (onClick, src/app.js, a URL). */
function maybeText(s) {
  const text = plainForm(s);
  if (!/[a-z]{2}/.test(text) || /^[a-zA-Z]{1,3}$/.test(text)) return false;
  const words = text.split(' ').filter((w) => /[A-Za-z]/.test(w));
  return !(words.length === 1 && /[a-z][A-Z]|^[a-z]+[-_./][a-z]|\.\w+$|^https?:/.test(words[0]));
}

/**
 * Whether `s` is surely text for a person to read in their language: words in lower case, not a
 * name (Keel, Azure DevOps), a number or a symbol. A word or two in capitals alone (Close, Pull
 * Request) could be a name too: the check counts one only when the project translates it elsewhere.
 */
export function isUserText(s) {
  if (!maybeText(s)) return false;
  const words = plainForm(s).split(' ').filter((w) => /[A-Za-z]/.test(w));
  return !words.every((w) => /^[^a-z]*[A-Z]/.test(w) || /^(?:of|and|for|the|by|on|in|to|de|da|do)$/.test(w));
}

/** Plain text in one JSX line (with the lines around it), not passed through a translation function: [{ text, sure }]. */
function plainTextIn(line, prev, next) {
  const out = [];
  const add = (s) => {
    const t = s.trim();
    if (t && maybeText(t)) out.push({ text: plainForm(t), sure: isUserText(t) });
  };
  for (const m of line.matchAll(TAG_TEXT)) {
    const [, closing, tag, attrs, text] = m;
    if (!closing && (CODE_TAG.test(tag) || /\bclassName="[^"]*\b(?:mono|code|kbd)\b/.test(attrs))) continue;
    // A comparison (`a > b`) or an arrow (`=>`) around the text means it's code, not markup.
    if (/^\s*(?:&&|\|\||\?|:|\)|=|;)/.test(text) || /(?:&&|\|\||[=;(?:])\s*$/.test(text)) continue;
    add(text);
  }
  for (const m of line.matchAll(AFTER_EXPR)) add(m[1]);
  for (const m of line.matchAll(SEEN_ATTR)) add(m[1]);
  // A line of bare text between a tag's end and a tag or an expression (text that wraps in the source).
  const bare = line.trim();
  if (/^[A-Za-z][^<>{}=;"'`()]*$/.test(bare) && /(?:^|[^=])>\s*$/.test(prev.trim()) && /^(?:<|\{)/.test(next.trim())) add(bare);
  return out;
}

/**
 * The translation check, fed one file at a time (`add(path, text)`, as scanCode walks) and judged at
 * the end (`findings()`): a key used in code (`t('Save changes')`) with no translation in a language
 * that has a locale folder (medium, `i18n-missing`), a key a source-language file has that another
 * language's lacks (medium, `i18n-missing`), a translation no code uses (no string in the code is its
 * key: low, `i18n-unused`) and text in JSX not passed through one of `functions` (low,
 * `i18n-plain-text`). Nothing is found where there are no translations. Tests and fixtures are left out.
 * Options: `locales` (folder names), `functions` (`t`, `$t`, `i18n.t` …), `source` (the language the
 * keys are written in: its own file, when there is one, is checked like any other's).
 */
export function i18nCollector({ locales = I18N_DEFAULTS.locales, functions = I18N_DEFAULTS.functions, source = I18N_DEFAULTS.source } = {}) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const call = `(?<![\\w$])(?:${functions.map(esc).join('|')})\\(\\s*(?:'((?:[^'\\\\\\n]|\\\\.)*)'|"((?:[^"\\\\\\n]|\\\\.)*)"|\`((?:[^\`\\\\]|\\\\.)*)\`)`;
  const calls = new RegExp(`${call}|\\b[Ll]ocali[sz]er\\[\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\]`, 'g');
  // Whether a file translates at all: a call with any argument.
  const callsOnly = new RegExp(`(?<![\\w$])(?:${functions.map(esc).join('|')})\\(`);
  const folders = new Set(locales.map((l) => l.toLowerCase()));
  // Each set of translations by the folder its app lives in: what holds the locale folder, less a src/
  // or public/ (client for client/src/locales/pt/; a .resx's project, above its Resources/). Keys and text are
  // looked for there, against that set: another app beside it (Keel's terminal app, English only) is
  // not this one. `sets` maps that folder to Map(lang → Map(key → { path, line, empty })).
  const sets = new Map();
  const uses = []; // [key, path, line]
  const strings = new Set(); // every string in the code, in usageForm
  const plain = []; // { path, line, text, sure }
  const used = new Set();
  const translating = new Set(); // files that call a translation function
  return {
    add(path, text) {
      // A test's or a fixture's translations and calls aren't the app's; their strings still count as
      // using a key (a mock provider sends the server's sentences in demo mode).
      const test = TESTISH.test(path);
      const lang = test ? null : localeOf(path, { locales, source });
      if (lang) {
        const parts = path.split('/');
        const at = parts.findLastIndex((p, i) => i < parts.length - 1 && folders.has(p.toLowerCase()));
        const holder = /\.resx$/i.test(path) ? parts.slice(0, -1) : parts.slice(0, Math.max(0, at));
        // The app, not the folder of its files: web for web/public/locales, client for client/src/locales.
        while (holder.length && /^(?:src|public|static|assets|resources|app|wwwroot|lib)$/i.test(holder.at(-1))) holder.pop();
        const scope = holder.join('/');
        if (!sets.has(scope)) sets.set(scope, new Map());
        const dicts = sets.get(scope);
        if (!dicts.has(lang)) dicts.set(lang, new Map());
        const d = dicts.get(lang);
        for (const e of translationEntries(path, text)) if (!d.has(e.key)) d.set(e.key, { path, line: e.line, empty: e.empty });
        return;
      }
      if (!UI_CODE.test(path)) return;
      for (const m of String(text).matchAll(jsString)) {
        const s = m[1] ?? m[2] ?? m[3];
        if (s && s.length < 1000) strings.add(usageForm(unescape(s)));
      }
      // Strings inside a template's ${…} too, which the pass above took as part of the template.
      for (const m of String(text).matchAll(quoted)) {
        const s = m[1] ?? m[2];
        if (s && s.length < 1000) strings.add(usageForm(unescape(s)));
      }
      if (test) return;
      if (callsOnly.test(text)) translating.add(path);
      const lines = String(text).split(/\r?\n/);
      const jsx = JSX.test(path);
      let inBlock = false;
      lines.forEach((line, i) => {
        if (line.length > MAX_LINE) return;
        // Comments are left out: an example in one (`t('Save changes')`) is no use.
        if (inBlock) {
          if (line.includes('*/')) inBlock = false;
          return;
        }
        if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
          inBlock = true;
          return;
        }
        if (commentOnly(line) && !/^\s*\{?\s*\/\*.*\*\/\s*\}?\s*</.test(line)) return;
        for (const key of usesIn(line, calls)) {
          used.add(key);
          uses.push([key, path, i + 1]);
        }
        if (jsx) for (const p of plainTextIn(line, lines[i - 1] ?? '', lines[i + 1] ?? '')) plain.push({ path, line: i + 1, ...p });
      });
    },
    findings() {
      const out = [];
      if (!sets.size) return out;
      // The set a file belongs to: the deepest folder holding it.
      const scopes = [...sets.keys()].sort((a, b) => b.length - a.length);
      const setOf = (path) => {
        const s = scopes.find((x) => x === '' || path.startsWith(`${x}/`));
        return s === undefined ? null : sets.get(s);
      };
      const fn = functions[0] ?? 't';
      const cut = (s) => (s.length > 157 ? `${s.slice(0, 156)}…` : s);
      const folderOf = (dicts, lang) => {
        const any = dicts.get(lang).values().next().value?.path ?? '';
        return any.split('/').slice(0, -1).join('/') || '.';
      };
      const lacks = (dicts, key, but) => [...dicts.keys()].sort().filter((l) => l !== but && (!dicts.get(l).get(key) || dicts.get(l).get(key).empty));
      let n = 0;
      const make = (rule, severity, title, path, line, excerpt, why, fix) => ({ key: `${rule}:${path}:${line}:${n++}`, rule, where: path, kind: 'i18n', severity, title, why, fix, path, line, excerpt: cut(excerpt), test: false });
      // Keys the code uses that a language lacks (or has empty), said once a set, where first used.
      // The source language needs no file (the key is its text); when it has one, it is checked too.
      const said = new Map(); // set → Set(key)
      for (const [key, path, line] of uses) {
        const dicts = setOf(path);
        if (!dicts) continue;
        if (!said.has(dicts)) said.set(dicts, new Set());
        if (said.get(dicts).has(key)) continue;
        said.get(dicts).add(key);
        const lacking = lacks(dicts, key);
        if (!lacking.length) continue;
        const where = lacking.map((l) => folderOf(dicts, l)).join(', ');
        out.push(make('i18n-missing', 'medium', `No ${lacking.join(', ')} translation`, path, line, key, `${fn}() shows this text untranslated to everyone reading in ${lacking.join(' or ')}: nothing in ${where} has it.`, `Add ${JSON.stringify(key)} with its ${lacking.join(', ')} text to ${where}.`));
      }
      const isUsed = (key) => used.has(key) || strings.has(usageForm(key));
      for (const dicts of sets.values()) {
        const langs = [...dicts.keys()].sort();
        // Keys the source language's own file has, that the code uses, which another language lacks.
        for (const [key, e] of dicts.get(source) ?? []) {
          if (said.get(dicts)?.has(key) || !isUsed(key)) continue;
          const lacking = lacks(dicts, key, source);
          if (lacking.length) out.push(make('i18n-missing', 'medium', `No ${lacking.join(', ')} translation`, e.path, e.line, key, `${e.path} has this key, and ${lacking.join(', ')} ${lacking.length === 1 ? 'has' : 'have'} no text for it.`, `Add ${JSON.stringify(key)} to ${lacking.map((l) => folderOf(dicts, l)).join(', ')}.`));
        }
        // Translations nothing uses: no call has the key, and no string in the code is it. A .resx's
        // keys are properties in code (Strings.Hello), so they are never said to be unused.
        const seen = new Set();
        for (const lang of langs) {
          for (const [key, e] of dicts.get(lang)) {
            if (seen.has(key) || isUsed(key) || /\.resx$/i.test(e.path)) continue;
            seen.add(key);
            const elsewhere = langs.filter((l) => l !== lang && dicts.get(l).has(key));
            out.push(make('i18n-unused', 'low', 'Translation no code uses', e.path, e.line, key, `No string in the code is this key${elsewhere.length ? ` (nor in ${elsewhere.join(', ')}'s)` : ''}: what it translated has changed or gone, or the key is made at run time.`, `Remove it from ${[lang, ...elsewhere].map((l) => folderOf(dicts, l)).join(', ')} if nothing builds the key at run time; if something does, ignore this finding.`));
          }
        }
      }
      // Text in JSX a person reads in one language only, in an app that translates: surely words, or a
      // word or two the project translates elsewhere (Close).
      // The sets some file translates in, worked out once rather than for each piece of text.
      const translated = new Set([...translating].map(setOf));
      for (const p of plain) {
        const dicts = setOf(p.path);
        if (!dicts || !translated.has(dicts)) continue;
        if (!p.sure && ![...dicts.values()].some((d) => d.has(p.text))) continue;
        const langs = [...dicts.keys()].sort();
        out.push(make('i18n-plain-text', 'low', `Text not passed through ${fn}()`, p.path, p.line, p.text, `It shows as written to everyone, whatever language they chose (${langs.join(', ')} ${langs.length === 1 ? 'has' : 'have'} a locale folder).`, `Wrap it: {${fn}(${JSON.stringify(p.text)})}, and add its translations.`));
      }
      return out;
    },
  };
}

/** The translation check over files already read: [{ path, text }] → findings (i18nCollector's). */
export function i18nFindings(files, options = {}) {
  const c = i18nCollector(options);
  for (const f of files) c.add(f.path, f.text);
  return c.findings();
}

/** Worst first, then by file and line. */
export const sortFindings = (list) => [...list].sort((a, b) => rank(a.severity) - rank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);

/** Without the findings `ignore` names: `rule:path` (that rule in that file) or a rule's id alone. */
export const withoutIgnoredCode = (list, ignore = []) => {
  const set = new Set(ignore);
  return list.filter((f) => !set.has(f.rule) && !set.has(`${f.rule}:${f.path}`));
};

/**
 * Walks `root` (SKIP_DIRS left out, MAX_FILES at most, a file over 512 KB or with a NUL in its start
 * skipped) and reads every text file through the rules: { root, files, findings, truncated }. Reads
 * only; `signal` stops it between files, `onProgress(files)` says how far it has got. `i18n` is the
 * translation check's options (`i18nCollector`'s), or false to leave it out.
 */
export async function scanCode(root, { signal, onProgress, maxFiles = MAX_FILES, i18n = {} } = {}) {
  const findings = [];
  const translations = i18n === false ? null : i18nCollector(i18n ?? {});
  let files = 0;
  let truncated = false;
  const ignoredBy = [];
  const isIgnored = (path) => ignoredBy.some(({ dir, test }) => (dir === '' || path.startsWith(`${dir}/`)) && test(dir ? path.slice(dir.length + 1) : path));
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const relDir = relative(root, dir).split(sep).join('/');
    const gi = entries.find((e) => e.isFile() && e.name === '.gitignore');
    if (gi) {
      try {
        ignoredBy.push({ dir: relDir, test: gitignored(readFileSync(join(dir, gi.name), 'utf8')) });
      } catch {}
    }
    for (const e of entries) {
      const path = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.isSymbolicLink()) stack.push(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      if (files >= maxFiles) {
        truncated = true;
        break;
      }
      files++;
      if (files % 200 === 0) {
        onProgress?.(files);
        // Lets the spinner turn and esc be heard on a big folder.
        await new Promise((r) => setImmediate(r));
      }
      findings.push(...fileFindings(path, { ignored: isIgnored }));
      if (BINARY.test(e.name) || LOCK_FILES.has(e.name) || /\.min\.(js|css)$/i.test(e.name)) continue;
      // A .env git ignores stays on this machine: what's in it is where secrets belong, but for a
      // browser variable, which the build still sends to every visitor.
      const ignoredEnv = ENV_FILE.test(path) && isIgnored(path);
      const full = join(dir, e.name);
      let text;
      try {
        if (statSync(full).size > MAX_BYTES) continue;
        const bytes = readFileSync(full);
        if (bytes.subarray(0, 8000).includes(0)) continue;
        text = bytes.toString('utf8');
      } catch {
        continue;
      }
      if (ignoredEnv) findings.push(...scanText(path, text, { rules: FRONTEND_RULES }));
      else findings.push(...scanText(path, text), ...dockerFindings(path, text));
      translations?.add(path, text);
    }
    if (truncated) break;
  }
  if (translations) findings.push(...translations.findings());
  return { root, files, findings: sortFindings(findings), truncated, at: Date.now() };
}

/** A finding as one line of text: severity, where, what. */
export const findingWhere = (f) => (f.line ? `${f.path}:${f.line}` : f.path);
