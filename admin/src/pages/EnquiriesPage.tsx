import { confirmEnquiryTransition } from '../lib/enquiry-transition-confirm';
import { useState, type FormEvent } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { EnquiryBoard } from '../components/EnquiryBoard';
import { Link, useQueryState } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can } from '../lib/permissions';
import type { Enquiry, EnquiryStatus, StatusTransition } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { enquiryHeadline } from '../lib/enquiry-summary';
import { ENQUIRY_BOARD_STATUSES } from '../lib/enquiry-board';

const FILTERS: ('' | EnquiryStatus)[] = [
  '',
  'new',
  'reviewing',
  'waiting_for_client',
  'accepted',
  'quote_sent',
  'deposit_requested',
  'deposit_paid',
  'converted',
  'declined',
  'closed',
];

type ManualForm = {
  fullName: string;
  email: string;
  phone: string;
  instagram: string;
  preferredContact: '' | 'Email' | 'WhatsApp' | 'Instagram';
  travellingFrom: string;
  projectType: string;
  placement: string;
  approximateSize: string;
  coverUp: string;
  preferredTiming: string;
  idea: string;
  privacyAcknowledged: boolean;
};

const EMPTY_MANUAL_FORM: ManualForm = {
  fullName: '',
  email: '',
  phone: '',
  instagram: '',
  preferredContact: '',
  travellingFrom: '',
  projectType: '',
  placement: '',
  approximateSize: '',
  coverUp: '',
  preferredTiming: '',
  idea: '',
  privacyAcknowledged: false,
};

