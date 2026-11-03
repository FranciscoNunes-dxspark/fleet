// How well a Linux server is hardened (/harden, `mooring security <host>`): one script, sent over the
// session's exec as `echo <base64> | base64 -d | sh` (so no login shell's quoting can change it), prints
// each part under a marker line, and the pure parse of what it printed into findings.js's shape.
//
// The script only reads. Each part tolerates its tool being absent and the user not being root: sudo is
// used only as `sudo -n` (never a prompt), only where a first `sudo -n true` said it needs no password,
// and only after the command failed as this user. What can't be read is "couldn't tell" (`unchecked`),
// never a finding. /etc/shadow's hashes never leave the server: awk prints only the names with an empty one.
//
// What a server prints is untrusted: every marker carries a nonce made for the run (a file on the server
// can't fake a section), and every text kept goes through format.js plainText.
import { plainText } from './format.js';
import { sortFindings } from '@fleet/kit/findings.js';

/** The script, with the run's `nonce` in its markers. */
export function hardenScript(nonce) {
  return [
    '{',
    `N=${nonce}`,
    'export LC_ALL=C',
    'PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"',
    'm() { echo "@@$N $1"; }',
    'has() { command -v "$1" >/dev/null 2>&1; }',
    'T=""; has timeout && T="timeout 20"',
    // sudo only when it needs no password: one `sudo -n true`, never a prompt.
    'S=""; if [ "$(id -u)" != 0 ] && has sudo && sudo -n true >/dev/null 2>&1; then S=1; fi',
    'try() { "$@" 2>/dev/null && return 0; [ -n "$S" ] && sudo -n "$@" 2>/dev/null; }',
    'm id; id -u; id -un; [ -n "$S" ] && echo sudo',
    'm os; cat /etc/os-release 2>/dev/null',
    'm kernel; uname -sr 2>/dev/null',
    'm listen',
    'if has ss; then echo "#tool ss"; ss -tulnpH 2>/dev/null || ss -tulnp 2>/dev/null',
    'elif has netstat; then echo "#tool netstat"; netstat -tulnp 2>/dev/null || netstat -tuln 2>/dev/null',
    'else echo "#tool none"; fi',
    'm sshd_t',
    'D=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)',
    '[ -x "$D" ] && try $T "$D" -T',
    'm sshd_config',
    'for f in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do [ -r "$f" ] && { echo "#file $f"; cat "$f"; }; done',
    'm pkg',
    'if has apt-get; then echo apt',
    '  m apt; $T apt list --upgradable 2>/dev/null',
    "  m unattended; dpkg-query -W -f='${Status}\\n' unattended-upgrades 2>/dev/null; cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null",
    'elif has dnf; then echo dnf; m rpmsec; $T dnf -q -C updateinfo list --security 2>/dev/null; echo "#rc $?"',
    'elif has yum; then echo yum; m rpmsec; $T yum -q -C updateinfo list security 2>/dev/null; echo "#rc $?"',
    'fi',
    'm reboot',
    '[ -f /var/run/reboot-required ] && { echo required; cat /var/run/reboot-required.pkgs 2>/dev/null; }',
    'if has needs-restarting; then $T needs-restarting -r >/dev/null 2>&1; [ $? = 1 ] && echo required; fi',
    'm firewall',
    'if has ufw; then echo ufw-installed; s=$(try ufw status | head -n 1); [ -n "$s" ] && echo "ufw $s"; grep -i "^ENABLED=" /etc/ufw/ufw.conf 2>/dev/null | sed "s/^/ufw.conf /"; fi',
    'if has firewall-cmd; then echo "firewalld $(systemctl is-active firewalld 2>/dev/null)"; fi',
    'if has nft; then if r=$(try nft list ruleset); then echo "nft ok"; printf "%s\\n" "$r" | grep "hook input" | head -n 20 | sed "s/^/nft /"; else echo "nft unreadable"; fi; fi',
    'if has iptables; then if r=$(try iptables -S); then echo "iptables ok"; printf "%s\\n" "$r" | grep -E "^-(P|A) INPUT" | head -n 40 | sed "s/^/iptables /"; else echo "iptables unreadable"; fi; fi',
    'm passwd; awk -F: \'{print $1":"$3":"$6":"$7}\' /etc/passwd 2>/dev/null',
    'm shadow',
    'if r=$(try awk -F: \'$2==""{print $1}\' /etc/shadow); then echo "#readable"; printf "%s\\n" "$r"; else echo "#unreadable"; fi',
    'm sudoers',
    'if try cat /etc/sudoers >/dev/null; then echo "#readable"',
    '  for f in /etc/sudoers /etc/sudoers.d/*; do r=$(try cat "$f") || continue; printf "%s\\n" "$r" | grep -v "^[[:space:]]*#" | grep NOPASSWD | head -n 20 | sed "s|^|$f: |"; done',
    'else echo "#unreadable"; fi',
    'm keys',
    'awk -F: \'$7 !~ /(nologin|false|sync|halt|shutdown)$/ {print $1" "$6}\' /etc/passwd 2>/dev/null | while read u h; do',
    '  f="$h/.ssh/authorized_keys"',
    '  if r=$(try cat "$f"); then echo "$u $(printf "%s\\n" "$r" | grep -cvE "^[[:space:]]*(#|$)")"',
    '  elif [ -e "$f" ] || { [ -d "$h/.ssh" ] && [ ! -x "$h/.ssh" ]; } || { [ -d "$h" ] && [ ! -x "$h" ]; }; then echo "$u ?"; fi',
    'done',
    'm worldwritable',
    '$T find /etc /usr/local/bin /usr/local/sbin -xdev -maxdepth 4 -type f -perm -0002 2>/dev/null | head -n 50',
    'm suid',
    '$T find / /usr /home /var /opt /srv /tmp -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /snap \\) -prune -o -type f -perm -4000 -print 2>/dev/null | sort -u | head -n 200',
    'm docker',
    'for s in /var/run/docker.sock /run/docker.sock; do [ -S "$s" ] && { ls -lnL "$s" 2>/dev/null; break; }; done',
    'getent group docker 2>/dev/null | sed "s/^/group /"',
    'm end',
    '} </dev/null',
    '',
  ].join('\n');
}

