// Staff classification of one enquiry image: what it shows and which body
// areas it concerns. Both are optional; nothing here is asked of the client
// and nothing touches Storage or the stored image analysis.

import { useState } from 'react';
import { can } from '../lib/permissions';
import type { Language } from '../lib/i18n';
import type { RecordEditApi } from '../lib/record-edit-api';
import { V2_REGIONS } from '../lib/enquiry-v2-catalogue';
import type { CrmRole, EnquiryFile } from '../lib/types';
import { catalogueLabel } from './EnquiryProjectDetails';

const COPY = {
  en: { category: 'Category', none: 'Not set', design: 'Design reference', existing: 'Existing tattoo', areas: 'Body areas', edit: 'Classify', save: 'Save', cancel: 'Cancel', failed: 'Could not save the image category.' },
  ru: { category: 'Категория', none: 'Не указана', design: 'Референс дизайна', existing: 'Существующая татуировка', areas: 'Зоны тела', edit: 'Классифицировать', save: 'Сохранить', cancel: 'Отмена', failed: 'Не удалось сохранить категорию изображения.' },
} as const;

export function describeFileClassification(file: Pick<EnquiryFile, 'intake_role' | 'body_areas'>, language: Language): string {
  const copy = COPY[language] ?? COPY.en;
  const role = file.intake_role === 'design_reference' ? copy.design : file.intake_role === 'existing_tattoo' ? copy.existing : null;
  const areas = (file.body_areas ?? [])
    .map((key) => V2_REGIONS.find((region) => region.key === key)?.label)
    .filter((label): label is string => Boolean(label))
    .map((label) => catalogueLabel(label, language));
  return [role, areas.join(', ')].filter(Boolean).join(' / ');
}

export function EnquiryFileClassification({
  file,
  role,
  api,
  language,
  suggestedAreas,
  onSaved,
}: {
  file: EnquiryFile;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'setEnquiryFileClassification'>;
  language: Language;
  /** Region keys from the enquiry's project, offered first. */
  suggestedAreas: string[];
  onSaved: () => void;
}) {
  const copy = COPY[language] ?? COPY.en;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intakeRole, setIntakeRole] = useState<EnquiryFile['intake_role']>(file.intake_role ?? null);
  const [areas, setAreas] = useState<string[]>(file.body_areas ?? []);
  const description = describeFileClassification(file, language);
  const mayEdit = can(role, 'manageEnquiryFiles');

  if (!editing) {
    return (
      <div className="meta" data-testid={`file-classification-${file.id}`} style={{ fontSize: '0.75rem' }}>
        {description || null}
        {mayEdit ? (
          <button type="button" className="link" style={{ marginLeft: description ? 6 : 0 }} onClick={() => {
            setIntakeRole(file.intake_role ?? null);
            setAreas(file.body_areas ?? []);
            setError(null);
            setEditing(true);
          }}>{copy.edit}</button>
        ) : null}
      </div>
    );
  }

  const ordered = [
    ...V2_REGIONS.filter((region) => suggestedAreas.includes(region.key)),
    ...V2_REGIONS.filter((region) => !suggestedAreas.includes(region.key)),
  ];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.setEnquiryFileClassification(file.id, intakeRole, areas);
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`file-classification-edit-${file.id}`} style={{ fontSize: '0.8rem' }}>
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      <label>
        {copy.category}
        <select
          value={intakeRole ?? ''}
          onChange={(event) => setIntakeRole((event.target.value || null) as EnquiryFile['intake_role'])}
        >
          <option value="">{copy.none}</option>
          <option value="design_reference">{copy.design}</option>
          <option value="existing_tattoo">{copy.existing}</option>
        </select>
      </label>
      <div role="group" aria-label={copy.areas}>
        <div className="meta">{copy.areas}</div>
        {ordered.map((region) => (
          <label key={region.key} style={{ display: 'inline-flex', gap: 4, marginRight: 10 }}>
            <input
              type="checkbox"
              checked={areas.includes(region.key)}
              onChange={() => setAreas(areas.includes(region.key)
                ? areas.filter((key) => key !== region.key)
                : [...areas, region.key])}
            />
            {catalogueLabel(region.label, language)}
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => { void save(); }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>{copy.cancel}</button>
      </div>
    </div>
  );
}
