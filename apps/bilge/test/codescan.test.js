// bilge-ignore-file: the made-up secrets and risky lines below are here to be found by the rules under test.
// The Code view: codescan.js's rules on text, the file-level findings, the walk of a folder on disk,
// bilge code, and the view over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerFindings, fileFindings, gitignored, redact, scanCode, scanText, withoutIgnoredCode } from '../src/codescan.js';
import { runHeadless } from '../src/headless.js';
import { demoBilge } from '../src/demo.js';
import { markdownReport } from '../src/share.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

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
    const r = await scanCode(root);
    assert.deepEqual(r.findings.map((f) => `${f.rule} ${f.path}:${f.line}`), ['aws-key src/a.js:1', 'env-committed api/.env.production:0', 'eval src/a.js:2']);
    assert.equal(r.truncated, false);
    const few = await scanCode(root, { maxFiles: 2 });
    assert.equal(few.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bilge code: the findings and the exit code, the JSON without the excerpts', async () => {
  let out = '';
  const code = await runHeadless(['code', '.'], { provider: demoBilge(), write: (s) => (out += s) });
  assert.equal(code, 1);
  assert.match(out, /CRIT AWS access key {2}src\/config\.js:1/);
  assert.match(out, /1 critical · 4 high · 1 medium · 2 low · failing on high and above/);
  out = '';
  assert.equal(await runHeadless(['code', '.', '--fail-on', 'critical', '--json'], { provider: demoBilge(), config: { codeIgnore: ['aws-key:src/config.js'] }, write: (s) => (out += s) }), 0);
  const j = JSON.parse(out);
  assert.equal(j.findings.length, 7);
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  assert.equal(j.counts.critical, 0);
});

test('the report has a Code section once /code has run, without the lines themselves', () => {
  const md = markdownReport({ name: 'shop', manifests: [], packages: [], found: [], code: [{ severity: 'critical', title: 'AWS access key', path: 'src/config.js', line: 1, excerpt: 'AKIA••••' }] });
  assert.match(md, /## Code/);
  assert.match(md, /\| CRIT \| AWS access key \| `src\/config\.js:1` \|/);
  assert.ok(!md.includes('AKIA'));
});

test('the Code view: /code reads the folder, ↵ shows a finding, x ignores it, t hands it to Splice', async () => {
  const app = start();
  await until(() => app.lastFrame().includes('minimist@1.2.5'), 'the findings');
  app.stdin.write('4');
  await until(() => app.lastFrame().includes('Not read yet'), 'the empty Code view');
  await type(app.stdin, '/code');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('AWS access key'), 'the code findings');
  const frame = app.lastFrame();
  assert.match(frame, /4 Code 8/);
  assert.match(frame, /CRIT secret AWS access key/);
  assert.ok(!frame.includes('AKIAZ7QX3PLM2RTW5KDN'), 'no secret on screen');
  assert.deepEqual(app.provider.state.calls.at(-1)[0], 'code');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('rotate it'), 'the finding');
  assert.match(app.lastFrame(), /Deactivate the key in IAM/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Deactivate'), 'the list again');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /family:v1:file:/);
  app.stdin.write('x');
  await until(() => app.lastFrame().includes('Ignore aws access key in src/config.js?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('4 Code 7'), 'one fewer');
  assert.ok(!app.lastFrame().includes('AWS access key'));
  app.unmount();
});
