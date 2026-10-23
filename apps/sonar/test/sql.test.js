// The other kinds of resource through the real UI over the demo: SQL databases opened in Trawl (a
// command copied for its prompt, the firewall checked first), a container app's logs and restart, storage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const command = async (app, line) => {
  app.stdin.write('/');
  await type(app.stdin, line);
  app.stdin.write(KEYS.enter);
};

const rules = (app, name) => app.provider.state.sqlServers.find((s) => s.name === name).rules;

test("T on a production database: the firewall rule asked for by name, then a command for Trawl naming the app whose login it uses, the password nowhere", async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write(KEYS.esc);
    await command(app, 'find sql-prod');
    await until(() => /❯ ● contoso-sql-prod\s+sql server/.test(frame()) && frame().includes('Azure services'), 'the server, its databases and its firewall');
    assert.match(frame(), /└ ● contoso\s+GeneralPur/);
    assert.match(frame(), /└ ● contoso-reporting\s+Standard/);
    assert.match(frame(), /entra\s+SQL Admins \(group\)/);
    assert.match(frame(), /office\s+203\.0\.113\.0 – 203\.0\.113\.255/);
    app.stdin.write('j');
    await until(() => /❯\s+└ ● contoso\s/.test(frame()) && frame().includes('SQL database'), 'the database');
    assert.match(frame(), /GP_S_Gen5_2 · GeneralPurpose/);

    app.stdin.write('T');
    await until(() => frame().includes("Let 198.51.100.7 through contoso-sql-prod's firewall? Type contoso-sql-prod to go ahead") && frame().includes('No rule lets this machine in'), 'the rule asked for, by name for production');
    await type(app.stdin, 'contoso-sql-prod');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Copied for Trawl: paste it into Trawl's prompt"), 'the command copied');
    assert.ok(rules(app, 'contoso-sql-prod').some((r) => r.name === 'sonar-198-51-100-7' && r.start === '198.51.100.7'), 'the rule added');
    const line = '/azure-sql contoso-sql-prod.database.windows.net contoso --name contoso-sql-prod-contoso --user contoso_app --password-from contoso-prod/contoso-api --subscription sub-prod --prod';
    assert.equal(copied.at(-1), line);
    app.stdin.write('5');
    app.stdin.write('6');
    await until(() => frame().includes('The login contoso_app, from contoso-api') && frame().includes(line.slice(0, 60)), 'the log says where the login comes from');
    assert.doesNotMatch(frame(), /demo-Sql-Pa55/);
    assert.ok(!copied.some((c) => c.includes('demo-Sql-Pa55')), 'the password is never copied');

    // The reporting database: its app uses its managed identity, so Trawl signs in with Entra; the firewall is open now.
    app.stdin.write('1');
    await until(() => /❯ ● contoso-sql-prod/.test(frame()), 'Resources again');
    app.stdin.write('G');
    await until(() => /❯\s+└ ● contoso-reporting/.test(frame()), 'the reporting database');
    app.stdin.write('T');
    await until(() => copied.length === 2, 'copied again, without asking');
    assert.equal(copied[1], '/azure-sql contoso-sql-prod.database.windows.net contoso-reporting --name contoso-sql-prod-contoso-reporting --prod');
  } finally {
    app.unmount();
  }
});

test('/trawl on a test database: a plain question for the firewall, declined, and still a command for Entra; F and /firewall', async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    await command(app, 'trawl contoso-sql-qa/contoso-qa');
    await until(() => frame().includes("Let 198.51.100.7 through contoso-sql-qa's firewall?") && frame().includes('Yes, add it'), 'a plain question');
    app.stdin.write('2');
    await until(() => copied.length === 1, 'copied all the same');
    assert.equal(copied[0], '/azure-sql contoso-sql-qa.database.windows.net contoso-qa --name contoso-sql-qa-contoso-qa');
    assert.equal(rules(app, 'contoso-sql-qa').length, 1, 'nothing added');

    await command(app, 'firewall contoso-sql-qa');
    await until(() => frame().includes('Yes, add it'), 'asked again');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-sql-qa lets 198.51.100.7 in'), 'added');
    assert.equal(rules(app, 'contoso-sql-qa').at(-1).name, 'sonar-198-51-100-7');
    await command(app, 'firewall contoso-sql-qa');
    await until(() => frame().includes("contoso-sql-qa's firewall already lets 198.51.100.7 in (rule sonar-198-51-100-7)"), 'already in');

    // F on the server in Resources.
    await command(app, 'find sql-qa');
    await until(() => /❯ ● contoso-sql-qa/.test(frame()) && frame().includes('sonar-198-51-100-7'), 'the server, the new rule beside it');
    app.stdin.write('F');
    await until(() => frame().split("already lets").length > 2 || /already lets 198\.51\.100\.7 in/.test(frame()), 'F says so too');
  } finally {
    app.unmount();
  }
});

test('a container app: its details, its logs from its workspace, a restart of its revision; a storage account', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    await command(app, 'find worker');
    await until(() => /❯ ● contoso-worker\s+container/.test(frame()) && frame().includes('contoso-worker--r7'), 'the container app beside the list');
    assert.match(frame(), /image\s+contosocr\.azurecr\.io\/worker:2\.14\.0/);
    app.stdin.write('l');
    await until(() => frame().includes('╭─ Logs') && frame().includes('contoso-env logs') && frame().includes('Processed'), 'its console log');
    app.stdin.write('1');
    await until(() => /❯ ● contoso-worker/.test(frame()), 'back');
    app.stdin.write('R');
    await until(() => frame().includes('Restart contoso-worker (revision contoso-worker--r7)? Type contoso-worker'), 'by name, in production');
    await type(app.stdin, 'contoso-worker');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("contoso-worker's revision contoso-worker--r7 is restarting"), 'restarted');
    assert.equal(app.provider.state.containers[0].restarts, 1);

    await command(app, 'find store');
    await until(() => /❯ ● contosoprodstore\s+storage/.test(frame()) && /blobs\s+contosoprodstore\.blob\.core\.windows\.net/.test(frame()), 'the storage account');
    assert.match(frame(), /Standard_RAGRS/);
  } finally {
    app.unmount();
  }
});
