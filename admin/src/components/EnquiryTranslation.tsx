// "Перевести на русский": a machine translation of the client's message, on
// request only. The original stays above it, untouched and always visible;
// the translation is labelled as a machine translation and can be hidden.
// Nothing here runs on page load, and a failure is shown here only.

import { useState } from 'react';
import type { AiIntakeApi, EnquiryTranslation as Translation } from '../lib/ai-intake-api';

const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 16;

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
    try {
      let current = await api.requestEnquiryTranslation(enquiryId);
      if ((current.status === 'pending' || current.status === 'processing') && current.job_id) {
        // The Worker reports only a status; the text is read back under the
        // artist's own session.
        await api.runEnquiryTranslation(current.job_id).catch(() => undefined);
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
          current = await api.getEnquiryTranslation(enquiryId);
          if (current.status !== 'pending' && current.status !== 'processing') break;
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
          <p lang="ru" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{text}</p>
        </div>
      ) : null}
    </div>
  );
}
