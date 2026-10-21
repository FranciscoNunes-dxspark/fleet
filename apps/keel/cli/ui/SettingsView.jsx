import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import {
  MERGE_LABEL, MERGE_STRATEGIES, UPDATE_LABEL, UPDATE_MODES, cycle, selectable, settingsRows, settingsSections, stepRefresh, stepThreshold, withAllRepos, withRepo, withTracked,
} from '../settings.js';
import { theme } from '../theme.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

const box = (on) => ({ text: on ? '[x] ' : '[ ] ', color: on ? theme.accent : theme.dim });

const HINTS = {
  project: (r) => (r.tracked ? 'space stop tracking · ↵ pick its repos' : 'space track it'),
  allRepos: () => 'space all repos, or pick them',
  repo: () => 'space in or out',
  merge: () => 'space next merge type',
  deleteBranch: () => 'space on or off',
  transitionWorkItems: () => 'space on or off',
  refresh: () => '- / + every 15 seconds',
  threshold: (r) => `- / + one ${r.unit.replace(/s$/, '')}`,
  org: (r) => (r.org.primary ? 'the primary one' : 'x remove'),
  addOrg: () => '↵ /addorg <address>',
  updates: () => 'space next choice',
  mouse: (r) => (r.available ? 'space on or off' : ''),
  info: () => '',
};

/**
 * Settings, an overlay over the tabs (/settings or ","; esc closes it): the projects and repos Keel follows, when to flag things,
 * merge defaults and how often it checks (the web app's settings, in the same data folder), the organizations, and this
 * computer's own. Sections down the left, as the ? window's; tab (or h/l, or a click) goes to another, and the cursor
 * stays in the rows of the one on screen.
 */
