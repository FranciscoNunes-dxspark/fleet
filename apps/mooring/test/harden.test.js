// How well a server is hardened (harden.js, /harden, mooring security): each part's parse over what the
// tools print, the whole check over the demo host, the list and its detail, and the headless command.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readActivity } from '@fleet/kit/family.js';
import {
  addressScope,
  checkHardening,
  endOfLife,
  hardenCommand,
  hardenFindings,
  hardenScript,
  parseAptUpgradable,
  parseFirewall,
  parseListeners,
  parseOsRelease,
  parseRpmSecurity,
  parseSshdFiles,
  parseSshdT,
  sections,
} from '../src/harden.js';
import { demoSession } from '../src/demo.js';
import { parseArgs, resolveHost, runSecurity } from '../src/headless.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const N = 'n0nce';
// A script's output from parts: { name: [lines] }.
const out = (parts) => [...Object.entries({ id: ['1000', 'deploy'], ...parts }).flatMap(([k, v]) => [`@@${N} ${k}`, ...v]), `@@${N} end`, ''].join('\n');
const run = (parts) => hardenFindings(out(parts), { host: 'web', nonce: N, now: NOW });
const rules = (r) => r.findings.map((f) => `${f.severity} ${f.rule}`);

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('the script only reads, never prompts for sudo, and goes as base64 so no login shell can change it', () => {
  const script = hardenScript('abc');
  for (const part of ['ss -tulnpH', 'netstat -tulnp', '"$D" -T', '/etc/ssh/sshd_config.d/*.conf', 'apt list --upgradable', 'updateinfo list --security', '/var/run/reboot-required', 'ufw status', 'firewall-cmd', 'nft list ruleset', 'iptables -S', '/etc/passwd', '/etc/shadow', '/etc/sudoers.d/*', 'authorized_keys', '-perm -0002', '-perm -4000', 'docker.sock', '/etc/os-release']) assert.ok(script.includes(part), part);
  // sudo only as sudo -n, and only once a first sudo -n true said no password is needed.
  assert.doesNotMatch(script.replace(/sudo -n|has sudo|sudoers|echo sudo/g, ''), /sudo/);
  assert.match(script, /sudo -n true/);
  // Nothing that changes anything.
  assert.doesNotMatch(script, /\b(rm|chmod|chown|mv|tee|apt-get install|apt install|dnf install|systemctl (start|stop|restart|enable))\b/);
  // /etc/shadow's hashes stay on the server: awk prints only names.
  assert.match(script, /awk -F: '\$2==""\{print \$1\}' \/etc\/shadow/);
  const line = hardenCommand('abc');
  assert.match(line, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  assert.equal(Buffer.from(line.split(' ')[1], 'base64').toString(), script);
});

test("sections count only the run's own markers, so a file on the server can't fake one", () => {
  const s = sections(['@@abc os', 'ID=ubuntu', '@@evil passwd', '@@abc passwd', 'root:0:/root:/bin/bash', '@@abc passwd-x', '@@abc end'].join('\n'), 'abc');
  assert.deepEqual(s.os, ['ID=ubuntu', '@@evil passwd']);
  assert.deepEqual(s.passwd, ['root:0:/root:/bin/bash', '@@abc passwd-x']);
  assert.equal(hardenFindings('Permission denied\n', { host: 'web', nonce: 'abc' }).ran, false);
});

test('ss and netstat: addresses, scopes and processes', () => {
  const ss = parseListeners([
    'tcp   LISTEN 0      4096   0.0.0.0:22          0.0.0.0:*    users:(("sshd",pid=812,fd=3))',
    'tcp   LISTEN 0      4096   [::]:22             [::]:*       users:(("sshd",pid=812,fd=4))',
    'tcp   LISTEN 0      511    127.0.0.1:6379      0.0.0.0:*',
    'udp   UNCONN 0      0      127.0.0.53%lo:53    0.0.0.0:*',
    'tcp   LISTEN 0      80     10.0.0.5:3306       0.0.0.0:*',
    'tcp   LISTEN 0      80     *:2375              *:*',
    'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
  ]);
  assert.deepEqual(ss.map((l) => [l.proto, l.address, l.port, l.scope, l.process]), [
    ['tcp', '0.0.0.0', 22, 'any', 'sshd'],
    ['tcp', '::', 22, 'any', 'sshd'],
    ['tcp', '127.0.0.1', 6379, 'loopback', ''],
    ['udp', '127.0.0.53', 53, 'loopback', ''],
    ['tcp', '10.0.0.5', 3306, 'private', ''],
    ['tcp', '*', 2375, 'any', ''],
  ]);
  // ss -t alone has no Netid column.
  assert.deepEqual(parseListeners(['LISTEN 0 128 203.0.113.9:5432 0.0.0.0:*']).map((l) => [l.proto, l.port, l.scope]), [['tcp', 5432, 'public']]);
  const ns = parseListeners([
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:27017           0.0.0.0:*               LISTEN      901/mongod',
    'tcp6       0      0 :::9200                 :::*                    LISTEN      -',
    'tcp6       0      0 ::1:5432                :::*                    LISTEN      -',
    'udp        0      0 0.0.0.0:11211           0.0.0.0:*                           77/memcached',
  ]);
  assert.deepEqual(ns.map((l) => [l.proto, l.address, l.port, l.scope, l.process]), [
    ['tcp', '0.0.0.0', 27017, 'any', 'mongod'],
    ['tcp', '::', 9200, 'any', ''],
    ['tcp', '::1', 5432, 'loopback', ''],
    ['udp', '0.0.0.0', 11211, 'any', 'memcached'],
  ]);
  assert.deepEqual(['192.168.1.2', '172.20.0.1', '100.100.1.1', 'fd12::1', '8.8.8.8', '::ffff:127.0.0.1'].map(addressScope), ['private', 'private', 'private', 'private', 'public', 'loopback']);
});

test('listeners become findings: the Docker API critical, a database on every address high, on a private one medium, the rest low', () => {
  const r = run({
    listen: ['#tool ss', 'tcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:*', 'tcp LISTEN 0 1 [::]:22 [::]:*', 'tcp LISTEN 0 1 0.0.0.0:2375 0.0.0.0:*', 'tcp LISTEN 0 1 0.0.0.0:5432 0.0.0.0:*', 'tcp LISTEN 0 1 [::]:5432 [::]:*', 'tcp LISTEN 0 1 10.1.2.3:6379 0.0.0.0:*', 'tcp LISTEN 0 1 127.0.0.1:27017 0.0.0.0:*', 'tcp LISTEN 0 1 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=1,fd=1))', 'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*'],
    firewall: ['ufw Status: active'],
  });
  assert.deepEqual(rules(r), ['critical docker-api-exposed', 'high database-exposed', 'medium database-exposed', 'low public-listener']);
  const pg = r.findings[1];
  assert.equal(pg.title, 'PostgreSQL listens on 0.0.0.0, [::] port 5432/tcp');
  assert.equal(pg.where, 'web');
  assert.match(pg.fix, /127\.0\.0\.1.*sudo ufw deny 5432\/tcp/);
  assert.equal(pg.excerpt.split('\n').length, 2);
  assert.match(r.findings[3].title, /8080\/tcp .*\(java\)/);
  assert.ok(r.facts.includes('firewall: ufw'));
  assert.ok(run({ listen: ['#tool none'] }).unchecked.includes('what listens on the network (neither ss nor netstat is there)'));
});

test("sshd -T is believed when it runs; else the files, the first value winning, drop-ins where they're included, Match blocks left out", () => {
  const files = parseSshdFiles([
    '#file /etc/ssh/sshd_config',
    '# PermitRootLogin yes',
    'Include /etc/ssh/sshd_config.d/*.conf',
    'PasswordAuthentication yes',
    'PermitRootLogin yes',
    'Match Address 10.0.0.0/8',
    '  PermitEmptyPasswords yes',
    '#file /etc/ssh/sshd_config.d/10-hard.conf',
    'PasswordAuthentication no',
    'X11Forwarding = yes',
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v.value, v.file, v.line]])), {
    passwordauthentication: ['no', '/etc/ssh/sshd_config.d/10-hard.conf', 1],
    x11forwarding: ['yes', '/etc/ssh/sshd_config.d/10-hard.conf', 2],
    permitrootlogin: ['yes', '/etc/ssh/sshd_config', 4],
  });
  assert.deepEqual(parseSshdT(['sshd: no hostkeys available -- exiting.']), {});
  const r = run({
    sshd_t: ['port 22', 'permitrootlogin yes', 'passwordauthentication yes', 'permitemptypasswords yes', 'x11forwarding no', 'ciphers chacha20-poly1305@openssh.com,aes128-cbc,3des-cbc', 'macs hmac-sha2-256,hmac-md5', 'kexalgorithms curve25519-sha256,diffie-hellman-group1-sha1'],
    sshd_config: ['#file /etc/ssh/sshd_config', 'PermitRootLogin yes'],
  });
  assert.deepEqual(rules(r), ['critical ssh-empty-passwords', 'high ssh-root-login', 'medium ssh-password-auth', 'medium ssh-weak-crypto', 'medium ssh-weak-crypto', 'medium ssh-weak-crypto']);
  assert.equal(r.findings[1].where, 'web:/etc/ssh/sshd_config');
  assert.equal(r.findings[1].line, 1);
  assert.match(r.findings[3].title, /ciphers: aes128-cbc, 3des-cbc/);
  // From the files alone, an unset PasswordAuthentication is OpenSSH's default, yes; Protocol 1 is high.
  const f = run({ sshd_t: [], sshd_config: ['#file /etc/ssh/sshd_config', 'Protocol 2,1', 'X11Forwarding yes'] });
  assert.deepEqual(rules(f), ['high ssh-protocol-1', 'medium ssh-password-auth', 'low ssh-x11-forwarding']);
  assert.match(f.findings[1].why, /default is yes/);
  assert.equal(f.findings[1].line, undefined);
  assert.ok(run({}).unchecked.some((u) => u.startsWith("sshd's settings")));
});

