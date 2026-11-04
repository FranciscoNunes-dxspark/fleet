// bilge-ignore-file: the made-up secrets and risky lines below are here to be found by the rules under test.
// codescan.js: the rules on text, the file-level findings and the walk of a folder on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_RULES, PUBLIC_BY_DESIGN, RULES, dockerFindings, fileFindings, frontendLeak, frontendPrefix, gitignored, looksRandom, redact, scanCode, scanText, withoutIgnoredCode } from '../codescan.js';

// Made up from pieces, so that no line of this file is a whole one.
const AWS = ['AKIA', 'Q4ZB7XWM2HNE9TLC'].join('');
const GH = ['ghp', '_', 'a'.repeat(36)].join('');
const rules = (path, text) => scanText(path, text).map((f) => f.rule);

test('secrets: keys and tokens are found, and never kept whole', () => {
  const [f] = scanText('src/aws.js', `const id = '${AWS}';`);
  assert.equal(f.rule, 'aws-key');
  assert.equal(f.severity, 'critical');
  assert.equal(f.line, 1);
  assert.ok(!f.excerpt.includes(AWS), 'the key is redacted');
  assert.match(f.excerpt, /AKIA•+/);
  assert.deepEqual(rules('a.js', `token = "${GH}"`), ['github-token']);
  assert.deepEqual(rules('k.pem', '-----BEGIN RSA PRIVATE KEY-----'), ['private-key']);
  assert.deepEqual(rules('app.config', 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=' + 'Q'.repeat(86) + '==;'), ['azure-storage-key']);
  assert.deepEqual(rules('db.js', "const url = 'postgres://shop:S3cr3t-pw@db:5432/shop';"), ['url-credentials']);
  assert.deepEqual(rules('appsettings.json', '"Main": "Server=tcp:x.database.windows.net;Database=shop;User Id=app;Password=Hx81kq!z;"'), ['connection-password']);
  assert.deepEqual(rules('config.py', 'API_KEY = "f3a9c1d27b8e4a6f"'), ['hardcoded-secret']);
  assert.equal(redact('abcdefghijkl'), 'abcd••••••••');
  assert.equal(redact('abc'), '•••');
});

test('secrets: placeholders, variables and words are left alone', () => {
  assert.deepEqual(rules('a.js', 'const password = process.env.DB_PASSWORD;'), []);
  assert.deepEqual(rules('a.js', 'password: "${DB_PASSWORD}"'), []);
  assert.deepEqual(rules('a.js', "const url = 'postgres://user:password@localhost/db';"), []);
  assert.deepEqual(rules('a.js', "const url = 'postgres://shop:${PASS}@db/shop';"), []);
  assert.deepEqual(rules('a.js', "'Password': 'Palavra-passe',"), []);
  assert.deepEqual(rules('a.js', 'secret_name = "DATABASE_URL"'), []);
  assert.deepEqual(rules('a.js', "Password=your-password-here;Server=x"), []);
});

test('code: eval, shell and SQL built from values, TLS off, unsafe deserialisation', () => {
  assert.deepEqual(rules('a.js', 'eval(userInput)'), ['eval']);
  assert.deepEqual(rules('a.js', 'const f = new Function("return " + body);'), ['eval']);
  assert.deepEqual(rules('a.js', 'exec(`git log ${branch}`)'), ['shell-injection']);
  assert.deepEqual(rules('a.js', "execSync('ls ' + dir)"), ['shell-injection']);
  assert.deepEqual(rules('a.js', "execFile('git', ['log', branch])"), []);
  assert.deepEqual(rules('a.py', 'subprocess.run(cmd, shell=True)'), ['shell-injection']);
  assert.deepEqual(rules('a.js', 'db.query(`SELECT * FROM users WHERE id = ${id}`)'), ['sql-injection']);
  assert.deepEqual(rules('a.cs', 'var sql = $"SELECT * FROM Users WHERE Name = \'{name}\'";'), ['sql-injection']);
  assert.deepEqual(rules('a.py', 'cur.execute(f"DELETE FROM items WHERE id = {item_id}")'), ['sql-injection']);
  assert.deepEqual(rules('a.js', "db.query('SELECT * FROM users WHERE id = $1', [id])"), []);
  assert.deepEqual(rules('a.js', 'new https.Agent({ rejectUnauthorized: false })'), ['tls-off']);
  assert.deepEqual(rules('a.py', 'requests.get(url, verify=False)'), ['tls-off']);
  assert.deepEqual(rules('a.py', 'data = pickle.loads(blob)'), ['unsafe-deserialise']);
  assert.deepEqual(rules('a.py', 'yaml.load(text, Loader=yaml.SafeLoader)'), []);
  assert.deepEqual(rules('a.jsx', '<div dangerouslySetInnerHTML={{ __html: body }} />'), ['xss-sink']);
  assert.deepEqual(rules('a.js', "el.innerHTML = '';"), []);
  assert.deepEqual(rules('a.js', "const token = Math.random().toString(36);"), ['insecure-random']);
  assert.deepEqual(rules('a.js', 'const x = Math.random() * width;'), []);
  // A comment isn't code, and the rules for one language leave the others alone.
  assert.deepEqual(rules('a.js', '// never eval(input) here'), []);
  assert.deepEqual(rules('README.md', 'eval(x)'), []);
});

test('config: workflows, curl | sh, Dockerfiles', () => {
  assert.deepEqual(rules('.github/workflows/ci.yml', '      - run: echo "${{ github.event.issue.title }}"'), ['workflow-injection']);
  assert.deepEqual(rules('.github/workflows/ci.yml', '      - run: echo "${{ github.sha }}"'), []);
  assert.deepEqual(rules('.github/workflows/ci.yml', '  pull_request_target:'), ['workflow-target']);
  assert.deepEqual(rules('install.sh', 'curl -fsSL https://example.com/install.sh | sudo bash'), ['curl-pipe-shell']);
  assert.deepEqual(rules('Dockerfile', 'FROM node'), ['docker-latest']);
  assert.deepEqual(rules('Dockerfile', 'FROM node:22-alpine AS build'), []);
  assert.deepEqual(rules('Dockerfile', 'ENV DB_PASSWORD=hunter2hunter2'), ['docker-secret']);
  assert.deepEqual(rules('Dockerfile', 'ARG NPM_TOKEN'), []);
  assert.equal(dockerFindings('Dockerfile', 'FROM node:22\nCMD node .\n')[0].rule, 'docker-root');
  assert.equal(dockerFindings('Dockerfile', 'FROM node:22\nUSER root\nRUN x\n')[0].line, 2);
  assert.deepEqual(dockerFindings('Dockerfile', 'FROM node:22\nUSER node\n'), []);
  assert.deepEqual(dockerFindings('src/app.js', 'FROM x'), []);
});

test('in tests and fixtures a finding is one step milder; bilge-ignore leaves a line or a file out', () => {
  assert.equal(scanText('test/aws.test.js', `const id = '${AWS}';`)[0].severity, 'high');
  assert.equal(scanText('src/fixtures/k.js', `const id = '${AWS}';`)[0].test, true);
  assert.deepEqual(rules('a.js', `const id = '${AWS}'; // bilge-ignore`), []);
  assert.deepEqual(rules('a.js', `// bilge-ignore: a documented example\nconst id = '${AWS}';`), []);
  assert.deepEqual(rules('a.js', `// bilge-ignore-file\n\nconst id = '${AWS}';`), []);
  // One secret a line, the most particular rule's.
  assert.deepEqual(rules('a.js', `const apiKey = '${AWS}';`), ['aws-key']);
});

// Made up from pieces too: a Stripe secret and publishable key, a Supabase anon and service_role token.
const SK = ['sk_live_', 'Q4ZB7XWM2HNE9TLCabcdefgh'].join('');
const PK = ['pk_live_', 'Q4ZB7XWM2HNE9TLCabcdefgh'].join('');
const jwt = (role) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ iss: 'supabase', role })).toString('base64url'), 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.');

