import { useState } from 'react';
import { can } from '../lib/permissions';
import type { RecordEditApi } from '../lib/record-edit-api';
import { useRouter } from '../lib/router';
import type { CrmRole, Enquiry } from '../lib/types';

function value(value: string | null | undefined) {
  return value ?? '';
}

export function EnquiryEditPanel({
  enquiry,
  role,
  api,
  language,
  onSaved,
  mode = 'all',
}: {
  enquiry: Enquiry;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'updateEnquiryDetails' | 'updateEnquiryIdea'>;
  language: 'en' | 'ru';
  onSaved: () => void;
  /**
   * 'idea' for booking form v2 enquiries: their type, placement, size,
   * cover-up and timing are edited in EnquiryStructuredEditPanel, so only the
   * description is offered and sent here.
   */
  mode?: 'all' | 'idea';
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectType, setProjectType] = useState(value(enquiry.project_type));
  const [placement, setPlacement] = useState(value(enquiry.placement));
  const [approximateSize, setApproximateSize] = useState(value(enquiry.approximate_size));
  const [coverUp, setCoverUp] = useState(value(enquiry.cover_up));
  const [preferredTiming, setPreferredTiming] = useState(value(enquiry.preferred_timing));
  const [idea, setIdea] = useState(value(enquiry.idea));

  if (!can(role, 'editEnquiry')) return null;

  const copy = language === 'ru' ? {
    edit: mode === 'idea' ? 'Редактировать описание' : 'Редактировать заявку',
    save: 'Сохранить',
    cancel: 'Отмена',
    type: 'Тип',
    placement: 'Расположение',
    size: 'Размер',
    cover: 'Перекрытие',
    timing: 'Сроки',
    idea: 'Описание проекта',
    failed: 'Не удалось сохранить изменения заявки.',
  } : {
    edit: mode === 'idea' ? 'Edit description' : 'Edit enquiry',
    save: 'Save',
    cancel: 'Cancel',
    type: 'Type',
    placement: 'Placement',
    size: 'Size',
    cover: 'Cover-up',
    timing: 'Timing',
    idea: 'Project description',
    failed: 'Could not save the enquiry changes.',
  };

  if (!editing) {
    return (
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => { setIdea(value(enquiry.idea)); setEditing(true); }}>{copy.edit}</button>
      </div>
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'idea') {
        await api.updateEnquiryIdea(enquiry.id, idea);
        setEditing(false);
        onSaved();
        return;
      }
      await api.updateEnquiryDetails(enquiry.id, {
        projectType,
        placement,
        approximateSize,
        coverUp,
        preferredTiming,
        idea,
      });
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      {mode === 'all' ? <div className="form-grid">
        <label>{copy.type}<input value={projectType} maxLength={100} onChange={(event) => setProjectType(event.target.value)} /></label>
        <label>{copy.placement}<input value={placement} maxLength={160} onChange={(event) => setPlacement(event.target.value)} /></label>
        <label>{copy.size}<input value={approximateSize} maxLength={120} onChange={(event) => setApproximateSize(event.target.value)} /></label>
        <label>{copy.cover}<input value={coverUp} maxLength={40} onChange={(event) => setCoverUp(event.target.value)} /></label>
        <label>{copy.timing}<input value={preferredTiming} maxLength={160} onChange={(event) => setPreferredTiming(event.target.value)} /></label>
      </div> : null}
      <label>
        {copy.idea}
        <textarea value={idea} maxLength={4000} onChange={(event) => setIdea(event.target.value)} />
      </label>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => { void save(); }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={() => { setError(null); setEditing(false); }}>{copy.cancel}</button>
      </div>
    </div>
  );
}

/**
 * Deleting an enquiry is administration, not editing. It sits with status,
 * assignment and conversion behind the admin disclosure, so a thumb aiming at
 * "Edit enquiry" in the middle of the page cannot land on it.
 */
export function EnquiryArchiveAction({
  enquiry,
  role,
  api,
  language,
}: {
  enquiry: Enquiry;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'archiveEnquiry'>;
  language: 'en' | 'ru';
}) {
  const { navigate } = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can(role, 'editEnquiry')) return null;

  const copy = language === 'ru' ? {
    title: 'Удаление',
    delete: 'Удалить заявку',
    deleteConfirm: 'Удалить эту заявку из рабочих списков? История сохранится для аудита. Если у заявки есть активный проект или запись, удаление будет заблокировано.',
    deleteConfirmAction: 'Да, удалить заявку',
    cancel: 'Отмена',
    deleteFailed: 'Не удалось удалить заявку.',
  } : {
    title: 'Delete',
    delete: 'Delete enquiry',
    deleteConfirm: 'Delete this enquiry from working lists? Its history is retained for audit. If it has an active project or appointment, deletion will be blocked.',
    deleteConfirmAction: 'Yes, delete enquiry',
    cancel: 'Cancel',
    deleteFailed: 'Could not delete the enquiry.',
  };

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.archiveEnquiry(enquiry.id);
      if (result) navigate('/enquiries');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.deleteFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>{copy.title}</h3>
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      {confirming ? (
        <div className="notice warn" role="alert">
          <p style={{ marginTop: 0 }}>{copy.deleteConfirm}</p>
          <div className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => { void archive(); }}>
              {copy.deleteConfirmAction}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</button>
          </div>
        </div>
      ) : (
        <div className="actions" style={{ marginTop: 0 }}>
          <button type="button" className="danger" onClick={() => { setError(null); setConfirming(true); }}>
            {copy.delete}
          </button>
        </div>
      )}
    </div>
  );
}