test('updates: apt security origins, unattended-upgrades, dnf advisories, a reboot waiting', () => {
  const apt = parseAptUpgradable(['Listing...', 'openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]', 'vim/jammy-updates 2:8.2 amd64 [upgradable from: 2:8.1]', 'curl/bookworm-security 7.88.1-10+deb12u5 amd64 [upgradable from: 7.88.1-10+deb12u4]']);
  assert.deepEqual(apt.map((a) => [a.name, a.security]), [['openssl', true], ['vim', false], ['curl', true]]);
  const r = run({ pkg: ['apt'], apt: ['Listing...', 'openssl/jammy-security 3 amd64 [upgradable from: 2]'], unattended: ['unknown ok not-installed'], reboot: ['required', 'linux-image-6.8.0-50-generic'] });
  assert.deepEqual(rules(r), ['medium security-updates', 'medium reboot-required', 'low no-auto-updates']);
  assert.equal(r.findings[1].excerpt, 'linux-image-6.8.0-50-generic');
  assert.deepEqual(rules(run({ pkg: ['apt'], apt: [], unattended: ['install ok installed', 'APT::Periodic::Unattended-Upgrade "0";'] })), ['low no-auto-updates']);
  assert.deepEqual(rules(run({ pkg: ['apt'], apt: [], unattended: ['install ok installed', 'APT::Periodic::Unattended-Upgrade "1";'] })), []);

  const dnf = parseRpmSecurity(['RHSA-2024:1234 Important/Sec. openssl-libs-1:3.0.7-25.el9_3.x86_64', 'RHSA-2024:1234 Important/Sec. openssl-1:3.0.7-25.el9_3.x86_64', 'RHSA-2024:2001 Critical/Sec.  kernel-5.14.0-427.el9.x86_64', '#rc 0']);
  assert.deepEqual(dnf.advisories.map((a) => [a.id, a.severity]), [['RHSA-2024:1234', 'Important'], ['RHSA-2024:1234', 'Important'], ['RHSA-2024:2001', 'Critical']]);
  const d = run({ pkg: ['dnf'], rpmsec: ['RHSA-2024:2001 Critical/Sec. kernel-5.14.0-427.el9.x86_64', 'RHSA-2024:1234 Important/Sec. openssl-libs', '#rc 0'] });
  assert.deepEqual(rules(d), ['high security-updates']);
  assert.match(d.findings[0].title, /2 security advisories waiting, some critical/);
  assert.match(d.findings[0].fix, /sudo dnf upgrade --security/);
  // dnf without its cache can't tell, which is not a finding.
  const none = run({ pkg: ['dnf'], rpmsec: ['#rc 1'] });
  assert.deepEqual(rules(none), []);
  assert.ok(none.unchecked.some((u) => u.includes("couldn't read its cache")));
});

