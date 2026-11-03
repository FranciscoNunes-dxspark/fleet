// The pages to audit, and the hosts for the domain checks: a folder's lantern.json, and its project's
// environments (.fleet/project.json, the kit's environments.js), whose "lantern" section names each
// environment's page: { "url": "https://staging.shop.example/" } or { "urls": [ … ] }.
//
//   lantern.json: { "pages": ["https://shop.example/", { "name": "checkout", "url": "https://shop.example/checkout" }],
//                   "domains": ["shop.example"] }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '@fleet/kit/environments.js';

export const PAGES_FILE = 'lantern.json';

/** Whether `s` is an http(s) URL Lantern will open. */
export function isUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A URL as typed (shop.example/x) made whole (https://shop.example/x); null when it can't be one. */
export function normalUrl(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const withScheme = /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
  return isUrl(withScheme) ? new URL(withScheme).href : null;
}

/** The page's path, which names it when nothing else does and pairs it across environments. */
export const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

export const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const entry = (x, extra = {}) => {
  const url = normalUrl(typeof x === 'string' ? x : x?.url);
  if (!url) return null;
  return { name: (typeof x === 'object' && x?.name) || pathOf(url), url, ...extra };
};

/**
 * { pages: [{ name, url, env? }], domains: [host], sources: [file], errors: [sentence] } for `dir`:
 * lantern.json's pages, then each environment's (in the project file's order).
 */
export function readPages(dir) {
  const pages = [];
  const domains = [];
  const sources = [];
  const errors = [];
  try {
    const json = JSON.parse(readFileSync(join(dir, PAGES_FILE), 'utf8').replace(/^﻿/, ''));
    sources.push(PAGES_FILE);
    for (const p of [...[].concat(json.pages ?? []), ...[].concat(json.urls ?? [])]) {
      const e = entry(p);
      if (e) pages.push(e);
      else errors.push(`${PAGES_FILE}: ${JSON.stringify(p)} isn't a URL`);
    }
    for (const d of [].concat(json.domains ?? [])) if (typeof d === 'string' && d.trim()) domains.push(d.trim().toLowerCase());
  } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`${PAGES_FILE} can't be read: ${String(e.message).split('\n')[0]}`);
  }
  const project = readProject(dir);
  if (project?.error) errors.push(`${project.file} can't be read: ${project.error}`);
  else if (project) {
    let named = false;
    for (const env of project.names) {
      const own = project.environments[env]?.lantern;
      if (!own || typeof own !== 'object') continue;
      named = true;
      for (const u of [...(own.url ? [own.url] : []), ...[].concat(own.urls ?? [])]) {
        const e = entry(u, { env });
        if (e) pages.push(e);
        else errors.push(`.fleet/project.json: ${env}'s lantern url ${JSON.stringify(u)} isn't a URL`);
      }
    }
    if (named) sources.push('.fleet/project.json');
  }
  const seen = new Set();
  const unique = pages.filter((p) => !seen.has(`${p.env ?? ''} ${p.url}`) && seen.add(`${p.env ?? ''} ${p.url}`));
  return { pages: unique, domains: [...new Set([...domains, ...unique.map((p) => hostOf(p.url)).filter(Boolean)])], sources, errors };
}

/** The page in environment `env` paired with `page` (the same path), or null. */
export function counterpart(pages, page, env) {
  return pages.find((p) => p.env === env && pathOf(p.url) === pathOf(page.url)) ?? pages.find((p) => p.env === env) ?? null;
}
