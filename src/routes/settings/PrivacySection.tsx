import { useState } from 'react';
import { Cpu, Download, Folder, Lock, ShieldCheck } from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Card, SectionHead } from '../../components/ui';
import { getApi } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';

export function PrivacySection() {
  const { run, notify } = useRuntime();
  const t = useT();
  const api = getApi();
  const [exporting, setExporting] = useState(false);

  const openFolder = async (): Promise<void> => {
    try {
      await api?.openDataFolder();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('errGeneric'), 'error');
    }
  };

  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true);
    const result = await run({ type: 'export-diagnostics' }, { toast: false });
    setExporting(false);
    if (result.ok) notify(t('exportDone'), 'success');
    else notify(result.error ?? t('exportFailed'), 'error');
  };

  return (
    <>
      <SectionHead title={t('privacyTitle')} subtitle={t('privacySubtitle')} />

      <div className="settings-stack">
        <Card>
          <SettingRow icon={<ShieldCheck size={15} />} title={t('privacyNoCollect')} />
          <SettingRow icon={<Lock size={15} />} title={t('privacyNoNetwork')} />
          <SettingRow icon={<Cpu size={15} />} title={t('privacyNoAccount')} />
          <SettingRow icon={<Folder size={15} />} title={t('privacyLocal')} />
        </Card>

        <Card title={t('cardPermission')}>
          <div className="privacy-callout">
            <span className="privacy-callout-icon">
              <Lock size={17} />
            </span>
            <div>
              <h2>{t('privacyPermission')}</h2>
              <p>{t('privacyPermissionBody')}</p>
            </div>
          </div>
        </Card>

        <Card title={t('cardData')}>
          <div className="card-actions">
            <button type="button" className="secondary-button" onClick={() => void openFolder()}>
              <Folder size={14} />
              {t('openDataFolder')}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void exportDiagnostics()}
              disabled={exporting}
            >
              {exporting ? <span className="spinner" aria-hidden="true" /> : <Download size={14} />}
              {t('exportDiagnostics')}
            </button>
          </div>
          <p className="card-note indented">{t('logsNote')}</p>
        </Card>
      </div>
    </>
  );
}
