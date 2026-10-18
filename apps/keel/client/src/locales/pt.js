// European Portuguese. Keys are the English text exactly as written in the code
// (t('...')) or as the server sends it (templates with {placeholders}).
// Split by area so each part stays readable; later parts win on duplicates.
import shell from './pt/shell.js';
import settings from './pt/settings.js';
import code from './pt/code.js';
import work from './pt/work.js';
import server from './pt/server.js';
import totals from './pt/totals.js';
import runs from './pt/runs.js';
import orgs from './pt/orgs.js';
import ship from './pt/ship.js';
import flow from './pt/flow.js';
import palette from './pt/palette.js';
import channels from './pt/channels.js';
import assist from './pt/assist.js';
import tests from './pt/tests.js';
import notes from './pt/notes.js';
import views from './pt/views.js';

export default { ...server, ...shell, ...settings, ...code, ...work, ...totals, ...runs, ...orgs, ...ship, ...flow, ...palette, ...channels, ...assist, ...tests, ...notes, ...views };

// Text the server sends: its templates are the only ones tx() matches against.
export { server as serverText };
