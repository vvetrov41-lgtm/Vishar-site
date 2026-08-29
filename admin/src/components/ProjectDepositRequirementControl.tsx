import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Project, ProjectFinance } from '../lib/types';

export function ProjectDepositRequirementControl({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [finance, setFinance] = useState<ProjectFinance | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFinance() {
    setLoading(true);
    try {
      setFinance(await api.getProjectFinance(project.id));
    } catch {
      setFinance(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFinance();
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!['not_required'].includes(project.deposit_status)) return null;
  if (loading) return <div className="notice">{copy.loading}</div>;
  if (!finance) return null;

  const explicitlyWaived = finance.deposit_amount === 0;

  async function setRequired(required: boolean) {
    if (!required && !window.confirm(copy.waiveConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateDeposit(
        project.id,
        required ? null : 0,
        'not_required'
      );
      await loadFinance();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={explicitlyWaived ? 'notice warn' : 'notice'} style={{ marginBottom: 14 }}>
      <div>
        <strong>{copy.requirement}</strong>: {explicitlyWaived ? copy.notRequired : copy.notRequested}
      </div>
      <div style={{ marginTop: 6 }}>
        {explicitlyWaived ? copy.notRequiredHint : copy.notRequestedHint}
      </div>
      <div className="actions" style={{ marginTop: 10 }}>
        {explicitlyWaived ? (
          <button type="button" className="primary" disabled={busy} onClick={() => { void setRequired(true); }}>
            {busy ? copy.saving : copy.markRequired}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => { void setRequired(false); }}>
            {busy ? copy.saving : copy.markNotRequired}
          </button>
        )}
      </div>
      {error ? <div className="notice warn" role="alert" style={{ marginTop: 10 }}>{error}</div> : null}
    </div>
  );
}

const COPY = {
  en: {
    requirement: 'Deposit status',
    notRequested: 'not requested yet',
    notRequired: 'not required',
    notRequestedHint: 'No deposit request has been created yet. This is different from waiving the deposit.',
    notRequiredHint: 'This project is explicitly marked as not requiring a deposit.',
    markNotRequired: 'Deposit is not required',
    markRequired: 'Deposit is required',
    loading: 'Loading deposit status…',
    saving: 'Saving…',
    waiveConfirm: 'Mark this project as not requiring a deposit?',
    failed: 'Could not change the deposit requirement.',
  },
  ru: {
    requirement: 'Статус депозита',
    notRequested: 'ещё не запрошен',
    notRequired: 'не требуется',
    notRequestedHint: 'Запрос на депозит ещё не создан. Это не означает, что депозит не требуется.',
    notRequiredHint: 'Для этого проекта явно указано, что депозит не требуется.',
    markNotRequired: 'Депозит не требуется',
    markRequired: 'Депозит требуется',
    loading: 'Загружаю статус депозита…',
    saving: 'Сохраняю…',
    waiveConfirm: 'Отметить, что для этого проекта депозит не требуется?',
    failed: 'Не удалось изменить требование депозита.',
  },
} as const;