test('frontendLeak: a browser variable holding a secret, by its shape, its name, a reference or its randomness', () => {
  assert.equal(frontendPrefix('NEXT_PUBLIC_API'), 'NEXT_PUBLIC_');
  assert.equal(frontendPrefix('API_SECRET'), null);
  assert.deepEqual(frontendLeak('VITE_STRIPE_KEY', SK), { prefix: 'VITE_', name: 'VITE_STRIPE_KEY', reason: 'shape', what: 'a Stripe secret key' });
  assert.equal(frontendLeak('REACT_APP_AWS', AWS).what, 'an AWS access key');
  assert.equal(frontendLeak('NEXT_PUBLIC_SUPABASE_KEY', jwt('service_role')).what, 'a Supabase service_role key');
  assert.equal(frontendLeak('VITE_ADMIN_PASSWORD', '"hunter2!x"').reason, 'name');
  assert.equal(frontendLeak('EXPO_PUBLIC_TOKEN', '${{ secrets.DEPLOY_TOKEN }}').reason, 'reference');
  assert.equal(frontendLeak('VITE_DB', 'process.env.DB_PASSWORD').reason, 'reference');
  assert.equal(frontendLeak('VITE_SECRET', '${SECRET}').reason, 'reference');
  assert.equal(frontendLeak('VITE_API_KEY', '${API_KEY}'), null);
  assert.equal(frontendLeak('GATSBY_X', 'Zx8kQ2pLm9Vt4RbW7nYc3HdF').reason, 'entropy');
  // Never the value in the answer.
  assert.ok(!JSON.stringify(frontendLeak('VITE_STRIPE_KEY', SK)).includes(SK));
  // Not a browser variable, empty, a placeholder, plain configuration.
  for (const [n, v] of [['STRIPE_KEY', SK], ['VITE_SECRET', ''], ['VITE_API_SECRET', 'your-secret-here'], ['VITE_API_URL', 'https://api.example.com/v1'], ['VITE_APP_TITLE', 'Shop'], ['VITE_COMMIT_SHA', '3f1c9a7be0d24c55a1b2c3d4e5f60718293a4b5c'], ['VITE_AZURE_CLIENT_ID', '0f3e9a4c-1b2d-4e5f-8a9b-0c1d2e3f4a5b'], ['VITE_API', '${{ vars.API_URL }}'], ['VITE_PASSWORD_MIN', '12']]) assert.equal(frontendLeak(n, v), null, `${n}=${v}`);
});

