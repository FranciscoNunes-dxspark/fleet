// POSIX paths, enough for the folder names the terminal app works out.
const parts = (list) => {
  const out = [];
  for (const p of list.join('/').split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
};
export const sep = '/';
export const delimiter = ':';
export const join = (...list) => `${list[0]?.startsWith('/') ? '/' : ''}${parts(list).join('/')}` || '.';
export const resolve = (...list) => {
  const from = list.findLastIndex((p) => p.startsWith('/'));
  return `/${parts(from < 0 ? list : list.slice(from)).join('/')}`;
};
export const dirname = (p) => p.replace(/\/[^/]*\/?$/, '') || '/';
export const basename = (p, ext) => {
  const b = p.replace(/\/+$/, '').split('/').pop() ?? '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname = (p) => /\.[^./]*$/.exec(basename(p))?.[0] ?? '';
export const relative = (from, to) => to.replace(`${from.replace(/\/$/, '')}/`, '');
export const isAbsolute = (p) => p.startsWith('/');
const path = { sep, delimiter, join, resolve, dirname, basename, extname, relative, isAbsolute };
path.posix = path;
path.win32 = path;
export const posix = path;
export default path;
