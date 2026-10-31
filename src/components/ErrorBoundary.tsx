import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate } from '../../shared/i18n';
import { AppMark } from './AppMark';

interface BoundaryState {
  error: Error | null;
}

function CrashScreen({ error }: { error: Error }) {
  const locale = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  return (
    <div className="window-shell">
      <div className="boot-surface">
        <AppMark size={54} className="large" />
        <div className="boot-error" role="alert">
          <strong>{translate(locale, 'bootErrorTitle')}</strong>
          <span>{translate(locale, 'bootErrorBody')}</span>
          <code>{error.message}</code>
          <div style={{ marginTop: 16 }}>
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              {translate(locale, 'reload')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    window.__insomniazBootError = error.message;
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    window.__insomniazBootError = `${error.message}\n${info.componentStack ?? ''}`;
    console.error('InsomniaZ renderer crashed', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) return <CrashScreen error={this.state.error} />;
    return this.props.children;
  }
}