/** The one line session.exec runs: the script as base64, decoded and run by sh on the server. */
export const hardenCommand = (nonce) => `echo ${Buffer.from(hardenScript(nonce)).toString('base64')} | base64 -d | sh`;

/** A nonce for a run's markers. */
export const newNonce = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** The script's output as { name: [lines] }; only markers with the run's nonce count. */
export function sections(text, nonce) {
  const out = {};
  const mark = `@@${nonce} `;
  let at = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(mark) && /^\w+$/.test(line.slice(mark.length))) {
      at = line.slice(mark.length);
      out[at] ??= [];
    } else if (at) out[at].push(line);
  }
  return out;
}

const clean = (s) => plainText(String(s ?? '')).trim();

// ---------------------------------------------------------------------------------------------------
// Listening sockets

// Ports whose service should never face the network: a database, a cache, a cluster's control plane.
export const SENSITIVE_PORTS = {
  2375: 'the Docker API (unencrypted)',
  3306: 'MySQL/MariaDB',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  9200: 'Elasticsearch',
  9300: 'Elasticsearch (transport)',
  11211: 'Memcached',
  1433: 'SQL Server',
  2379: 'etcd',
  5984: 'CouchDB',
};
// What a server is expected to have open, and DHCP and mDNS clients: not worth a finding of their own.
const EXPECTED = new Set(['tcp/22', 'tcp/80', 'tcp/443', 'udp/68', 'udp/546', 'udp/5353', 'udp/123']);

/** `0.0.0.0:22`, `[::]:22`, `*:22`, `:::22`, `127.0.0.53%lo:53` as { address, port }. */
export function splitAddress(text) {
  const t = String(text ?? '');
  const i = t.lastIndexOf(':');
  if (i < 0) return null;
  const port = Number(t.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  const address = t.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '') || '*';
  return { address, port };
}

