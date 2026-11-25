// Staff classification of one enquiry image: what it shows and which body
// areas it concerns. Both are optional; nothing here is asked of the client
// and nothing touches Storage or the stored image analysis.

import { useState } from 'react';
import { can } from '../lib/permissions';
import type { Language } from '../lib/i18n';
import type { RecordEditApi } from '../lib/record-edit-api';
import { BODY_ZONE_GROUPS, bodyZoneLabel } from '../lib/body-zones';
import type { CrmRole, EnquiryFile } from '../lib/types';
import { catalogueLabel } from './EnquiryProjectDetails';

const COPY = {
  en: { category: 'Category', none: 'Not set', design: 'Design reference', existing: 'Existing tattoo', areas: 'Body areas', edit: 'Classify', save: 'Save', cancel: 'Cancel', failed: 'Could not save the image category.' },
  ru: { category: 'Категория', none: 'Не указана', design: 'Референс дизайна', existing: 'Существующая татуировка', areas: 'Зоны тела', edit: 'Классифицировать', save: 'Сохранить', cancel: 'Отмена', failed: 'Не удалось сохранить категорию изображения.' },
} as const;

export function describeFileClassification(file: Pick<EnquiryFile, 'intake_role' | 'body_areas'>, language: Language): string {
  const copy = COPY[language] ?? COPY.en;
  const role = file.intake_role === 'design_reference' ? copy.design : file.intake_role === 'existing_tattoo' ? copy.existing : null;
  const areas = (file.body_areas ?? []).map(key=>bodyZoneLabel(key,language,catalogueLabel));
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

  const suggestedRegions=new Set(suggestedAreas.map(key=>key.split(':')[0]));
  const ordered = [...BODY_ZONE_GROUPS.filter(r=>suggestedRegions.has(r.key)),...BODY_ZONE_GROUPS.filter(r=>!suggestedRegions.has(r.key))];
  const toggle=(key:string)=>setAreas(current=>current.includes(key)?current.filter(k=>k!==key):[...current,key]);

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
        <p className="meta">{language==='ru'?'Выбери конкретные участки тела или оставь общую зону, если расположение пока неизвестно.':'Choose specific placements, or a general area if the exact placement is unknown.'}</p>
        {ordered.map(region=>(
          <div key={region.key} style={{borderTop:'1px solid var(--border)',padding:'8px 0'}}>
            <label style={{display:'flex',alignItems:'center',gap:8}}>
              <input type="checkbox" checked={areas.includes(region.key)} onChange={()=>toggle(region.key)} />
              {catalogueLabel(region.label,language)}
            </label>
            {region.zones.length>0?<details open={suggestedRegions.has(region.key)||areas.some(k=>k.startsWith(region.key+':'))||undefined}>
              <summary style={{padding:'8px 0',cursor:'pointer'}}>{language==='ru'?'Конкретные зоны':'Specific placements'} · {region.zones.length}</summary>
              <div style={{display:'grid',gap:4,paddingLeft:8}}>
                {[...region.zones.filter(z=>suggestedAreas.includes(z.key)),...region.zones.filter(z=>!suggestedAreas.includes(z.key))].map(z=><label key={z.key} style={{display:'flex',alignItems:'center',gap:8,minHeight:36}}>
                  <input type="checkbox" checked={areas.includes(z.key)} onChange={()=>toggle(z.key)} />
                  {bodyZoneLabel(z.key,language,catalogueLabel)}
                </label>)}
              </div>
            </details>:null}
          </div>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => { void save(); }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>{copy.cancel}</button>
      </div>
    </div>
  );
}
