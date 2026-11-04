import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/400.css';
import './styles.css';
import App from './App.jsx';
import { applyTheme, watchSystemTheme } from './theme.js';
import { registerServiceWorker } from './pwa.js';

// Before the first render, so the saved theme shows without a flash.
applyTheme();
watchSystemTheme();
// Safari ignores user-scalable=no, so pinch zoom is stopped here too.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
// Installable app and push notifications (public/sw.js).
registerServiceWorker();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
