import { useState } from 'react';
import type { AiIntakeApi, AiReplyDraft } from '../lib/ai-intake-api';
import type { Language } from '../lib/i18n';

/** Save changes only. Approval remains a separate existing operator action. */
export function EmailDraftEditor({ draft, api, language, onEditingChange, onSaved }: {
  draft: AiReplyDraft;
  api: AiIntakeApi;
  language: Language;
  onEditingChange?: (editing: boolean) => void;
  onSaved?: () => void;
}) {
  const copy = COPY[language];
  const [saved, setSaved] = useState(draft);
  const [body, setBody] = useState(draft.body);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(false);
  function toggle(value: boolean) {
    setEditing(value);
    onEditingChange?.(value);
  }
  async function save() {
    setBusy(true);
    setFailed(false);
    try {
      const next = await api.editEmailDraft(saved, body);
      setSaved(next);
      setBody(next.body);
      toggle(false);
      setNotice(true);
      onSaved?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {editing ? (
        <>
          <label htmlFor={`draft-${draft.id}`}>{copy.body}</label>
          <textarea id={`draft-${draft.id}`} rows={9} maxLength={12000} value={body}
            disabled={busy} onChange={(event) => setBody(event.target.value)} />
          <div className="actions">
            <button type="button" disabled={busy || !body.trim() || body === saved.body}
              onClick={() => { void save(); }}>{busy ? copy.saving : copy.save}</button>
            <button type="button" disabled={busy} onClick={() => {
              setBody(saved.body); setFailed(false); toggle(false);
            }}>{copy.cancel}</button>
          </div>
          {failed ? <p className="notice warn" role="alert">{copy.failed}</p> : null}
        </>
      ) : (
        <>
          <pre className="email-body">{saved.body}</pre>
          {saved.status === 'draft' && saved.updated_at ? (
            <button type="button" onClick={() => { setNotice(false); toggle(true); }}>{copy.edit}</button>
          ) : null}
        </>
      )}
      {notice ? <p className="notice ok" role="status">{copy.saved}</p> : null}
    </div>
  );
}

const COPY = {
  en: {
    body: 'Reply draft', edit: 'Edit draft', save: 'Save draft', saving: 'Saving…', cancel: 'Cancel editing',
    saved: 'Draft saved. Nothing has been sent.',
    failed: 'Could not save. The draft may have changed or been approved elsewhere. Your text is still here; copy it before refreshing.',
  },
  ru: {
    body: 'Черновик ответа', edit: 'Изменить черновик', save: 'Сохранить черновик', saving: 'Сохраняем…', cancel: 'Отменить изменения',
    saved: 'Черновик сохранён. Ничего не отправлено.',
    failed: 'Не удалось сохранить. Возможно, черновик уже изменили или утвердили. Твой текст остался здесь, скопируй его перед обновлением.',
  },
} as const;
