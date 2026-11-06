import { useEffect, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { canPromptInstall, isInstalled, isIos, promptInstall } from '../pwa.js';
import { t } from '../i18n.js';
import { Logo } from '../ui.jsx';

// Offers to install Keel as an app (public/manifest.webmanifest, public/sw.js) on this device: the
// browser's own install dialog where it has one (Chrome, Edge, Android), the steps where it doesn't
// (Safari on iPhone, iPad and Mac). "Not now" is kept in this browser for a month: installing is per
// device, so it isn't an account preference.
const KEY = 'keel.install.dismissed';
const QUIET = 30 * 864e5;

const dismissedRecently = () => {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) || 0) < QUIET;
  } catch {
    return false;
  }
};
const isMacSafari = () => /Macintosh/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(navigator.userAgent) && !isIos();

/** How this device can install Keel: 'prompt', 'ios', 'mac', or null when it can't or already has. */
function installWay(installable) {
  if (typeof window === 'undefined' || isInstalled()) return null;
  if (installable) return 'prompt';
  if (isIos()) return 'ios';
  if (isMacSafari()) return 'mac';
  return null;
}

export default function InstallBanner() {
  const [installable, setInstallable] = useState(canPromptInstall);
  const [hidden, setHidden] = useState(dismissedRecently);

  useEffect(() => {
    const onChange = () => setInstallable(canPromptInstall());
    window.addEventListener('keel:installable', onChange);
    return () => window.removeEventListener('keel:installable', onChange);
  }, []);

  const way = installWay(installable);
  if (hidden || !way) return null;

  const notNow = () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private window: hide for this visit only */ }
    setHidden(true);
  };
  const install = async () => {
    if (await promptInstall()) setHidden(true);
  };

  return (
    <div className="install-banner" role="region" aria-label={t('Install Keel')}>
      <Logo size={28} />
      <span className="install-banner-text">
        {way === 'prompt' && t('Install Keel as an app on this device: its own window and icon, opening straight to your work, with notifications even when it\'s closed.')}
        {way === 'ios' && t('Add Keel to your Home Screen: tap Share, then Add to Home Screen. It opens like an app and can send you notifications.')}
        {way === 'mac' && t('Add Keel to your Dock: in Safari, choose File, then Add to Dock. It opens in its own window, like an app.')}
      </span>
      <span className="install-banner-actions">
        {way === 'prompt' && <Button size="1" variant="solid" type="button" onClick={install}>{t('Install')}</Button>}
        <Button size="1" variant="ghost" color="gray" type="button" onClick={notNow}>{t('Not now')}</Button>
      </span>
    </div>
  );
}
