import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type {
  ClientLifecycleExecutionHistoryRow,
  ClientLifecyclePreview,
  ClientLifecyclePreviewSession,
  ClientLifecyclePurpose,
  ClientLifecycleRule,
  ClientLifecycleTemplate,
  ClientLifecycleVariable,
  LifecycleAppointmentType,
  LifecycleLocale,
  LifecycleScheduleAnchor,
} from '../lib/lifecycle-api';
import { useApi } from '../lib/session';

interface LifecycleData {
  rules: ClientLifecycleRule[];
  templates: ClientLifecycleTemplate[];
  purposes: ClientLifecyclePurpose[];
  variables: ClientLifecycleVariable[];
  previewSessions: ClientLifecyclePreviewSession[];
  history: ClientLifecycleExecutionHistoryRow[];
  canManage: boolean;
  canPreview: boolean;
  canHistory: boolean;
  workspaceId: string;
}

const APPOINTMENT_TYPES: LifecycleAppointmentType[] = [
  'tattoo_session',
  'in_person_consultation',
  'video_consultation',
  'touch_up',
];

const PREVIEW_CAPABILITIES = [
  'view_automations',
  'view_sessions',
  'view_clients',
  'view_enquiries',
  'view_integrations',
  'view_finance',
] as const;

const HISTORY_CAPABILITIES = [
  'view_automations',
  'view_sessions',
  'view_clients',
  'view_integrations',
] as const;

