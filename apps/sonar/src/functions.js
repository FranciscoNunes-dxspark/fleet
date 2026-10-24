// A function app's functions: what triggers each, whether it's turned off (the AzureWebJobs.<name>.Disabled
// app setting, as the portal sets it), how its runs went in Application Insights, and what invoking one
// sends. Pure: the provider lists and invokes them (azure/arm.js functions, invokeFunction; demo.js too).

/** A function as ARM lists it ({site}/functions): its name, trigger, the HTTP methods and route, its address. */
export function functionFrom(f) {
  const p = f.properties ?? {};
  const bindings = p.config?.bindings ?? [];
  const trigger = bindings.find((b) => /Trigger$/i.test(b.type ?? '')) ?? bindings[0] ?? {};
  return {
    id: f.id,
    name: p.name ?? String(f.name ?? '').split('/').pop(),
    trigger: trigger.type ?? 'unknown',
    methods: Array.isArray(trigger.methods) ? trigger.methods.map((m) => String(m).toUpperCase()) : null,
    authLevel: trigger.authLevel ?? null,
    route: trigger.route ?? null,
    // What it listens to, for a trigger that isn't HTTP: its schedule, queue, topic, container…
    source: trigger.schedule ?? trigger.queueName ?? trigger.topicName ?? trigger.path ?? trigger.collectionName ?? trigger.containerName ?? trigger.eventHubName ?? null,
    url: p.invoke_url_template ?? null,
    disabled: Boolean(p.isDisabled),
    language: p.language ?? null,
  };
}

/** Whether it's invoked over HTTP (its own address) rather than through the admin endpoint. */
export const isHttp = (fn) => /^httpTrigger$/i.test(fn?.trigger ?? '');

/** Its trigger in words: "http POST", "timer 0 0 2 * * *", "serviceBus payments". */
export function triggerLabel(fn) {
  const kind = String(fn.trigger ?? '').replace(/Trigger$/i, '') || 'unknown';
  if (isHttp(fn)) return `http ${(fn.methods ?? ['any']).join(',')}`;
  return fn.source ? `${kind} ${fn.source}` : kind;
}

// The setting that turns a function off: the portal writes it with dots; Linux plans take __ too.
const DISABLED_NAMES = (name) => [`AzureWebJobs.${name}.Disabled`, `AzureWebJobs__${name}__Disabled`];
const truthy = (v) => /^(true|1)$/i.test(String(v ?? '').trim());

/** The setting that disables `name` in `settings`, when there is one. */
export const disabledSetting = (settings, name) => DISABLED_NAMES(name).find((k) => k in (settings ?? {})) ?? null;

/** Whether a function is off: its setting says so, else ARM does (function.json's "disabled"). */
export function isDisabled(fn, settings) {
  const key = disabledSetting(settings, fn.name);
  return key ? truthy(settings[key]) : Boolean(fn.disabled);
}

/**
 * The settings with `fn` turned off (or on): the setting it already has changed in place, else the
 * portal's (dotted) one added. Turning on removes the setting, unless ARM says function.json turns it off,
 * when it's set to false.
 */
export function withDisabled(settings, fn, off) {
  const key = disabledSetting(settings, fn.name) ?? DISABLED_NAMES(fn.name)[0];
  const { [key]: _, ...rest } = settings ?? {};
  if (off) return { ...rest, [key]: 'true' };
  return fn.disabled ? { ...rest, [key]: 'false' } : rest;
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** How each function's runs went over the span: Functions logs each run as a request named for the function. */
export const functionRunsQuery = (role) =>
  `requests | where cloud_RoleName == ${quote(role)} | summarize runs = count(), failed = countif(success == false), last = max(timestamp), lastFailure = maxif(timestamp, success == false), p50 = percentile(duration, 50) by name | order by name asc`;

/** One function's latest runs, for Logs. */
export const functionLogQuery = (role, name) => `requests | where cloud_RoleName == ${quote(role)} | where name == ${quote(name)} | order by timestamp desc | take 50`;

/**
 * What invoking `fn` sends, from what was typed (`input`): over HTTP, its method (POST or the first it
 * takes when there's a body, else GET when it takes it) and the body; otherwise the admin endpoint's
 * POST with { input }.
 */
export function invocation(fn, input = '') {
  const text = String(input ?? '');
  if (!isHttp(fn)) return { admin: true, method: 'POST', body: JSON.stringify({ input: text }) };
  const methods = fn.methods ?? ['GET', 'POST'];
  if (text) return { method: methods.includes('POST') ? 'POST' : methods.find((m) => m !== 'GET') ?? methods[0], body: text };
  return { method: methods.includes('GET') ? 'GET' : methods[0], body: undefined };
}

/** A function's HTTP address: ARM's invoke_url_template, else /api/<route or name> on the app's host. */
export const functionUrl = (fn, host) => fn.url ?? `https://${host}/api/${String(fn.route ?? fn.name).replace(/^\/+/, '')}`;

/** An answer's body made readable: JSON indented, anything else as it came (cut at 200 KB). */
export function prettyBody(text) {
  const s = String(text ?? '');
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s.length > 200_000 ? `${s.slice(0, 200_000)}\n… (cut at 200 KB)` : s;
  }
}
