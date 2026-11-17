// An app's settings as a file, and a file's settings into an app: pure. The file Sonar writes is the Azure portal's
// "Advanced edit" format (and `az webapp config appsettings list`'s), a list of { name, value, slotSetting }, so one
// saved here pastes into the portal and the other way round. Reading takes that list, a plain { name: value } object,
// or an appsettings.json, whose nesting becomes App Service's `__` (Logging:LogLevel:Default → Logging__LogLevel__Default).

/** `settings` ({ name: value }) as the portal's JSON, by name. */
export function settingsJson(settings) {
  const list = Object.keys(settings)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, value: settings[name], slotSetting: false }));
  return `${JSON.stringify(list, null, 2)}\n`;
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

/**
 * The settings in a file's `text`: { settings } ({ name: value }), or { error } in words. `$schema` and comments
 * aren't settings; an appsettings.json's own comments (// and /* *​/, which .NET allows) are taken out first.
 */
export function readSettingsFile(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    try {
      data = JSON.parse(stripComments(String(text).replace(/^﻿/, '')));
    } catch (err) {
      return { error: `It isn't JSON: ${err.message}` };
    }
  }
  if (Array.isArray(data)) {
    const settings = {};
    for (const [i, item] of data.entries()) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) return { error: `Item ${i + 1} has no name: the list is the portal's, [{ "name": …, "value": … }]` };
      settings[item.name.trim()] = asValue(item.value);
    }
    return { settings };
  }
  if (data && typeof data === 'object') {
    const { $schema: _, ...rest } = data;
    return { settings: flatten(rest, '', {}) };
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

/** A file name for `label`'s settings: contoso-web/staging → contoso-web-staging.settings.json. */
export const settingsFileName = (label) => `${String(label).replace(/[\\/:*?"<>|]+/g, '-')}.settings.json`;
