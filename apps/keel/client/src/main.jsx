import { StrictMode, useEffect, useState } from 'react';
import { Theme } from '@radix-ui/themes';
// Radix Themes' CSS in parts: the colours Keel's accents use, the base tokens and the components. Its
// utilities (margin and padding props, responsive layout) are left out, as nothing here uses them.
import '@radix-ui/themes/tokens/colors/sage.css';
import '@radix-ui/themes/tokens/colors/orange.css';
import '@radix-ui/themes/tokens/colors/jade.css';
import '@radix-ui/themes/tokens/colors/blue.css';
import '@radix-ui/themes/tokens/colors/violet.css';
import '@radix-ui/themes/tokens/colors/teal.css';
import '@radix-ui/themes/tokens/colors/plum.css';
import '@radix-ui/themes/tokens/colors/tomato.css';
import '@radix-ui/themes/tokens/colors/bronze.css';
import '@radix-ui/themes/tokens/colors/red.css';
import '@radix-ui/themes/tokens/colors/amber.css';
import '@radix-ui/themes/tokens/colors/green.css';
import '@radix-ui/themes/tokens/base.css';
import '@radix-ui/themes/components.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/400.css';
import './styles.css';
import './bridge.css';
import App from './App.jsx';
import { RADIX_ACCENT, applyTheme, loadTheme, watchSystemTheme } from './theme.js';
import { registerServiceWorker } from './pwa.js';

// Before the first render, so the saved theme shows without a flash.
applyTheme();
watchSystemTheme();
// Safari ignores user-scalable=no, so pinch zoom is stopped here too.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
// Installable app and push notifications (public/sw.js).
registerServiceWorker();

/** Radix Themes' root: Keel's mode and accent, followed live (Settings, the OS switching). */
function ThemeRoot({ children }) {
  const [now, setNow] = useState(() => ({ mode: document.documentElement.dataset.mode, accent: loadTheme().accent }));
  useEffect(() => {
    const on = (e) => setNow(e.detail);
    window.addEventListener('keel:theme', on);
    return () => window.removeEventListener('keel:theme', on);
  }, []);
  return (
    <Theme appearance={now.mode === 'dark' ? 'dark' : 'light'} accentColor={RADIX_ACCENT[now.accent] || 'orange'} grayColor="sage" radius="medium" scaling="100%" panelBackground="solid">
      {children}
    </Theme>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeRoot>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeRoot>
  </StrictMode>,
);
