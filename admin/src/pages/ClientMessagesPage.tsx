import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import type {
  ClientLifecyclePurpose,
  ClientLifecycleRule,
  ClientLifecycleTemplate,
  ClientLifecycleVariable,
} from '../lib/lifecycle-api';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';

type View = 'messages' | 'schedule';
type SaveMode = 'draft' | 'apply';

interface ClientMessagesData {
  templates: ClientLifecycleTemplate[];
  purposes: ClientLifecyclePurpose[];
  variables: ClientLifecycleVariable[];
  rules: ClientLifecycleRule[];
  canManage: boolean;
  workspaceId: string;
}

interface TemplateSlot {
  key: string;
  purpose: string;
  locale: ClientLifecycleTemplate['locale'];
  versions: ClientLifecycleTemplate[];
  active: ClientLifecycleTemplate | null;
  draft: ClientLifecycleTemplate | null;
  source: ClientLifecycleTemplate;
}

const PURPOSE_LABELS: Record<string, { en: string; ru: string }> = {
  consultation_reminder: { en: 'Consultation reminder', ru: 'Напоминание о консультации' },
  deposit_confirmation: { en: 'Deposit confirmation', ru: 'Подтверждение депозита' },
  deposit_policy: { en: 'Deposit policy', ru: 'Условия депозита' },
  deposit_request: { en: 'Deposit request', ru: 'Запрос депозита' },
  new_enquiry_ack: { en: 'New enquiry reply', ru: 'Ответ на новую заявку' },
  no_response_followup: { en: 'No-response follow-up', ru: 'Напоминание без ответа' },
  post_session_checkin: { en: 'Post-session check-in', ru: 'Сообщение после сеанса' },
  session_reminder_24h: { en: '24-hour session reminder', ru: 'Напоминание о сеансе за 24 часа' },
  session_reminder_72h: { en: '72-hour session reminder', ru: 'Напоминание о сеансе за 72 часа' },
  session_reminder_7d: { en: '7-day session reminder', ru: 'Напоминание о сеансе за 7 дней' },
};

const CATEGORY_ORDER = ['booking', 'deposit', 'lead', 'aftercare', 'other'] as const;
type Category = typeof CATEGORY_ORDER[number];

const CATEGORY_LABELS: Record<Category, { en: string; ru: string }> = {
  booking: { en: 'Before the appointment', ru: 'До записи' },
  deposit: { en: 'Payments and deposit', ru: 'Оплата и депозит' },
  lead: { en: 'Enquiries and follow-up', ru: 'Заявки и follow-up' },
  aftercare: { en: 'After the session', ru: 'После сеанса' },
  other: { en: 'Other messages', ru: 'Другие сообщения' },
};

