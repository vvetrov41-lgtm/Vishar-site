// Operator editor for booking form v2 answers (enquiries.project_details).
//
// The operator changes body areas, placements, kinds of work, styles, size
// notes, existing-tattoo notes and timing with the same choices the client had.
// The server (update_enquiry_project_details) re-normalises the answers,
// recomputes project_type/placement/approximate_size/cover_up and refuses the
// save if the enquiry changed after it was opened. The client's own
// description is not part of this form.

import { useState } from 'react';
import type { Language } from '../lib/i18n';
import { can } from '../lib/permissions';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { CrmRole, Enquiry, EnquiryProjectDetails } from '../lib/types';
import {
  V2_LIMITS,
  V2_REGIONS,
  V2_STYLES,
  V2_WORK,
  detailsToInput,
  firstProblem,
  hasExistingWork,
  toggleExclusive,
  togglePlacement,
  toPayload,
  type AreaInput,
  type ProjectInput,
} from '../lib/enquiry-v2-catalogue';
import { catalogueLabel } from './EnquiryProjectDetails';

const COPY = {
  en: {
    edit: 'Edit body areas and style',
    save: 'Save',
    cancel: 'Cancel',
    addArea: 'Add body area',
    removeArea: 'Remove area',
    placements: 'Placement',
    otherPlacement: 'Describe the placement',
    work: 'Existing tattoo work',
    styles: 'Style',
    size: 'Exact placement and size',
    existing: 'Existing tattoo',
    timing: 'Timing',
    note: 'Type, placement, size and cover-up in lists are recalculated from these answers. The client\'s description is not changed.',
    unsupported: 'This enquiry was saved with a body area the form no longer offers. Use the standard edit form.',
    problems: {
      area: 'Choose at least one body area.',
      placement: 'Choose a placement for every area.',
      other: 'Describe the "Other" placement.',
      work: 'Choose the kind of work for every area.',
      style: 'Choose a style or Not sure yet.',
    },
    failed: 'Could not save the body areas.',
  },
  ru: {
    edit: 'Изменить зоны тела и стиль',
    save: 'Сохранить',
    cancel: 'Отмена',
    addArea: 'Добавить зону тела',
    removeArea: 'Убрать зону',
    placements: 'Расположение',
    otherPlacement: 'Опишите расположение',
    work: 'Существующая татуировка',
    styles: 'Стиль',
    size: 'Точное место и размер',
    existing: 'Существующая татуировка',
    timing: 'Сроки',
    note: 'Тип, расположение, размер и перекрытие в списках пересчитываются из этих ответов. Описание клиента не меняется.',
    unsupported: 'В заявке сохранена зона тела, которой больше нет в форме. Используйте обычное редактирование.',
    problems: {
      area: 'Выберите хотя бы одну зону тела.',
      placement: 'Выберите расположение для каждой зоны.',
      other: 'Опишите расположение «Другое».',
      work: 'Укажите вид работы для каждой зоны.',
      style: 'Выберите стиль или «Пока не решил(а)».',
    },
    failed: 'Не удалось сохранить зоны тела.',
  },
} as const;