export function SettingsView({ version, orgs, local, filter, ctx, width, height, active }) {
  // Read again whenever everything else is (the version moves on each load and after each change).
  const [view, setView] = useState({});
  useEffect(() => {
    let live = true;
    ctx.service.settingsView().then((value) => live && setView({ value }), (error) => live && setView((v) => ({ ...v, error })));
    return () => {
      live = false;
    };
  }, [version]);
  const [open, setOpen] = useState(() => new Set());
  const [options, setOptions] = useState({});
  // What was tracked when Settings opened goes first, and stays first while it's open.
  const pinned = useRef(null);
  if (!pinned.current && view.value) pinned.current = new Set(Object.keys(view.value.settings.projects || {}).filter((id) => view.value.settings.projects[id]?.tracked));
  const rows = useMemo(
    () => settingsRows({ view: view.value, orgs, options, open, filter, local, pinned: pinned.current }),
    [view.value, orgs, options, open, filter, local],
  );
  const sections = useMemo(() => settingsSections(rows), [rows]);
  const [sec, setSec] = useState(0);
  // /find narrows the projects, so it shows them.
  useEffect(() => {
    if (filter) setSec(0);
  }, [filter]);
  const current = sections[Math.min(sec, sections.length - 1)];
  const list = current?.rows ?? [];
  const leftW = Math.min(26, Math.max(18, ...sections.map((x) => x.short.length + 8)));
  const rightW = width - leftW;
  const innerH = height - 2;
  const innerW = rightW - 2;
  const nav = useListNav(list.length, innerH, { selectable: (i) => selectable(list[i]), resetKey: `${filter}:${current?.id}` });
  const row = list[nav.index];
  const goSection = (dir) => setSec((i) => (i + dir + sections.length) % sections.length);

  useEffect(() => {
    ctx.select({ setting: row });
  }, [row]);

  // A project's repos, read the first time it's opened.
  const loadOptions = (p) => {
    if (options[p.id] && !options[p.id].error) return;
    setOptions((o) => ({ ...o, [p.id]: 'loading' }));
    ctx.service.projectOptions(p.id).then(
      (opt) => setOptions((o) => ({ ...o, [p.id]: opt })),
      (e) => setOptions((o) => ({ ...o, [p.id]: { error: e.message.split('\n')[0] } })),
    );
  };
  const toggleOpen = (p) => {
    const next = new Set(open);
    if (next.has(p.id)) next.delete(p.id);
    else {
      next.add(p.id);
      loadOptions(p);
    }
    setOpen(next);
  };

  const settings = view.value?.settings;
  const save = (title, patch, done) => a.saveSettings(ctx, title, patch, done);
  const ac = settings?.autoComplete || {};
  const toggle = (r) => {
    switch (r.kind) {
      case 'project':
        return save(`${r.tracked ? 'Stop tracking' : 'Track'} ${r.label}`, { projects: withTracked(settings, r.project, !r.tracked) }, r.tracked ? 'Its pull requests and pipelines no longer show.' : 'Its pull requests and pipelines show in the other tabs.');
      case 'allRepos':
        return save(`${r.project.name}: ${r.on ? 'pick its repos' : 'all repos'}`, { projects: withAllRepos(settings, r.project, rows.filter((x) => x.kind === 'repo' && x.project.id === r.project.id).map((x) => x.repo.id), !r.on) }, r.on ? 'Every repo is ticked: space takes one out.' : 'Every repo it has, including new ones.');
      case 'repo':
        return save(`${r.on ? 'Leave out' : 'Follow'} ${r.repo.name}`, { projects: withRepo(settings, r.project, r.allRepoIds, r.repo.id, !r.on) }, r.on ? 'Its pull requests and pipelines no longer show.' : 'Its pull requests and pipelines show again.');
      case 'merge': {
        const next = cycle(MERGE_STRATEGIES, r.value);
        return save(`Merge type: ${MERGE_LABEL[next]}`, { autoComplete: { ...ac, mergeStrategy: next } }, 'Used by c (complete) and auto-complete, here and in the web app.');
      }
      case 'deleteBranch':
        return save(`${r.on ? "Don't delete" : 'Delete'} the source branch after merging`, { autoComplete: { ...ac, deleteSourceBranch: !r.on } }, 'Used by c (complete) and auto-complete.');
      case 'transitionWorkItems':
        return save(`${r.on ? "Don't complete" : 'Complete'} linked work items when merging`, { autoComplete: { ...ac, transitionWorkItems: !r.on } }, 'Used by c (complete) and auto-complete.');
      case 'updates':
        return a.setUpdateMode(ctx, cycle(UPDATE_MODES, r.mode));
      case 'mouse':
        return r.available ? a.setMouse(ctx, !r.on) : ctx.note(r.why);
      case 'addOrg':
        return ctx.prefill('/addorg ');
      case 'refresh':
        return ctx.note('- and + change how often Keel checks.');
      case 'threshold':
        return ctx.note('- and + change it.');
      case 'org':
        if (!r.org.primary) return ctx.note('x removes it from Keel.');
        return ctx.note(ctx.server ? `${r.org.name} is the primary organization of Keel at ${ctx.server}.` : `${r.org.name} comes from ${local.envFile}.`);
      default:
        return undefined;
    }
  };

  const keys = (input, key) => {
    if (!ctx.settingsHasKeys()) return;
    if (key.tab) return goSection(key.shift ? -1 : 1);
    if (input === 'l') return goSection(1);
    if (input === 'h') return goSection(-1);
    if (nav.handle(input, key) || !row || !settings) return;
    if (key.return && row.kind === 'project') {
      if (!row.tracked) return ctx.note(`Space tracks ${row.label} first; then ↵ picks its repos.`);
      return toggleOpen(row.project);
    }
    if (input === ' ' || key.return) return toggle(row);
    if (row.kind === 'refresh' && (input === '-' || input === '+' || input === '=' || key.leftArrow || key.rightArrow)) {
      const seconds = stepRefresh(row.seconds, input === '-' || key.leftArrow ? -1 : 1);
      if (seconds !== row.seconds) save(`Check every ${seconds} seconds`, { refreshSeconds: seconds }, 'Here and in the web app, while either is open.');
      return;
    }
    if (row.kind === 'threshold' && (input === '-' || input === '+' || input === '=' || key.leftArrow || key.rightArrow)) {
      const value = stepThreshold(row.value, input === '-' || key.leftArrow ? -1 : 1, row.max);
      if (value !== row.value) save(`${row.label} ${value} ${row.unit}`, { thresholds: { ...settings.thresholds, [row.key]: value } }, 'The Inbox and the Team tab go by it, here and in the web app.');
      return;
    }
    if (row.kind === 'org' && input === 'x') a.removeOrg(ctx, row.org);
  };
  useInput(keys, { isActive: active });
  // A click picks a row and a double-click is ↵ (a project's repos, or the change a row makes); the wheel scrolls.
  useMouse(ctx, (e) => {
    if (e.x < leftW) {
      if (!e.wheel && e.y >= 1 && e.y - 1 < sections.length) setSec(e.y - 1);
      return;
    }
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const segmentsOf = (r) => {
    switch (r.kind) {
      case 'header':
        return [{ text: r.label, color: theme.accent, bold: true }];
      case 'note':
        return [{ text: r.text, color: r.error ? theme.del : theme.dim }];
      case 'project':
        return [box(r.tracked), { text: r.label, strong: true }, { text: r.summary ? `  ${r.summary}` : '', color: theme.dim }, { text: r.tracked ? (r.open ? '  ▾' : '  ▸') : '', color: theme.dim }];
      case 'allRepos':
        return [{ text: '    ' }, box(r.on), { text: `All repos (${r.count})`, strong: true }, { text: r.on ? '  including new ones' : '  only the ticked ones below', color: theme.dim }];
      case 'repo':
        return [{ text: '      ' }, box(r.on), { text: r.repo.name }];
      case 'merge':
        return [{ text: 'Merge type          ', color: theme.dim }, { text: MERGE_LABEL[r.value] ?? r.value, strong: true }];
      case 'deleteBranch':
        return [box(r.on), { text: 'Delete the source branch after merging' }];
      case 'transitionWorkItems':
        return [box(r.on), { text: 'Complete linked work items when merging' }];
      case 'threshold':
        return [{ text: `${r.label} `, color: theme.dim }, { text: `${r.value} ${r.unit}`, strong: true }];
      case 'refresh':
        return [{ text: 'Check for changes   ', color: theme.dim }, { text: `every ${r.seconds} seconds`, strong: true }, { text: '  while Keel is open', color: theme.dim }];
      case 'org':
        return [{ text: r.org.name, strong: true }, { text: `  ${r.org.url.replace(/^https?:\/\//, '')}`, color: theme.dim }, { text: r.org.primary ? '  primary' : r.org.kind === 'github' ? '  GitHub' : '', color: theme.dim }];
      case 'addOrg':
        return [{ text: '+ Add an organization or GitHub owner', color: theme.accent }];
      case 'updates':
        return [{ text: 'Updates             ', color: theme.dim }, { text: UPDATE_LABEL[r.mode], strong: true }];
      case 'mouse':
        return r.available
          ? [box(r.on), { text: 'Mouse: click, double-click, scroll, drag to copy' }, { text: r.on ? '' : "  off: the terminal's own selection", color: theme.dim }]
          : [{ text: 'Mouse               ', color: theme.dim }, { text: r.why, color: theme.dim }];
      case 'info':
        return [{ text: `${r.label.padEnd(20)}`, color: theme.dim }, { text: r.text }];
      default:
        return [];
    }
  };

  const hint = row && HINTS[row.kind] ? HINTS[row.kind](row) : '';
  let empty = null;
  if (!view.value) empty = view.error ? `  Couldn't read the settings: ${view.error.message.split('\n')[0]}` : '  Reading the settings…';
  return (
    <Box width={width} height={height}>
      <Panel title="Settings" hint="tab" width={leftW} height={height}>
        {sections.map((x, i) => {
          const on = x.id === current?.id;
          const note = x.label.split(' · ')[1] ?? '';
          return (
            // Keys go to the rows beside it, so the section on screen is marked, without a cursor of its own.
            <Row
              key={x.id}
              width={leftW - 2}
              pointer={false}
              segments={[{ text: on ? '▸ ' : '  ', color: theme.accent }, { text: x.short, color: on ? theme.accent : undefined, bold: on },{ text: note ? `  ${note.replace(/ tracked$/, '')}` : '', color: theme.dim }]}
            />
          );
        })}
      </Panel>
      <Panel title={current?.label ?? 'Settings'} hint={hint} width={rightW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: view.error ? theme.del : theme.dim }]} /> : null}
        {list.slice(nav.offset, nav.offset + innerH).map((r, i) => (
          <Row
            key={`${r.kind}:${r.project?.id ?? r.org?.key ?? r.label ?? ''}:${r.repo?.id ?? ''}`}
            width={innerW}
            pointer={r.kind !== 'header'}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={segmentsOf(r)}
          />
        ))}
      </Panel>
    </Box>
  );
}
