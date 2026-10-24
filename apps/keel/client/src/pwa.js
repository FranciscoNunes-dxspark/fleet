// The installed app and push notifications on this device (public/sw.js,
// server/push.js). Push is per device: turning it on here asks the browser
// for permission and hands Keel this browser's push subscription.
import { api } from './api.js';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;

/** Register the service worker (built app only: the dev server has no sw.js of its own). */
export function registerServiceWorker() {
  if (!supported() || !import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/** Running as an installed app (home screen, or "Install app" on a computer). */
export const isInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Can this device get push notifications? 'yes', 'install' (iPhone and iPad:
 * only from Keel added to the Home Screen), 'insecure' (not https) or 'no'.
 */
export function pushAvailability() {
  if (typeof window === 'undefined') return 'no';
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !isInstalled()) return 'install';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'yes' : 'no';
}

const ready = () => navigator.serviceWorker.ready;

/** This browser's current push subscription, or null. */
export async function currentSubscription() {
  if (pushAvailability() !== 'yes') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** The id Keel gives a device: the start of its push address's SHA-256 (server/push.js). */
export async function deviceId(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

const keyBytes = (b64u) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** A name for this device in the list ("iPhone · Safari", "Windows · Edge"). */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || isIos() ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${isInstalled() ? 'Keel app' : browser}`;
}

/** Turn push on here: permission, a subscription with Keel's key, and Keel told about it. */
export async function enablePush() {
  if (pushAvailability() !== 'yes') throw new Error('unsupported');
  if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('denied'), { code: 'denied' });
  const { publicKey } = await api('/push');
  const reg = await ready();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be used: replace it.
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  // The browser asks its push service (Google's, Apple's, Mozilla's…); don't wait forever if it doesn't answer.
  sub ||= await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }),
    new Promise((_, reject) => { setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), 20_000); }),
  ]);
  return api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
}

/** Turn push off here: Keel forgets this device, and the browser drops the subscription. */
export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// Chrome, Edge and Android offer installing through an event we keep for the "Install Keel" buttons.
let installEvent = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    window.dispatchEvent(new CustomEvent('keel:installable'));
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    window.dispatchEvent(new CustomEvent('keel:installable'));
  });
}

/** Can Keel offer its own install button here (not on Safari, which only has Add to Home Screen)? */
export const canPromptInstall = () => !!installEvent;

/** Show the browser's install dialog; resolves to true when installed. */
export async function promptInstall() {
  if (!installEvent) return false;
  const e = installEvent;
  installEvent = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  window.dispatchEvent(new CustomEvent('keel:installable'));
  return outcome === 'accepted';
}
