// Sharing a running service: a process's port reachable from the internet for a while, through a
// Dev Tunnel (`devtunnel host -p <port> --allow-anonymous`), cloudflared's quick tunnels (`cloudflared
// tunnel --url http://localhost:<port>`) or ngrok (`ngrok http <port>`), the first one installed
// (in that order, unless bosun.json's "tunnel" names one). The tunnel itself is a child the supervisor
// keeps (supervisor.js's openTunnel). What's here is pure: which tool, its arguments, the address in
// what it says, and how to install one.
import { findOnPath } from './which.js';

export const TUNNEL_TOOLS = ['devtunnel', 'cloudflared', 'ngrok'];

/** Names as a sentence lists them: `a`, `a or b`, `a, b or c`. */
export const either = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? ''));

/** The tool to use: { tool, path } for the first of `preferred` (else devtunnel, cloudflared, then ngrok) that `find` finds, or { missing: [tools looked for] }. */
export function tunnelTool(preferred, find = findOnPath) {
  const order = preferred ? [preferred] : TUNNEL_TOOLS;
  for (const tool of order) {
    const path = find(tool);
    if (path) return { tool, path };
  }
  return { missing: order };
}

/** The arguments that tunnel to `port` on this machine. */
export function tunnelArgs(tool, port) {
  // --allow-anonymous: whoever has the address gets in without signing in to Microsoft, as with the others.
  if (tool === 'devtunnel') return ['host', '-p', String(port), '--allow-anonymous'];
  if (tool === 'ngrok') return ['http', String(port), '--log', 'stdout', '--log-format', 'json'];
  return ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
}

const CLOUDFLARE_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![\w/.-])/i;
// devtunnel says each address twice (the port in the name, and after it) and an -inspect one besides.
const DEVTUNNEL_URL = /https:\/\/[a-z0-9-]+\.[a-z0-9]+\.devtunnels\.ms(?::\d+)?(?![\w.-])/gi;

/** The public address in a line `tool` wrote (devtunnel's "Connect via browser", cloudflared's box around it, ngrok's JSON log), or null. */
export function tunnelUrl(tool, line) {
  if (tool === 'devtunnel') return (String(line).match(DEVTUNNEL_URL) ?? []).find((u) => !/-inspect\./i.test(u)) ?? null;
  if (tool === 'ngrok') {
    try {
      const o = JSON.parse(line);
      return typeof o?.url === 'string' && /^https:\/\//.test(o.url) && (o.msg === 'started tunnel' || o.obj === 'tunnels') ? o.url : null;
    } catch {
      return null;
    }
  }
  return CLOUDFLARE_URL.exec(line)?.[0] ?? null;
}

/** What in a line of the tool's is worth putting in the process's log: an error, in its own words; else null. */
export function tunnelProblem(tool, line) {
  if (tool === 'devtunnel') {
    const s = String(line).trim();
    // Not signed in is the usual one: devtunnel hosts a tunnel only for a signed-in user.
    if (/^(error|fatal)\b\s*:?\s*/i.test(s)) return s.replace(/^(error|fatal)\b\s*:?\s*/i, '');
    return /\b(login|log in|sign in)\b.*\brequired\b|\bunauthori[sz]ed\b/i.test(s) ? s : null;
  }
  if (tool === 'ngrok') {
    try {
      const o = JSON.parse(line);
      return ['eror', 'error', 'crit'].includes(o?.lvl) ? String(o.err ?? o.msg ?? line) : null;
    } catch {
      return /\bERROR\b|\berr\b/i.test(line) ? line.trim() : null;
    }
  }
  return /\s(ERR|FTL)\s/.test(line) ? line.replace(/^\S+\s+(ERR|FTL)\s+/, '').trim() : null;
}

const HOW = {
  devtunnel: {
    win32: 'winget install Microsoft.devtunnel',
    darwin: 'brew install --cask devtunnel',
    other: 'curl -sL https://aka.ms/DevTunnelCliInstall | bash',
  },
  cloudflared: {
    win32: 'winget install --id Cloudflare.cloudflared',
    darwin: 'brew install cloudflared',
    other: 'the package for your system from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  },
  ngrok: {
    win32: 'winget install ngrok.ngrok',
    darwin: 'brew install ngrok',
    other: 'the package from https://ngrok.com/download',
  },
};

/** How to install the tools in `missing`, for this platform: a line each. */
export function installHint(missing, platform = process.platform) {
  const lines = missing.map((tool) => {
    const how = HOW[tool] ?? {};
    const after = { ngrok: ', then ngrok config add-authtoken <your token>', devtunnel: ', then devtunnel user login (once)' }[tool] ?? ' (quick tunnels need no account)';
    return `${tool}: ${how[platform] ?? how.other}${after}`;
  });
  return [`Sharing needs ${either(missing)} on the PATH. To install ${missing.length > 1 ? 'one' : 'it'}:`, ...lines].join('\n');
}
