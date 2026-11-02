// The parameters of a command, kept under the prompt while its arguments are typed. Each app's `suggestionsFor` offers
// names to complete; where it has none (the command takes free text, or the value is typed in full) this is the one
// row left: the command's `args` and `desc`. Its `insert` is the line as it is, so ↵ runs it and tab changes nothing.
export function withCommandHint(items, value, find) {
  if (items.length || !value.startsWith('/')) return items;
  const space = value.indexOf(' ');
  if (space < 0) return items;
  const cmd = find(value.slice(1, space));
  return cmd?.args ? [{ label: `/${cmd.name}`, hint: cmd.args, desc: cmd.desc, insert: value, run: false }] : [];
}
