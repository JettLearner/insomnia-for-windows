import { ErrorBoundary } from './components/ErrorBoundary';
import { readWindowName } from './lib/api';
import { RuntimeProvider } from './lib/runtime';
import { Autopilot } from './routes/Autopilot';
import { Onboarding } from './routes/Onboarding';
import { Panel } from './routes/Panel';
import { Settings } from './routes/Settings';

export function App() {
  const windowName = readWindowName();
  return (
    <ErrorBoundary>
      <RuntimeProvider windowName={windowName}>
        {windowName === 'settings' ? (
          <Settings />
        ) : windowName === 'onboarding' ? (
          <Onboarding />
        ) : windowName === 'autopilot' ? (
          <Autopilot />
        ) : (
          <Panel />
        )}
      </RuntimeProvider>
    </ErrorBoundary>
  );
}