test("a firewall: on, off, or couldn't tell (never a finding when it needs root to read)", () => {
  assert.deepEqual(parseFirewall(['ufw-installed', 'ufw Status: active']).active, ['ufw']);
  assert.deepEqual(parseFirewall(['ufw-installed', 'ufw.conf ENABLED=yes']).active, ['ufw']);
  assert.deepEqual(parseFirewall(['firewalld active']).active, ['firewalld']);
  assert.deepEqual(parseFirewall(['nft ok', 'nft \t\tchain input { type filter hook input priority filter; policy drop;']).active, ['nftables']);
  assert.deepEqual(parseFirewall(['iptables ok', 'iptables -P INPUT ACCEPT', 'iptables -A INPUT -j ufw-before-input']).active, ['iptables']);
  const off = parseFirewall(['ufw-installed', 'ufw Status: inactive', 'firewalld inactive', 'nft ok', 'iptables ok', 'iptables -P INPUT ACCEPT']);
  assert.deepEqual([off.active, off.certain], [[], true]);
  const unsure = parseFirewall(['ufw-installed', 'nft unreadable', 'iptables unreadable']);
  assert.deepEqual([unsure.certain, unsure.unreadable], [false, ['ufw', 'nftables', 'iptables']]);

  const listen = ['#tool ss', 'tcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:*', 'tcp LISTEN 0 1 0.0.0.0:80 0.0.0.0:*'];
  assert.deepEqual(rules(run({ listen, firewall: ['ufw Status: inactive', 'iptables ok', 'iptables -P INPUT ACCEPT'] })), ['medium no-firewall']);
  const cant = run({ listen, firewall: ['iptables unreadable'] });
  assert.deepEqual(rules(cant), []);
  assert.ok(cant.unchecked.some((u) => u.startsWith('whether a firewall is on')));
  // Nothing listening beyond this machine but a DHCP client: no firewall is no finding.
  assert.deepEqual(rules(run({ listen: ['#tool ss', 'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*', 'tcp LISTEN 0 1 127.0.0.1:5432 0.0.0.0:*'], firewall: [] })), []);
});