export function EnquiryStructuredEditPanel({
  enquiry,
  details,
  role,
  api,
  language,
  onSaved,
}: {
  enquiry: Enquiry;
  details: EnquiryProjectDetails;
  role: CrmRole | null | undefined;
  api: Pick<RecordEditApi, 'updateEnquiryProjectDetails'>;
  language: Language;
  onSaved: () => void;
}) {
  const copy = COPY[language] ?? COPY.en;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState<ProjectInput | null>(null);
  const [timing, setTiming] = useState('');
  // What the operator opened; sent back so a concurrent change is refused.
  const [loaded, setLoaded] = useState<{ projectDetails: EnquiryProjectDetails; preferredTiming: string | null } | null>(null);

  if (!can(role, 'editEnquiry')) return null;

  function open() {
    setError(null);
    setInput(detailsToInput(details));
    setTiming(enquiry.preferred_timing ?? '');
    setLoaded({ projectDetails: details, preferredTiming: enquiry.preferred_timing ?? null });
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" onClick={open}>{copy.edit}</button>
      </div>
    );
  }

  if (!input || !loaded) {
    return (
      <div className="notice warn" role="alert" style={{ marginTop: 12 }}>
        {copy.unsupported}
        <div className="actions"><button type="button" onClick={() => setEditing(false)}>{copy.cancel}</button></div>
      </div>
    );
  }

  const current = input;
  const usedRegions = new Set(current.areas.map((area) => area.region));
  const freeRegions = V2_REGIONS.filter((region) => !usedRegions.has(region.key));
  const problem = firstProblem(current);

  function updateArea(index: number, change: Partial<AreaInput>) {
    setInput({ ...current, areas: current.areas.map((area, i) => (i === index ? { ...area, ...change } : area)) });
  }

  async function save() {
    if (problem || !loaded) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateEnquiryProjectDetails(enquiry.id, toPayload(current), timing, loaded);
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }} data-testid="enquiry-structured-edit">
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      {current.areas.map((area, index) => {
        const region = V2_REGIONS.find((item) => item.key === area.region);
        if (!region) return null;
        const needsOther = region.key === 'other' || area.placements.includes('other');
        return (
          <fieldset key={region.key} style={{ marginBottom: 12 }}>
            <legend><strong>{catalogueLabel(region.label, language)}</strong></legend>
            {region.placements.length ? (
              <div role="group" aria-label={copy.placements}>
                <div className="meta">{copy.placements}</div>
                {region.placements.map((placement) => (
                  <label key={placement.key} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
                    <input
                      type="checkbox"
                      checked={area.placements.includes(placement.key)}
                      onChange={() => updateArea(index, { placements: togglePlacement(region, area.placements, placement.key) })}
                    />
                    {catalogueLabel(placement.label, language)}
                  </label>
                ))}
              </div>
            ) : null}
            {needsOther ? (
              <label>
                {copy.otherPlacement}
                <input
                  value={area.otherPlacement ?? ''}
                  maxLength={V2_LIMITS.otherText}
                  onChange={(event) => updateArea(index, { otherPlacement: event.target.value })}
                />
              </label>
            ) : null}
            <div role="group" aria-label={copy.work}>
              <div className="meta">{copy.work}</div>
              {V2_WORK.map((work) => (
                <label key={work.key} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={area.work.includes(work.key)}
                    onChange={() => updateArea(index, { work: toggleExclusive(V2_WORK, area.work, work.key) })}
                  />
                  {catalogueLabel(work.label, language)}
                </label>
              ))}
            </div>
            <div className="actions">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => setInput({ ...current, areas: current.areas.filter((_, i) => i !== index) })}
              >
                {copy.removeArea}
              </button>
            </div>
          </fieldset>
        );
      })}

      {freeRegions.length && current.areas.length < V2_LIMITS.maxAreas ? (
        <label>
          {copy.addArea}
          <select
            value=""
            onChange={(event) => {
              if (!event.target.value) return;
              setInput({ ...current, areas: [...current.areas, { region: event.target.value, placements: [], work: [] }] });
            }}
          >
            <option value="">—</option>
            {freeRegions.map((region) => (
              <option key={region.key} value={region.key}>{catalogueLabel(region.label, language)}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div role="group" aria-label={copy.styles}>
        <div className="meta">{copy.styles}</div>
        {V2_STYLES.map((style) => (
          <label key={style.key} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
            <input
              type="checkbox"
              checked={current.styles.includes(style.key)}
              onChange={() => setInput({ ...current, styles: toggleExclusive(V2_STYLES, current.styles, style.key) })}
            />
            {catalogueLabel(style.label, language)}
          </label>
        ))}
      </div>

      <label>
        {copy.size}
        <input
          value={current.sizeNotes ?? ''}
          maxLength={V2_LIMITS.sizeNotes}
          onChange={(event) => setInput({ ...current, sizeNotes: event.target.value })}
        />
      </label>
      {hasExistingWork(current) ? (
        <label>
          {copy.existing}
          <textarea
            value={current.existingDetails ?? ''}
            maxLength={V2_LIMITS.existingDetails}
            onChange={(event) => setInput({ ...current, existingDetails: event.target.value })}
          />
        </label>
      ) : null}
      <label>
        {copy.timing}
        <input value={timing} maxLength={160} onChange={(event) => setTiming(event.target.value)} />
      </label>

      <p className="meta" style={{ marginBottom: 0 }}>{copy.note}</p>
      {problem ? <p className="meta" role="status">{copy.problems[problem]}</p> : null}
      <div className="actions">
        <button type="button" className="primary" disabled={busy || Boolean(problem)} onClick={() => { void save(); }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={() => { setError(null); setEditing(false); }}>{copy.cancel}</button>
      </div>
    </div>
  );
}
