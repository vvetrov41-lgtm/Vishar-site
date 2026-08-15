import { useRef, useState } from 'react';
import { can } from '../lib/permissions';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { CrmRole, EnquiryFile } from '../lib/types';

export function EnquiryReferenceActions({
  enquiryId,
  files,
  role,
  api,
  language,
  onChanged,
}: {
  enquiryId: string;
  files: EnquiryFile[];
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'addEnquiryReference' | 'finalizeEnquiryReference'>;
  language: 'en' | 'ru';
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAdd = can(role, 'manageEnquiryFiles') && files.length < 3;

  const copy = language === 'ru' ? {
    add: 'Добавить референсы',
    retry: 'Завершить загрузку',
    hint: 'До 3 изображений, JPG/PNG/WebP, максимум 4 MB каждое.',
    failed: 'Не удалось изменить референсы.',
  } : {
    add: 'Add references',
    retry: 'Finish upload',
    hint: 'Up to 3 images, JPG/PNG/WebP, maximum 4 MB each.',
    failed: 'Could not change the reference images.',
  };

  if (!can(role, 'manageEnquiryFiles')) return null;

  async function add(filesToAdd: FileList | null) {
    if (!filesToAdd || filesToAdd.length === 0) return;
    const remaining = Math.max(0, 3 - files.length);
    const selected = Array.from(filesToAdd).slice(0, remaining);
    setBusy(true);
    setError(null);
    try {
      for (const file of selected) await api.addEnquiryReference(enquiryId, file);
      if (inputRef.current) inputRef.current.value = '';
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function finish(fileId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.finalizeEnquiryReference(fileId);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      {canAdd ? (
        <>
          <input
            ref={inputRef}
            id="enquiry-reference-upload"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(event) => { void add(event.target.files); }}
          />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>{copy.add}</button>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 0 }}>{copy.hint}</p>
        </>
      ) : null}

      {files.some((file) => file.upload_state !== 'ready') ? (
        <div className="list" style={{ marginTop: 12 }}>
          {files.filter((file) => file.upload_state !== 'ready').map((file) => (
            <div className="row" key={file.id}>
              <div className="title">{file.original_filename ?? `Reference ${file.ordinal + 1}`}</div>
              <div className="meta">
                <button type="button" disabled={busy} onClick={() => { void finish(file.id); }}>{copy.retry}</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
