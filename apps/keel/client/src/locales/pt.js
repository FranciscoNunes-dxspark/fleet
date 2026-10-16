// European Portuguese. Keys are the English text exactly as written in the code
// (t('...')) or as the server sends it (templates with {placeholders}).
// Split by area so each part stays readable; later parts win on duplicates.
import shell from './pt/shell.js';
import settings from './pt/settings.js';
import code from './pt/code.js';
import work from './pt/work.js';
import server from './pt/server.js';

export default { ...server, ...shell, ...settings, ...code, ...work };