export function EnquiriesPage() {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const copy = MANUAL_COPY[language];
  // Filters live in the address so they survive opening an enquiry and
  // coming back, a reload, and a shared link.
  const [statusParam, setStatusParam] = useQueryState('status');
  const status = statusParam as '' | EnquiryStatus;
  const setStatus = setStatusParam;
  const [search, setSearch] = useQueryState('q');
  const [viewParam, setViewParam] = useQueryState('view');
  const storedView: 'list' | 'board' = (() => {
    try {
      return window.localStorage.getItem('vishar-crm-enquiries-view') === 'board' ? 'board' : 'list';
    } catch {
      return 'list';
    }
  })();
  const view: 'list' | 'board' = viewParam === 'board' || viewParam === 'list' ? viewParam : storedView;
  const setView = (next: 'list' | 'board') => setViewParam(next);
  const [movingEnquiryId, setMovingEnquiryId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim());
  const { selectedArtistId } = useArtistScope();
  const mayCreate = can(profile?.role, 'createEnquiry');
  const mayTransition = can(profile?.role, 'transitionEnquiry');

  const [manual, setManual] = useState<ManualForm>(EMPTY_MANUAL_FORM);
  const [manualKey, setManualKey] = useState(() => crypto.randomUUID());
  const [manualAttempted, setManualAttempted] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSuccess, setManualSuccess] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<{
    enquiries: Enquiry[];
    clientNames: Map<string, string>;
    transitions: StatusTransition[];
  }>(async () => {
    const [enquiries, transitions] = await Promise.all([
      api.listEnquiries({
        status: view === 'list' ? status || undefined : undefined,
        statuses: view === 'board' ? ENQUIRY_BOARD_STATUSES : undefined,
        search: debouncedSearch || undefined,
        artistId: selectedArtistId ?? undefined,
      }),
      mayTransition ? api.listStatusTransitions() : Promise.resolve([] as StatusTransition[]),
    ]);
    // The queue used to identify an enquiry by its reference number alone, so
    // triaging cost one navigation per enquiry just to learn who it was from.
    const clients = await api.listClientsByIds(
      enquiries.map((enquiry) => enquiry.client_id)
    );
    return {
      enquiries,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
      transitions,
    };
  }, [api, status, debouncedSearch, selectedArtistId, view, mayTransition]);

  function changeView(next: 'list' | 'board') {
    setView(next);
    setMoveError(null);
    try {
      window.localStorage.setItem('vishar-crm-enquiries-view', next);
    } catch {
      // View choice still applies for this session.
    }
  }

  async function moveEnquiry(enquiry: Enquiry, to: EnquiryStatus) {
    if (movingEnquiryId) return;
    if (!(await confirmEnquiryTransition(to, language, data?.clientNames.get(enquiry.client_id)))) return;
    setMovingEnquiryId(enquiry.id);
    setMoveError(null);
    try {
      await api.transitionEnquiry(enquiry.id, to);
      reload();
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : t('enquiries.boardMoveFailed'));
    } finally {
      setMovingEnquiryId(null);
    }
  }

  function updateManual<K extends keyof ManualForm>(field: K, value: ManualForm[K]) {
    setManual((current) => ({ ...current, [field]: value }));
    setManualError(null);
    setManualSuccess(null);
    if (manualAttempted) {
      setManualKey(crypto.randomUUID());
      setManualAttempted(false);
    }
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    setManualError(null);
    setManualSuccess(null);

    if (!selectedArtistId) {
      setManualError(copy.chooseArtist);
      return;
    }
    if (!manual.fullName.trim() || !manual.email.trim()) {
      setManualError(copy.required);
      return;
    }
    if (!manual.privacyAcknowledged) {
      setManualError(copy.privacyRequired);
      return;
    }

    setManualSaving(true);
    setManualAttempted(true);
    try {
      const result = await api.createManualEnquiry({
        idempotencyKey: manualKey,
        artistId: selectedArtistId,
        fullName: manual.fullName,
        email: manual.email,
        phone: manual.phone,
        instagram: manual.instagram,
        preferredContact: manual.preferredContact,
        travellingFrom: manual.travellingFrom,
        projectType: manual.projectType,
        placement: manual.placement,
        approximateSize: manual.approximateSize,
        coverUp: manual.coverUp,
        preferredTiming: manual.preferredTiming,
        idea: manual.idea,
        privacyAcknowledged: manual.privacyAcknowledged,
      });
      setManualSuccess(
        result.client_conflict
          ? copy.createdConflict.replace('{reference}', result.reference_number)
          : copy.created.replace('{reference}', result.reference_number)
      );
      setManual(EMPTY_MANUAL_FORM);
      setManualKey(crypto.randomUUID());
      setManualAttempted(false);
      reload();
    } catch (cause) {
      setManualError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setManualSaving(false);
    }
  }

  return (
    <>
      {mayCreate ? (
        <details className="card">
          <summary className="title">{copy.newManual}</summary>
          <p className="notice">{copy.intro}</p>
          {!selectedArtistId ? <p className="notice warn">{copy.chooseArtist}</p> : null}
          <form onSubmit={(event) => { void submitManual(event); }}>
            <div className="form-grid">
              <label>
                <span>{copy.fullName}</span>
                <input
                  value={manual.fullName}
                  maxLength={160}
                  required
                  onChange={(event) => updateManual('fullName', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.email}</span>
                <input
                  type="email"
                  value={manual.email}
                  maxLength={320}
                  required
                  onChange={(event) => updateManual('email', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.phone}</span>
                <input
                  type="tel"
                  value={manual.phone}
                  maxLength={80}
                  onChange={(event) => updateManual('phone', event.target.value)}
                />
              </label>
              <label>
                <span>Instagram</span>
                <input
                  value={manual.instagram}
                  maxLength={80}
                  onChange={(event) => updateManual('instagram', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.preferredContact}</span>
                <select
                  value={manual.preferredContact}
                  onChange={(event) => updateManual(
                    'preferredContact',
                    event.target.value as ManualForm['preferredContact']
                  )}
                >
                  <option value="">{copy.notSpecified}</option>
                  <option value="Email">{copy.email}</option>
                  <option value="WhatsApp">WhatsApp</option>
                  <option value="Instagram">Instagram</option>
                </select>
              </label>
              <label>
                <span>{copy.travellingFrom}</span>
                <input
                  value={manual.travellingFrom}
                  maxLength={160}
                  onChange={(event) => updateManual('travellingFrom', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.projectType}</span>
                <input
                  value={manual.projectType}
                  maxLength={100}
                  onChange={(event) => updateManual('projectType', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.placement}</span>
                <input
                  value={manual.placement}
                  maxLength={160}
                  onChange={(event) => updateManual('placement', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.size}</span>
                <input
                  value={manual.approximateSize}
                  maxLength={120}
                  onChange={(event) => updateManual('approximateSize', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.coverUp}</span>
                <input
                  value={manual.coverUp}
                  maxLength={40}
                  onChange={(event) => updateManual('coverUp', event.target.value)}
                />
              </label>
              <label>
                <span>{copy.timing}</span>
                <input
                  value={manual.preferredTiming}
                  maxLength={160}
                  onChange={(event) => updateManual('preferredTiming', event.target.value)}
                />
              </label>
            </div>
            <label>
              <span>{copy.idea}</span>
              <textarea
                value={manual.idea}
                maxLength={4000}
                onChange={(event) => updateManual('idea', event.target.value)}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={manual.privacyAcknowledged}
                onChange={(event) => updateManual('privacyAcknowledged', event.target.checked)}
              />
              <span>{copy.privacyConfirmation}</span>
            </label>
            {manualError ? <p className="notice warn" role="alert">{manualError}</p> : null}
            {manualSuccess ? <p className="notice ok" role="status">{manualSuccess}</p> : null}
            <div className="actions">
              <button type="submit" disabled={manualSaving || !selectedArtistId}>
                {manualSaving ? copy.saving : copy.create}
              </button>
            </div>
          </form>
        </details>
      ) : null}

      {/* One compact toolbar: on a phone the list starts right below it
          instead of after half a screen of labelled fields. The labels stay
          for assistive technology. */}
      <div className="card enquiry-toolbar-card">
        <div className="enquiry-toolbar">
          <div className="enquiry-view-toggle" role="group" aria-label={t('enquiries.viewLabel')}>
            <button
              type="button"
              aria-pressed={view === 'list'}
              className={view === 'list' ? 'active' : ''}
              onClick={() => changeView('list')}
            >
              {t('enquiries.viewList')}
            </button>
            <button
              type="button"
              aria-pressed={view === 'board'}
              className={view === 'board' ? 'active' : ''}
              onClick={() => changeView('board')}
            >
              {t('enquiries.viewBoard')}
            </button>
          </div>
          {view === 'list' ? (
            <div className="toolbar-status">
              <label htmlFor="enquiry-status" className="visually-hidden">{t('enquiries.status')}</label>
              <select
                id="enquiry-status" value={status}
                onChange={(event) => setStatus(event.target.value as '' | EnquiryStatus)}
              >
                {FILTERS.map((filter) => (
                  <option key={filter || 'all'} value={filter}>
                    {filter ? label('enquiryStatus', filter) : t('enquiries.all')}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="toolbar-search">
            <label htmlFor="enquiry-search" className="visually-hidden">{t('enquiries.searchByReference')}</label>
            <input
              id="enquiry-search" type="search" inputMode="search"
              placeholder={t('enquiries.searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        {view === 'board' ? (
          <p className="meta enquiry-board-scope" style={{ margin: '8px 0 0' }}>{t('enquiries.boardActiveOnly')}</p>
        ) : null}
      </div>

      {loading && !data ? <LoadingState label={t('enquiries.loading')} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {moveError ? <p className="notice warn" role="alert">{moveError}</p> : null}

      {!error && data && data.enquiries.length === 0 ? (
        <EmptyState
          title={t('enquiries.noMatch')}
          hint={t('enquiries.noMatchHint')}
        />
      ) : null}

      {!error && data && data.enquiries.length > 0 && view === 'board' ? (
        <EnquiryBoard
          enquiries={data.enquiries}
          clientNames={data.clientNames}
          transitions={data.transitions}
          role={profile?.role}
          movingEnquiryId={movingEnquiryId}
          onMove={moveEnquiry}
        />
      ) : null}

      {!error && data && data.enquiries.length > 0 && view === 'list' ? (
        <div className="list">
          {data.enquiries.map((enquiry) => (
            <Link key={enquiry.id} to={`/enquiries/${enquiry.id}`} className="row">
              <div className="title">
                {data.clientNames.get(enquiry.client_id) ?? enquiry.reference_number}
              </div>
              <div className="meta">
                <span className="badge">{label('enquiryStatus', enquiry.status)}</span>{' '}
                {enquiry.assigned_to ? null : <span className="badge warn">{t('common.unassigned')}</span>}{' '}
                {enquiryHeadline(enquiry) ?? t('enquiries.projectTypeMissing')} · {formatDateTime(enquiry.last_action_at, language)}
              </div>
              <div className="meta">{enquiry.reference_number}</div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

const MANUAL_COPY: Record<Language, Record<string, string>> = {
  en: {
    newManual: 'New manual enquiry',
    intro: 'Create an enquiry entered directly by staff. This does not send Telegram, email or Calendar work and does not claim a public booking source.',
    chooseArtist: 'Choose one artist in the CRM artist selector before creating a manual enquiry.',
    required: 'Full name and a valid email address are required.',
    privacyRequired: 'Confirm that the client has acknowledged the current privacy notice before creating the enquiry.',
    fullName: 'Client full name',
    email: 'Email',
    phone: 'Phone',
    preferredContact: 'Preferred contact',
    travellingFrom: 'Travelling from',
    projectType: 'Project type',
    placement: 'Placement',
    size: 'Approximate size',
    coverUp: 'Cover-up',
    timing: 'Preferred timing',
    idea: 'Idea / brief',
    notSpecified: 'Not specified',
    privacyConfirmation: 'I confirm the client has acknowledged the current privacy notice (29 July 2026).',
    create: 'Create manual enquiry',
    saving: 'Creating…',
    failed: 'Could not create that manual enquiry.',
    created: 'Created {reference}.',
    createdConflict: 'Created {reference}. Contact identifiers matched different client records and require review.',
  },
  ru: {
    newManual: 'Новая ручная заявка',
    intro: 'Создаёт заявку, которую сотрудник вводит напрямую в CRM. Telegram, электронная почта и Календарь не задействуются, публичный источник бронирования не назначается.',
    chooseArtist: 'Перед созданием ручной заявки выберите одного мастера в переключателе мастеров CRM.',
    required: 'Обязательны имя клиента и корректный адрес электронной почты.',
    privacyRequired: 'Перед созданием подтвердите, что клиент ознакомился с актуальным уведомлением о конфиденциальности.',
    fullName: 'Имя клиента',
    email: 'Электронная почта',
    phone: 'Телефон',
    preferredContact: 'Предпочтительный контакт',
    travellingFrom: 'Откуда приезжает',
    projectType: 'Тип проекта',
    placement: 'Расположение',
    size: 'Примерный размер',
    coverUp: 'Перекрытие',
    timing: 'Желаемые сроки',
    idea: 'Идея / описание',
    notSpecified: 'Не указано',
    privacyConfirmation: 'Подтверждаю, что клиент ознакомился с актуальным уведомлением о конфиденциальности от 29 июля 2026 года.',
    create: 'Создать ручную заявку',
    saving: 'Создание…',
    failed: 'Не удалось создать ручную заявку.',
    created: 'Создана заявка {reference}.',
    createdConflict: 'Создана заявка {reference}. Контактные идентификаторы совпали с разными карточками клиентов и требуют проверки.',
  },
};
