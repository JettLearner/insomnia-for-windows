import { AppMark } from '../../components/AppMark';
import { ExternalLink, Globe } from '../../components/Icons';
import { Card, SectionHead } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';

const APP_STORE_URL = 'https://apps.apple.com/app/id1447041581';
const DEVELOPER_URL = 'https://pawandixit.com';

export function AboutSection() {
  const { state, bootstrap, run } = useRuntime();
  const t = useT();

  const open = (url: string): void => {
    void run({ type: 'open-external', url });
  };

  return (
    <>
      <SectionHead title={t('aboutTitle')} subtitle={t('aboutSubtitle')} />

      <div className="settings-stack">
        <div className="about-hero">
          <AppMark size={64} className="large" />
          <div className="about-hero-copy">
            <h1>InsomniaZ</h1>
            <span className="about-version">
              {t('aboutVersion', { version: state.version })} · {t('windowsPort')}
            </span>
            <p>{t('tagline')}</p>
          </div>
        </div>

        <Card>
          <div className="about-prose">
            <p>{t('aboutInspired')}</p>
            <p className="muted">{t('aboutDisclaimer')}</p>
            <p className="muted">{t('aboutLicense')}</p>
          </div>
        </Card>

        <Card title={t('cardLinks')}>
          <button type="button" className="link-row" onClick={() => open(APP_STORE_URL)}>
            <span className="link-icon">
              <Globe size={15} />
            </span>
            <span className="link-copy">
              <span className="link-title">{t('aboutOriginal')}</span>
              <span className="link-sub">apps.apple.com</span>
            </span>
            <ExternalLink size={14} className="link-arrow" />
          </button>
          <button type="button" className="link-row" onClick={() => open(DEVELOPER_URL)}>
            <span className="link-icon">
              <Globe size={15} />
            </span>
            <span className="link-copy">
              <span className="link-title">{t('aboutDeveloper')}</span>
              <span className="link-sub">pawandixit.com</span>
            </span>
            <ExternalLink size={14} className="link-arrow" />
          </button>
        </Card>

        <Card title={t('cardSystem')}>
          <div className="meta-row">
            <span>{t('aboutSystem')}</span>
            <span>Windows</span>
          </div>
          <div className="meta-row">
            <span>{t('aboutPort')}</span>
            <span className="mono">{state.version}</span>
          </div>
          <div className="meta-row">
            <span>{t('aboutElectron')}</span>
            <span className="mono">{bootstrap.versions.electron}</span>
          </div>
          <div className="meta-row">
            <span>{t('aboutChromium')}</span>
            <span className="mono">{bootstrap.versions.chrome}</span>
          </div>
          <div className="meta-row">
            <span>{t('aboutNode')}</span>
            <span className="mono">{bootstrap.versions.node}</span>
          </div>
          <div className="meta-row">
            <span>{t('aboutUpdates')}</span>
            <span className="meta-long">{t('aboutUpdatesValue')}</span>
          </div>
        </Card>
      </div>
    </>
  );
}
