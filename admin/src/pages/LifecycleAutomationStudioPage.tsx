import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { ClientLifecycleExecutionHistoryRow, LifecycleAutomationHealth } from '../lib/lifecycle-api';
import { useApi } from '../lib/session';
import { LifecycleAutomationPage } from './LifecycleAutomationPage';

type LifecycleRuntimeHealth = LifecycleAutomationHealth & {
  scheduler_last_succeeded_at: string | null;
  scheduler_stale: boolean;
};

interface LifecycleRecoveryData {
  rows: ClientLifecycleExecutionHistoryRow[];
  canManage: boolean;
}

export function LifecycleAutomationStudioPage() {
  const api = useApi();
  const { selectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const ru = language === 'ru';

  const diagnostics = useAsync<LifecycleRuntimeHealth | null>(async () => {
    if (!selectedArtistId) return null;
    return api.getLifecycleAutomationHealth(selectedArtistId) as Promise<LifecycleRuntimeHealth | null>;
  }, [api, selectedArtistId]);

  const recovery = useAsync<LifecycleRecoveryData | null>(async () => {
    if (!selectedArtistId) return null;
    const [rows, capabilities] = await Promise.all([
      api.listClientLifecycleExecutionHistory(selectedArtistId),
      api.listCapabilities(selectedArtistId),
    ]);
    const canManage = capabilities.some((grant) =>
      grant.artist_id === selectedArtistId && grant.capability === 'manage_automations'
    );
    return { rows, canManage };
  }, [api, selectedArtistId]);

  if (!selectedArtistId) return <LifecycleAutomationPage />;

  return (
    <div className="stack">
      <LifecycleAutomationPage />
      <Section
        title={ru ? 'Очередь и выполнение' : 'Queue and execution'}
        action={(
          <button type="button" onClick={diagnostics.reload} disabled={diagnostics.loading}>
            {ru ? 'Обновить' : 'Refresh'}
          </button>
        )}
      >
        <LifecycleRuntimeDiagnostics
          ru={ru}
          health={diagnostics.data}
          loading={diagnostics.loading}
          error={diagnostics.error}
          onRetry={diagnostics.reload}
        />
      </Section>

      <Section
        title={ru ? 'Безопасное восстановление ошибок' : 'Safe failure recovery'}
        action={(
          <button type="button" onClick={recovery.reload} disabled={recovery.loading}>
            {ru ? 'Обновить' : 'Refresh'}
          </button>
        )}
      >
        <LifecycleRecoveryPanel
          ru={ru}
          data={recovery.data}
          loading={recovery.loading}
          error={recovery.error}
          onRefresh={recovery.reload}
          onRetry={async (jobId) => {
            await api.retryClientLifecycleJob(jobId);
            recovery.reload();
            diagnostics.reload();
          }}
        />
      </Section>
    </div>
  );
}

function LifecycleRecoveryPanel({
  ru,
  data,
  loading,
  error,
  onRefresh,
  onRetry,
}: {
  ru: boolean;
  data: LifecycleRecoveryData | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onRetry: (jobId: string) => Promise<void>;
}) {
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) {
    return <LoadingState label={ru ? 'Проверяем ошибки автоматизаций…' : 'Checking automation failures…'} />;
  }

  if (error && !data) return <ErrorState message={error} onRetry={onRefresh} />;

  if (!data) {
    return (
      <EmptyState
        compact
        title={ru ? 'Восстановление недоступно' : 'Recovery unavailable'}
        hint={ru
          ? 'Для этой проверки нужен доступ к истории автоматизаций выбранного мастера.'
          : 'This check requires access to the selected artist’s automation history.'}
      />
    );
  }

  const retryable = data.rows.filter((row) => row.retryable);

  async function retry(jobId: string) {
    setBusyJobId(jobId);
    setActionError(null);
    setNotice(null);
    try {
      await onRetry(jobId);
      setNotice(ru
        ? 'Задача возвращена в очередь. Планировщик повторно проверит её перед выполнением.'
        : 'The task was returned to the queue. The scheduler will validate it again before execution.');
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (ru ? 'Не удалось повторить задачу.' : 'Could not retry the task.'));
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="notice">
        {ru
          ? 'Повтор доступен только для ошибки, где сервер подтвердил, что email ещё не создавался. Ошибки доставки после создания письма здесь намеренно не повторяются, чтобы исключить дубли.'
          : 'Retry is available only when the server confirms that no email was created. Delivery failures after email creation are deliberately not replayed here, preventing duplicate customer messages.'}
      </div>
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}
      {error ? (
        <div className="notice warn" role="alert">
          {ru
            ? 'Не удалось обновить список. Ниже остаётся последняя успешно загруженная версия.'
            : 'Refresh failed. The last successfully loaded values remain visible.'}
        </div>
      ) : null}

      {retryable.length === 0 ? (
        <EmptyState
          compact
          title={ru ? 'Нет ошибок для безопасного повтора' : 'No failures are safe to retry'}
          hint={ru
            ? 'Сейчас нет failed-задач, которые сервер разрешает вернуть в очередь без риска повторной отправки.'
            : 'There are currently no failed tasks that the server allows to requeue without duplicate-delivery risk.'}
        />
      ) : (
        <div className="stack">
          {retryable.map((row) => (
            <article className="card" key={row.job_id}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <strong>{row.rule_name}</strong>
                  <div className="meta">
                    {row.client_name}
                    {' · '}{formatDateTime(row.scheduled_at, ru ? 'ru' : 'en')}
                    {' · '}{ru ? `попыток: ${row.attempt_count}` : `attempts: ${row.attempt_count}`}
                  </div>
                </div>
                <span className="badge warn">{ru ? 'Можно повторить' : 'Retryable'}</span>
              </div>
              {row.failure_reason ? (
                <div className="meta" style={{ marginTop: 10 }}>
                  {ru ? 'Ошибка выполнения до создания email.' : 'Execution failed before email creation.'}
                </div>
              ) : null}
              {data.canManage ? (
                <div className="actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={busyJobId !== null}
                    onClick={() => { void retry(row.job_id); }}
                  >
                    {busyJobId === row.job_id
                      ? (ru ? 'Возвращаем в очередь…' : 'Requeueing…')
                      : (ru ? 'Повторить безопасно' : 'Retry safely')}
                  </button>
                </div>
              ) : (
                <div className="meta" style={{ marginTop: 10 }}>
                  {ru
                    ? 'Для повтора нужен доступ к управлению автоматизациями.'
                    : 'Managing automations permission is required to retry this task.'}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function LifecycleRuntimeDiagnostics({
  ru,
  health,
  loading,
  error,
  onRetry,
}: {
  ru: boolean;
  health: LifecycleRuntimeHealth | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !health) {
    return <LoadingState label={ru ? 'Проверяем очередь автоматизаций…' : 'Checking the automation queue…'} />;
  }

  if (error && !health) return <ErrorState message={error} onRetry={onRetry} />;

  if (!health) {
    return (
      <EmptyState
        compact
        title={ru ? 'Диагностика недоступна' : 'Diagnostics unavailable'}
        hint={ru
          ? 'Для этой проверки нужен доступ к автоматизациям и состоянию интеграций выбранного мастера.'
          : 'This check requires access to the selected artist’s automations and integration status.'}
      />
    );
  }

  const overdue = health.overdue_pending_job_count;
  const pending = health.pending_job_count;
  const queueSummary = overdue > 0
    ? ru
      ? `${overdue} ${russianTaskWord(overdue)} ${overdue === 1 ? 'опаздывает' : 'опаздывают'} больше чем на 15 минут.`
      : `${overdue} ${overdue === 1 ? 'task is' : 'tasks are'} more than 15 minutes late.`
    : pending > 0
      ? ru
        ? `${pending} ${russianTaskWord(pending)} ${pending === 1 ? 'ждёт' : 'ждут'} своего времени. Просроченных нет.`
        : `${pending} ${pending === 1 ? 'task is' : 'tasks are'} waiting for the scheduled time. None are overdue.`
      : ru
        ? 'Очередь пуста. Просроченных задач нет.'
        : 'The queue is empty. There are no overdue tasks.';

  const schedulerSummary = health.scheduler_stale
    ? health.scheduler_last_succeeded_at
      ? ru
        ? 'Планировщик давно не подтверждал успешный запуск.'
        : 'The scheduler has not confirmed a successful run recently.'
      : ru
        ? 'Успешный запуск планировщика ещё не подтверждён.'
        : 'A successful scheduler run has not been confirmed yet.'
    : ru
      ? 'Планировщик работает.'
      : 'The scheduler is active.';

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div
        className={health.scheduler_stale ? 'notice warn' : 'notice ok'}
        role={health.scheduler_stale ? 'alert' : 'status'}
      >
        <strong>{schedulerSummary}</strong>
        <div style={{ marginTop: 4 }}>
          {ru
            ? health.scheduler_stale
              ? 'Он должен подтверждать работу примерно каждые 5 минут. После 15 минут без успешного запуска новые автоматизации нельзя считать гарантированно работающими.'
              : 'Последний успешный запуск подтверждён сервером. Нормальный интервал планировщика — около 5 минут.'
            : health.scheduler_stale
              ? 'It should confirm work about every 5 minutes. After 15 minutes without a successful run, new automations should not be treated as reliably scheduled.'
              : 'The last successful run was confirmed by the server. The normal scheduler interval is about 5 minutes.'}
        </div>
      </div>

      <div className={overdue > 0 ? 'notice warn' : 'notice ok'} role={overdue > 0 ? 'alert' : 'status'}>
        <strong>{queueSummary}</strong>
        {overdue > 0 ? (
          <div style={{ marginTop: 4 }}>
            {ru
              ? 'Обновите данные через несколько минут. Если число не уменьшается, планировщик автоматизаций нужно проверить, прежде чем рассчитывать на новые напоминания.'
              : 'Refresh in a few minutes. If the count does not fall, the automation scheduler needs investigation before relying on new reminders.'}
          </div>
        ) : null}
      </div>

      <div className="dashboard-metrics">
        <div className="dashboard-metric stat">
          <span className="value">{pending}</span>
          <span className="label">{ru ? 'ждут выполнения' : 'waiting'}</span>
        </div>
        <div className="dashboard-metric stat">
          <span className="value">{overdue}</span>
          <span className="label">{ru ? 'опаздывают >15 мин' : 'overdue >15 min'}</span>
        </div>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, margin: 0 }}>
        <RuntimeRow
          label={ru ? 'Последний успешный запуск планировщика' : 'Last successful scheduler run'}
          value={runtimeDate(health.scheduler_last_succeeded_at, ru)}
        />
        <RuntimeRow
          label={ru ? 'Следующая запланированная задача' : 'Next scheduled task'}
          value={runtimeDate(health.next_scheduled_at, ru)}
        />
        {overdue > 0 ? (
          <RuntimeRow
            label={ru ? 'Самая старая просроченная задача' : 'Oldest overdue task'}
            value={runtimeDate(health.oldest_overdue_pending_at, ru)}
          />
        ) : null}
        <RuntimeRow
          label={ru ? 'Последняя выполненная задача' : 'Last completed task'}
          value={runtimeDate(health.last_completed_at, ru)}
        />
        <RuntimeRow
          label={ru ? 'Последняя неудачная задача' : 'Last failed task'}
          value={runtimeDate(health.last_failed_at, ru)}
        />
      </dl>

      <div className="meta">
        {ru
          ? 'Диагностика только читает агрегированные данные. Адреса клиентов, тексты писем и технические ошибки провайдера здесь не показываются.'
          : 'Diagnostics are read-only and aggregated. Recipient addresses, message bodies and raw provider errors are not shown here.'}
      </div>
      {error ? (
        <div className="notice warn" role="alert">
          {ru
            ? 'Не удалось обновить данные. Ниже остаётся последняя успешно загруженная версия.'
            : 'Refresh failed. The last successfully loaded values remain visible.'}
        </div>
      ) : null}
    </div>
  );
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="meta">{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

function runtimeDate(value: string | null, ru: boolean) {
  if (!value) return ru ? 'Пока нет' : 'None yet';
  return formatDateTime(value, ru ? 'ru' : 'en');
}

function russianTaskWord(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задача';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задачи';
  return 'задач';
}
