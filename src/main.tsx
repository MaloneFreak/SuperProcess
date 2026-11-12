import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './i18n';
import { useSettings } from './state/settings';
import './index.css';

initI18n(useSettings.getState().uiLanguage);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support and installability on the web. The desktop app loads from
// file://, where service workers do not exist.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