test('accounts: a second uid 0, empty passwords, sudo without a password, keys per user', () => {
  const r = run({
    passwd: ['root:0:/root:/bin/bash', 'toor:0:/root:/bin/sh', 'deploy:1000:/home/deploy:/bin/bash'],
    shadow: ['#readable', 'guest'],
    sudoers: ['#readable', '/etc/sudoers.d/90-cloud-init-users: deploy ALL=(ALL) NOPASSWD:ALL', '/etc/sudoers: backup ALL=(root) NOPASSWD: /usr/bin/rsync'],
    keys: ['root 1', 'deploy 3', 'git ?'],
  });
  assert.deepEqual(rules(r), ['critical uid0-account', 'high empty-password', 'medium sudo-nopasswd', 'low sudo-nopasswd']);
  assert.equal(r.findings[0].where, 'web:/etc/passwd');
  assert.equal(r.findings[2].where, 'web:/etc/sudoers.d/90-cloud-init-users');
  assert.match(r.findings[2].fix, /visudo -f \/etc\/sudoers\.d\/90-cloud-init-users/);
  assert.match(r.findings[3].fix, /visudo$/);
  assert.ok(r.facts.includes("authorized_keys: root 1, deploy 3, git (couldn't read)"));
  // Unreadable without root: couldn't tell, no finding.
  const u = run({ shadow: ['#unreadable'], sudoers: ['#unreadable'] });
  assert.deepEqual(rules(u), []);
  assert.ok(u.unchecked.includes('accounts with an empty password (/etc/shadow needs root)'));
  assert.ok(u.unchecked.includes('sudo rules without a password (/etc/sudoers needs root)'));
});

test('files: world-writable, SUID outside the usual list, the docker socket and group', () => {
  const r = run({
    worldwritable: ['/etc/cron.d/backup', '/usr/local/bin/deploy.sh'],
    suid: ['/usr/bin/sudo', '/usr/bin/passwd', '/usr/lib/openssh/ssh-keysign', '/opt/tool/bin/helper', '/tmp/.x/bash'],
    docker: ['srw-rw-rw- 1 0 998 0 Nov  3 09:00 /var/run/docker.sock', 'group docker:x:998:deploy,ci'],
  });
  assert.deepEqual(rules(r), ['critical docker-socket-open', 'high world-writable', 'high unusual-suid', 'high world-writable', 'low docker-group', 'low unusual-suid']);
  assert.equal(r.findings[1].where, 'web:/etc/cron.d/backup');
  assert.equal(r.findings[1].fix, 'sudo chmod o-w /etc/cron.d/backup');
  assert.match(r.findings[2].title, /\/tmp\/\.x\/bash .*from a place users write to/);
  assert.match(r.findings[4].title, /deploy, ci/);
  assert.equal(r.findings[5].where, 'web:/opt/tool/bin/helper');
  assert.deepEqual(rules(run({ docker: ['srw-rw---- 1 0 998 0 Nov  3 09:00 /run/docker.sock', 'group docker:x:998:'] })), []);
});

