import { ErrorBoundary } from './components/ErrorBoundary';
import { readWindowName } from './lib/api';
import { RuntimeProvider, useRuntime } from './lib/runtime';
import { Autopilot } from './routes/Autopilot';
import { Onboarding } from './routes/Onboarding';
import { Panel } from './routes/Panel';
import { Settings } from './routes/Settings';

/** Autopilot is hidden unless it was enabled for this launch. */
function AutopilotRoute() {
  const { bootstrap } = useRuntime();
  if (!bootstrap.autopilotEnabled) return null;
  return <Autopilot />;
}

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
          <AutopilotRoute />
        ) : (
          <Panel />
        )}
      </RuntimeProvider>
    </ErrorBoundary>
  );
}
