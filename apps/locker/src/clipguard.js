// A value copied to the clipboard doesn't stay there: after a while (the clearClipboard setting) the
// clipboard is emptied, if it still holds that value, or can't be read back to tell (over SSH, where
// copying went through the terminal). Quitting empties it at once.

/**
 * `copy(text)` puts text on the clipboard, `read()` reads it back ('' when it can't), `after()` is the
 * seconds to wait (0: never clear). `put(value)` copies and starts the wait; `flush()` clears now what
 * is waiting; `pending()` says whether something is.
 */
export function clipGuard({ copy, read = async () => '', after = () => 30, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let held = null;
  let timer = null;
  const clear = async () => {
    if (held == null) return;
    const value = held;
    held = null;
    if (timer) clearTimer(timer);
    timer = null;
    let now = '';
    try {
      now = await read();
    } catch {}
    // Something else copied since: that is yours, and stays.
    if (now === value || now === '') await copy('');
  };
  return {
    async put(value) {
      if (timer) clearTimer(timer);
      timer = null;
      held = String(value);
      await copy(held);
      const secs = after();
      if (secs > 0) {
        timer = setTimer(() => {
          clear();
        }, secs * 1000);
        timer?.unref?.();
      } else held = null;
    },
    flush: clear,
    pending: () => held != null,
  };
}