/** 'loopback', 'any' (every address), 'private' (RFC 1918, CGNAT, link-local, ULA) or 'public'. */
export function addressScope(address) {
  const a = String(address).toLowerCase().replace(/^::ffff:/, '');
  if (a === '*' || a === '0.0.0.0' || a === '::') return 'any';
  if (/^127\./.test(a) || a === '::1' || a === 'localhost') return 'loopback';
  if (/^(10\.|192\.168\.|169\.254\.)/.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return 'private';
  return 'public';
}

/** ss's or netstat's lines as [{ proto, address, port, scope, process, line }]. */
export function parseListeners(lines = []) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const w = line.split(/\s+/);
    let proto;
    let local;
    let process = '';
    if (/^(tcp|udp)6?$/.test(w[0]) && /^\d+$/.test(w[1] ?? '')) {
      // netstat: proto recv-q send-q local foreign [state] [pid/program]
      proto = w[0].replace('6', '');
      local = w[3];
      if (proto === 'tcp' && w[5] !== 'LISTEN') continue;
      const p = w.at(-1);
      if (/^\d+\/.+/.test(p)) process = p.split('/').slice(1).join('/');
    } else if (/^(tcp|udp)$/.test(w[0])) {
      // ss with its Netid column: netid state recv-q send-q local peer [process]
      proto = w[0];
      local = w[4];
    } else if (/^(LISTEN|UNCONN)$/.test(w[0])) {
      // ss -t or -u alone: state recv-q send-q local peer [process]
      proto = w[0] === 'LISTEN' ? 'tcp' : 'udp';
      local = w[3];
    } else continue;
    if (!process) process = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? '';
    const at = splitAddress(local);
    if (!at) continue;
    out.push({ proto, address: at.address, port: at.port, scope: addressScope(at.address), process: clean(process), line: clean(line) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// sshd

const SSHD_MAIN = '/etc/ssh/sshd_config';

/**
 * sshd's configuration files, as the script printed them (`#file <path>` before each), as the
 * settings sshd would take: the first value of a keyword wins, a drop-in folder's files come where the
 * main file Includes them, and nothing under a `Match` counts (it applies only to some connections).
 * { keyword (lower case): { value, file, line, text } }.
 */
export function parseSshdFiles(lines = []) {
  const files = [];
  for (const raw of lines) {
    const m = /^#file (\S+)$/.exec(raw);
    if (m) files.push({ path: m[1], lines: [] });
    else files.at(-1)?.lines.push(raw);
  }
  const main = files.find((f) => f.path === SSHD_MAIN);
  const dropIns = files.filter((f) => f !== main);
  const order = [];
  let included = false;
  for (const [i, text] of (main?.lines ?? []).entries()) {
    if (/^\s*include\s+\S*sshd_config\.d/i.test(text) && !included) {
      included = true;
      for (const d of dropIns) order.push(...d.lines.map((t, j) => ({ file: d.path, line: j + 1, text: t })));
    } else order.push({ file: SSHD_MAIN, line: i + 1, text });
  }
  if (!included) for (const d of dropIns) order.push(...d.lines.map((t, j) => ({ file: d.path, line: j + 1, text: t })));
  const out = {};
  let matching = null;
  for (const o of order) {
    if (o.file !== matching?.file) matching = null;
    const t = o.text.replace(/#.*$/, '').trim();
    if (!t) continue;
    const m = /^(\w+)\s*=?\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'match') {
      matching = o;
      continue;
    }
    if (matching || key in out) continue;
    out[key] = { value: m[2].trim(), file: o.file, line: o.line, text: clean(o.text) };
  }
  return out;
}

/** `sshd -T`'s lines as { keyword: value } (empty when it couldn't run). */
export function parseSshdT(lines = []) {
  const out = {};
  for (const l of lines) {
    const m = /^([a-z0-9]+)\s+(.*)$/.exec(l.trim());
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return 'permitrootlogin' in out ? out : {};
}

const WEAK = {
  ciphers: /^(3des-cbc|aes\d+-cbc|blowfish-cbc|cast128-cbc|arcfour\w*|rijndael-cbc@lysator\.liu\.se)$/,
  macs: /^(hmac-md5\S*|hmac-sha1-96\S*|umac-64\S*|hmac-ripemd160\S*)$/,
  kexalgorithms: /^(diffie-hellman-group1-sha1|diffie-hellman-group14-sha1|diffie-hellman-group-exchange-sha1)$/,
};

// ---------------------------------------------------------------------------------------------------
// Packages and updates

/** `apt list --upgradable`'s lines: [{ name, security, line }]. */
export function parseAptUpgradable(lines = []) {
  return lines
    .map((l) => /^([^\s/]+)\/(\S+)\s+\S+/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ name: clean(m[1]), security: /-security(,|$)/.test(m[2]), line: clean(m[0]) }));
}

/** `dnf/yum updateinfo list security`'s lines: { advisories: [{ id, severity, pkg }], ok } (`ok` false when it failed and said nothing). */
export function parseRpmSecurity(lines = []) {
  const rc = lines.map((l) => /^#rc (\d+)$/.exec(l.trim())).find(Boolean);
  const advisories = lines
    .map((l) => /^(\S+-\d{4}[:-]\S+)\s+(\S+)\s+(\S+)/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ id: clean(m[1]), severity: clean(m[2]).replace(/\/Sec\.$/, ''), pkg: clean(m[3]) }));
  return { advisories, ok: advisories.length > 0 || !rc || rc[1] === '0' };
}

// ---------------------------------------------------------------------------------------------------
// Firewall

/** The firewall section: { active: [names], certain (that none is active), unreadable: [names], lines }. */
export function parseFirewall(lines = []) {
  const has = (re) => lines.some((l) => re.test(l));
  const active = [];
  const unreadable = [];
  const ufwStatus = lines.find((l) => /^ufw Status:/.test(l));
  if (ufwStatus ? /Status: active/.test(ufwStatus) : has(/^ufw\.conf ENABLED=yes/i)) active.push('ufw');
  if (has(/^ufw-installed$/) && !ufwStatus && !has(/^ufw\.conf /i)) unreadable.push('ufw');
  if (has(/^firewalld active$/)) active.push('firewalld');
  if (has(/^nft unreadable/)) unreadable.push('nftables');
  if (lines.some((l) => /^nft .*hook input.*policy drop/.test(l))) active.push('nftables');
  if (has(/^iptables unreadable/)) unreadable.push('iptables');
  const rules = lines.filter((l) => l.startsWith('iptables -'));
  if (rules.some((l) => /-P INPUT (DROP|REJECT)/.test(l) || /-A INPUT .*-j (DROP|REJECT|ufw-|INPUT_)/.test(l))) active.push('iptables');
  return { active: [...new Set(active)], certain: !active.length && !unreadable.length, unreadable, lines: lines.map(clean).filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------------
// The operating system's end of life

// When each release stopped getting security updates from its maker (Ubuntu: standard support; ESM
// with Ubuntu Pro goes on longer, which the server can't say here).
const EOL = {
  ubuntu: { '14.04': '2019-04-30', '16.04': '2021-04-30', '18.04': '2023-05-31', '20.04': '2025-05-31', '22.04': '2027-06-30', '24.04': '2029-05-31' },
  debian: { 7: '2018-05-31', 8: '2020-06-30', 9: '2022-06-30', 10: '2024-06-30', 11: '2026-08-31', 12: '2028-06-30', 13: '2030-06-30' },
  centos: { 5: '2017-03-31', 6: '2020-11-30', 7: '2024-06-30', 8: '2021-12-31' },
  'centos-stream': { 8: '2024-05-31', 9: '2027-05-31' },
  rhel: { 6: '2020-11-30', 7: '2024-06-30', 8: '2029-05-31', 9: '2032-05-31' },
  rocky: { 8: '2029-05-31', 9: '2032-05-31' },
  almalinux: { 8: '2029-05-31', 9: '2032-05-31' },
  amzn: { 2018.03: '2023-12-31', 2: '2026-06-30' },
  alpine: { '3.15': '2023-11-01', '3.16': '2024-05-23', '3.17': '2024-11-22', '3.18': '2025-05-09', '3.19': '2025-11-01', '3.20': '2026-04-01', '3.21': '2026-11-01', '3.22': '2027-05-01' },
};

/** /etc/os-release's lines as { id, version, name, pretty }. */
export function parseOsRelease(lines = []) {
  const kv = {};
  for (const l of lines) {
    const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(l.trim());
    if (m) kv[m[1]] = clean(m[3]);
  }
  return { id: (kv.ID ?? '').toLowerCase(), version: kv.VERSION_ID ?? '', name: kv.NAME ?? '', pretty: kv.PRETTY_NAME ?? '' };
}

/** When the release in `os` stopped (or will stop) getting security updates: 'YYYY-MM-DD', or null when not known. */
export function endOfLife(os) {
  const { id, version, name } = os;
  if (id === 'ubuntu') {
    if (EOL.ubuntu[version]) return EOL.ubuntu[version];
    const m = /^(\d+)\.(\d+)$/.exec(version);
    if (!m) return null;
    const [yy, mm] = [Number(m[1]), Number(m[2])];
    // An LTS (an even year's April) has five years; the releases between have nine months.
    const lts = mm === 4 && yy % 2 === 0;
    const end = new Date(Date.UTC(2000 + yy + (lts ? 5 : 0), mm - 1 + (lts ? 0 : 9) + 1, 0));
    return end.toISOString().slice(0, 10);
  }
  if (id === 'alpine') {
    const mm = /^(\d+\.\d+)/.exec(version)?.[1];
    if (!mm) return null;
    if (EOL.alpine[mm]) return EOL.alpine[mm];
    const [a, b] = mm.split('.').map(Number);
    return a < 3 || (a === 3 && b < 15) ? '2023-11-01' : null;
  }
  const table = id === 'centos' && /stream/i.test(name) ? EOL['centos-stream'] : EOL[id];
  if (!table) return null;
  return table[version] ?? table[version.split('.')[0]] ?? null;
}

// ---------------------------------------------------------------------------------------------------
// SUID binaries a Linux distribution ships

const KNOWN_SUID = new Set([
  'sudo', 'sudoedit', 'su', 'passwd', 'chsh', 'chfn', 'newgrp', 'gpasswd', 'chage', 'expiry', 'mount', 'umount', 'ping', 'ping6', 'traceroute6.iputils', 'pkexec',
  'fusermount', 'fusermount3', 'ssh-keysign', 'dbus-daemon-launch-helper', 'polkit-agent-helper-1', 'snap-confine', 'Xorg.wrap', 'at', 'crontab', 'unix_chkpwd',
  'newuidmap', 'newgidmap', 'mount.nfs', 'mount.cifs', 'mount.ecryptfs_private', 'pam_timestamp_check', 'userhelper', 'staprun', 'chrome-sandbox', 'ntfs-3g',
  'pppd', 'exim4', 'vmware-user-suid-wrapper', 'ksu', 'usernetctl', 'grub2-set-bootflag', 'Xorg', 'lxc-user-nic', 'doas', 'suexec', 'cockpit-session',
  'qemu-bridge-helper', 'firejail', 'bwrap', 'nvidia-modprobe', 'kismet_cap_linux_wifi', 'dmcrypt-get-device', 'umount.nfs', 'mount.nfs4', 'umount.nfs4',
]);
// A SUID file where anyone may write is someone's way to root.
const WRITABLE_PLACE = /^\/(tmp|var\/tmp|dev\/shm|home)\//;

// ---------------------------------------------------------------------------------------------------
// Findings

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the script printed, as { findings, facts, unchecked, ran }: findings.js's shape (`where` the
 * host, or host:path; `excerpt` the lines seen), what was seen that isn't a finding (`facts`, lines to
 * show), and what couldn't be told (`unchecked`). Findings come worst first. `ran` is false when the script printed nothing of its own.
 */
export function hardenFindings(text, { host, nonce, now = new Date() }) {
  const s = sections(text, nonce);
  const findings = [];
  const facts = [];
  const unchecked = [];
  if (!s.id) return { findings, facts, unchecked: ['The check didn\'t run on the server: it needs sh and base64 there (a Linux server has both).'], ran: false };
  const at = (path) => (path ? `${host}:${path}` : host);
  const add = (f) => findings.push({ ...f, where: f.where ?? host, excerpt: f.excerpt ? [].concat(f.excerpt).map(clean).filter(Boolean).slice(0, 30).join('\n') : undefined });

  // Who ran it: root, someone with sudo -n, or someone who can't read root's files.
  const [uid, user] = (s.id ?? []).map((l) => l.trim());
  const root = uid === '0';
  const sudo = (s.id ?? []).some((l) => l.trim() === 'sudo');
  facts.push(`checked as ${clean(user) || '?'}${root ? (clean(user) === 'root' ? '' : ' (root)') : sudo ? ' (sudo without a password, used to read what root alone can)' : ' (not root: what only root can read is left out)'}`);

  // The OS and its end of life.
  const os = parseOsRelease(s.os);
  const kernel = clean((s.kernel ?? [])[0]);
  facts.push([os.pretty || os.name || 'an unknown system', kernel].filter(Boolean).join(' · '));
  const eol = endOfLife(os);
  if (eol && eol <= now.toISOString().slice(0, 10)) {
    add({
      rule: 'os-end-of-life',
      severity: 'high',
      title: `${os.pretty || `${os.name} ${os.version}`} no longer gets security updates`,
      where: at('/etc/os-release'),
      why: `Its maker stopped fixing it on ${eol}${os.id === 'ubuntu' ? ' (standard support; Ubuntu Pro\'s ESM extends it, if this server has it)' : ''}: vulnerabilities found since stay open.`,
      fix: os.id === 'ubuntu' ? 'Upgrade the release: sudo do-release-upgrade (or move the service to a new server), or attach Ubuntu Pro: sudo pro attach' : os.id === 'debian' ? 'Upgrade to the next Debian release (apt full-upgrade after pointing sources.list at it), or move to a new server' : 'Move to a supported release (a new server, or the distribution\'s upgrade tool, e.g. leapp for CentOS/RHEL 7)',
      excerpt: (s.os ?? []).filter((l) => /^(NAME|VERSION|VERSION_ID|PRETTY_NAME)=/.test(l)),
    });
  } else if (!os.id) unchecked.push('which system this is (no /etc/os-release)');

  // Listening sockets.
  const tool = (s.listen ?? []).find((l) => l.startsWith('#tool '))?.slice(6).trim();
  const listeners = parseListeners(s.listen);
  if (!tool || tool === 'none') unchecked.push('what listens on the network (neither ss nor netstat is there)');
  const exposed = listeners.filter((l) => l.scope !== 'loopback');
  const byPort = new Map();
  for (const l of exposed) {
    const key = `${l.proto}/${l.port}`;
    const was = byPort.get(key);
    if (!was) byPort.set(key, { ...l, lines: [l.line], addresses: [l.address], scopes: [l.scope] });
    else {
      was.lines.push(l.line);
      was.addresses.push(l.address);
      was.scopes.push(l.scope);
      was.process ||= l.process;
    }
  }
  const scopeOf = (p) => (p.scopes.includes('any') ? 'any' : p.scopes.includes('public') ? 'public' : 'private');
  const shown = (p) => `${p.addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(', ')} port ${p.port}/${p.proto}`;
  for (const [key, p] of byPort) {
    const name = SENSITIVE_PORTS[p.port];
    const scope = scopeOf(p);
    const who = p.process ? ` (${p.process})` : '';
    if (p.port === 2375 && p.proto === 'tcp') {
      add({ rule: 'docker-api-exposed', severity: 'critical', title: `The Docker API listens on ${shown(p)} without TLS`, why: 'Whoever reaches that port runs containers as root on this server: it is root on the machine, with no password.', fix: 'Remove -H tcp://0.0.0.0:2375 (or "hosts") from the Docker daemon\'s settings (/etc/docker/daemon.json, the systemd unit) and use the socket, or ssh://; then sudo systemctl restart docker', excerpt: p.lines });
    } else if (name) {
      const wide = scope !== 'private';
      add({
        rule: 'database-exposed',
        severity: wide ? 'high' : 'medium',
        title: `${name} listens on ${shown(p)}${who}`,
        why: wide ? `It answers on every address${scope === 'public' ? ' (a public one)' : ''}: anyone who reaches the server can try it, and these services are often run without a password or with a weak one.` : 'It answers on a private network address: anything on that network can try it.',
        fix: `Bind it to 127.0.0.1 in its settings (bind-address, listen_addresses, bind, net.bindIp), or close the port: sudo ufw deny ${p.port}/${p.proto}`,
        excerpt: p.lines,
      });
    } else if (!EXPECTED.has(key)) {
      add({ rule: 'public-listener', severity: 'low', title: `Port ${p.port}/${p.proto} is open on ${scope === 'private' ? 'a private address' : 'every address'}${who}`, why: 'Something listens beyond this machine; check it is meant to be reachable.', fix: `If it shouldn't be, bind it to 127.0.0.1 or close it: sudo ufw deny ${p.port}/${p.proto}`, excerpt: p.lines });
    }
  }
  if (tool && tool !== 'none') facts.push(exposed.length ? `listening beyond this machine: ${[...byPort.values()].map((p) => `${p.port}/${p.proto}${p.process ? ` ${p.process}` : ''}`).join(', ')}` : 'nothing listens beyond this machine');

  // sshd.
  const fromT = parseSshdT(s.sshd_t);
  const files = parseSshdFiles(s.sshd_config);
  const haveT = Object.keys(fromT).length > 0;
  const haveFiles = Object.keys(files).length > 0 || (s.sshd_config ?? []).some((l) => l.startsWith('#file '));
  if (!haveT && !haveFiles) unchecked.push("sshd's settings (no sshd -T it could run, and no /etc/ssh/sshd_config it could read)");
  else {
    facts.push(haveT ? "sshd's settings from sshd -T (what it runs with)" : "sshd's settings from /etc/ssh/sshd_config and its drop-ins (sshd -T needs root)");
    // The effective value, and where it is set when the files say.
    const setting = (key, fallback) => {
      const f = files[key];
      const value = (haveT ? fromT[key] : f?.value) ?? fallback;
      return { value: String(value ?? '').toLowerCase(), where: f ? at(f.file) : at(SSHD_MAIN), line: f?.line, excerpt: f ? [f.text] : haveT && fromT[key] ? [`${key} ${fromT[key]}`] : [], set: Boolean(f || (haveT && fromT[key])) };
    };
    const reload = 'then sudo sshd -t && sudo systemctl reload ssh (or sshd)';
    const root = setting('permitrootlogin', 'prohibit-password');
    if (root.value === 'yes') add({ rule: 'ssh-root-login', severity: 'high', title: 'sshd lets root sign in with a password', where: root.where, line: root.line, why: 'root is the one account every attacker guesses at, and a password is all it would take.', fix: `Set PermitRootLogin no (or prohibit-password) in ${root.where.slice(host.length + 1)}, ${reload}`, excerpt: root.excerpt });
    const pass = setting('passwordauthentication', 'yes');
    if (pass.value === 'yes') add({ rule: 'ssh-password-auth', severity: 'medium', title: 'sshd accepts passwords', where: pass.where, line: pass.line, why: pass.set ? 'Passwords can be guessed and are tried by bots all day; keys cannot.' : "It isn't set, and OpenSSH's default is yes: passwords can be guessed and are tried by bots all day.", fix: `Once your key signs in, set PasswordAuthentication no in ${pass.where.slice(host.length + 1)}, ${reload}`, excerpt: pass.excerpt });
    const empty = setting('permitemptypasswords', 'no');
    if (empty.value === 'yes') add({ rule: 'ssh-empty-passwords', severity: 'critical', title: 'sshd lets accounts with no password sign in', where: empty.where, line: empty.line, why: 'An account whose password is empty can be signed in to by anyone.', fix: `Set PermitEmptyPasswords no in ${empty.where.slice(host.length + 1)}, ${reload}`, excerpt: empty.excerpt });
    const x11 = setting('x11forwarding', 'no');
    if (x11.value === 'yes') add({ rule: 'ssh-x11-forwarding', severity: 'low', title: 'sshd forwards X11', where: x11.where, line: x11.line, why: 'A server seldom needs it, and it lets a session reach the X display of whoever connects with -X.', fix: `Set X11Forwarding no in ${x11.where.slice(host.length + 1)}, ${reload}`, excerpt: x11.excerpt });
    const protocol = setting('protocol', '2');
    if (/\b1\b/.test(protocol.value) && protocol.set) add({ rule: 'ssh-protocol-1', severity: 'high', title: 'sshd allows SSH protocol 1', where: protocol.where, line: protocol.line, why: 'Protocol 1 is broken: its sessions can be read and taken over.', fix: `Remove the Protocol line (or set Protocol 2) in ${protocol.where.slice(host.length + 1)}, ${reload}`, excerpt: protocol.excerpt });
    for (const key of Object.keys(WEAK)) {
      const v = setting(key);
      const weak = v.value.split(',').map((x) => x.trim()).filter((x) => WEAK[key].test(x));
      if (weak.length) add({ rule: 'ssh-weak-crypto', severity: 'medium', title: `sshd offers weak ${key === 'kexalgorithms' ? 'key exchanges' : key}: ${weak.join(', ')}`, where: v.where, line: v.line, why: 'These are broken or too weak today; a client that agrees to them can be read or tampered with.', fix: `Leave them out of ${key === 'kexalgorithms' ? 'KexAlgorithms' : key === 'macs' ? 'MACs' : 'Ciphers'} in ${v.where.slice(host.length + 1)} (or remove the line for OpenSSH's defaults), ${reload}`, excerpt: v.excerpt.length ? v.excerpt : [`${key} ${v.value}`] });
    }
  }

  // Updates.
  const pkg = (s.pkg ?? []).map((l) => l.trim()).find(Boolean);
  if (pkg === 'apt') {
    const up = parseAptUpgradable(s.apt);
    const security = up.filter((u) => u.security);
    facts.push(`${plural(up.length, 'package')} to update, ${security.length} of them security updates (as of the last apt update)`);
    if (security.length) add({ rule: 'security-updates', severity: 'medium', title: `${plural(security.length, 'security update')} waiting`, why: 'Fixed vulnerabilities stay open until these are installed. (Counted from apt\'s lists as of the last apt update, which may be older.)', fix: 'sudo apt update && sudo apt upgrade', excerpt: security.map((u) => u.line) });
    const un = s.unattended ?? [];
    const installed = un.some((l) => /install ok installed/.test(l));
    const on = un.some((l) => /Unattended-Upgrade\s+"1"/.test(l));
    if (!installed || un.some((l) => /Unattended-Upgrade\s+"0"/.test(l))) add({ rule: 'no-auto-updates', severity: 'low', title: installed ? 'unattended-upgrades is installed but turned off' : 'Security updates are not installed by themselves (no unattended-upgrades)', where: at('/etc/apt/apt.conf.d/20auto-upgrades'), why: 'Each security fix waits for someone to log in and install it.', fix: 'sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades', excerpt: un });
    else if (on) facts.push('unattended-upgrades installs security updates by itself');
  } else if (pkg === 'dnf' || pkg === 'yum') {
    const { advisories, ok } = parseRpmSecurity(s.rpmsec);
    if (!ok) unchecked.push(`pending security updates (${pkg} updateinfo couldn't read its cache)`);
    else if (advisories.length) {
      const critical = advisories.some((a) => /^critical$/i.test(a.severity));
      const ids = [...new Set(advisories.map((a) => a.id))];
      add({ rule: 'security-updates', severity: critical ? 'high' : 'medium', title: `${ids.length} security ${ids.length === 1 ? 'advisory' : 'advisories'} waiting${critical ? ', some critical' : ''}`, why: `Fixed vulnerabilities stay open until these are installed. (From ${pkg}'s cache, which may be older.)`, fix: `sudo ${pkg} upgrade --security`, excerpt: advisories.map((a) => `${a.id} ${a.severity} ${a.pkg}`) });
    } else facts.push(`no security advisories waiting (as of ${pkg}'s cache)`);
  } else if (s.pkg) unchecked.push('pending updates (neither apt, dnf nor yum is here)');
  const reboot = (s.reboot ?? []).map((l) => l.trim()).filter(Boolean);
  if (reboot[0] === 'required') add({ rule: 'reboot-required', severity: 'medium', title: 'A reboot is waiting', where: at('/var/run/reboot-required'), why: 'Updates to the kernel or core libraries were installed but are not in use until the server restarts.', fix: 'Reboot when it suits: sudo reboot', excerpt: reboot.filter((l) => l !== 'required') });

  // Firewall: worth one when something serves beyond this machine (a DHCP client's port doesn't count).
  const serving = [...byPort.entries()].filter(([key]) => key !== 'udp/68' && key !== 'udp/546').map(([, p]) => p);
  const fw = parseFirewall(s.firewall ?? []);
  if (fw.active.length) facts.push(`firewall: ${fw.active.join(', ')}`);
  else if (!fw.certain) unchecked.push(`whether a firewall is on (${fw.unreadable.join(' and ')} need root to read)`);
  else if (serving.length) add({ rule: 'no-firewall', severity: 'medium', title: 'No firewall is on, and ports are open beyond this machine', why: `Every port something listens on is reachable (${serving.map((p) => `${p.port}/${p.proto}`).join(', ')}), including ones opened later by mistake. (A cloud provider's security group may stand in front of it, which can't be seen from here.)`, fix: 'sudo ufw allow OpenSSH && sudo ufw enable (or firewalld: sudo systemctl enable --now firewalld)', excerpt: fw.lines.length ? fw.lines : ['no ufw, firewalld, nftables or iptables rules'] });

  // Accounts.
  const passwd = (s.passwd ?? []).map((l) => l.split(':')).filter((w) => w.length >= 4);
  for (const [name, uidText] of passwd) {
    if (uidText === '0' && name !== 'root') add({ rule: 'uid0-account', severity: 'critical', title: `${clean(name)} has user id 0: it is root under another name`, where: at('/etc/passwd'), why: 'A second root account is a classic backdoor, and nothing about its name says what it can do.', fix: `If it isn't meant to be, lock it and give it its own id: sudo usermod -L -u <new id> ${clean(name)} (or sudo userdel ${clean(name)})`, excerpt: [passwd.find((w) => w[0] === name).join(':')] });
  }
  const shadow = s.shadow ?? [];
  if (shadow.some((l) => l.trim() === '#readable')) {
    for (const name of shadow.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) add({ rule: 'empty-password', severity: 'high', title: `${clean(name)} has an empty password`, where: at('/etc/shadow'), why: 'Anything that accepts passwords (su, a console, sshd with PermitEmptyPasswords) lets anyone in as this account.', fix: `Lock it or give it a password: sudo passwd -l ${clean(name)}`, excerpt: [`${name}: its password field in /etc/shadow is empty`] });
  } else unchecked.push('accounts with an empty password (/etc/shadow needs root)');
  const sudoers = s.sudoers ?? [];
  if (sudoers.some((l) => l.trim() === '#readable')) {
    for (const l of sudoers.filter((x) => x.trim() && !x.startsWith('#'))) {
      const m = /^(\/\S+?):\s(.*)$/.exec(l);
      if (!m) continue;
      const rule = clean(m[2]);
      const all = /NOPASSWD:\s*ALL\b/.test(rule);
      add({ rule: 'sudo-nopasswd', severity: all ? 'medium' : 'low', title: `sudo without a password: ${rule.split(/\s+/)[0]}${all ? ' may run anything' : ' may run some commands'}`, where: at(m[1]), why: all ? 'Whoever gets this account (a stolen key, a hole in a service it runs) is root at once.' : 'Each command allowed without a password is a way to root if it can be made to do more than meant.', fix: `If it isn't needed, remove NOPASSWD from that line with sudo visudo${m[1] === '/etc/sudoers' ? '' : ` -f ${m[1]}`}`, excerpt: [rule] });
    }
  } else unchecked.push('sudo rules without a password (/etc/sudoers needs root)');
  const keys = (s.keys ?? []).map((l) => l.trim().split(/\s+/)).filter((w) => w.length === 2);
  if (keys.length) facts.push(`authorized_keys: ${keys.map(([u, n]) => `${clean(u)} ${n === '?' ? '(couldn\'t read)' : n}`).join(', ')}`);

  // Files.
  for (const path of (s.worldwritable ?? []).map(clean).filter((l) => l.startsWith('/'))) {
    add({ rule: 'world-writable', severity: 'high', title: `${path} can be changed by anyone`, where: at(path), why: path.startsWith('/etc/') ? "Settings in /etc are read by services running as root: anyone on the server can change what they do." : 'A program here is on root\'s PATH: anyone on the server can replace what root runs.', fix: `sudo chmod o-w ${path}`, excerpt: [`find -perm -0002: ${path}`] });
  }
  for (const path of (s.suid ?? []).map(clean).filter((l) => l.startsWith('/'))) {
    const name = path.split('/').pop();
    if (KNOWN_SUID.has(name) && !WRITABLE_PLACE.test(path)) continue;
    const bad = WRITABLE_PLACE.test(path);
    add({ rule: 'unusual-suid', severity: bad ? 'high' : 'low', title: `${path} runs as its owner (SUID)${bad ? ' from a place users write to' : ''}`, where: at(path), why: bad ? 'A SUID program in a home or temporary folder is a common way to keep root after a break-in.' : "It isn't one a distribution ships SUID: a bug in it, or a replaced copy, is a way to root.", fix: `If it doesn't need it: sudo chmod u-s ${path}`, excerpt: [`find -perm -4000: ${path}`] });
  }
  const docker = s.docker ?? [];
  const sock = docker.find((l) => /^s[rwx-]{9}/.test(l.trim()));
  if (sock) {
    const mode = sock.trim().slice(0, 10);
    const path = sock.trim().split(/\s+/).at(-1);
    if (mode[8] === 'w') add({ rule: 'docker-socket-open', severity: 'critical', title: `${clean(path)} can be written by anyone`, where: at(clean(path)), why: 'Anyone on the server can start a container that mounts / and is root.', fix: `sudo chmod 660 ${clean(path)} (and find what changed it: the docker.socket unit's SocketMode)`, excerpt: [sock] });
    const group = docker.find((l) => l.startsWith('group '));
    const members = group ? group.split(':')[3]?.split(',').map(clean).filter(Boolean) ?? [] : [];
    if (members.length) add({ rule: 'docker-group', severity: 'low', title: `In the docker group (root in effect): ${members.join(', ')}`, where: at('/etc/group'), why: 'Being able to talk to Docker is being able to be root on this server.', fix: `Keep it to who needs it: sudo gpasswd -d <user> docker`, excerpt: [group.slice(6)] });
  }
  if (!s.end) unchecked.push("the rest: the check stopped before the end (the connection dropped, or a part took too long)");
  return { findings: sortFindings(findings), facts, unchecked, ran: true };
}

/**
 * The check over `session` (session.js's, or the demo's): the script run through `exec`, its output
 * parsed. The one part here that isn't pure, as /harden and `mooring security` both do just this.
 */
export async function checkHardening(session, { host, signal, now = new Date() }) {
  const nonce = newNonce();
  const out = await session.exec(hardenCommand(nonce), { signal });
  return hardenFindings(out.stdout, { host, nonce, now });
}