test("the OS's end of life: from os-release, against the day the check runs", () => {
  const os = (lines) => parseOsRelease(lines);
  assert.equal(endOfLife(os(['ID=ubuntu', 'VERSION_ID="18.04"'])), '2023-05-31');
  assert.equal(endOfLife(os(['ID=ubuntu', 'VERSION_ID="23.10"'])), '2024-07-31');
  assert.equal(endOfLife(os(['ID=debian', 'VERSION_ID="10"'])), '2024-06-30');
  assert.equal(endOfLife(os(['ID="centos"', 'NAME="CentOS Linux"', 'VERSION_ID="7"'])), '2024-06-30');
  assert.equal(endOfLife(os(['ID="centos"', 'NAME="CentOS Stream"', 'VERSION_ID="9"'])), '2027-05-31');
  assert.equal(endOfLife(os(['ID="rhel"', 'VERSION_ID="8.9"'])), '2029-05-31');
  assert.equal(endOfLife(os(['ID=alpine', 'VERSION_ID=3.12.12'])), '2023-11-01');
  assert.equal(endOfLife(os(['ID="amzn"', 'VERSION_ID="2"'])), '2026-06-30');
  assert.equal(endOfLife(os(['ID=arch'])), null);
  const old = run({ os: ['NAME="CentOS Linux"', 'ID="centos"', 'VERSION_ID="7"', 'PRETTY_NAME="CentOS Linux 7 (Core)"'] });
  assert.deepEqual(rules(old), ['high os-end-of-life']);
  assert.equal(old.findings[0].where, 'web:/etc/os-release');
  assert.match(old.findings[0].title, /CentOS Linux 7 \(Core\) no longer gets security updates/);
  assert.deepEqual(rules(run({ os: ['ID=ubuntu', 'VERSION_ID="24.04"'] })), []);
});

test("a server's escapes are cleaned from what is kept", () => {
  const r = run({ worldwritable: ['/etc/\x1b]0;evil\x07motd'], passwd: ['\x1b[31mevil:0:/:/bin/sh'] });
  assert.ok(r.findings.every((f) => !/\x1b|\x07/.test(`${f.title}${f.where}${f.excerpt ?? ''}`)));
});

test('the whole check over the demo host, and its findings in findings.js\'s shape', async () => {
  const session = demoSession();
  const r = await checkHardening(session, { host: 'demo', now: NOW });
  assert.equal(r.ran, true);
  assert.deepEqual(new Set(r.findings.map((f) => f.rule)), new Set(['uid0-account', 'database-exposed', 'world-writable', 'os-end-of-life', 'ssh-root-login', 'security-updates', 'no-firewall', 'ssh-password-auth', 'reboot-required', 'public-listener', 'docker-group', 'ssh-x11-forwarding', 'unusual-suid']));
  for (const f of r.findings) {
    assert.ok(['critical', 'high', 'medium', 'low'].includes(f.severity), f.rule);
    assert.ok(f.where === 'demo' || f.where.startsWith('demo:/'), f.where);
    assert.ok(f.title && f.why && f.fix, f.rule);
  }
  // The Match block's PermitEmptyPasswords doesn't count; the drop-in's PasswordAuthentication does.
  assert.equal(r.findings.find((f) => f.rule === 'ssh-password-auth').where, 'demo:/etc/ssh/sshd_config.d/50-cloud-init.conf');
  assert.equal(session.state.calls.filter((c) => c[0] === 'exec').length, 1);
});

