import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useApp } from './context.js';

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

export function Markdown({ text, people = [] }) {
  const { meta } = useApp();
  const html = useMemo(() => {
    orgPrefix = meta.mock ? '' : `${meta.orgUrl}/`;
    const names = new Map(people.filter(Boolean).map((p) => [String(p.id).toLowerCase(), p.displayName]));
    return DOMPurify.sanitize(marked.parse(resolveMentions(text || '', names)), { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  }, [text, people, meta.orgUrl, meta.mock]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
