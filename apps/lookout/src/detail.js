// An exchange as the detail view shows it: what was asked and answered, headers, bodies and timings,
// with credentials hidden until `secrets` (s) shows them. Pure.
import { bodyText, decoded, duration, header, mediaType, size, statusWord } from './exchange.js';
import { headerHidden, maskBody, maskHeader, maskUrl } from './redact.js';

// More than this of a body is left to the data viewer (d, r) and the HAR export.
const MAX_BODY_LINES = 400;

const clock = (ms) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** How many values the masks hide in an exchange: what s would show. */
export function hiddenCount(ex) {
  let n = maskUrl(ex.url) !== ex.url ? 1 : 0;
  for (const part of [ex.request, ex.response].filter(Boolean)) {
    for (const [name, value] of part.headers ?? []) if (headerHidden(name, value)) n++;
    const t = bodyText(part);
    if (t && maskBody(t, mediaType(part)) !== t) n++;
  }
  return n;
}

/** The timings in words: connecting, waiting for the first byte, receiving, all of it. */
export function timingLine(ex, now = Date.now()) {
  const t = ex.timings ?? {};
  const parts = [];
  if (t.connect != null && t.connect > t.start) parts.push(`connect ${t.connect - t.start} ms`);
  else if (t.connect === t.start && ex.kind === 'http') parts.push('connection reused');
  if (t.ttfb != null) parts.push(`waiting ${t.ttfb - (t.connect ?? t.start)} ms`);
  if (t.end != null && t.ttfb != null) parts.push(`receiving ${t.end - t.ttfb} ms`);
  parts.push(`total ${duration(ex, now) || '…'}`);
  return parts.join(' · ');
}

function headerLines(headers = [], secrets) {
  if (!headers.length) return ['  (none)'];
  return headers.map(([n, v]) => `  ${n}: ${secrets ? v : maskHeader(n, v)}${!secrets && headerHidden(n, v) ? '   (hidden)' : ''}`);
}

function bodyLines(part, secrets) {
  if (!part?.size) return [];
  const type = header(part.headers, 'content-type') ?? 'no Content-Type';
  const enc = header(part.headers, 'content-encoding');
  const kept = part.body?.length ?? 0;
  const head = `${type}, ${size(part.size)}${enc ? `, ${enc} (shown undone)` : ''}${part.truncated ? `, the first ${size(kept)} kept` : ''}`;
  if (part.body == null) return [`  (${head}; not kept)`];
  const text = bodyText(part);
  if (text == null) return [`  (${head}: binary, ${size(decoded(part)?.length ?? 0)})`];
  let shown = secrets ? text : maskBody(text, mediaType(part));
  // JSON is easier to read laid out.
  if (/^\s*[[{]/.test(shown) && !/\n/.test(shown.trim())) {
    try {
      shown = JSON.stringify(JSON.parse(shown), null, 2);
    } catch {}
  }
  const lines = shown.replace(/\r\n/g, '\n').split('\n');
  const more = lines.length > MAX_BODY_LINES ? [`  … ${lines.length - MAX_BODY_LINES} more lines (d or r opens it whole)`] : [];
  return [`  ${head}`, '', ...lines.slice(0, MAX_BODY_LINES).map((l) => `  ${l}`), ...more];
}

/** The detail view's text for `ex`: { title, text, hidden }. */
export function detailText(ex, { secrets = false, now = Date.now() } = {}) {
  const hidden = hiddenCount(ex);
  const url = secrets ? ex.url : maskUrl(ex.url);
  if (ex.kind === 'refused') {
    return {
      title: `${ex.host}:${ex.port} refused`,
      hidden: 0,
      text: [
        `A client opened a tunnel to ${ex.host}:${ex.port} at ${clock(ex.at)} and ${ex.note ?? 'turned Lookout\'s certificate down'}.`,
        '',
        'Either it doesn\'t trust Lookout\'s certificate authority yet (the Setup view, 4, says how to trust it),',
        'or it pins the certificates it accepts, as banking apps, some SDKs and the browsers\' own services do:',
        'then no trust store helps. p passes this host through untouched: its traffic still goes, unread.',
      ].join('\n'),
    };
  }
  if (ex.kind === 'tunnel') {
    return {
      title: `CONNECT ${ex.host}:${ex.port}`,
      hidden: 0,
      text: [
        `CONNECT ${ex.host}:${ex.port}  ${ex.state === 'open' ? 'open' : ex.state === 'error' ? 'failed' : 'closed'}`,
        `At ${clock(ex.at)} · ${size(ex.request.size)} sent · ${size(ex.response?.size ?? 0)} received · ${duration(ex, now)}`,
        ...(ex.error ? ['', `Error: ${ex.error}`] : []),
        '',
        ex.note ? `${ex.note[0].toUpperCase()}${ex.note.slice(1)}.` : 'An HTTPS tunnel, passed through: Lookout sees the host name and how much went each way, nothing inside.',
        ex.note?.includes('pass-through') ? '/unpass removes it from the list.' : '/intercept on reads HTTPS too, once you trust Lookout\'s certificate authority (the Setup view, 4).',
      ].join('\n'),
    };
  }
  const res = ex.response;
  const how = ex.imported ? 'from a HAR file' : ex.intercepted ? 'HTTPS, intercepted' : ex.scheme === 'http' ? 'plain HTTP' : 'HTTPS';
  const lines = [
    `${ex.method} ${url}`,
    `${res ? `${res.status} ${res.statusText}`.trim() : ex.state === 'error' ? 'No response' : 'Waiting for the response'} · ${how} · ${clock(ex.at)}`,
    timingLine(ex, now),
    ...(ex.error ? [`Error: ${ex.error}`] : []),
    ...(ex.note ? [ex.note] : []),
    '',
    `Request headers${ex.request.httpVersion ? ` (HTTP/${ex.request.httpVersion})` : ''}`,
    ...headerLines(ex.request.headers, secrets),
  ];
  if (ex.request.size) lines.push('', 'Request body', ...bodyLines(ex.request, secrets));
  if (res) {
    lines.push('', `Response headers (HTTP/${res.httpVersion ?? '1.1'} ${statusWord(ex)})`, ...headerLines(res.headers, secrets));
    if (res.size) lines.push('', 'Response body', ...bodyLines(res, secrets));
  }
  return { title: `${ex.method} ${ex.host}${String(secrets ? ex.path : maskUrl(ex.path)).slice(0, 60)}`, text: lines.join('\n'), hidden };
}