export function LifecycleAutomationPage() {
  const api = useApi();
  const { language } = useLanguage();
  const ru = language === 'ru';
  const { artists, selectedArtistId } = useArtistScope();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useAsync<LifecycleData | null>(async () => {
    if (!selectedArtistId) return null;

    const [rules, templates, purposes, variables, previewSessions, history, capabilities, context] = await Promise.all([
      api.listClientLifecycleRules(selectedArtistId),
      api.listClientLifecycleTemplates(selectedArtistId),
      api.listClientLifecycleTemplatePurposes(selectedArtistId),
      api.listClientLifecycleTemplateVariables(selectedArtistId),
      api.listClientLifecyclePreviewSessions(selectedArtistId),
      api.listClientLifecycleExecutionHistory(selectedArtistId),
      api.listCapabilities(selectedArtistId),
      api.artistControlPlaneContext(selectedArtistId),
    ]);

    if (!context?.workspace_id) throw new Error('Could not resolve the artist workspace.');

    const granted = new Set(
      capabilities
        .filter((grant) => grant.artist_id === selectedArtistId)
        .map((grant) => grant.capability),
    );

    return {
      rules,
      templates,
      purposes,
      variables,
      previewSessions,
      history,
      canManage: granted.has('manage_automations'),
      canPreview: PREVIEW_CAPABILITIES.every((capability) => granted.has(capability)),
      canHistory: HISTORY_CAPABILITIES.every((capability) => granted.has(capability)),
      workspaceId: context.workspace_id,
    };
  }, [api, selectedArtistId]);

  const artistName = useMemo(
    () => artists.find((artist) => artist.id === selectedArtistId)?.display_name ?? null,
    [artists, selectedArtistId],
  );

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : (ru ? 'Не удалось выполнить действие.' : 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }

  if (!selectedArtistId) {
    return (
      <EmptyState
        title={ru ? 'Выберите мастера' : 'Choose an artist'}
        hint={ru
          ? 'Автоматизация всегда принадлежит одному мастеру. Выберите его в верхней панели.'
          : 'Lifecycle automation always belongs to one artist. Choose that artist in the top bar.'}
      />
    );
  }

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;

  const data = state.data;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{ru ? 'Автоматизации клиентов' : 'Client automations'}</h1>
        <div className="meta">
          {artistName ?? selectedArtistId}
          {' · '}
          {ru ? 'Email через существующую очередь Gmail' : 'Email through the existing Gmail queue'}
        </div>
      </div>

      <div className="notice">
        {ru
          ? 'Правило и шаблон управляются отдельно. Новое правило создаётся выключенным, новый шаблон создаётся черновиком. Ничего не отправляется только от сохранения формы.'
          : 'Rules and templates are controlled separately. A new rule starts disabled and a new template starts as a draft. Saving either form does not send anything by itself.'}
      </div>
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}

      <Section title={ru ? 'Предпросмотр' : 'Preview'}>
        <LifecyclePreviewPanel
          key={selectedArtistId}
          ru={ru}
          rules={data.rules}
          sessions={data.previewSessions}
          canPreview={data.canPreview}
          onPreview={(ruleId, sessionId) => api.previewClientLifecycleRule(selectedArtistId, ruleId, sessionId)}
        />
      </Section>

      <Section title={ru ? 'История выполнения' : 'Execution history'}>
        <LifecycleExecutionHistoryPanel
          key={selectedArtistId}
          ru={ru}
          rows={data.history}
          canView={data.canHistory}
        />
      </Section>

      <Section title={ru ? 'Правила' : 'Rules'}>
        {data.rules.length === 0 ? (
          <EmptyState
            compact
            title={ru ? 'Правил пока нет' : 'No rules yet'}
            hint={ru ? 'Можно создать первое правило ниже.' : 'Create the first rule below.'}
          />
        ) : (
          <div className="stack">
            {data.rules.map((rule) => {
              const hasActiveTemplate = matchingActiveTemplate(rule, data.templates);
              return (
                <article className="card" key={rule.id}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <strong>{rule.name}</strong>
                      <div className="meta">
                        {appointmentLabel(rule.appointment_type, ru)}
                        {' · '}{scheduleLabel(rule, ru)}
                        {' · '}{rule.message_purpose}
                        {' · '}{rule.message_locale.toUpperCase()}
                      </div>
                    </div>
                    <span className={`badge ${rule.is_enabled ? 'ok' : 'warn'}`}>
                      {rule.is_enabled ? (ru ? 'Включено' : 'Enabled') : (ru ? 'Выключено' : 'Disabled')}
                    </span>
                  </div>
                  {data.canManage ? (
                    <div className="actions" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        disabled={busy || (!rule.is_enabled && !hasActiveTemplate)}
                        title={!rule.is_enabled && !hasActiveTemplate
                          ? (ru ? 'Сначала активируйте подходящий шаблон.' : 'Activate a matching template first.')
                          : undefined}
                        onClick={() => run(
                          () => api.setAutomationRuleEnabled(rule.id, !rule.is_enabled),
                          rule.is_enabled
                            ? (ru ? 'Правило выключено.' : 'Rule disabled.')
                            : (ru ? 'Правило включено.' : 'Rule enabled.'),
                        )}
                      >
                        {rule.is_enabled ? (ru ? 'Выключить' : 'Disable') : (ru ? 'Включить' : 'Enable')}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

        {data.canManage ? (
          <RuleForm
            ru={ru}
            busy={busy}
            artistId={selectedArtistId}
            purposes={data.purposes}
            onCreate={(input) => run(
              () => api.createClientLifecycleRule(input),
              ru ? 'Правило создано выключенным.' : 'Rule created disabled.',
            )}
          />
        ) : (
          <p className="meta" style={{ marginTop: 12 }}>
            {ru ? 'У вас есть доступ на просмотр, но не на изменение автоматизаций.' : 'You can view these automations but cannot change them.'}
          </p>
        )}
      </Section>

      <Section title={ru ? 'Email-шаблоны' : 'Email templates'}>
        {data.templates.length === 0 ? (
          <EmptyState
            compact
            title={ru ? 'Шаблонов пока нет' : 'No templates yet'}
            hint={ru ? 'Создайте черновик ниже.' : 'Create a draft below.'}
          />
        ) : (
          <div className="stack">
            {data.templates.map((template) => (
              <article className="card" key={template.id}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <strong>{template.subject || template.purpose}</strong>
                    <div className="meta">
                      {template.purpose}
                      {' · '}{template.locale.toUpperCase()}
                      {' · '}{template.template_scope === 'artist' ? (ru ? 'для мастера' : 'artist override') : (ru ? 'для организации' : 'workspace')}
                      {' · '}v{template.version}
                    </div>
                  </div>
                  <span className={`badge ${template.status === 'active' ? 'ok' : template.status === 'draft' ? 'warn' : ''}`}>
                    {templateStatusLabel(template.status, ru)}
                  </span>
                </div>
                <p style={{ whiteSpace: 'pre-wrap' }}>{template.body}</p>
                {data.canManage && template.template_scope === 'artist' ? (
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(
                        () => api.setMessageTemplateActive(template.id, template.status !== 'active'),
                        template.status === 'active'
                          ? (ru ? 'Шаблон выведен из использования.' : 'Template retired.')
                          : (ru ? 'Шаблон активирован.' : 'Template activated.'),
                      )}
                    >
                      {template.status === 'active' ? (ru ? 'Вывести из использования' : 'Retire') : (ru ? 'Активировать' : 'Activate')}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}

        {data.canManage ? (
          <TemplateForm
            ru={ru}
            busy={busy}
            workspaceId={data.workspaceId}
            artistId={selectedArtistId}
            purposes={data.purposes}
            variables={data.variables}
            onCreate={(input) => run(
              () => api.upsertMessageTemplate(input),
              ru ? 'Черновик шаблона сохранён.' : 'Template draft saved.',
            )}
          />
        ) : null}
      </Section>
    </div>
  );
}

function LifecycleExecutionHistoryPanel({
  ru,
  rows,
  canView,
}: {
  ru: boolean;
  rows: ClientLifecycleExecutionHistoryRow[];
  canView: boolean;
}) {
  if (!canView) {
    return (
      <EmptyState
        compact
        title={ru ? 'История недоступна' : 'History unavailable'}
        hint={ru
          ? 'Для истории нужен доступ к автоматизациям, клиентам, записям и интеграциям этого мастера.'
          : 'History requires access to this artist’s automations, clients, appointments and integrations.'}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title={ru ? 'История пока пуста' : 'No execution history yet'}
        hint={ru
          ? 'Здесь появятся последние запланированные и выполненные автоматизации этого мастера.'
          : 'The latest scheduled and completed automations for this artist will appear here.'}
      />
    );
  }

  return (
    <div className="stack">
      <div className="meta">
        {ru
          ? 'Последние 50 задач. История доступна только для чтения и не показывает адреса получателей, текст писем или ошибки провайдера.'
          : 'Latest 50 jobs. History is read-only and never exposes recipient addresses, message bodies or raw provider errors.'}
      </div>
      {rows.map((row) => (
        <article className="card" key={row.job_id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <strong>{row.rule_name}</strong>
              <div className="meta">
                {row.client_name}
                {' · '}{appointmentLabel(row.appointment_type, ru)}
                {' · '}{row.message_purpose}
                {' · '}v{row.rule_version}
              </div>
            </div>
            <span className={`badge ${executionBadgeClass(row.lifecycle_status)}`}>
              {executionStatusLabel(row.lifecycle_status, ru)}
            </span>
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px', margin: '14px 0 0' }}>
            <dt className="meta">{ru ? 'Запланировано' : 'Scheduled for'}</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(row.scheduled_at, ru ? 'ru' : 'en')}</dd>
            <dt className="meta">{ru ? 'Попытки' : 'Attempts'}</dt>
            <dd style={{ margin: 0 }}>{row.attempt_count}</dd>
            {row.failure_reason ? (
              <>
                <dt className="meta">{ru ? 'Причина' : 'Reason'}</dt>
                <dd style={{ margin: 0 }}>{failureReasonLabel(row.failure_reason, ru)}</dd>
              </>
            ) : null}
          </dl>
        </article>
      ))}
    </div>
  );
}

function LifecyclePreviewPanel({
  ru,
  rules,
  sessions,
  canPreview,
  onPreview,
}: {
  ru: boolean;
  rules: ClientLifecycleRule[];
  sessions: ClientLifecyclePreviewSession[];
  canPreview: boolean;
  onPreview: (ruleId: string, sessionId: string) => Promise<ClientLifecyclePreview | null>;
}) {
  const [ruleId, setRuleId] = useState(rules[0]?.id ?? '');
  const [sessionId, setSessionId] = useState(sessions[0]?.session_id ?? '');
  const [preview, setPreview] = useState<ClientLifecyclePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!rules.some((rule) => rule.id === ruleId)) setRuleId(rules[0]?.id ?? '');
    if (!sessions.some((session) => session.session_id === sessionId)) setSessionId(sessions[0]?.session_id ?? '');
    setPreview(null);
    setPreviewError(null);
  }, [rules, sessions, ruleId, sessionId]);

  if (!canPreview) {
    return (
      <EmptyState
        compact
        title={ru ? 'Предпросмотр недоступен' : 'Preview unavailable'}
        hint={ru
          ? 'Для предпросмотра нужен доступ к автоматизациям, клиентам, записям, заявкам, финансам и интеграциям этого мастера.'
          : 'Preview requires access to this artist’s automations, clients, appointments, enquiries, finance and integrations.'}
      />
    );
  }

  if (rules.length === 0 || sessions.length === 0) {
    return (
      <EmptyState
        compact
        title={ru ? 'Пока нечего проверять' : 'Nothing to preview yet'}
        hint={rules.length === 0
          ? (ru ? 'Для предпросмотра нужно хотя бы одно правило.' : 'Create at least one rule before using preview.')
          : (ru ? 'Для этого мастера нет доступных записей для предпросмотра.' : 'There are no accessible appointments for this artist to preview.')}
      />
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ruleId || !sessionId) return;
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const result = await onPreview(ruleId, sessionId);
      if (!result) {
        setPreviewError(ru
          ? 'Предпросмотр недоступен для выбранного правила и записи.'
          : 'Preview is unavailable for the selected rule and appointment.');
        return;
      }
      setPreview(result);
    } catch (cause) {
      setPreviewError(cause instanceof Error
        ? cause.message
        : (ru ? 'Не удалось построить предпросмотр.' : 'Could not build the preview.'));
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="notice">
        {ru
          ? 'Предпросмотр использует реальные данные выбранной записи, но ничего не отправляет, не создаёт задачу и не ставит письмо в очередь.'
          : 'Preview uses the selected appointment’s real data, but it does not send anything, create a job or queue an email.'}
      </div>
      <form className="stack" onSubmit={(event) => { void submit(event); }}>
        <label>
          {ru ? 'Правило' : 'Rule'}
          <select
            value={ruleId}
            onChange={(event) => {
              setRuleId(event.target.value);
              setPreview(null);
              setPreviewError(null);
            }}
          >
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name} · {appointmentLabel(rule.appointment_type, ru)} · {scheduleLabel(rule, ru)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {ru ? 'Запись' : 'Appointment'}
          <select
            value={sessionId}
            onChange={(event) => {
              setSessionId(event.target.value);
              setPreview(null);
              setPreviewError(null);
            }}
          >
            {sessions.map((session) => (
              <option key={session.session_id} value={session.session_id}>
                {session.client_name} · {appointmentLabel(session.appointment_type, ru)} · {formatDateTime(session.start_at, ru ? 'ru' : 'en')}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="submit" disabled={previewBusy || !ruleId || !sessionId}>
            {previewBusy ? (ru ? 'Проверяем…' : 'Checking…') : (ru ? 'Показать предпросмотр' : 'Show preview')}
          </button>
        </div>
      </form>

      {previewError ? <div className="notice warn" role="alert">{previewError}</div> : null}
      {preview ? <LifecyclePreviewResult ru={ru} preview={preview} /> : null}
    </div>
  );
}

function LifecyclePreviewResult({
  ru,
  preview,
}: {
  ru: boolean;
  preview: ClientLifecyclePreview;
}) {
  return (
    <article className="card" aria-label={ru ? 'Результат предпросмотра' : 'Preview result'}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong>{preview.rule_name}</strong>
          <div className="meta">
            {preview.client_name}
            {' · '}{appointmentLabel(preview.appointment_type, ru)}
            {' · '}{sessionStatusLabel(preview.session_status, ru)}
          </div>
        </div>
        <span className={`badge ${preview.eligible ? 'ok' : 'warn'}`}>
          {preview.eligible ? (ru ? 'Можно отправить' : 'Would send') : (ru ? 'Не отправится' : 'Would not send')}
        </span>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px', margin: '16px 0' }}>
        <dt className="meta">{ru ? 'Когда' : 'Scheduled for'}</dt>
        <dd style={{ margin: 0 }}>{formatDateTime(preview.scheduled_at, ru ? 'ru' : 'en')}</dd>
        <dt className="meta">{ru ? 'Шаблон' : 'Template'}</dt>
        <dd style={{ margin: 0 }}>{preview.template_id ? `${preview.template_scope ?? ''} · v${preview.template_version ?? '?'}` : (ru ? 'Нет активного шаблона' : 'No active template')}</dd>
        <dt className="meta">{ru ? 'Email' : 'Email integration'}</dt>
        <dd style={{ margin: 0 }}>{preview.integration_available ? (ru ? 'Подключён' : 'Available') : (ru ? 'Недоступен' : 'Unavailable')}</dd>
        <dt className="meta">{ru ? 'Существующая задача' : 'Existing job'}</dt>
        <dd style={{ margin: 0 }}>{preview.existing_job_status ? automationJobStatusLabel(preview.existing_job_status, ru) : (ru ? 'Нет' : 'None')}</dd>
        <dt className="meta">{ru ? 'Результат' : 'Decision'}</dt>
        <dd style={{ margin: 0 }}>{preview.blocker ? blockerLabel(preview.blocker, ru) : (ru ? 'Все проверки пройдены' : 'All checks pass')}</dd>
        {preview.suppression_reason ? (
          <>
            <dt className="meta">{ru ? 'Ограничение клиента' : 'Client suppression'}</dt>
            <dd style={{ margin: 0 }}>{suppressionLabel(preview.suppression_reason, ru)}</dd>
          </>
        ) : null}
      </dl>

      <div className="stack">
        <div>
          <div className="meta">{ru ? 'Тема письма' : 'Email subject'}</div>
          <div>{preview.rendered_subject || (ru ? 'Недоступна' : 'Unavailable')}</div>
        </div>
        <div>
          <div className="meta">{ru ? 'Текст письма' : 'Email body'}</div>
          <div className="card" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
            {preview.rendered_body || (ru ? 'Текст недоступен' : 'Body unavailable')}
          </div>
        </div>
      </div>

      <div className="meta" style={{ marginTop: 12 }}>
        {ru
          ? 'Только чтение · реальные ссылки действий не создаются'
          : 'Read only · real action links are never created'}
      </div>
    </article>
  );
}

function RuleForm({
  ru,
  busy,
  artistId,
  purposes,
  onCreate,
}: {
  ru: boolean;
  busy: boolean;
  artistId: string;
  purposes: ClientLifecyclePurpose[];
  onCreate: (input: {
    artistId: string;
    name: string;
    appointmentType: LifecycleAppointmentType;
    messagePurpose: string;
    scheduleAnchor: LifecycleScheduleAnchor;
    anchorOffsetMinutes: number;
    locale: LifecycleLocale;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [appointmentType, setAppointmentType] = useState<LifecycleAppointmentType>('tattoo_session');
  const [purpose, setPurpose] = useState('');
  const [anchor, setAnchor] = useState<LifecycleScheduleAnchor>('session_start');
  const [offset, setOffset] = useState('');
  const [locale, setLocale] = useState<LifecycleLocale>('en');
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const minutes = Number(offset);
    if (!name.trim() || !purpose || !Number.isInteger(minutes)) {
      setValidation(ru ? 'Заполните название, назначение и целое количество минут.' : 'Enter a name, purpose and a whole number of minutes.');
      return;
    }
    if ((anchor === 'session_start' && minutes > 0) || (anchor === 'session_end' && minutes < 0)) {
      setValidation(ru
        ? 'Для начала сессии offset должен быть 0 или отрицательным, для конца сессии 0 или положительным.'
        : 'Session-start offsets must be zero or negative; session-end offsets must be zero or positive.');
      return;
    }
    setValidation(null);
    await onCreate({
      artistId,
      name: name.trim(),
      appointmentType,
      messagePurpose: purpose,
      scheduleAnchor: anchor,
      anchorOffsetMinutes: minutes,
      locale,
    });
    setName('');
    setOffset('');
  }

  return (
    <form className="stack" style={{ marginTop: 18 }} onSubmit={(event) => { void submit(event); }}>
      <h3>{ru ? 'Новое правило' : 'New rule'}</h3>
      {validation ? <div className="notice warn" role="alert">{validation}</div> : null}
      <label>
        {ru ? 'Название' : 'Name'}
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
      </label>
      <label>
        {ru ? 'Тип записи' : 'Appointment type'}
        <select value={appointmentType} onChange={(event) => setAppointmentType(event.target.value as LifecycleAppointmentType)}>
          {APPOINTMENT_TYPES.map((type) => <option key={type} value={type}>{appointmentLabel(type, ru)}</option>)}
        </select>
      </label>
      <label>
        {ru ? 'Назначение сообщения' : 'Message purpose'}
        <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
          <option value="">{ru ? 'Выберите назначение' : 'Choose a purpose'}</option>
          {purposes.map((item) => <option key={item.purpose} value={item.purpose}>{item.purpose}</option>)}
        </select>
      </label>
      <label>
        {ru ? 'От какой точки считать' : 'Schedule anchor'}
        <select value={anchor} onChange={(event) => setAnchor(event.target.value as LifecycleScheduleAnchor)}>
          <option value="session_start">{ru ? 'Начало записи' : 'Appointment start'}</option>
          <option value="session_end">{ru ? 'Конец записи' : 'Appointment end'}</option>
        </select>
      </label>
      <label>
        {ru ? 'Смещение, минуты' : 'Offset, minutes'}
        <input
          inputMode="numeric"
          value={offset}
          onChange={(event) => setOffset(event.target.value)}
          placeholder={anchor === 'session_start' ? '-1440' : '1440'}
        />
        <span className="meta">
          {anchor === 'session_start'
            ? (ru ? 'Отрицательное значение означает до начала.' : 'Use a negative value for before the appointment starts.')
            : (ru ? 'Положительное значение означает после окончания.' : 'Use a positive value for after the appointment ends.')}
        </span>
      </label>
      <label>
        {ru ? 'Язык' : 'Locale'}
        <select value={locale} onChange={(event) => setLocale(event.target.value as LifecycleLocale)}>
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>
      </label>
      <div className="actions">
        <button type="submit" disabled={busy}>{ru ? 'Создать выключенным' : 'Create disabled'}</button>
      </div>
    </form>
  );
}

function TemplateForm({
  ru,
  busy,
  workspaceId,
  artistId,
  purposes,
  variables,
  onCreate,
}: {
  ru: boolean;
  busy: boolean;
  workspaceId: string;
  artistId: string;
  purposes: ClientLifecyclePurpose[];
  variables: ClientLifecycleVariable[];
  onCreate: (input: {
    workspaceId: string;
    artistId: string;
    purpose: string;
    body: string;
    locale: LifecycleLocale;
    subject: string | null;
  }) => Promise<void>;
}) {
  const [purpose, setPurpose] = useState('');
  const [locale, setLocale] = useState<LifecycleLocale>('en');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!purpose || !body.trim()) {
      setValidation(ru ? 'Выберите назначение и заполните текст.' : 'Choose a purpose and enter the message body.');
      return;
    }
    setValidation(null);
    await onCreate({
      workspaceId,
      artistId,
      purpose,
      body: body.trim(),
      locale,
      subject: subject.trim() || null,
    });
    setSubject('');
    setBody('');
  }

  return (
    <form className="stack" style={{ marginTop: 18 }} onSubmit={(event) => { void submit(event); }}>
      <h3>{ru ? 'Новый черновик шаблона' : 'New template draft'}</h3>
      {validation ? <div className="notice warn" role="alert">{validation}</div> : null}
      <label>
        {ru ? 'Назначение' : 'Purpose'}
        <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
          <option value="">{ru ? 'Выберите назначение' : 'Choose a purpose'}</option>
          {purposes.map((item) => (
            <option key={item.purpose} value={item.purpose}>{item.purpose}</option>
          ))}
        </select>
      </label>
      <label>
        {ru ? 'Язык' : 'Locale'}
        <select value={locale} onChange={(event) => setLocale(event.target.value as LifecycleLocale)}>
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>
      </label>
      <label>
        {ru ? 'Тема письма' : 'Email subject'}
        <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} />
      </label>
      <label>
        {ru ? 'Текст письма' : 'Email body'}
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} maxLength={4000} />
      </label>
      {variables.length > 0 ? (
        <div className="meta">
          <strong>{ru ? 'Доступные переменные:' : 'Available variables:'}</strong>{' '}
          {variables.map((variable) => `{{${variable.variable}}}`).join(', ')}
        </div>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={busy}>{ru ? 'Сохранить черновик' : 'Save draft'}</button>
      </div>
    </form>
  );
}

function matchingActiveTemplate(rule: ClientLifecycleRule, templates: ClientLifecycleTemplate[]): boolean {
  return templates.some((template) =>
    template.status === 'active'
    && template.purpose === rule.message_purpose
    && template.locale === rule.message_locale
  );
}

function appointmentLabel(type: LifecycleAppointmentType, ru: boolean): string {
  const labels: Record<LifecycleAppointmentType, [string, string]> = {
    tattoo_session: ['Tattoo session', 'Тату-сеанс'],
    in_person_consultation: ['In-person consultation', 'Очная консультация'],
    video_consultation: ['Video consultation', 'Видео-консультация'],
    touch_up: ['Touch-up', 'Коррекция'],
  };
  return labels[type][ru ? 1 : 0];
}

function scheduleLabel(rule: ClientLifecycleRule, ru: boolean): string {
  const minutes = rule.anchor_offset_minutes;
  const amount = humanDuration(Math.abs(minutes), ru);
  if (rule.schedule_anchor === 'session_start') {
    if (minutes === 0) return ru ? 'в момент начала' : 'at appointment start';
    return ru ? `${amount} до начала` : `${amount} before start`;
  }
  if (minutes === 0) return ru ? 'в момент окончания' : 'at appointment end';
  return ru ? `${amount} после окончания` : `${amount} after end`;
}

function humanDuration(minutes: number, ru: boolean): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return ru ? `${days} дн.` : `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return ru ? `${hours} ч.` : `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return ru ? `${minutes} мин.` : `${minutes} min`;
}

function templateStatusLabel(status: ClientLifecycleTemplate['status'], ru: boolean): string {
  if (status === 'active') return ru ? 'Активен' : 'Active';
  if (status === 'draft') return ru ? 'Черновик' : 'Draft';
  return ru ? 'Архив' : 'Retired';
}

function sessionStatusLabel(status: ClientLifecyclePreview['session_status'], ru: boolean): string {
  const labels: Record<ClientLifecyclePreview['session_status'], [string, string]> = {
    draft: ['Draft', 'Черновик'],
    proposed: ['Proposed', 'Предложено'],
    confirmed: ['Confirmed', 'Подтверждено'],
    completed: ['Completed', 'Завершено'],
    cancelled: ['Cancelled', 'Отменено'],
    no_show: ['No-show', 'Неявка'],
  };
  return labels[status][ru ? 1 : 0];
}

function automationJobStatusLabel(status: NonNullable<ClientLifecyclePreview['existing_job_status']>, ru: boolean): string {
  const labels: Record<NonNullable<ClientLifecyclePreview['existing_job_status']>, [string, string]> = {
    pending: ['Pending', 'Ожидает'],
    running: ['Running', 'Выполняется'],
    completed: ['Completed', 'Отправлено'],
    cancelled: ['Cancelled', 'Отменено'],
    failed: ['Failed', 'Ошибка'],
  };
  return labels[status][ru ? 1 : 0];
}

function executionStatusLabel(status: ClientLifecycleExecutionHistoryRow['lifecycle_status'], ru: boolean): string {
  const labels: Record<ClientLifecycleExecutionHistoryRow['lifecycle_status'], [string, string]> = {
    scheduled: ['Scheduled', 'Запланировано'],
    pending: ['Pending', 'Ожидает'],
    queued: ['Queued', 'В очереди'],
    sent: ['Sent', 'Отправлено'],
    suppressed: ['Suppressed', 'Отправка запрещена'],
    withdrawn: ['Withdrawn', 'Снято'],
    cancelled: ['Cancelled', 'Отменено'],
    failed: ['Failed', 'Ошибка'],
    retrying: ['Retrying', 'Повторная попытка'],
  };
  return labels[status][ru ? 1 : 0];
}

function executionBadgeClass(status: ClientLifecycleExecutionHistoryRow['lifecycle_status']): string {
  if (status === 'sent') return 'ok';
  if (['failed', 'suppressed', 'withdrawn', 'cancelled', 'retrying'].includes(status)) return 'warn';
  return '';
}

function failureReasonLabel(reason: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    client_suppressed: ['Client communications are suppressed', 'Коммуникации с клиентом отключены'],
    appointment_withdrawn: ['Appointment is no longer eligible', 'Запись больше не подходит для отправки'],
    integration_unavailable: ['Email integration is unavailable', 'Email-интеграция недоступна'],
    template_unavailable: ['Active template is unavailable', 'Нет подходящего активного шаблона'],
    destination_unavailable: ['Delivery destination is unavailable', 'Адрес доставки недоступен'],
    email_failed: ['Email preparation failed', 'Не удалось подготовить email'],
    provider_delivery_failed: ['Provider delivery failed', 'Провайдер не доставил сообщение'],
    delivery_state_missing: ['Delivery state could not be confirmed', 'Не удалось подтвердить состояние доставки'],
    automation_failed: ['Automation failed', 'Ошибка автоматизации'],
  };
  return labels[reason]?.[ru ? 1 : 0] ?? (ru ? 'Неизвестная причина' : 'Unknown failure reason');
}

function blockerLabel(blocker: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    already_delivered: ['Already delivered', 'Уже отправлено'],
    job_cancelled: ['Existing job was cancelled', 'Существующая задача отменена'],
    job_failed: ['Existing job failed', 'Существующая задача завершилась ошибкой'],
    automation_paused: ['Automations are paused for this artist', 'Автоматизации этого мастера приостановлены'],
    rule_disabled: ['This rule is disabled', 'Это правило выключено'],
    appointment_type_mismatch: ['Appointment type does not match the rule', 'Тип записи не подходит для этого правила'],
    appointment_ineligible: ['Appointment status makes this message ineligible', 'Статус записи не позволяет отправить это сообщение'],
    appointment_not_ready: ['Appointment is not ready for this automation yet', 'Запись ещё не готова для этой автоматизации'],
    not_due: ['Message is not due yet', 'Время отправки ещё не наступило'],
    destination_unavailable: ['Client email destination is unavailable', 'Email клиента недоступен'],
    template_unavailable: ['Active service template is unavailable', 'Нет подходящего активного сервисного шаблона'],
    client_blocked: ['Client suppression blocks this message', 'Ограничения клиента блокируют это сообщение'],
    integration_unavailable: ['Email integration is unavailable', 'Email-интеграция недоступна'],
  };
  return labels[blocker]?.[ru ? 1 : 0] ?? (ru ? 'Отправка заблокирована' : 'Delivery is blocked');
}

function suppressionLabel(reason: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    client_archived: ['Client is archived', 'Клиент архивирован'],
    client_email_missing: ['Client email is missing', 'У клиента нет email'],
    email_suppressed: ['Email is suppressed for this client', 'Email для этого клиента отключён'],
    service_email_suppressed: ['Service email is suppressed for this client', 'Сервисные email для этого клиента отключены'],
  };
  return labels[reason]?.[ru ? 1 : 0] ?? (ru ? 'Действует ограничение клиента' : 'A client suppression applies');
}