test('/harden lists the findings worst first; ↵ shows one with what was seen, esc comes back, y copies, r checks again', async () => {
  const app = start();
  await until(shows(app, 'demo  /home/demo'), 'the host connected');
  await type(app.stdin, '/harden');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Hardening · demo'), 'the list');
  let frame = app.lastFrame();
  assert.match(frame, /1 critical · 4 high · 4 medium · 4 low/);
  const at = (text) => frame.indexOf(text);
  assert.ok(at('CRIT') < at('HIGH') && at('HIGH') < at('MED ') && at('MED ') < at('LOW'), frame);
  assert.match(frame, /toor has user id 0/);
  // The first row is the worst: its detail, with the fix and the line it was seen in.
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Fix: If it'), 'the detail');
  frame = app.lastFrame();
  assert.match(frame, /where  demo:\/etc\/passwd/);
  assert.match(frame, /Seen:/);
  assert.match(frame, /toor:0:\/root:\/bin\/bash/);
  app.stdin.write(KEYS.esc);
  await until(() => shows(app, 'Hardening · demo')() && !app.lastFrame().includes('Fix: If it'), 'back to the list');
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'copied');
  assert.match(app.copied[0], /^Hardening of demo/);
  assert.match(app.copied[0], /CRIT toor has user id 0/);
  assert.match(app.copied[0], /Couldn't tell:/);
  app.stdin.write('r');
  await until(() => app.host.state.calls.filter((c) => c[0] === 'exec').length === 2, 'checked again');
  // Nothing about the check goes in the family's activity log.
  assert.ok(!readActivity().some((e) => /harden/i.test(e.text ?? '')));
  app.unmount();
});

test('/harden needs a connection', async () => {
  const app = start({ connectTo: undefined });
  await until(shows(app, 'Files'), 'started');
  await type(app.stdin, '/harden');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Not connected'), 'the note');
  app.unmount();
});

test('mooring security: its arguments, the host it means', () => {
  assert.deepEqual(parseArgs(['web', '--json', '--fail-on', 'MEDIUM']), { target: 'web', json: true, failOn: 'medium' });
  assert.match(parseArgs(['web', '--fail-on', 'bad']).error, /--fail-on is one of/);
  assert.match(parseArgs([]).error, /Which host/);
  assert.match(parseArgs(['a', 'b']).error, /One host at a time/);
  const hosts = [{ name: 'web', host: 'web.example.com', user: 'me' }];
  assert.equal(resolveHost('we', hosts).host.name, 'web');
  assert.deepEqual(resolveHost('ci@10.0.0.7:2222', hosts).host, { name: 'ci@10.0.0.7:2222', user: 'ci', host: '10.0.0.7', port: 2222 });
  assert.match(resolveHost('nope', hosts).error, /no saved host nope \(web\)/);
  assert.match(resolveHost('-oProxyCommand=x@h', hosts).error, /dash/);
});

test('mooring security over the demo host: text, --json, --fail-on, and what it refuses', async () => {
  const config = { hosts: [{ name: 'demo', host: 'demo.example.com', user: 'demo' }, { name: 'secure', host: 'secure.example.com', password: true }] };
  let text = '';
  const write = (s) => (text += s);
  const code = await runSecurity(['demo'], { config, makeSession: () => demoSession(), write, now: NOW });
  assert.equal(code, 1);
  assert.match(text, /^Hardening of demo \(demo@demo\.example\.com\)/);
  assert.match(text, /CRIT toor has user id 0/);
  assert.match(text, /failing on high and above/);
  assert.match(text, /Couldn't tell:/);

  text = '';
  assert.equal(await runSecurity(['demo', '--json', '--fail-on', 'none'], { config, makeSession: () => demoSession(), write, now: NOW }), 0);
  const json = JSON.parse(text);
  assert.equal(json.app, 'mooring');
  assert.equal(json.check, 'harden');
  assert.equal(json.target, 'demo');
  assert.equal(json.host, 'demo@demo.example.com');
  assert.equal(json.at, NOW.toISOString());
  assert.deepEqual(json.counts, { critical: 1, high: 4, medium: 4, low: 4, unknown: 0 });
  assert.equal(json.findings[0].rule, 'uid0-account');
  assert.ok(json.findings.every((f) => !('excerpt' in f)));
  assert.ok(Array.isArray(json.facts) && Array.isArray(json.unchecked));

  // A password host has no one to ask; a session that fails is exit 2 with ssh's words.
  text = '';
  assert.equal(await runSecurity(['secure'], { config, makeSession: () => assert.fail('no session'), write }), 2);
  assert.match(text, /signs in with a password/);
  text = '';
  const failing = { exec: async () => Promise.reject(new Error('Permission denied (publickey).\nmore')), close: () => {} };
  assert.equal(await runSecurity(['demo'], { config, makeSession: () => failing, write }), 2);
  assert.equal(text, 'mooring security: Permission denied (publickey).\n');
  text = '';
  assert.equal(await runSecurity(['demo'], { config, makeSession: () => ({ exec: async () => ({ code: 127, stdout: '', stderr: 'sh: base64: not found' }) }), write }), 2);
  assert.match(text, /needs sh and base64/);
});
