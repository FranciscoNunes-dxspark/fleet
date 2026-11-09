// Which look the kit's parts draw in. "classic" is the boxed one every app had: a header row, a tab
// strip, rounded boxes around each pane, a welcome box, a prompt box and a hint row. "shell" is the
// lighter one the family is moving to: one top line (the app, its views and its context), panes with a
// title row and a single rule down their left side, a one-row prompt and one status line. An app
// chooses it in its src/app.js (configureApp's `look`); Keel's terminal app stays classic until it
// moves. The parts read it as they draw, so a test can switch it with setLook.

export const LOOKS = Object.freeze(['classic', 'shell']);

let current = 'classic';

/** Sets the look the kit's parts draw in: one of LOOKS. */
export function setLook(name = 'classic') {
  if (!LOOKS.includes(name)) throw new Error(`No look called ${JSON.stringify(name)}: ${LOOKS.join(' or ')}.`);
  current = name;
}

/** The look the parts draw in. */
export const look = () => current;

/** Whether the parts draw in the shell look. */
export const shellLook = () => current === 'shell';
