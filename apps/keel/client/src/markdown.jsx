import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useApp } from './context.js';
import { imageSource } from './images.js';
import { t } from './i18n.js';
import { TextArea } from '@radix-ui/themes';

marked.setOptions({ gfm: true, breaks: true });

// PR text comes from other people, so everything is sanitized. Links open in a
// new tab; images are shown only from your Azure DevOps organizations (through the
// server, which has your PAT) or written into the text as data: (images.js), and
// any other is dropped rather than fetched.
let orgPrefixes = [];
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = imageSource(node.getAttribute('src'), orgPrefixes);
    if (src) {
      node.setAttribute('src', src);
      node.setAttribute('loading', 'lazy');
    } else {
      node.replaceWith(Object.assign(document.createElement('span'), { className: 'md-img-blocked', textContent: `[image: ${node.getAttribute('alt') || 'external'}]` }));
    }
  }
});

/** Azure DevOps stores @mentions as "@<identity-guid>"; show the person's name instead. */
function resolveMentions(text, names) {
  return text.replace(/@<([0-9A-Za-z-]{2,64})>/g, (m, id) => `**@${names.get(id.toLowerCase()) || 'someone'}**`);
}

/** Markdown text, or (html) a rich-text field Azure DevOps stores as HTML; both sanitized. */
export function Markdown({ text, html, people = [] }) {
  const { meta } = useApp();
  const safe = useMemo(() => {
    // GitHub's images need a browser signed in to GitHub, not a token: they stay blocked.
    orgPrefixes = meta.mock ? [] : (meta.orgs?.length ? meta.orgs : [{ url: meta.orgUrl }]).filter((o) => o.kind !== 'github' && o.url).map((o) => `${o.url}/`);
    const names = new Map(people.filter(Boolean).map((p) => [String(p.id).toLowerCase(), p.displayName]));
    const source = html ? String(html) : marked.parse(resolveMentions(text || '', names));
    return DOMPurify.sanitize(source, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  }, [text, html, people, meta.orgUrl, meta.orgs, meta.mock]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: safe }} />;
}

/**
 * A Markdown textarea with Write / Preview tabs. It grows with what's written (up to most of the
 * window), can be dragged taller, and Expand gives it most of the window at once; Ctrl or ⌘ + Enter
 * sends the form it's in. Extra props go to the textarea.
 */
export function MarkdownInput({ value, onChange, label, rows = 5, people, ...rest }) {
  const [preview, setPreview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Back to writing, at its own size, once the text is posted or cleared.
  useEffect(() => { if (!value) { setPreview(false); setExpanded(false); } }, [value]);
  const send = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
  };
  return (
    <div className={`md-input${expanded ? ' md-expanded' : ''}`}>
      <div className="md-input-bar">
        <span className="segmented segmented-compact" role="tablist" aria-label={label}>
          <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t('Write')}</button>
          <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t('Preview')}</button>
        </span>
        <span className="md-input-tools">
          <a className="small muted" href="https://learn.microsoft.com/azure/devops/project/wiki/markdown-guidance" target="_blank" rel="noreferrer noopener">{t('Markdown supported')}</a>
          <button type="button" className="link-btn small" aria-pressed={expanded} onClick={() => setExpanded((x) => !x)}>{expanded ? t('Shrink') : t('Expand')}</button>
        </span>
      </div>
      {preview
        ? <div className="md-preview" style={{ minHeight: `${rows * 1.5}em` }}><Markdown text={value || t('_Nothing to preview._')} people={people} /></div>
        : <TextArea variant="surface" color="gray" resize="vertical" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={send} aria-label={label} {...rest} />}
      {!preview && <span className="md-input-hint small muted">{t('Ctrl + Enter to send')}</span>}
    </div>
  );
}
