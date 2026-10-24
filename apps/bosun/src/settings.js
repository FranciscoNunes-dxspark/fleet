// The /settings list: every setting, its value and what ↵ does with it. Pure, so the list is tested
// without the UI; actions.js shows it in a picker and makes the changes.
import { THEMES, defaultAccent, theme } from './theme.js';
import { fit } from '@fleet/kit/text.js';
import { notifySeconds } from './notify.js';
import { memoryAlertLabel, nextMemoryAlert } from './usage.js';

const isOn = (value) => value !== false;
const count = (n, one, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : 'none');

/** The Theme setting: dark, light, or auto (the default: COLORFGBG says, else dark). */
export const themeSetting = (config) => (THEMES.includes(config.theme) ? config.theme : 'auto');

/** What ↵ on the Theme row changes it to: dark, light, auto, round again. */
export const nextTheme = (config) => THEMES[(THEMES.indexOf(themeSetting(config)) + 1) % THEMES.length];

/**
 * The rows, from the config: { id, label, value, note, action }, where `action` is what ↵ does:
 * 'toggle' (an on/off setting named `id`), 'theme', 'accent', 'clear' (the list named `id`) or 'none'.
 * `mouse`: whether this terminal can report the mouse at all.
 */
export function settingRows(config, { file = '', mouse = true } = {}) {
  const history = config.history ?? [];
  const checks = isOn(config.checkForUpdates);
  return [
    {
      id: 'theme',
      label: 'Theme',
      value: themeSetting(config) === 'auto' ? `auto (${theme.mode} here)` : themeSetting(config),
      note: `${nextTheme(config)} next${themeSetting(config) === 'light' ? ': from the terminal, else dark' : ''}`,
      action: 'theme',
    },
    { id: 'accent', label: 'Accent colour', value: config.accent ?? `${defaultAccent()} (default)`, colour: config.accent ?? defaultAccent(), note: 'type a new one', action: 'accent' },
    {
      id: 'mouse',
      label: 'Mouse',
      value: isOn(config.mouse) ? 'on' : 'off',
      note: !mouse ? "this terminal can't report it" : isOn(config.mouse) ? 'off leaves selecting to the terminal' : 'click, scroll, drag to copy',
      action: 'toggle',
    },
    {
      id: 'notify',
      label: 'Notify',
      value: isOn(config.notify) ? 'on' : 'off',
      note: isOn(config.notify) ? `a bell and a notification when a process crashes or gives up, and after a ${notifySeconds(config)} s command` : 'say nothing',
      action: 'toggle',
    },
    {
      id: 'memoryAlert',
      label: 'Memory alert',
      value: memoryAlertLabel(config.memoryAlert),
      note: `${memoryAlertLabel(nextMemoryAlert(config.memoryAlert))} next: ${config.memoryAlert ? 'say once when a process\'s memory keeps growing past it' : 'say nothing about memory'}`,
      action: 'memory',
    },
    {
      id: 'record',
      label: 'Record sessions',
      value: isOn(config.record) ? 'on' : 'off',
      note: isOn(config.record) ? 'every run\'s logs and states, for /replay (from the next start)' : 'record nothing (from the next start)',
      action: 'toggle',
    },
    {
      id: 'familyMoods',
      label: 'Family moods',
      value: isOn(config.familyMoods) ? 'on' : 'off',
      note: isOn(config.familyMoods) ? 'Squawk tells the siblings how it feels, and says when theirs are worried, sad or happy' : 'keep to itself',
      action: 'toggle',
    },
    { id: 'checkForUpdates', label: 'Check for new versions', value: checks ? 'on' : 'off', note: 'once a day, in the downloaded Bosun', action: 'toggle' },
    {
      id: 'autoUpdate',
      label: 'Install them by itself',
      value: isOn(config.autoUpdate) ? 'on' : 'off',
      note: checks ? 'they start the next time you open Bosun' : 'only while checking is on',
      action: 'toggle',
    },
    { id: 'history', label: 'Prompt history', value: count(history.length, 'entry', 'entries'), note: history.length ? 'clear it' : '', action: history.length ? 'clear' : 'none' },
    { id: 'file', label: 'Settings file', value: file, note: '', action: 'none' },
  ];
}

/** A row as segments: the label, the value (on in green, the accent in its own colour), and what ↵ does. */
export function settingSegments(row) {
  const value =
    row.id === 'accent'
      ? [{ text: '■ ', color: row.colour }, { text: fit(row.value, 26), color: row.colour }]
      : [{ text: fit(row.value, 28), color: row.value === 'on' ? theme.add : row.value === 'off' || row.value === 'none' ? theme.dim : undefined }];
  return [{ text: fit(row.label, 28), strong: true }, ...value, { text: row.note ? `  ↵ ${row.note}` : '', color: theme.dim }];
}