export function ClientMessagesPage() {
  const api = useApi();
  const { language } = useLanguage();
  const ru = language === 'ru';
  const { artists, selectedArtistId } = useArtistScope();
  const [view, setView] = useState<View>('messages');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = useAsync<ClientMessagesData | null>(async () => {
    if (!selectedArtistId) return null;
    const [templates, purposes, variables, rules, capabilities, context] = await Promise.all([
      api.listClientLifecycleTemplates(selectedArtistId),
      api.listClientLifecycleTemplatePurposes(selectedArtistId),
      api.listClientLifecycleTemplateVariables(selectedArtistId),
      api.listClientLifecycleRules(selectedArtistId),
      api.listCapabilities(selectedArtistId),
      api.artistControlPlaneContext(selectedArtistId),
    ]);
    if (!context?.workspace_id) throw new Error('Could not resolve the artist workspace.');
    return {
      templates,
      purposes,
      variables,
      rules,
      canManage: capabilities.some((grant) =>
        grant.artist_id === selectedArtistId && grant.capability === 'manage_automations'
      ),
      workspaceId: context.workspace_id,
    };
  }, [api, selectedArtistId]);

  const artistName = useMemo(
    () => artists.find((artist) => artist.id === selectedArtistId)?.display_name ?? null,
    [artists, selectedArtistId],
  );

  const slots = useMemo(() => groupTemplates(state.data?.templates ?? []), [state.data?.templates]);
  const purposeDescriptions = useMemo(() => new Map(
    (state.data?.purposes ?? []).map((purpose) => [purpose.purpose, purpose.description]),
  ), [state.data?.purposes]);

  if (!selectedArtistId) {
    return (
      <EmptyState
        title={ru ? 'Выберите мастера' : 'Choose an artist'}
        hint={ru
          ? 'Сообщения клиентам принадлежат конкретному мастеру. Выберите его в верхней панели.'
          : 'Client messages belong to one artist. Choose that artist in the top bar.'}
      />
    );
  }
  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return null;

  const data = state.data;
  const exactArtistId = selectedArtistId;

  function startEditing(slot: TemplateSlot) {
    setEditingKey(slot.key);
    setSubject(slot.source.subject ?? '');
    setBody(slot.source.body);
    setNotice(null);
    setActionError(null);
  }

  async function save(slot: TemplateSlot, mode: SaveMode) {
    if (!body.trim()) {
      setActionError(ru ? 'Текст сообщения не может быть пустым.' : 'Message body cannot be empty.');
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const templateId = await api.upsertMessageTemplate({
        workspaceId: data.workspaceId,
        artistId: exactArtistId,
        purpose: slot.purpose,
        body: body.trim(),
        locale: slot.locale,
        subject: subject.trim() || null,
      });
      if (mode === 'apply') {
        await api.setMessageTemplateActive(templateId, true);
        setNotice(ru
          ? 'Изменения сохранены и применены. Новые сообщения будут использовать этот текст.'
          : 'Changes saved and applied. New messages will use this text.');
      } else {
        setNotice(ru
          ? 'Изменения сохранены как черновик. Действующий текст пока не изменился.'
          : 'Changes saved as a draft. The active message has not changed yet.');
      }
      setEditingKey(null);
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (ru ? 'Не удалось сохранить изменения.' : 'Could not save changes.'));
    } finally {
      setBusy(false);
    }
  }

  async function activateDraft(slot: TemplateSlot) {
    if (!slot.draft) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api.setMessageTemplateActive(slot.draft.id, true);
      setNotice(ru
        ? 'Черновик применён. Новые сообщения будут использовать этот текст.'
        : 'Draft applied. New messages will use this text.');
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (ru ? 'Не удалось применить черновик.' : 'Could not apply the draft.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{ru ? 'Автоматические сообщения' : 'Automatic messages'}</h1>
        <div className="meta">
          {artistName ?? selectedArtistId}
          {' · '}
          {ru ? 'Автоматические email клиентам' : 'Automated client email'}
        </div>
      </div>

      <div className="notice">
        {ru
          ? 'Здесь редактируется то, что увидит клиент. Техническая история, очередь и диагностика вынесены в расширенные настройки.'
          : 'Edit what the client will actually see here. Technical history, queue and diagnostics live in Advanced settings.'}
      </div>
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}

      <div className="actions" role="navigation" aria-label={ru ? 'Разделы сообщений' : 'Message sections'}>
        <button type="button" aria-pressed={view === 'messages'} onClick={() => setView('messages')}>
          {ru ? 'Тексты сообщений' : 'Message text'}
        </button>
        <button type="button" aria-pressed={view === 'schedule'} onClick={() => setView('schedule')}>
          {ru ? 'Когда отправлять' : 'When to send'}
        </button>
        <Link to="/automations/advanced">{ru ? 'Расширенные настройки' : 'Advanced settings'}</Link>
      </div>

      {view === 'messages' ? (
        slots.length === 0 ? (
          <EmptyState
            title={ru ? 'Шаблонов пока нет' : 'No message templates yet'}
            hint={ru
              ? 'Создать первый шаблон можно в расширенных настройках.'
              : 'Create the first template in Advanced settings.'}
          />
        ) : (
          CATEGORY_ORDER.map((category) => {
            const categorySlots = slots.filter((slot) => categoryForPurpose(slot.purpose) === category);
            if (categorySlots.length === 0) return null;
            return (
              <Section key={category} title={CATEGORY_LABELS[category][language]}>
                <div className="stack">
                  {categorySlots.map((slot) => {
                    const editing = editingKey === slot.key;
                    const label = purposeLabel(slot.purpose, language, purposeDescriptions.get(slot.purpose));
                    const activeVersion = slot.active?.version ?? null;
                    const shown = slot.draft ?? slot.active ?? slot.source;
                    return (
                      <article className="card" key={slot.key}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                          <div>
                            <strong>{label}</strong>
                            <div className="meta">
                              Email · {slot.locale.toUpperCase()} · v{shown.version}
                              {' · '}
                              {shown.status === 'draft'
                                ? (ru ? 'черновик' : 'draft')
                                : shown.status === 'active'
                                  ? (ru ? 'активно' : 'active')
                                  : (ru ? 'архив' : 'retired')}
                            </div>
                          </div>
                          <span className={`badge ${slot.draft ? 'warn' : slot.active ? 'ok' : ''}`}>
                            {slot.draft
                              ? (ru ? 'Есть черновик' : 'Draft waiting')
                              : slot.active
                                ? (ru ? 'Используется' : 'In use')
                                : (ru ? 'Не активно' : 'Inactive')}
                          </span>
                        </div>

                        {slot.draft && activeVersion !== null ? (
                          <div className="notice" style={{ marginTop: 12 }}>
                            {ru
                              ? `Сейчас клиентам отправляется активная версия v${activeVersion}. Ниже показан новый черновик v${slot.draft.version}.`
                              : `Clients currently receive active v${activeVersion}. Draft v${slot.draft.version} is shown below.`}
                          </div>
                        ) : null}

                        {!editing ? (
                          <>
                            {shown.subject ? (
                              <div style={{ marginTop: 12 }}>
                                <div className="meta">{ru ? 'Тема письма' : 'Subject'}</div>
                                <div>{shown.subject}</div>
                              </div>
                            ) : null}
                            <div style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{shown.body}</div>
                            {data.canManage ? (
                              <div className="actions" style={{ marginTop: 12 }}>
                                <button type="button" disabled={busy} onClick={() => startEditing(slot)}>
                                  {shown.template_scope === 'workspace'
                                    ? (ru ? 'Изменить для этого мастера' : 'Customize for this artist')
                                    : (ru ? 'Редактировать текст' : 'Edit message')}
                                </button>
                                {slot.draft ? (
                                  <button type="button" disabled={busy} onClick={() => { void activateDraft(slot); }}>
                                    {ru ? 'Применить черновик' : 'Apply draft'}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="stack" style={{ marginTop: 12 }}>
                            <label>
                              {ru ? 'Тема письма' : 'Email subject'}
                              <input value={subject} onChange={(event) => setSubject(event.target.value)} />
                            </label>
                            <label>
                              {ru ? 'Текст сообщения' : 'Message text'}
                              <textarea rows={9} value={body} onChange={(event) => setBody(event.target.value)} />
                            </label>
                            {data.variables.length > 0 ? (
                              <div className="meta">
                                {ru ? 'Можно использовать переменные: ' : 'Available variables: '}
                                {data.variables.map((variable, index) => (
                                  <span key={variable.variable}>
                                    {index > 0 ? ', ' : ''}<code>{`{{${variable.variable}}}`}</code>
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <div className="notice">
                              {ru
                                ? 'Сохранение создаёт новую версию. Можно оставить её черновиком или сразу применить. Старые версии сохраняются в истории.'
                                : 'Saving creates a new version. Keep it as a draft or apply it immediately. Older versions remain in history.'}
                            </div>
                            <div className="actions">
                              <button type="button" disabled={busy} onClick={() => { void save(slot, 'apply'); }}>
                                {ru ? 'Сохранить и применить' : 'Save and apply'}
                              </button>
                              <button type="button" disabled={busy} onClick={() => { void save(slot, 'draft'); }}>
                                {ru ? 'Сохранить черновик' : 'Save draft'}
                              </button>
                              <button type="button" disabled={busy} onClick={() => setEditingKey(null)}>
                                {ru ? 'Отмена' : 'Cancel'}
                              </button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </Section>
            );
          })
        )
      ) : (
        <Section title={ru ? 'Когда отправлять' : 'When to send'}>
          <div className="notice">
            {ru
              ? 'Здесь коротко показано расписание. Изменение времени, создание новых правил, предпросмотр и техническая диагностика остаются в расширенных настройках.'
              : 'This is the short schedule view. Timing edits, new rules, preview and technical diagnostics remain in Advanced settings.'}
          </div>
          {data.rules.length === 0 ? (
            <EmptyState
              compact
              title={ru ? 'Активных сценариев пока нет' : 'No automation rules yet'}
              hint={ru ? 'Создать правило можно в расширенных настройках.' : 'Create a rule in Advanced settings.'}
            />
          ) : (
            <div className="stack" style={{ marginTop: 12 }}>
              {data.rules.map((rule) => (
                <article className="card" key={rule.id}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div>
                      <strong>{purposeLabel(rule.message_purpose, language, purposeDescriptions.get(rule.message_purpose))}</strong>
                      <div className="meta">
                        {scheduleLabel(rule.anchor_offset_minutes, language)} · {appointmentLabel(rule.appointment_type, language)}
                      </div>
                    </div>
                    <span className={`badge ${rule.is_enabled ? 'ok' : 'warn'}`}>
                      {rule.is_enabled ? (ru ? 'Включено' : 'Enabled') : (ru ? 'Выключено' : 'Disabled')}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="actions" style={{ marginTop: 12 }}>
            <Link to="/automations/advanced">{ru ? 'Открыть расширенные настройки' : 'Open Advanced settings'}</Link>
          </div>
        </Section>
      )}
    </div>
  );
}

export function groupTemplates(templates: ClientLifecycleTemplate[]): TemplateSlot[] {
  const grouped = new Map<string, ClientLifecycleTemplate[]>();
  for (const template of templates) {
    const key = `${template.purpose}|${template.locale}`;
    const versions = grouped.get(key) ?? [];
    versions.push(template);
    grouped.set(key, versions);
  }
  return Array.from(grouped.entries()).map(([key, versions]) => {
    const byVersion = (items: ClientLifecycleTemplate[]) => [...items].sort((a, b) => b.version - a.version);
    const artistVersions = byVersion(versions.filter((template) => template.template_scope === 'artist'));
    const workspaceVersions = byVersion(versions.filter((template) => template.template_scope === 'workspace'));
    const artistActive = artistVersions.find((template) => template.status === 'active') ?? null;
    const artistDraft = artistVersions.find((template) => template.status === 'draft') ?? null;
    const workspaceActive = workspaceVersions.find((template) => template.status === 'active') ?? null;
    const workspaceDraft = workspaceVersions.find((template) => template.status === 'draft') ?? null;
    const active = artistActive ?? workspaceActive;
    const draft = artistDraft ?? (artistActive ? null : workspaceDraft);
    const sorted = [...artistVersions, ...workspaceVersions];
    const source = draft ?? active ?? artistVersions[0] ?? workspaceVersions[0];
    return {
      key,
      purpose: source.purpose,
      locale: source.locale,
      versions: sorted,
      active,
      draft,
      source,
    };
  }).sort((a, b) => purposeRank(a.purpose) - purposeRank(b.purpose) || a.locale.localeCompare(b.locale));
}

function categoryForPurpose(purpose: string): Category {
  if (['consultation_reminder', 'session_reminder_7d', 'session_reminder_72h', 'session_reminder_24h'].includes(purpose)) return 'booking';
  if (['deposit_request', 'deposit_confirmation', 'deposit_policy'].includes(purpose)) return 'deposit';
  if (['new_enquiry_ack', 'no_response_followup'].includes(purpose)) return 'lead';
  if (purpose === 'post_session_checkin') return 'aftercare';
  return 'other';
}

function purposeRank(purpose: string): number {
  const order = [
    'consultation_reminder',
    'session_reminder_7d',
    'session_reminder_72h',
    'session_reminder_24h',
    'deposit_request',
    'deposit_confirmation',
    'deposit_policy',
    'new_enquiry_ack',
    'no_response_followup',
    'post_session_checkin',
  ];
  const index = order.indexOf(purpose);
  return index === -1 ? order.length : index;
}

function purposeLabel(purpose: string, language: 'en' | 'ru', fallback?: string): string {
  return PURPOSE_LABELS[purpose]?.[language] ?? fallback ?? purpose.replaceAll('_', ' ');
}

function appointmentLabel(value: string, language: 'en' | 'ru'): string {
  const labels: Record<string, { en: string; ru: string }> = {
    tattoo_session: { en: 'tattoo session', ru: 'тату-сеанс' },
    in_person_consultation: { en: 'in-person consultation', ru: 'очная консультация' },
    video_consultation: { en: 'video consultation', ru: 'видеоконсультация' },
    touch_up: { en: 'touch-up', ru: 'коррекция' },
  };
  return labels[value]?.[language] ?? value.replaceAll('_', ' ');
}

function scheduleLabel(offsetMinutes: number, language: 'en' | 'ru'): string {
  if (offsetMinutes === 0) return language === 'ru' ? 'В момент начала записи' : 'At appointment start';
  const before = offsetMinutes < 0;
  const minutes = Math.abs(offsetMinutes);
  const [amount, unit] = minutes % 1440 === 0
    ? [minutes / 1440, language === 'ru' ? 'дн.' : minutes / 1440 === 1 ? 'day' : 'days']
    : minutes % 60 === 0
      ? [minutes / 60, language === 'ru' ? 'ч.' : minutes / 60 === 1 ? 'hour' : 'hours']
      : [minutes, language === 'ru' ? 'мин.' : minutes === 1 ? 'minute' : 'minutes'];
  if (language === 'ru') return `${amount} ${unit} ${before ? 'до записи' : 'после записи'}`;
  return `${amount} ${unit} ${before ? 'before appointment' : 'after appointment'}`;
}
