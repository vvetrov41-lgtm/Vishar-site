import { useMemo, useState, type FormEvent } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import type {
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
  canManage: boolean;
  workspaceId: string;
}

const APPOINTMENT_TYPES: LifecycleAppointmentType[] = [
  'tattoo_session',
  'in_person_consultation',
  'video_consultation',
  'touch_up',
];

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

    const [rules, templates, purposes, variables, capabilities, context] = await Promise.all([
      api.listClientLifecycleRules(selectedArtistId),
      api.listClientLifecycleTemplates(selectedArtistId),
      api.listClientLifecycleTemplatePurposes(selectedArtistId),
      api.listClientLifecycleTemplateVariables(selectedArtistId),
      api.listCapabilities(selectedArtistId),
      api.artistControlPlaneContext(selectedArtistId),
    ]);

    if (!context?.workspace_id) throw new Error('Could not resolve the artist workspace.');

    return {
      rules,
      templates,
      purposes,
      variables,
      canManage: capabilities.some(
        (grant) => grant.artist_id === selectedArtistId && grant.capability === 'manage_automations',
      ),
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
                {data.canManage ? (
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
