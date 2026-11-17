// An app's settings and connection strings as a file, and a file's into an app: pure. The file Sonar writes is
// { "appSettings": [...], "connectionStrings": [...] }, each list in the Azure portal's "Advanced edit" format for its
// own pane (and `az webapp config appsettings list`'s / `connection-string list`'s): [{ name, value, slotSetting }]
// and [{ name, value, type, slotSetting }], so either pastes into the portal and the other way round. Reading takes
// that, either list alone (a list whose items have a `type` is connection strings), a plain { name: value } object, or
// an appsettings.json: its ConnectionStrings section becomes connection strings, and the rest's nesting App Service's
// `__` (Logging:LogLevel:Default → Logging__LogLevel__Default).

/** The connection string types App Service takes; another in a file is kept, and Azure says if it won't have it. */
export const STRING_TYPES = ['SQLAzure', 'SQLServer', 'MySql', 'PostgreSQL', 'Custom', 'NotificationHub', 'ServiceBus', 'EventHub', 'ApiHub', 'DocDb', 'RedisCache'];

const byName = (o) => Object.keys(o).sort((a, b) => a.localeCompare(b));

/** `settings` ({ name: value }) and `strings` ({ name: { value, type } }) as the file, by name. */
export function configJson({ settings = {}, strings = {} }) {
  return `${JSON.stringify(
    {
      appSettings: byName(settings).map((name) => ({ name, value: settings[name], slotSetting: false })),
      connectionStrings: byName(strings).map((name) => ({ name, value: strings[name].value, type: strings[name].type, slotSetting: false })),
    },
    null,
    2,
  )}\n`;
}

// A value as App Service keeps it: a string (true, 3 and null as text, as the portal saves them).
const asValue = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));

function flatten(object, prefix, out) {
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}__${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else if (Array.isArray(value)) value.forEach((v, i) => (v && typeof v === 'object' ? flatten(v, `${name}__${i}`, out) : (out[`${name}__${i}`] = asValue(v))));
    else out[name] = asValue(value);
  }
  return out;
}

// A portal list: { settings } or { strings }, or { error }.
function readList(list, what) {
  const out = {};
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) return { error: `Item ${i + 1}${what ? ` of ${what}` : ''} has no name: the list is the portal's, [{ "name": …, "value": … }]` };
    out[item.name.trim()] = what === 'connectionStrings' || (!what && 'type' in item) ? { value: asValue(item.value), type: item.type ? String(item.type) : 'Custom' } : asValue(item.value);
  }
  return { out };
}

/**
 * What a file's `text` holds: { settings, strings } (strings { name: { value, type } }), or { error } in words.
 * `$schema` isn't a setting; an appsettings.json's comments (// and /* *​/, which .NET allows) are taken out first.
 */
export function readSettingsFile(text) {
  let data;
  const body = String(text).replace(/^﻿/, '');
  try {
    data = JSON.parse(body);
  } catch {
    try {
      data = JSON.parse(stripComments(body));
    } catch (err) {
      return { error: `It isn't JSON: ${err.message}` };
    }
  }
  if (Array.isArray(data)) {
    const r = readList(data);
    if (r.error) return r;
    const strings = data.length && data.every((it) => 'type' in it);
    return strings ? { settings: {}, strings: r.out } : { settings: r.out, strings: {} };
  }
  if (data && typeof data === 'object' && (Array.isArray(data.appSettings) || Array.isArray(data.connectionStrings))) {
    const a = readList(data.appSettings ?? [], 'appSettings');
    if (a.error) return a;
    const c = readList(data.connectionStrings ?? [], 'connectionStrings');
    if (c.error) return c;
    return { settings: a.out, strings: c.out };
  }
  if (data && typeof data === 'object') {
    const { $schema: _, ConnectionStrings, ...rest } = data;
    const strings = {};
    if (ConnectionStrings && typeof ConnectionStrings === 'object' && !Array.isArray(ConnectionStrings)) {
      for (const [name, value] of Object.entries(ConnectionStrings)) strings[name] = { value: asValue(value), type: 'Custom' };
    } else if (ConnectionStrings !== undefined) rest.ConnectionStrings = ConnectionStrings;
    return { settings: flatten(rest, '', {}), strings };
  }
  return { error: 'It holds no settings: a list of { "name", "value" } or an object was expected' };
}

// Comments out of JSON, strings left as they are.
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** What an app holds once `incoming` is added to `current`: new ones added, different ones changed, its others kept. */
export const mergeSettings = (current, incoming) => ({ ...current, ...incoming });

/** Connection strings as { name: "type value" }, for settingsDiff: a change of type is a change. */
export const stringsForDiff = (strings) => Object.fromEntries(Object.entries(strings).map(([name, e]) => [name, `${e.type} ${e.value}`]));

/** A file name for `label`'s settings: contoso-web/staging → contoso-web-staging.settings.json. */
export const settingsFileName = (label) => `${String(label).replace(/[\\/:*?"<>|]+/g, '-')}.settings.json`;
