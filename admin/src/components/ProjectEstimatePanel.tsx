import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { Project, ProjectFinance } from '../lib/types';

export function ProjectEstimatePanel({
  project,
  finance,
  appointments,
  mayViewFinance,
  mayManage,
  onSaved,
}: {
  project: Project;
  finance: ProjectFinance | null;
  appointments: Appointment[];
  mayViewFinance: boolean;
  mayManage: boolean;
  onSaved: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const planned = useMemo(() => plannedWork(appointments), [appointments]);
  const fallbackSessions = project.estimated_sessions ?? (planned.sessions > 0 ? planned.sessions : null);
  const fallbackHours = project.estimated_hours ?? (planned.hours > 0 ? planned.hours : null);
  const fallbackRate = mayViewFinance ? (finance?.hourly_rate ?? null) : null;
  const fallbackTotal = mayViewFinance
    ? (finance?.estimate_total
      ?? (fallbackHours !== null && fallbackRate !== null ? roundMoney(fallbackHours * fallbackRate) : null))
    : null;
  const paidDeposit = mayViewFinance && project.deposit_status === 'paid' ? (finance?.deposit_amount ?? 0) : 0;
  const remaining = mayViewFinance && fallbackTotal !== null ? Math.max(0, fallbackTotal - paidDeposit) : null;

  const [editing, setEditing] = useState(false);
  const [sessions, setSessions] = useState(numberToInput(fallbackSessions));
  const [hours, setHours] = useState(numberToInput(fallbackHours));
  const [rate, setRate] = useState(numberToInput(fallbackRate));
  const [total, setTotal] = useState(numberToInput(fallbackTotal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setSessions(numberToInput(fallbackSessions));
    setHours(numberToInput(fallbackHours));
    setRate(numberToInput(fallbackRate));
    setTotal(numberToInput(fallbackTotal));
  }, [editing, fallbackSessions, fallbackHours, fallbackRate, fallbackTotal]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsedSessions = parseOptionalNumber(sessions);
    const parsedHours = parseOptionalNumber(hours);
    const parsedRate = parseOptionalNumber(rate);
    const parsedTotal = parseOptionalNumber(total);

    if (
      parsedSessions === 'invalid'
      || parsedHours === 'invalid'
      || parsedRate === 'invalid'
      || parsedTotal === 'invalid'
      || (typeof parsedSessions === 'number' && (!Number.isInteger(parsedSessions) || parsedSessions < 0))
      || (typeof parsedHours === 'number' && parsedHours < 0)
      || (typeof parsedRate === 'number' && parsedRate < 0)
      || (typeof parsedTotal === 'number' && parsedTotal < 0)
    ) {
      setError(copy.invalid);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.updateProjectEstimate({
        projectId: project.id,
        estimatedSessions: parsedSessions,
        estimatedHours: parsedHours,
        hourlyRate: parsedRate,
        estimateTotal: parsedTotal,
        currency: project.currency,
      });
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setSaving(false);
    }
  }

  function useAppointments() {
    setSessions(planned.sessions > 0 ? String(planned.sessions) : '');
    setHours(planned.hours > 0 ? trimNumber(planned.hours) : '');
    const parsedRate = Number(rate);
    if (planned.hours > 0 && Number.isFinite(parsedRate) && parsedRate >= 0) {
      setTotal(trimNumber(roundMoney(planned.hours * parsedRate)));
    }
  }

  function calculateTotal() {
    const parsedHours = Number(hours);
    const parsedRate = Number(rate);
    if (Number.isFinite(parsedHours) && parsedHours >= 0 && Number.isFinite(parsedRate) && parsedRate >= 0) {
      setTotal(trimNumber(roundMoney(parsedHours * parsedRate)));
    }
  }

  return (
    <>
      <dl className="definition">
        <dt>{copy.sessions}</dt>
        <dd>
          {fallbackSessions ?? '—'}
          {project.estimated_sessions === null && planned.sessions > 0 ? <span className="meta"> {copy.fromAppointments}</span> : null}
        </dd>
        <dt>{copy.hours}</dt>
        <dd>
          {fallbackHours ?? '—'}
          {project.estimated_hours === null && planned.hours > 0 ? <span className="meta"> {copy.fromAppointments}</span> : null}
        </dd>
        {mayViewFinance ? (
          <>
            <dt>{copy.hourlyRate}</dt><dd>{formatMoney(fallbackRate, project.currency, language)}</dd>
            <dt>{copy.estimateTotal}</dt><dd>{formatMoney(fallbackTotal, project.currency, language)}</dd>
            <dt>{copy.depositReceived}</dt>
            <dd>{paidDeposit > 0 ? formatMoney(paidDeposit, project.currency, language) : '—'}</dd>
            <dt>{copy.remaining}</dt><dd>{formatMoney(remaining, project.currency, language)}</dd>
          </>
        ) : null}
      </dl>

      {mayManage ? (
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setEditing((value) => !value)} aria-expanded={editing}>
            {editing ? copy.close : copy.edit}
          </button>
        </div>
      ) : null}

      {editing ? (
        <form onSubmit={(event) => { void save(event); }} style={{ marginTop: 12 }}>
          <div className="field-row">
            <div>
              <label htmlFor="estimate-sessions">{copy.sessions}</label>
              <input id="estimate-sessions" type="number" min="0" step="1" value={sessions} onChange={(event) => setSessions(event.target.value)} />
            </div>
            <div>
              <label htmlFor="estimate-hours">{copy.hours}</label>
              <input id="estimate-hours" type="number" min="0" step="0.25" value={hours} onChange={(event) => setHours(event.target.value)} />
            </div>
          </div>
          <div className="field-row" style={{ marginTop: 12 }}>
            <div>
              <label htmlFor="estimate-rate">{copy.hourlyRate} ({project.currency})</label>
              <input id="estimate-rate" type="number" min="0" step="0.01" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
            </div>
            <div>
              <label htmlFor="estimate-total">{copy.estimateTotal} ({project.currency})</label>
              <input id="estimate-total" type="number" min="0" step="0.01" inputMode="decimal" value={total} onChange={(event) => setTotal(event.target.value)} />
            </div>
          </div>
          <div className="actions">
            <button type="button" disabled={saving || planned.sessions === 0} onClick={useAppointments}>{copy.useAppointments}</button>
            <button type="button" disabled={saving || !hours || !rate} onClick={calculateTotal}>{copy.calculate}</button>
            <button type="submit" disabled={saving}>{saving ? copy.saving : copy.save}</button>
          </div>
          {error ? <div className="notice warn" role="alert">{error}</div> : null}
          <p className="notice">{copy.notice}</p>
        </form>
      ) : null}
    </>
  );
}

