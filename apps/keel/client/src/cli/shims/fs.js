// No files in the browser: reads fail as a missing file would, and writes (this computer's .env) are dropped.
const missing = (p) => {
  throw Object.assign(new Error(`ENOENT: no such file, '${p}'`), { code: 'ENOENT' });
};
export const existsSync = () => false;
export const readFileSync = missing;
export const statSync = missing;
export const readdirSync = () => [];
export const writeFileSync = () => {};
export const appendFileSync = () => {};
export const mkdirSync = () => {};
export const renameSync = () => {};
export const rmSync = () => {};
export const unlinkSync = () => {};
export const promises = { readFile: async (p) => missing(p), writeFile: async () => {}, mkdir: async () => {}, rename: async () => {}, rm: async () => {} };
export default { existsSync, readFileSync, statSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, renameSync, rmSync, unlinkSync, promises };
