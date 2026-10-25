// One encryption key for everything Keel stores that must stay secret:
// sign-in tokens and Azure (Application Insights) API keys. AES-256-GCM.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let key = null;

/** SESSION_SECRET if set; otherwise a random key generated once into data/secret.key. */
export function getKey() {
  if (key) return key;
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    key = crypto.createHash('sha256').update(secret).digest();
    return key;
  }
  const file = path.join(config.dataDir, 'secret.key');
  const read = () => {
    try {
      const saved = fs.readFileSync(file, 'utf8').trim();
      return /^[0-9a-f]{64}$/.test(saved) ? Buffer.from(saved, 'hex') : null;
    } catch {
      return null;
    }
  };
  key = read();
  if (!key) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    try {
      // 'wx' fails if another server process wrote its key first; then every process uses that one,
      // or a token one of them encrypted couldn't be read by the others.
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      // written by another process
    }
    key = read();
    if (!key) throw new Error(`Couldn't read the encryption key in ${file}. Set SESSION_SECRET, or remove that file.`);
  }
  return key;
}

export function encrypt(k, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

export function decrypt(k, blob) {
  const buf = Buffer.from(blob, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
