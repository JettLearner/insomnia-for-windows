import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readWindowName } from './lib/api';
import './styles/tokens.css';
import './styles/base.css';
import './styles/panel.css';
import './styles/settings.css';
import './styles/onboarding.css';

// Set before React mounts so the smoke harness can identify the window even
// while the bootstrap IPC is still in flight.
document.body.dataset.app = readWindowName();

window.addEventListener('error', (event) => {
  if (!window.__insomniazBootError) {
    window.__insomniazBootError = event.message || 'Unknown renderer error';
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (!window.__insomniazBootError) {
    const reason = event.reason;
    window.__insomniazBootError = reason instanceof Error ? reason.message : String(reason);
  }
});

const container = document.getElementById('root');
if (!container) {
  document.body.innerHTML = '<pre style="color:#ff7a8a;padding:24px">Missing #root element.</pre>';
  throw new Error('Missing #root element.');
}

createRoot(container).render(<App />);
