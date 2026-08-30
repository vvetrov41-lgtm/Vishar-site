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
}: {
  enquiry: Enquiry;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'updateEnquiryDetails' | 'archiveEnquiry'>;
  language: 'en' | 'ru';
  onSaved: () => void;
}) {
  const { navigate } = useRouter();
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
    edit: 'Редактировать заявку',
    delete: 'Удалить заявку',
    save: 'Сохранить',
    cancel: 'Отмена',
    type: 'Тип',
    placement: 'Расположение',
    size: 'Размер',
    cover: 'Перекрытие',
    timing: 'Сроки',
    idea: 'Описание проекта',
    failed: 'Не удалось сохранить изменения заявки.',
    deleteFailed: 'Не удалось удалить заявку.',
  } : {
    edit: 'Edit enquiry',
    delete: 'Delete enquiry',
    save: 'Save',
    cancel: 'Cancel',
    type: 'Type',
    placement: 'Placement',
    size: 'Size',
    cover: 'Cover-up',
    timing: 'Timing',
    idea: 'Project description',
    failed: 'Could not save the enquiry changes.',
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

  if (!editing) {
    return (
      <>
        {error ? <div className="notice warn" role="alert" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>{copy.edit}</button>
          {role === 'owner' ? (
            <button type="button" className="danger" disabled={busy} onClick={() => { void archive(); }}>
              {copy.delete}
            </button>
          ) : null}
        </div>
      </>
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
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
      <div className="form-grid">
        <label>{copy.type}<input value={projectType} maxLength={100} onChange={(event) => setProjectType(event.target.value)} /></label>
        <label>{copy.placement}<input value={placement} maxLength={160} onChange={(event) => setPlacement(event.target.value)} /></label>
        <label>{copy.size}<input value={approximateSize} maxLength={120} onChange={(event) => setApproximateSize(event.target.value)} /></label>
        <label>{copy.cover}<input value={coverUp} maxLength={40} onChange={(event) => setCoverUp(event.target.value)} /></label>
        <label>{copy.timing}<input value={preferredTiming} maxLength={160} onChange={(event) => setPreferredTiming(event.target.value)} /></label>
      </div>
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
