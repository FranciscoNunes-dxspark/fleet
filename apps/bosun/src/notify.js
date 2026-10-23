// Telling the terminal that something happened, for when you've looked away: a bell, and a desktop
// notification through the escape sequence the terminal understands (OSC 9, as iTerm2, Windows
// Terminal, WezTerm and kitty take it, or OSC 777 for VTE terminals such as GNOME Terminal). Pure:
// cli.jsx writes what it returns. Trawl's and Splice's; Bosun says when a process crashes or gives up
// restarting, and when a long command ends.

// Seconds a command takes before its end is worth a notification, unless the config says otherwise.
export const NOTIFY_AFTER = 10;

// Nothing in the text may end the sequence early or start another.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x9b]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** The bytes that ring the bell and raise a notification saying `title` and `body`, for this terminal. */
export function notification(title, body, env = process.env) {
  const t = clean(title);
  const b = clean(body);
  const vte = Boolean(env.VTE_VERSION) || /^(foot|rxvt)/.test(env.TERM ?? '');
  const osc = vte ? `\x1b]777;notify;${t.replace(/;/g, ',')};${b.replace(/;/g, ',')}\x1b\\` : `\x1b]9;${b ? `${t}: ${b}` : t}\x07`;
  return `\x07${osc}`;
}

/** The seconds from the config's `notifyAfter`, or NOTIFY_AFTER. */
export const notifySeconds = (config) => (Number(config?.notifyAfter) >= 0 ? Number(config.notifyAfter) : NOTIFY_AFTER);

/** Whether a run of `ms` should notify, by the config's `notify` (on unless false) and `notifyAfter` (seconds). */
export const worthNotifying = (ms, config) => config?.notify !== false && ms >= notifySeconds(config) * 1000;

/**
 * What to say when a process ended by itself (supervisor.js's exit event: `p` and its restart `plan`),
 * as { title, body }, or null: it crashed (the first time, not each time it's restarted), or it gave
 * up restarting. A clean exit says nothing.
 */
export function exitNews(p, plan) {
  if (plan.gaveUp) return { title: `Bosun: ${p.name} gave up`, body: `It ended ${plan.quick} times in a row just after starting.` };
  if (p.code === 0 || (plan.restart && plan.attempt > 1)) return null;
  const why = p.trouble ?? (p.code != null ? `It exited with ${p.code}.` : 'It was ended.');
  return { title: `Bosun: ${p.name} crashed`, body: plan.restart ? `${why} Restarting it.` : why };
}
