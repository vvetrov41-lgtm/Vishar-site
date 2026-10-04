import { useCallback, useEffect, useState } from 'react';
import type { ConversationAttention } from '../lib/communications-api';
import { formatDateTime } from '../lib/format';

type StateApi = {
  getConversationAttention(conversationId: string): Promise<ConversationAttention | null>;
  setNotCrm(conversationId: string, notCrm: boolean): Promise<unknown>;
  setHandledOutsideCrm(attention: ConversationAttention, handled: boolean): Promise<unknown>;
};

const COPY = {
  en: {
    title: 'Does this need you?',
    waiting: (at: string) => `Waiting on the studio since ${at}.`,
    nothing: 'Nothing here waits on the studio.',
    handled: (at: string) => `Marked handled outside the CRM (${at}). A new message brings it back.`,
    notCrm: 'Marked personal / not CRM work. New messages from this sender stay hidden until you clear it.',
    markHandled: 'Handled outside the CRM',
    undoHandled: 'Undo handled',
    markNotCrm: 'Personal / not CRM',
    clearNotCrm: 'Not personal after all',
    failed: 'Could not save that.',
  },
  ru: {
    title: 'Нужно ли ваше действие?',
    waiting: (at: string) => `Ждёт ответа студии с ${at}.`,
    nothing: 'Здесь никто не ждёт ответа студии.',
    handled: (at: string) => `Отмечено: обработано вне CRM (${at}). Новое сообщение вернёт диалог в работу.`,
    notCrm: 'Отмечено как личное, не работа CRM. Новые сообщения этого отправителя скрыты, пока вы не снимете отметку.',
    markHandled: 'Обработано вне CRM',
    undoHandled: 'Отменить «обработано»',
    markNotCrm: 'Личное / не CRM',
    clearNotCrm: 'Снять отметку «личное»',
    failed: 'Не удалось сохранить.',
  },
} as const;

/**
 * The two operator states a conversation can carry, neither of which deletes
 * anything (20261004180000):
 *   * handled outside the CRM covers the exact client message on screen; a
 *     newer real message returns the conversation to Today;
 *   * personal / not CRM applies only while no client is linked.
 */
export function ConversationOperatorState({
  conversationId,
  linked,
  mayAct,
  api,
  language,
  onChange,
}: {
  conversationId: string;
  linked: boolean;
  mayAct: boolean;
  api: StateApi;
  language: 'en' | 'ru';
  onChange?: () => void;
}) {
  const copy = COPY[language];
  const [state, setState] = useState<ConversationAttention | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.getConversationAttention(conversationId).then(setState), [api, conversationId]);
  useEffect(() => {
    let live = true;
    api.getConversationAttention(conversationId)
      .then((value) => { if (live) setState(value); })
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [api, conversationId, linked]);

  if (!state) return null;
  const current = state;
  const notCrmApplies = Boolean(current.not_crm_at) && !linked;

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChange?.();
    } catch {
      setError(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  let summary: string;
  if (notCrmApplies) summary = copy.notCrm;
  else if (current.handled_outside_crm_at) summary = copy.handled(formatDateTime(current.handled_outside_crm_at, language));
  else if (current.needs_reply && current.awaiting_reply_since) summary = copy.waiting(formatDateTime(current.awaiting_reply_since, language));
  else summary = copy.nothing;

  return (
    <section className="card conversation-operator-state">
      <h3>{copy.title}</h3>
      <p className="notice">{summary}</p>
      {mayAct ? (
        <div className="actions">
          {current.handled_outside_crm_at ? (
            <button type="button" disabled={busy} onClick={() => { void act(() => api.setHandledOutsideCrm(current, false)); }}>
              {copy.undoHandled}
            </button>
          ) : current.needs_reply ? (
            <button type="button" disabled={busy} onClick={() => { void act(() => api.setHandledOutsideCrm(current, true)); }}>
              {copy.markHandled}
            </button>
          ) : null}
          {!linked ? (
            <button type="button" disabled={busy} onClick={() => { void act(() => api.setNotCrm(conversationId, !current.not_crm_at)); }}>
              {current.not_crm_at ? copy.clearNotCrm : copy.markNotCrm}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  );
}
