import { useRef, useState, type FormEvent } from 'react';
import type { ProjectOperationsApi } from '../lib/project-operations-api';
import { useRouter } from '../lib/router';

export function ClientProjectCreatePanel({
  clientId, artistId, language, api,
}: {
  clientId: string;
  artistId: string | null;
  language: 'en' | 'ru';
  api: Pick<ProjectOperationsApi, 'createClientProject'>;
}) {
  const { navigate } = useRouter();
  const requestId = useRef<string>(crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ru = language === 'ru';

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !artistId || title.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createClientProject({
        requestId: requestId.current,
        clientId,
        artistId,
        title,
        description,
      });
      // A successful response always resolves to the server's authoritative
      // project id. It may be a replay after a previous network timeout.
      navigate(`/projects/${result.project_id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (
        ru ? 'Не удалось сохранить проект. Попробуй ещё раз.' : 'Could not save the project. Try again.'
      ));
      // Keep requestId stable. Repeating a request after a lost response
      // cannot create another project or change the first one's contents.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label={ru ? 'Новый проект клиента' : 'New client project'}>
      <button type="button" onClick={() => setOpen((value) => !value)} disabled={busy}>
        {ru ? 'Новый проект' : 'New project'}
      </button>
      {open ? (
        <form onSubmit={(event) => { void save(event); }} style={{ marginTop: 12 }}>
          <p className="meta" style={{ marginTop: 0 }}>
            {ru ? 'Проект для существующего клиента, без новой заявки.' : 'Start a project for this client without creating an enquiry.'}
          </p>
          {!artistId ? (
            <p className="notice warn" role="status">
              {ru ? 'Сначала выбери мастера в фильтре сверху.' : 'Choose an artist in the selector above first.'}
            </p>
          ) : null}
          <label>
            {ru ? 'Название проекта' : 'Project title'}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              minLength={2}
              maxLength={160}
              required
              disabled={busy}
              autoComplete="off"
              placeholder={ru ? 'Например: рукав с вороном' : 'For example: raven sleeve'}
            />
          </label>
          <label>
            {ru ? 'Описание' : 'Description'}
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
              rows={3}
              disabled={busy}
            />
          </label>
          {error ? <p className="notice warn" role="alert">{error}</p> : null}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !artistId || title.trim().length < 2}>
              {busy ? (ru ? 'Сохраняю…' : 'Saving…') : (ru ? 'Создать проект' : 'Create project')}
            </button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
              {ru ? 'Закрыть' : 'Close'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
