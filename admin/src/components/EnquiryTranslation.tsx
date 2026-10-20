// "Перевести на русский": a machine translation of the client's message, on
// request only. The original stays above it, untouched and always visible;
// the translation is labelled as a machine translation and can be hidden.
// Nothing here runs on page load, and a failure is shown here only.
//
// Every request is bounded: in-app browsers such as Telegram's can leave a
// request unanswered, and the button must never stay on "Translating…".

import { useState } from 'react';
import { ClientBrief } from './ClientBrief';
import type { AiIntakeApi, EnquiryTranslation as Translation } from '../lib/ai-intake-api';

const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 16;
const REQUEST_TIMEOUT_MS = 15000;
const RUN_TIMEOUT_MS = 25000;
const TOTAL_TIMEOUT_MS = 45000;

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('translation_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Api = Pick<AiIntakeApi, 'requestEnquiryTranslation' | 'getEnquiryTranslation' | 'runEnquiryTranslation'>;

export function EnquiryTranslation({
  enquiryId, api, language,
}: { enquiryId: string; api: Api; language: 'en' | 'ru' }) {
  const ru = language === 'ru';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Translation | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function translate() {
    setBusy(true);
    setError(null);
    setHidden(false);
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    try {
      let current = await withTimeout(api.requestEnquiryTranslation(enquiryId), REQUEST_TIMEOUT_MS);
      if ((current.status === 'pending' || current.status === 'processing') && current.job_id) {
        // The Worker reports only a status; the text is read back under the
        // artist's own session. A slow or lost run request still falls
        // through to polling, which sees the job finish either way.
        await withTimeout(api.runEnquiryTranslation(current.job_id), RUN_TIMEOUT_MS).catch(() => undefined);
        for (let attempt = 0; attempt < POLL_ATTEMPTS && Date.now() < deadline; attempt += 1) {
          const remaining = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
          current = await withTimeout(api.getEnquiryTranslation(enquiryId), remaining).catch(() => current);
          if (current.status !== 'pending' && current.status !== 'processing') break;
          if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
          await wait(POLL_INTERVAL_MS);
        }
      }
      setResult(current);
      if (current.status === 'failed') {
        setError(ru
          ? 'Не удалось сделать точный перевод. Оригинал выше остаётся основным текстом.'
          : 'An accurate translation could not be made. The original above is the source of truth.');
      } else if (current.status === 'pending' || current.status === 'processing') {
        setError(ru ? 'Перевод ещё готовится. Нажмите ещё раз через минуту.' : 'Still translating. Try again in a minute.');
      } else if (current.status === 'nothing_to_translate') {
        setError(ru ? 'Нет текста для перевода.' : 'There is no text to translate.');
      } else if (current.status === 'too_long') {
        setError(ru ? 'Сообщение слишком длинное для перевода.' : 'The message is too long to translate.');
      }
    } catch {
      setError(ru ? 'Перевод сейчас недоступен.' : 'Translation is unavailable right now.');
    } finally {
      setBusy(false);
    }
  }

  const text = result?.status === 'succeeded' && !hidden ? result.translation : null;

  return (
    <div className="enquiry-translation" style={{ marginTop: 8 }}>
      <div className="actions" style={{ marginTop: 0 }}>
        {text ? (
          <button type="button" className="link-button" onClick={() => setHidden(true)}>
            {ru ? 'Скрыть перевод' : 'Hide translation'}
          </button>
        ) : (
          <button type="button" className="link-button" onClick={translate} disabled={busy} aria-busy={busy}>
            {busy ? (ru ? 'Перевожу…' : 'Translating…') : (ru ? 'Перевести на русский' : 'Translate to Russian')}
          </button>
        )}
      </div>
      {error ? <p className="meta" role="status" style={{ margin: '4px 0 0' }}>{error}</p> : null}
      {text ? (
        <div style={{ marginTop: 6 }}>
          <div className="meta" style={{ fontWeight: 600 }}>
            {ru ? 'Машинный перевод — сверяйте с оригиналом' : 'Machine translation — check against the original'}
          </div>
          <ClientBrief text={text} language={language} lang="ru" />
        </div>
      ) : null}
    </div>
  );
}