test('frontendLeak: keys made for the browser are allowed, their secret halves are not', () => {
  const allowed = [
    ['VITE_STRIPE_PUBLISHABLE_KEY', PK, 'publishable-key'],
    ['NEXT_PUBLIC_CLERK_KEY', ['pk_test_', 'Y2xlcmsuZXhhbXBsZS5jb20k'].join(''), 'publishable-key'],
    ['VITE_FIREBASE_API_KEY', ['AIza', 'SyD3x9QkZb7LmW2pV8tR4nY6cH1jF5gK0aE'].join(''), 'google-browser-key'],
    ['NEXT_PUBLIC_GOOGLE_MAPS_KEY', ['AIza', 'SyB1qW2eR3tY4uI5oP6aS7dF8gH9jK0lZxC'].join(''), 'google-browser-key'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', jwt('anon'), 'supabase-anon'],
    ['VITE_SUPABASE_KEY', jwt('anon'), 'supabase-anon'],
    ['VITE_SENTRY_DSN', `https://${'0a1b2c3d'.repeat(4)}@o4501.ingest.sentry.io/4502`, 'sentry-dsn'],
    ['VITE_MAPBOX_TOKEN', ['pk.', 'eyJ1IjoiZXhhbXBsZSJ9.abcdefghijklmnop'].join(''), 'mapbox-public'],
    ['VITE_POSTHOG_KEY', ['phc_', 'Zx8kQ2pLm9Vt4RbW7nYc3HdF'].join(''), 'posthog-project'],
    ['VITE_RECAPTCHA_SITE_KEY', '6LcZx8kQAAAAAPm9Vt4RbW7nYc3HdF2kQ8pLmZx9', 'site-key'],
    ['VITE_ALGOLIA_SEARCH_KEY', 'Zx8kQ2pLm9Vt4RbW7nYc3HdF', 'search-only-key'],
  ];
  for (const [n, v, id] of allowed) {
    assert.equal(frontendLeak(n, v), null, n);
    assert.ok(PUBLIC_BY_DESIGN.find((p) => p.id === id).test(n, v), `${n} is ${id}`);
  }
  assert.ok(PUBLIC_BY_DESIGN.every((p) => p.why && p.title));
  assert.ok(frontendLeak('VITE_STRIPE_KEY', SK));
  assert.ok(frontendLeak('VITE_MAPBOX_TOKEN', ['sk.', 'eyJ1IjoiZXhhbXBsZSJ9.abcdefghijklmnop'].join('')));
  assert.ok(frontendLeak('VITE_POSTHOG_KEY', ['phx_', 'Zx8kQ2pLm9Vt4RbW7nYc3HdF'].join('')));
  assert.equal(looksRandom('Zx8kQ2pLm9Vt4RbW7nYc3HdF'), true);
  assert.equal(looksRandom('ThisIsNotRandomAtAll'), false);
});

test('the frontend-secret rule: .env files and the configs that set a browser variable, the value never whole', () => {
  const [f] = scanText('web/.env.production', `# keys\nVITE_STRIPE_KEY="${SK}"\nVITE_STRIPE_PK=${PK}\nVITE_TITLE=Shop\n`).filter((x) => x.rule === 'frontend-secret');
  assert.equal(f.line, 2);
  assert.equal(f.severity, 'high');
  assert.equal(f.kind, 'secret');
  assert.ok(!f.excerpt.includes(SK));
  assert.match(f.excerpt, /^VITE_STRIPE_KEY="sk_l•+"$/);
  // Alongside the line's other secret rule, not instead of it.
  assert.deepEqual(rules('.env', `VITE_STRIPE_KEY=${SK}`), ['stripe-key', 'frontend-secret']);
  assert.deepEqual(rules('.env', `STRIPE_KEY=${SK}`), ['stripe-key']);
  assert.deepEqual(rules('vite.config.ts', "  define: { 'import.meta.env.VITE_ADMIN_SECRET': JSON.stringify('q8ZtW2kP9xLm') },"), ['frontend-secret']);
  assert.deepEqual(rules('next.config.mjs', `  env: { NEXT_PUBLIC_SUPABASE_KEY: '${jwt('service_role')}' },`), ['jwt', 'frontend-secret']);
  assert.deepEqual(rules('next.config.mjs', '  env: { NEXT_PUBLIC_API_URL: process.env.API_URL },'), []);
  assert.deepEqual(rules('Dockerfile', 'ARG VITE_SUPABASE_KEY=sb_secret_Zx8kQ2pLm9Vt4RbW'), ['frontend-secret']);
  assert.deepEqual(rules('Dockerfile', 'ENV VITE_API_TOKEN Zx8kQ2pLm9Vt4RbW7nYc3HdF'), ['docker-secret', 'frontend-secret']);
  assert.deepEqual(rules('docker-compose.yml', '        - VITE_CLIENT_SECRET=Zx8kQ2pLm9Vt'), ['frontend-secret']);
  assert.deepEqual(rules('compose.yaml', '      REACT_APP_KEY: Zx8kQ2pLm9Vt4RbW7nYc3HdF'), ['frontend-secret']);
  assert.deepEqual(rules('.github/workflows/deploy.yml', '          VITE_DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}'), ['frontend-secret']);
  assert.deepEqual(rules('.github/workflows/deploy.yml', '          VITE_API_URL: ${{ vars.API_URL }}'), []);
  assert.deepEqual(rules('package.json', '    "build": "VITE_ADMIN_PASSWORD=Hx81kq!z vite build",'), ['frontend-secret']);
  // A Firebase key is the google-key rule's to judge (restrict it), not a browser leak.
  assert.deepEqual(rules('app.json', `      "EXPO_PUBLIC_FIREBASE_KEY": "${['AIza', 'SyD3x9QkZb7LmW2pV8tR4nY6cH1jF5gK0aE'].join('')}"`), ['google-key']);
  // Only in the files that set one: code that reads a variable sets nothing.
  assert.deepEqual(rules('src/app.js', `const k = import.meta.env.VITE_STRIPE_KEY ?? '${PK}';`), []);
  assert.ok(FRONTEND_RULES.length === 2 && FRONTEND_RULES.every((r) => r.id === 'frontend-secret'));
});

test('a .env git would commit, and key stores; the ignore list', () => {
  const ignored = gitignored('node_modules/\n.env*\n!.env.example\n/build\n');
  assert.equal(ignored('.env'), true);
  assert.equal(ignored('api/.env.local'), true);
  assert.equal(ignored('.env.example'), false);
  assert.equal(ignored('build/x.js'), true);
  assert.equal(ignored('src/build/x.js'), false);
  assert.deepEqual(fileFindings('.env', { ignored }), []);
  assert.equal(fileFindings('.env', {})[0].rule, 'env-committed');
  assert.deepEqual(fileFindings('.env.example', {}), []);
  assert.equal(fileFindings('certs/site.pfx', {})[0].rule, 'key-store');
  const list = [{ rule: 'weak-hash', path: 'a.js' }, { rule: 'weak-hash', path: 'b.js' }, { rule: 'eval', path: 'a.js' }];
  assert.deepEqual(withoutIgnoredCode(list, ['weak-hash:a.js']).length, 2);
  assert.deepEqual(withoutIgnoredCode(list, ['weak-hash']).map((f) => f.rule), ['eval']);
});

test('scanCode walks the folder: skips installed packages, lock files, binaries and an ignored .env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bilge-code-'));
  try {
    const put = (path, text) => {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    };
    put('src/a.js', `const k = '${AWS}';\neval(x);\n`);
    put('node_modules/x/index.js', 'eval(x)');
    put('package-lock.json', `"integrity": "sha512-${AWS}"`);
    put('img.png', `${AWS}`);
    put('blob.dat2', Buffer.from([0, 1, 2, ...Buffer.from(`eval(x) ${AWS}`)]));
    put('.gitignore', '.env\n');
    put('.env', `AWS=${AWS}`);
    put('api/.env.production', 'X=1');
    // An ignored .env is read only for browser variables, which the build sends out all the same.
    put('web/.gitignore', '.env.local\n');
    put('web/.env.local', `AWS=${AWS}\nVITE_AWS_KEY=${AWS}\n`);
    const r = await scanCode(root);
    assert.deepEqual(r.findings.map((f) => `${f.rule} ${f.path}:${f.line}`), ['aws-key src/a.js:1', 'env-committed api/.env.production:0', 'eval src/a.js:2', 'frontend-secret web/.env.local:2']);
    assert.ok(!r.findings.some((f) => f.excerpt.includes(AWS)));
    assert.equal(r.truncated, false);
    const few = await scanCode(root, { maxFiles: 2 });
    assert.equal(few.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule's needs hold for every line it matches: the same findings as every pattern on every line", () => {
  const everyLine = RULES.map(({ needs, ...r }) => r);
  // This file's lines (less its first, which leaves the file out), in capitals too, and the kit's own
  // code, read as files of each kind the rules look at.
  const here = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).join('\n');
  const kitDir = fileURLToPath(new URL('..', import.meta.url));
  const kit = readdirSync(kitDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(kitDir, f), 'utf8'));
  let found = 0;
  for (const text of [here, here.toUpperCase(), ...kit]) {
    for (const path of ['a.js', 'a.py', 'a.cs', 'Dockerfile', '.github/workflows/ci.yml', '.npmrc', 'test/a.js', '.env', 'web/vite.config.ts', 'docker-compose.yml', 'package.json']) {
      const fast = scanText(path, text);
      assert.deepEqual(fast, scanText(path, text, { rules: everyLine }), path);
      found += fast.length;
    }
  }
  assert.ok(found > 100, `the lines find things (${found})`);
});