export function plannedWork(appointments: Appointment[]): { sessions: number; hours: number } {
  const billable = appointments.filter((appointment) =>
    ['tattoo_session', 'touch_up'].includes(appointment.appointment_type)
    && !['cancelled', 'no_show'].includes(appointment.status)
  );
  return {
    sessions: billable.length,
    hours: roundHours(billable.reduce((sum, appointment) => sum + (appointment.duration_hours ?? 0), 0)),
  };
}

function parseOptionalNumber(value: string): number | null | 'invalid' {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function numberToInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : trimNumber(Number(value));
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function roundHours(value: number): number {
  return Number(value.toFixed(2));
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

const COPY = {
  en: {
    sessions: 'Planned sessions',
    hours: 'Planned hours',
    hourlyRate: 'Hourly rate',
    estimateTotal: 'Estimated total',
    depositReceived: 'Deposit received',
    remaining: 'Estimated balance after deposit',
    fromAppointments: '(from appointments)',
    edit: 'Edit estimate',
    close: 'Close estimate editor',
    useAppointments: 'Use planned appointments',
    calculate: 'Hours × rate',
    save: 'Save estimate',
    saving: 'Saving…',
    invalid: 'Use zero or positive numbers. Sessions must be a whole number.',
    failed: 'Could not save the estimate.',
    notice: 'Planned appointments can prefill sessions and hours. The estimate stays editable because the final price depends on actual time worked.',
  },
  ru: {
    sessions: 'Плановые сеансы',
    hours: 'Плановые часы',
    hourlyRate: 'Почасовая ставка',
    estimateTotal: 'Предварительная сумма',
    depositReceived: 'Получено депозитом',
    remaining: 'Ориентировочно осталось после депозита',
    fromAppointments: '(из записей)',
    edit: 'Редактировать расчёт',
    close: 'Закрыть расчёт',
    useAppointments: 'Взять часы из записей',
    calculate: 'Часы × ставка',
    save: 'Сохранить расчёт',
    saving: 'Сохраняем…',
    invalid: 'Используй ноль или положительные числа. Количество сеансов должно быть целым.',
    failed: 'Не удалось сохранить расчёт.',
    notice: 'CRM может подставить количество сеансов и часы из записей. Итог остаётся предварительным, потому что фактическая стоимость зависит от реально затраченного времени.',
  },
} as const;
