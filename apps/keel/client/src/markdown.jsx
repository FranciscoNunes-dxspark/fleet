import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useApp } from './context.js';
import { t } from './i18n.js';

marked.setOptions({ gfm: true, breaks: true });

// PR text comes from other people, so everything is sanitized. Links open in a
// new tab, and images hosted in your organization load through the server
// (they need your PAT); any other image is dropped rather than fetched.
let orgPrefix = '';
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    let abs = '';
    try {
      abs = orgPrefix ? new URL(src, orgPrefix).href : '';
    } catch {
      abs = '';
    }
    if (abs && orgPrefix && abs.toLowerCase().startsWith(orgPrefix.toLowerCase())) {
      node.setAttribute('src', `/api/image?url=${encodeURIComponent(abs)}`);
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
    orgPrefix = meta.mock ? '' : `${meta.orgUrl}/`;
    const names = new Map(people.filter(Boolean).map((p) => [String(p.id).toLowerCase(), p.displayName]));
    const source = html ? String(html) : marked.parse(resolveMentions(text || '', names));
    return DOMPurify.sanitize(source, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  }, [text, html, people, meta.orgUrl, meta.mock]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: safe }} />;
}

/** A Markdown textarea with Write / Preview tabs. Extra props go to the textarea. */
export function MarkdownInput({ value, onChange, label, rows = 4, people, ...rest }) {
  const [preview, setPreview] = useState(false);
  // Back to writing once the text is posted or cleared.
  useEffect(() => { if (!value) setPreview(false); }, [value]);
  return (
    <div className="md-input">
      <div className="md-input-bar">
        <span className="segmented segmented-compact" role="tablist" aria-label={label}>
          <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t('Write')}</button>
          <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t('Preview')}</button>
        </span>
        <a className="small muted" href="https://learn.microsoft.com/azure/devops/project/wiki/markdown-guidance" target="_blank" rel="noreferrer noopener">{t('Markdown supported')}</a>
      </div>
      {preview
        ? <div className="md-preview" style={{ minHeight: `${rows * 1.5}em` }}><Markdown text={value || t('_Nothing to preview._')} people={people} /></div>
        : <textarea className="input" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} {...rest} />}
    </div>
  );
}
