import { useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Project } from '../lib/types';

export function ProjectDepositRequirementControl({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const api = useApi();
  const { language, label } = useLanguage();
  const copy = COPY[language];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!['not_requested', 'not_required'].includes(project.deposit_status)) return null;

  async function setRequired(required: boolean) {
    if (!required && !window.confirm(copy.waiveConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      if (required) {
        await api.setProjectDepositOverride({ projectId: project.id, amount: null });
      } else {
        await api.updateDeposit(project.id, 0, 'not_required');
      }
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  const required = project.deposit_status === 'not_requested';

  return (
    <div className={required ? 'notice' : 'notice warn'} style={{ marginBottom: 14 }}>
      <div>
        <strong>{copy.requirement}</strong>: {label('depositStatus', project.deposit_status)}
      </div>
      <div style={{ marginTop: 6 }}>{required ? copy.notRequestedHint : copy.notRequiredHint}</div>
      <div className="actions" style={{ marginTop: 10 }}>
        {required ? (
          <button type="button" disabled={busy} onClick={() => { void setRequired(false); }}>
            {busy ? copy.saving : copy.markNotRequired}
          </button>
        ) : (
          <button type="button" className="primary" disabled={busy} onClick={() => { void setRequired(true); }}>
            {busy ? copy.saving : copy.markRequired}
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
    notRequestedHint: 'No deposit request has been created yet. This is different from waiving the deposit.',
    notRequiredHint: 'This project is explicitly marked as not requiring a deposit.',
    markNotRequired: 'Deposit is not required',
    markRequired: 'Deposit is required',
    saving: 'Saving…',
    waiveConfirm: 'Mark this project as not requiring a deposit?',
    failed: 'Could not change the deposit requirement.',
  },
  ru: {
    requirement: 'Статус депозита',
    notRequestedHint: 'Запрос на депозит ещё не создан. Это не означает, что депозит не требуется.',
    notRequiredHint: 'Для этого проекта явно указано, что депозит не требуется.',
    markNotRequired: 'Депозит не требуется',
    markRequired: 'Депозит требуется',
    saving: 'Сохраняю…',
    waiveConfirm: 'Отметить, что для этого проекта депозит не требуется?',
    failed: 'Не удалось изменить требование депозита.',
  },
} as const;
