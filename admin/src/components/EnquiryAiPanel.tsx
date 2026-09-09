import { Fragment, useEffect, useState } from 'react';
import { AI_FIELD_NAMES, type AiFieldName, type AiIntakeApi } from '../lib/ai-intake-api';
import type { Language } from '../lib/i18n';
import { Link } from '../lib/router';
import { useAsync } from './AsyncData';
import { EmailDraftEditor } from './EmailDraftEditor';
import { Section } from './StateViews';

export function EnquiryAiPanel({ enquiryId, api, language, mayEdit }: {
  enquiryId: string; api: AiIntakeApi; language: Language; mayEdit: boolean;
}) {
  const copy = COPY[language];
  const { data, loading, error, reload } = useAsync(() => api.getEnquiryAiResult(enquiryId), [api, enquiryId]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Poll only durable pending work, never a succeeded draft someone is editing.
  useEffect(() => {
    if (!data?.enabled || !['pending', 'processing'].includes(data.status)) return;
    const timer = window.setTimeout(reload, 8000);
    return () => window.clearTimeout(timer);
  }, [data, reload]);
  async function retry() {
    setBusy(true); setFailed(false);
    try { await api.retryEnquiryAi(enquiryId); reload(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  // A disabled rollout adds no empty panel to every historical enquiry.
  if (data && !data.enabled && data.status === 'not_requested') return null;
  const result = data?.result;
  const draft = data?.draft;
  const passiveStatus = data?.enabled && !result && !error && ['pending', 'processing'].includes(data.status)
    ? data.status as 'pending' | 'processing'
    : null;
  // Passive background work should remain visible without taking the space of
  // an actionable assistant result. Polling and the live status announcement
  // remain unchanged; failed/stale/results still use the full panel below.
  if (passiveStatus) {
    return (
      <section className="card" data-compact-enquiry-ai="true" style={{ padding: '12px 16px' }}>
        <h2 style={{ margin: '0 0 4px' }}>{copy.title}</h2>
        <p className="meta" role="status" style={{ margin: 0 }}>{copy.states[passiveStatus]}</p>
      </section>
    );
  }
  return (
    <Section title={copy.title}>
      {loading && !data ? <p className="meta" role="status">{copy.loading}</p> : null}
      {error ? (
        <div className="notice warn" role="status">
          <p>{copy.unavailable}</p><button type="button" onClick={reload}>{copy.refresh}</button>
        </div>
      ) : data ? (
        <>
          <p className="meta" role="status">{copy.states[data.status]}</p>
          {result ? (
            <>
              <p>{result.summary}</p>
              <p className="meta">{copy.suggestions}</p>
              <details>
                <summary>{copy.fields}</summary>
                <dl className="definition">
                  {AI_FIELD_NAMES.map((name) => {
                    const field = result.fields[name];
                    return (
                      <Fragment key={name}>
                        <dt>{copy.fieldNames[name]}</dt>
                        <dd>
                          {field.value === null ? copy.notProvided : typeof field.value === 'boolean'
                            ? field.value ? copy.yes : copy.no : field.value}
                          {' '}<span className="badge">{copy.provenance[field.status]}</span>
                        </dd>
                      </Fragment>
                    );
                  })}
                </dl>
              </details>
              <h3>{copy.missing}</h3>
              {result.missing_information.length ? (
                <ul>{result.missing_information.map((name: AiFieldName) => <li key={name}>{copy.fieldNames[name]}</li>)}</ul>
              ) : <p className="meta">{copy.noMissing}</p>}
              <h3>{copy.draft}</h3>
              <p className="meta">{copy.draftHint}</p>
              {draft ? (
                <>
                  {mayEdit && draft.status === 'draft' ? (
                    <EmailDraftEditor key={`${draft.id}-${draft.updated_at}`} draft={draft} api={api} language={language} />
                  ) : <pre className="email-body">{draft.body}</pre>}
                  <div className="actions">
                    <Link to={`/inbox/email/enquiry-${enquiryId}`} className="action-link">{copy.openDraft}</Link>
                  </div>
                </>
              ) : (
                <>
                  <pre className="email-body">{result.draft_reply}</pre>
                  <p className="meta">{copy.unsavedDraft}</p>
                </>
              )}
            </>
          ) : null}
          {mayEdit && data.enabled && ['not_requested', 'failed', 'stale'].includes(data.status) ? (
            <button type="button" disabled={busy} onClick={() => { void retry(); }}>{busy ? copy.queuing : copy.retry}</button>
          ) : null}
          {failed ? <p className="notice warn" role="alert">{copy.retryFailed}</p> : null}
        </>
      ) : null}
    </Section>
  );
}

const COPY = {
  en: {
    title: 'Enquiry assistant', loading: 'Loading the analysis…',
    unavailable: 'The analysis is unavailable. Your saved enquiry is still available.', refresh: 'Reload analysis',
    suggestions: 'AI suggestions below are separate from the saved enquiry fields. Check inferred details with the client.',
    fields: 'Extracted details', missing: 'Still needed', noMissing: 'No missing details identified. Review before replying.',
    draft: 'Suggested reply', draftHint: 'Review and edit before sending. Dates, prices and bookings still need your approval.',
    openDraft: 'Open email draft', unsavedDraft: 'Reply suggestion only. No email draft has been saved.',
    retry: 'Analyse enquiry', queuing: 'Queuing…', retryFailed: 'Could not queue analysis. Your enquiry has not changed.',
    yes: 'Yes', no: 'No', notProvided: 'Not provided',
    provenance: { explicit: 'Stated by client', inferred: 'Inferred', missing: 'Missing' },
    states: { not_requested: 'Not analysed yet.', pending: 'Waiting for analysis. You can keep working on this enquiry.',
      processing: 'Analysing the enquiry…', succeeded: 'Analysis ready. Nothing has been sent.',
      failed: 'Analysis could not finish. The original enquiry is saved.', stale: 'The enquiry changed during analysis. Run it again to use the latest details.' },
    fieldNames: {
      client_name: 'Client name', email: 'Email', phone: 'Phone', project_description: 'Project description',
      concept: 'Subject / concept', placement: 'Placement', style: 'Style', approximate_size: 'Approximate size',
      colour: 'Colour / black and grey', cover_up: 'Cover-up', budget: 'Budget', preferred_dates: 'Dates / availability',
      reference_images_present: 'Reference images attached', discovery_source: 'Discovery source',
      discovery_source_detail: 'Discovery details', notes: 'Notes',
    },
  },
  ru: {
    title: 'Помощник по заявке', loading: 'Загружаем разбор…',
    unavailable: 'Разбор сейчас недоступен. Сохранённая заявка доступна.', refresh: 'Обновить разбор',
    suggestions: 'Ниже предложения AI, отдельно от сохранённых полей заявки. Предположения нужно уточнить у клиента.',
    fields: 'Детали заявки', missing: 'Что ещё уточнить', noMissing: 'Пропуски не найдены. Проверь детали перед ответом.',
    draft: 'Предложенный ответ', draftHint: 'Проверь и поправь текст перед отправкой. Даты, стоимость и запись требуют твоего решения.',
    openDraft: 'Открыть черновик письма', unsavedDraft: 'Это предложенный текст. Черновик письма не сохранён.',
    retry: 'Разобрать заявку', queuing: 'Добавляем в очередь…', retryFailed: 'Не удалось запустить разбор. Заявка не изменилась.',
    yes: 'Да', no: 'Нет', notProvided: 'Не указано',
    provenance: { explicit: 'Указал клиент', inferred: 'Предположение', missing: 'Не указано' },
    states: { not_requested: 'Разбора пока нет.', pending: 'В очереди на разбор. Можно продолжать работу с заявкой.',
      processing: 'Разбираем заявку…', succeeded: 'Разбор готов. Ничего не отправлено.',
      failed: 'Не удалось завершить разбор. Исходная заявка сохранена.', stale: 'Заявка изменилась во время разбора. Запусти его снова с новыми данными.' },
    fieldNames: {
      client_name: 'Имя клиента', email: 'Email', phone: 'Телефон', project_description: 'Описание проекта',
      concept: 'Сюжет / идея', placement: 'Место', style: 'Стиль', approximate_size: 'Примерный размер',
      colour: 'Цвет / чёрно-серый', cover_up: 'Перекрытие', budget: 'Бюджет', preferred_dates: 'Даты / доступность',
      reference_images_present: 'Референсы приложены', discovery_source: 'Откуда узнал',
      discovery_source_detail: 'Уточнение источника', notes: 'Примечания',
    },
  },
} as const;
