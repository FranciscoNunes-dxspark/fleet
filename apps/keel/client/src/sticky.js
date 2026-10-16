// View choices that survive moving between pages and reloads: the board's
// project and team, list filters, tabs and toggles. Kept per browser (they
// describe how you look at things here, not your account). Free-text search
// boxes are not kept.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const KEY = 'keel.view.v1';

const readAll = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const writeOne = (name, value) => {
  try {
    const all = readAll();
    if (value === undefined) delete all[name];
    else all[name] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the choice lasts until you leave the page.
  }
};

/** Like useState, but remembered under `name` (e.g. "prs.project"). */
export function useSticky(name, initial) {
  const [value, setValue] = useState(() => {
    const saved = readAll()[name];
    return saved === undefined ? (typeof initial === 'function' ? initial() : initial) : saved;
  });
  useEffect(() => writeOne(name, value), [name, value]);
  return [value, setValue];
}

/**
 * useSearchParams for choices kept in the URL (so links still share them).
 * Opening the page without any of `keys` in the URL (from the menu, say)
 * brings back the last values used on this page.
 */
export function useStickyParams(page, keys) {
  const [params, setParams] = useSearchParams();
  const hasAny = keys.some((k) => params.has(k));
  const savedJson = hasAny ? '' : JSON.stringify(readAll()[`${page}.params`] || {});

  const merged = useMemo(() => {
    if (hasAny || savedJson === '{}') return params;
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(JSON.parse(savedJson))) if (keys.includes(k) && v) next.set(k, v);
    return next;
  }, [params, hasAny, savedJson]); // keys is a constant list per page

  // Show the restored values in the address bar too.
  useEffect(() => {
    if (merged !== params) setParams(merged, { replace: true });
  }, [merged, params, setParams]);

  // Remember what's in effect now.
  useEffect(() => {
    const picked = {};
    for (const k of keys) if (merged.get(k)) picked[k] = merged.get(k);
    writeOne(`${page}.params`, picked);
  }, [merged, page]);

  // Remember the new choice before the URL changes: clearing the last choice
  // (e.g. "Anyone") empties the URL, which would otherwise bring the old one back.
  const set = useCallback((next, opts) => {
    const value = new URLSearchParams(typeof next === 'function' ? next(merged) : next);
    const picked = {};
    for (const k of keys) if (value.get(k)) picked[k] = value.get(k);
    writeOne(`${page}.params`, picked);
    setParams(value, opts);
  }, [setParams, merged, page]); // keys is a constant list per page
  return [merged, set];
}
