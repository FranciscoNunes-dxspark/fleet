import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
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
