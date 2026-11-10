import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { Theme } from '@radix-ui/themes';
import { useApi } from './context.js';
import { t } from './i18n.js';
import { ErrorBox, Loading } from './ui.jsx';
import { Icon } from './icons.jsx';
import { splitRows } from './diffrows.js';

// Side by side or one column: each viewer's own choice, kept in this browser. Side by side by
// default where there is room for two columns of code.
const MODE_KEY = 'keel.diff.mode';
const readMode = () => {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'split' || saved === 'unified') return saved;
  } catch { /* private window */ }
  return typeof window !== 'undefined' && window.innerWidth >= 1100 ? 'split' : 'unified';
};

const tone = (l) => (!l ? 'diff-gap' : l.t === '+' ? 'diff-add' : l.t === '-' ? 'diff-del' : 'diff-ctx');

/** A file's hunks as a table, in one column (unified) or two (split). */
export function DiffTable({ d, mode = 'unified' }) {
  if (mode === 'split') {
    return (
      <table className="diff-table diff-split">
        <colgroup><col className="diff-no-col" /><col /><col className="diff-no-col" /><col /></colgroup>
        <tbody>
          {d.hunks.map((h, i) => (
            <Fragment key={i}>
              <tr className="diff-hunk"><td colSpan={4}>{h.header}</td></tr>
              {splitRows(h.lines).map((r, j) => (
                <tr key={j}>
                  <td className={`diff-no ${tone(r.left)}`}>{r.left?.a ?? ''}</td>
                  <td className={`diff-text ${tone(r.left)}`}>{r.left ? r.left.text : ''}</td>
                  <td className={`diff-no diff-side ${tone(r.right)}`}>{r.right?.b ?? ''}</td>
                  <td className={`diff-text ${tone(r.right)}`}>{r.right ? r.right.text : ''}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="diff-table">
      <tbody>
        {d.hunks.map((h, i) => (
          <Fragment key={i}>
            <tr className="diff-hunk"><td colSpan={3}>{h.header}</td></tr>
            {h.lines.map((l, j) => (
              <tr key={j} className={tone(l)}>
                <td className="diff-no">{l.a ?? ''}</td>
                <td className="diff-no">{l.b ?? ''}</td>
                <td className="diff-text"><span aria-hidden="true">{l.t === ' ' ? ' ' : l.t}</span>{l.text}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** What a file's diff says instead of lines, when it has none to show; null when it has. */
export function diffNote(d) {
  if (d.skipped) return d.skipped === 'binary' ? t('A binary file: there is no text to compare.') : t('Too large to show here: open it in the browser instead.');
  if (!d.hunks.length) return t('No lines changed (the file was moved or its mode changed).');
  return null;
}

function ViewerDiff({ url, mode }) {
  const { data: d, error, reload } = useApi(url);
  if (!d) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const note = diffNote(d);
  if (note) return <p className="muted diff-viewer-note">{note}</p>;
  return <DiffTable d={d} mode={mode} />;
}

/**
 * Every changed file of a pull request or commit in one window: the files down the left, the
 * chosen one's changes on the right, side by side or in one column. j and k (or [ and ]) go to the
 * next and previous file; Esc closes it.
 */
export function DiffViewer({ files, initialPath, diffPath, fileHref, webUrl, title, onClose }) {
  const [path, setPath] = useState(initialPath || files[0]?.path);
  const [mode, setMode] = useState(readMode);
  const body = useRef(null);
  const at = Math.max(0, files.findIndex((f) => f.path === path));
  const file = files[at];
  const go = (n) => { const next = files[Math.min(files.length - 1, Math.max(0, at + n))]; if (next) setPath(next.path); };
  const pickMode = (m) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* this visit only */ } };

  useEffect(() => { body.current?.scrollTo(0, 0); }, [path]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'j' || e.key === ']') { e.preventDefault(); go(1); }
      if (e.key === 'k' || e.key === '[') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Each file's folder once, then its name, as a list reads in a code review.
  const rail = useMemo(() => files.map((f) => {
    const parts = f.path.replace(/^\//, '').split('/');
    return { ...f, name: parts.pop(), dir: parts.join('/') };
  }), [files]);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Theme asChild>
          <div className="diff-viewer-layer">
            <Dialog.Overlay className="drawer-scrim" />
            <Dialog.Content className="diff-viewer" aria-describedby={undefined}>
              <header className="diff-viewer-head">
                <Dialog.Title className="diff-viewer-title">{title || t('Changes')}</Dialog.Title>
                <span className="muted small">{t('{n} of {total}', { n: at + 1, total: files.length })}</span>
                <span className="segmented segmented-compact diff-viewer-mode" role="group" aria-label={t('Layout')}>
                  <button type="button" className={mode === 'split' ? 'on' : ''} aria-pressed={mode === 'split'} onClick={() => pickMode('split')}>{t('Side by side')}</button>
                  <button type="button" className={mode === 'unified' ? 'on' : ''} aria-pressed={mode === 'unified'} onClick={() => pickMode('unified')}>{t('One column')}</button>
                </span>
                <Dialog.Close asChild>
                  <button type="button" className="drawer-tool" aria-label={t('Close')} title={t('Close')}><Icon name="close" size={16} /></button>
                </Dialog.Close>
              </header>
              <nav className="diff-viewer-files" aria-label={t('Files changed')}>
                <ol>
                  {rail.map((f) => (
                    <li key={f.path}>
                      <button type="button" className={f.path === file?.path ? 'on' : ''} aria-current={f.path === file?.path ? 'true' : undefined} onClick={() => setPath(f.path)} title={f.path}>
                        <span className={`diff-kind diff-kind-${f.kind || 'edited'}`} aria-hidden="true" />
                        <span className="diff-file-name">{f.name}</span>
                        {f.dir && <span className="diff-file-dir">{f.dir}</span>}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
              <section className="diff-viewer-body" ref={body}>
                {file && (
                  <>
                    <div className="diff-viewer-file">
                      <span className="mono">{file.path.replace(/^\//, '')}</span>
                      {file.originalPath && <span className="muted small">{t('from {name}', { name: file.originalPath })}</span>}
                      {fileHref && <a className="small diff-viewer-out" href={fileHref(webUrl, file.path)} target="_blank" rel="noreferrer noopener">{t('Open outside Keel')} ↗</a>}
                    </div>
                    <ViewerDiff key={file.path} url={diffPath(file)} mode={mode} />
                  </>
                )}
              </section>
              <footer className="diff-viewer-foot small muted">
                <span><kbd>j</kbd> <kbd>k</kbd> {t('Next and previous file')}</span>
                <span><kbd>Esc</kbd> {t('Close')}</span>
                <VisuallyHidden.Root>{file?.path}</VisuallyHidden.Root>
              </footer>
            </Dialog.Content>
          </div>
        </Theme>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
