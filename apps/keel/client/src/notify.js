// Notification preferences live in this browser (they're about this screen,
// not about Azure DevOps), and desktop notifications use the Notification API.

const KEY = 'leadConsole.notifications.v1';

export const CATEGORIES = [
  { id: 'approval', label: 'Deployments waiting for your approval' },
  { id: 'review', label: 'Pull requests waiting for your review' },
  { id: 'myPr', label: 'Votes on your pull requests, and when they complete' },
  { id: 'run', label: 'Pipeline runs you started finishing' },
  { id: 'pipeline', label: 'Pipelines and deployments that start failing' },
  { id: 'work', label: 'Newly blocked items and unowned P1 bugs' },
  { id: 'pr', label: 'Other pull request alerts (no reviewers, conflicts, stale)' },
];

const DEFAULTS = {
  inApp: true,
  desktop: false,
  onlyWhenHidden: true,
  categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.id !== 'pr'])),
};

export function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    return saved ? { ...DEFAULTS, ...saved, categories: { ...DEFAULTS.categories, ...saved.categories } } : structuredClone(DEFAULTS);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked: preferences last for this visit only.
  }
}

export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const desktopPermission = () => (desktopSupported() ? Notification.permission : 'unsupported');

export async function requestDesktop() {
  if (!desktopSupported()) return 'unsupported';
  return Notification.requestPermission();
}

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%233ec486'/%3E%3Cpath d='M9 9h4v14H9zM15 15h4v8h-4zM21 12h4v11h-4z' fill='white'/%3E%3C/svg%3E";

/** Shows a desktop notification if allowed; returns true when one was shown. */
export function showDesktop({ title, body, tag, onClick }) {
  const prefs = loadPrefs();
  if (!prefs.desktop || desktopPermission() !== 'granted') return false;
  if (prefs.onlyWhenHidden && document.visibilityState === 'visible' && document.hasFocus()) return false;
  try {
    const n = new Notification(title, { body, tag, icon: ICON });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
