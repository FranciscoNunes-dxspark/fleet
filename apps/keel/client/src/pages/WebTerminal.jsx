import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@xterm/xterm/css/xterm.css';
import { t } from '../i18n.js';

// The terminal app's own palette (cli/theme.js), whatever the web app's theme: it is drawn for a dark terminal.
const THEME = { background: '#121212', foreground: '#e4e4e4', cursor: '#ff8a65', selectionBackground: '#3a2219' };

/** The terminal app (cli/), Ink and all, running on the page in xterm.js. */
export default function WebTerminal() {
  const box = useRef(null);
  const navigate = useNavigate();
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    let stop;
    const page = new AbortController();
    const font = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    import('../cli/boot.js')
      .then(({ startTerminal }) => startTerminal(box.current, { theme: THEME, fontFamily: font, onExit: () => navigate('/'), signal: page.signal }))
      .then((s) => (page.signal.aborted ? s() : (stop = s)))
      .catch((e) => setFailed(e.message));
    return () => {
      page.abort();
      stop?.();
    };
  }, []);

  // The whole window, without the menu (App.jsx): ? for shortcuts, / for commands, q to leave.
  return (
    <div className="web-terminal-page" role="application" aria-label={t('Terminal app')}>
      {failed ? <p className="text-bad">{t("The terminal app couldn't start: {reason}", { reason: failed })}</p> : <div className="web-terminal" ref={box} />}
    </div>
  );
}
