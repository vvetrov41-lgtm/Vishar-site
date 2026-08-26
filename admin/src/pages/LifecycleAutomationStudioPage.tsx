import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { LifecycleAutomationHealth } from '../lib/lifecycle-api';
import { useApi } from '../lib/session';
import { LifecycleAutomationPage } from './LifecycleAutomationPage';

export function LifecycleAutomationStudioPage() {
  const api = useApi();
  const { selectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const ru = language === 'ru';

  const diagnostics = useAsync<LifecycleAutomationHealth | null>(async () => {
    if (!selectedArtistId) return null;
    return api.getLifecycleAutomationHealth(selectedArtistId);
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
  health: LifecycleAutomationHealth | null;
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
      ? `${overdue} ${russianTaskWord(overdue)} опаздывает больше чем на 15 минут.`
      : `${overdue} ${overdue === 1 ? 'task is' : 'tasks are'} more than 15 minutes late.`
    : pending > 0
      ? ru
        ? `${pending} ${russianTaskWord(pending)} ждёт своего времени. Просроченных нет.`
        : `${pending} ${pending === 1 ? 'task is' : 'tasks are'} waiting for the scheduled time. None are overdue.`
      : ru
        ? 'Очередь пуста. Просроченных задач нет.'
        : 'The queue is empty. There are no overdue tasks.';

  return (
    <div className="stack" style={{ marginTop: 12 }}>
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
          <span className="label">{ru ? 'ждёт выполнения' : 'waiting'}</span>
        </div>
        <div className="dashboard-metric stat">
          <span className="value">{overdue}</span>
          <span className="label">{ru ? 'опаздывает >15 мин' : 'overdue >15 min'}</span>
        </div>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, margin: 0 }}>
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
