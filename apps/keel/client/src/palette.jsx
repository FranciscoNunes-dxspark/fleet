import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { useApp } from './context.js';
import { Icon } from './icons.jsx';
import { parseQuery, rank } from './search.js';
import { t } from './i18n.js';

// Lists the palette searches, fetched when it opens and kept a minute (the server caches them too).
const SOURCES = ['/prs', '/workitems', '/pipelines', '/repos'];
const TTL = 60_000;
let loaded = { at: 0, data: null };

const RECENT_KEY = 'keel.palette.recent.v1';
const readRecent = () => {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.slice(0, 8) : [];
  } catch {
    return [];
  }
};
const remember = (entry) => {
  if (entry.run) return; // actions that run code can't be stored
  try {
    const { key, kind, title, sub, to, target } = entry;
    const next = [{ key, kind, title, sub, to, target }, ...readRecent().filter((r) => r.key !== key)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: nothing is remembered.
  }
};

const KIND = {
  get page() { return t('Page'); },
  get action() { return t('Action'); },
  get pr() { return t('Pull request'); },
  get workitem() { return t('Work item'); },
  get pipeline() { return t('Pipeline'); },
  get repo() { return t('Commits'); },
};

/** Every page and tab, with the words people might type for it. */
function pages(can, authMode) {
  const p = (to, title, keywords = []) => ({ key: `page:${to}`, kind: 'page', title, sub: to, keywords, to, boost: 1 });
  return [
    p('/', t('Dashboard'), ['home', 'widgets']),
    p('/inbox', t('Inbox'), ['attention', 'needs me', 'triage']),
    p('/summary', t('Weekly summary'), ['week', 'report']),
    p('/work', t('Work items'), ['backlog', 'tickets']),
    p('/work?view=mine', `${t('Work items')} · ${t('Mine')}`, ['my items', 'assigned to me']),
    p('/work?view=sprint', `${t('Work items')} · ${t('Current sprint')}`, ['iteration']),
    p('/work?view=bugs', `${t('Work items')} · ${t('Bugs')}`),
    p('/work?view=blocked', `${t('Work items')} · ${t('Blocked')}`, ['impediment']),
    p('/work?view=unassigned', `${t('Work items')} · ${t('Unassigned')}`),
    p('/board', t('Board'), ['kanban', 'columns']),
    p('/board?mode=sprint', `${t('Board')} · ${t('Current sprint')}`, ['taskboard', 'iteration']),
    p('/epics', t('Epics'), ['features', 'roadmap']),
    p('/prs', t('Pull requests'), ['reviews', 'code']),
    p('/commits', t('Commits'), ['history', 'git']),
    p('/pipelines', t('Pipelines'), ['builds', 'ci']),
    p('/pipelines?tab=releases', `${t('Pipelines')} · ${t('Releases')}`, ['deploy', 'classic']),
    p('/production', t('Production'), ['monitors', 'uptime', 'health']),
    p('/ship', t('Waiting to ship'), ['undeployed', 'pending', 'not deployed']),
    p('/totals', t('Platform totals'), ['ism']),
    p('/team', t('Team'), ['people', 'load']),
    p('/insights', `${t('Insights')} · ${t('Delivery to production')}`, ['dora', 'metrics']),
    p('/insights?tab=review', `${t('Insights')} · ${t('Code review and merging')}`, ['metrics']),
    p('/insights?tab=flow', `${t('Insights')} · ${t('Work item flow')}`, ['cycle time', 'throughput', 'aging', 'sprint scope']),
    p('/settings', t('Settings'), ['preferences', 'projects', 'repos', 'monitors', 'notifications']),
    ...(authMode === 'login' && can('users.manage') ? [p('/users', t('Users'), ['accounts', 'invite'])] : []),
  ];
}

/** Searchable entries from the loaded lists. */
function itemsOf(data) {
  if (!data) return [];
  const [prs, work, pipes, repos] = data;
  return [
    ...(prs?.prs || []).map((p) => ({
      key: `pr:${p.org || ''}:${p.key}`, kind: 'pr', title: p.title, ids: [p.id],
      sub: `!${p.id} · ${p.repoName} · ${p.author?.displayName || ''}`, keywords: [p.sourceBranch, p.projectName],
      target: { type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id, org: p.org },
    })),
    ...(work?.items || []).map((w) => ({
      key: `wi:${w.org || ''}:${w.id}`, kind: 'workitem', title: w.title, ids: [w.id],
      sub: `${w.type} #${w.id} · ${w.state}${w.assignedTo ? ` · ${w.assignedTo.displayName}` : ''}`, keywords: [w.projectName, ...(w.tags || [])],
      target: { type: 'workitem', id: w.id, org: w.org },
    })),
    ...(pipes || []).map((p) => ({
      key: `pipe:${p.org || ''}:${p.key}`, kind: 'pipeline', title: p.definition.name,
      sub: [p.projectName, p.repoName, p.health].filter(Boolean).join(' · '), keywords: [p.definition.path],
      target: { type: 'pipeline', key: p.key, org: p.org },
    })),
    ...(repos || []).map((r) => ({
      key: `repo:${r.org || ''}:${r.id}`, kind: 'repo', title: r.name, sub: `${t('Commits')} · ${r.projectName}`,
      to: `/commits?project=${encodeURIComponent(r.projectId)}&repo=${encodeURIComponent(r.id)}`,
    })),
  ];
}

/**
 * The command palette: Ctrl+K (⌘K on a Mac) anywhere, or the search button in
 * the menu. Finds pages, pull requests, work items, pipelines and repos, and
 * opens a work item by number (#4107) or a pull request (!815).
 */
export function CommandPalette() {
  const { openDrawer, refresh, can, authMode } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [data, setData] = useState(loaded.data);
  const [failed, setFailed] = useState(false);
  const input = useRef(null);
  const list = useRef(null);
  const back = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keel:palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keel:palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    back.current = document.activeElement;
    setQ('');
    setActive(0);
    setFailed(false);
    input.current?.focus();
    if (Date.now() - loaded.at > TTL || !loaded.data) {
      // Each list on its own: one failing (no pipelines access, say) still leaves the rest.
      Promise.all(SOURCES.map((s) => api(s).catch(() => null))).then((d) => {
        if (d.every((x) => x === null)) setFailed(true);
        loaded = { at: Date.now(), data: d };
        setData(d);
      });
    }
    return () => back.current?.focus?.();
  }, [open]);

  const actions = useMemo(() => [
    ...(can('workitems.write') ? [{ key: 'action:newwi', kind: 'action', title: t('New work item'), keywords: ['create', 'bug', 'story', 'task'], target: { type: 'newworkitem' }, boost: 1 }] : []),
    ...(can('prs.write') ? [{ key: 'action:newpr', kind: 'action', title: t('New pull request'), keywords: ['create'], target: { type: 'newpr' }, boost: 1 }] : []),
    { key: 'action:refresh', kind: 'action', title: t('Refresh from Azure DevOps'), keywords: ['reload'], run: () => api('/refresh', { method: 'POST' }).then(refresh), boost: 1 },
  ], [can, refresh]);
  const entries = useMemo(() => [...pages(can, authMode), ...actions, ...itemsOf(data)], [can, authMode, actions, data]);

  const results = useMemo(() => {
    const query = parseQuery(q);
    if (!query.words.length) return readRecent().length ? readRecent() : pages(can, authMode).slice(0, 8);
    const found = rank(entries, query, 40);
    // A number that isn't in the open lists: any work item by that number (closed ones too).
    if (query.workItemId != null && !found.some((e) => e.kind === 'workitem' && e.ids?.includes(query.workItemId))) {
      found.unshift({ key: `wi::${query.workItemId}`, kind: 'workitem', title: t('Open work item #{id}', { id: query.workItemId }), sub: t('Any work item, open or closed'), target: { type: 'workitem', id: query.workItemId } });
    }
    return found;
  }, [q, entries, can, authMode]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = useCallback((entry) => {
    if (!entry) return;
    setOpen(false);
    remember(entry);
    if (entry.run) entry.run();
    else if (entry.target) openDrawer(entry.target);
    else if (entry.to) navigate(entry.to);
  }, [openDrawer, navigate]);

  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };
  const recent = !parseQuery(q).words.length && readRecent().length > 0;

  return (
    <div className="palette-layer">
      <div className="drawer-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Search Keel')}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('Search pages, pull requests, work items, pipelines… (#4107, !815)')}
            aria-label={t('Search Keel')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="palette-esc">Esc</kbd>
        </div>
        <div className="palette-head small muted">
          {recent ? t('Recently opened') : !parseQuery(q).words.length ? t('Go to') : !data && !failed ? t('Loading…') : t(results.length === 1 ? '{n} result' : '{n} results', { n: results.length })}
          {failed && <span className="text-warn"> · {t("Couldn't load the lists; pages still work.")}</span>}
        </div>
        <ul className="palette-results" id="palette-results" role="listbox" ref={list}>
          {results.map((r, i) => (
            <li
              key={r.key}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span className="palette-title truncate">{r.title}</span>
              {r.sub && <span className="palette-sub truncate">{r.sub}</span>}
              <span className="palette-kind">{KIND[r.kind]}</span>
            </li>
          ))}
          {!results.length && <li className="palette-empty muted">{t('Nothing matches. Try fewer words, or a work item number like #4107.')}</li>}
        </ul>
        <div className="palette-foot small muted">{t('↑↓ to move · Enter to open · Ctrl+K to close')}</div>
      </div>
    </div>
  );
}
