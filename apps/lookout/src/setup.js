// What to set so traffic goes through Lookout, and how to trust its certificate authority, per system
// and per client: the Setup view, `lookout env` and `lookout ca`. Pure: text from an address and paths.
import { LISTEN_HOST } from './proxy.js';

/** The proxy's URL, as clients take it. */
export const proxyUrl = (port) => `http://${LISTEN_HOST}:${port}`;

/** The one line a process's environment needs (.env, bosun.json's env, a shell). */
export const httpsProxyLine = (port) => `HTTPS_PROXY=${proxyUrl(port)}`;

/**
 * Bosun's processes: the variables to put in bosun.json's "env" (or the project's .env) so what they
 * send goes through Lookout, and with interception on, Node trusts the CA.
 */
export function bosunEnv(port, { caCert = null } = {}) {
  return {
    HTTP_PROXY: proxyUrl(port),
    HTTPS_PROXY: proxyUrl(port),
    NO_PROXY: '',
    // Node 24 and later send through HTTP_PROXY when this is set; earlier ones need an agent of their own.
    NODE_USE_ENV_PROXY: '1',
    ...(caCert ? { NODE_EXTRA_CA_CERTS: caCert } : {}),
  };
}

/** The lines that send traffic through Lookout on `port`: shells, Bosun, browsers, an emulator. */
export function proxyLines(port, { caCert = null, platform = process.platform } = {}) {
  const url = proxyUrl(port);
  const env = bosunEnv(port, { caCert });
  return [
    `Lookout listens on ${LISTEN_HOST}:${port}, this machine only. HTTP and HTTPS both go to it.`,
    '',
    'For a process (a .env file, or what Bosun runs):',
    `  ${httpsProxyLine(port)}`,
    `  HTTP_PROXY=${url}`,
    ...(caCert ? [`  NODE_EXTRA_CA_CERTS=${caCert}`] : []),
    '',
    "Bosun: in bosun.json, under the process (or a profile's) \"env\":",
    `  "env": ${JSON.stringify(env)}`,
    '  Node 24 and later read HTTP_PROXY with NODE_USE_ENV_PROXY=1; an older Node needs a proxy agent in the code. .NET\'s HttpClient, Python\'s requests, curl and Go read it as it is.',
    '',
    'In a shell:',
    platform === 'win32' ? `  $env:HTTPS_PROXY="${url}"; $env:HTTP_PROXY="${url}"     (PowerShell)` : `  export HTTPS_PROXY=${url} HTTP_PROXY=${url}`,
    `  curl -x ${url} https://example.com${caCert ? `   (with --cacert ${caCert} while HTTPS is intercepted)` : ''}`,
    '',
    'A browser:',
    `  Chrome or Edge: start it with --proxy-server="${url}" --proxy-bypass-list="<-loopback>" (the last part sends localhost through too)`,
    `  Firefox: Settings, Network Settings, Manual proxy: HTTP proxy ${LISTEN_HOST} port ${port}, "Also use this proxy for HTTPS"`,
    '',
    'An Android emulator:',
    `  emulator -avd <name> -http-proxy ${url}   (or in its settings: Proxy, manual, ${LISTEN_HOST}:${port}; inside the emulator this machine is 10.0.2.2)`,
    '  Apps trust only the system\'s CAs unless their network_security_config also trusts user CAs: debug builds can.',
  ];
}

/** How to trust the CA in `certPath`, for this system and the clients with stores of their own. */
export function trustSteps(certPath, { platform = process.platform, name = 'Lookout local CA' } = {}) {
  const win = [
    'Windows (for you alone, no administrator needed):',
    `  certutil -user -addstore Root "${certPath}"`,
    '  or open certmgr.msc: Trusted Root Certification Authorities, Certificates, All Tasks, Import.',
    `  To take it out again: certutil -user -delstore Root "${name}"`,
  ];
  const mac = [
    'macOS (your login keychain):',
    `  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
    `  To take it out again: security delete-certificate -c "${name}" ~/Library/Keychains/login.keychain-db`,
  ];
  const linux = [
    'Linux (the system store, as root):',
    `  Debian, Ubuntu:   sudo cp "${certPath}" /usr/local/share/ca-certificates/lookout.crt && sudo update-ca-certificates`,
    `  Fedora, RHEL:     sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/lookout.crt && sudo update-ca-trust`,
    `  Arch:             sudo trust anchor --store "${certPath}"`,
    '  Chrome on Linux keeps its own: Settings, Privacy and security, Security, Manage certificates, Authorities, Import.',
  ];
  const own = platform === 'win32' ? win : platform === 'darwin' ? mac : linux;
  const others = [win, mac, linux].filter((s) => s !== own);
  return [
    `Lookout's certificate authority: ${certPath}`,
    'Trusting it lets Lookout read HTTPS for the clients you point at it. Its key stays in the same folder, readable by you alone; it never leaves this machine.',
    '',
    ...own,
    '',
    'Firefox keeps a store of its own: Settings, Privacy & Security, Certificates, View Certificates, Authorities, Import (tick "websites"),',
    '  or set security.enterprise_roots.enabled to true in about:config to use the system\'s (Windows, macOS).',
    `Node (and Bosun's Node processes): NODE_EXTRA_CA_CERTS=${certPath}`,
    `Python requests: REQUESTS_CA_BUNDLE pointing at a bundle with it added · curl: --cacert "${certPath}"`,
    '.NET reads the system store (above).',
    'Android emulator: Settings, Security, Encryption & credentials, Install a certificate, CA certificate.',
    '',
    'A client that pins its certificates refuses Lookout\'s whatever you trust: its row says so, and p passes that host through untouched.',
    '',
    'On other systems:',
    ...others.flatMap((s) => [...s, '']),
  ];
}
