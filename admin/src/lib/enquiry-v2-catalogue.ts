// Booking form v2 catalogue for the operator editor.
//
// project_details stores English catalogue labels; the server edit RPC
// (update_enquiry_project_details) takes catalogue keys, exactly like the
// public form, and re-derives labels and the legacy columns itself. This
// module only maps between the two and mirrors the form's exclusivity rules
// so the operator sees a mistake before saving. The server stays the
// authority.

import catalogue from '../../../config/enquiry-form-v2.json';
import type { EnquiryProjectDetails } from './types';

export interface CataloguePlacement { key: string; label: string; group?: string; large?: boolean }
export interface CatalogueRegion { key: string; label: string; placements: CataloguePlacement[] }
export interface CatalogueOption { key: string; label: string; exclusive?: boolean }

export const V2_REGIONS = catalogue.regions as CatalogueRegion[];
export const V2_WORK = catalogue.work as CatalogueOption[];
export const V2_STYLES = catalogue.styles as CatalogueOption[];
export const V2_LIMITS = catalogue.limits;
export const EXISTING_WORK_KEYS = ['extension', 'cover_up', 'rework'];

export interface AreaInput {
  region: string;
  placements: string[];
  otherPlacement?: string;
  work: string[];
}

export interface ProjectInput {
  areas: AreaInput[];
  styles: string[];
  sizeNotes?: string;
  existingDetails?: string;
}

const byLabel = <T extends { label: string }>(list: T[], label: string) => list.find((item) => item.label === label);

/**
 * Stored labels back to form keys. Returns null when a stored label is not in
 * the current catalogue, so the caller can fall back instead of silently
 * dropping what the client chose.
 */
export function detailsToInput(details: EnquiryProjectDetails): ProjectInput | null {
  const areas: AreaInput[] = [];
  for (const area of details.areas) {
    const region = byLabel(V2_REGIONS, area.region);
    if (!region) return null;
    const placements: string[] = [];
    for (const label of area.placements) {
      const placement = byLabel(region.placements, label);
      if (!placement) return null;
      placements.push(placement.key);
    }
    const work: string[] = [];
    for (const label of area.work) {
      const option = byLabel(V2_WORK, label);
      if (!option) return null;
      work.push(option.key);
    }
    areas.push({
      region: region.key,
      placements,
      ...(area.otherPlacement ? { otherPlacement: area.otherPlacement } : {}),
      work,
    });
  }
  const styles: string[] = [];
  for (const label of details.styles) {
    const option = byLabel(V2_STYLES, label);
    if (!option) return null;
    styles.push(option.key);
  }
  return {
    areas,
    styles,
    ...(details.sizeNotes ? { sizeNotes: details.sizeNotes } : {}),
    ...(details.existingDetails ? { existingDetails: details.existingDetails } : {}),
  };
}

export function hasExistingWork(input: ProjectInput): boolean {
  return input.areas.some((area) => area.work.some((key) => EXISTING_WORK_KEYS.includes(key)));
}

/** Toggle a placement; a sleeve length replaces any other length in its group. */
export function togglePlacement(region: CatalogueRegion, selected: string[], key: string): string[] {
  if (selected.includes(key)) return selected.filter((item) => item !== key);
  const group = region.placements.find((placement) => placement.key === key)?.group;
  const kept = group
    ? selected.filter((item) => region.placements.find((placement) => placement.key === item)?.group !== group)
    : selected;
  return [...kept, key];
}

/** Toggle an option where an exclusive choice (New tattoo, Not sure yet) stands alone. */
export function toggleExclusive(options: CatalogueOption[], selected: string[], key: string): string[] {
  if (selected.includes(key)) return selected.filter((item) => item !== key);
  if (options.find((option) => option.key === key)?.exclusive) return [key];
  const exclusive = new Set(options.filter((option) => option.exclusive).map((option) => option.key));
  return [...selected.filter((item) => !exclusive.has(item)), key];
}

/** First problem the server would refuse, as an i18n-free code, or null. */
export function firstProblem(input: ProjectInput): 'area' | 'placement' | 'other' | 'work' | 'style' | null {
  if (input.areas.length === 0) return 'area';
  for (const area of input.areas) {
    const needsOther = area.region === 'other' || area.placements.includes('other');
    if (area.region !== 'other' && area.placements.length === 0) return 'placement';
    if (needsOther && !(area.otherPlacement ?? '').trim()) return 'other';
    if (area.work.length === 0) return 'work';
  }
  if (input.styles.length === 0) return 'style';
  return null;
}

/** The payload the RPC accepts: only the fields the form itself sends. */
export function toPayload(input: ProjectInput): ProjectInput {
  const existing = hasExistingWork(input);
  return {
    areas: input.areas.map((area) => {
      const needsOther = area.region === 'other' || area.placements.includes('other');
      return {
        region: area.region,
        placements: area.placements,
        ...(needsOther ? { otherPlacement: (area.otherPlacement ?? '').trim() } : {}),
        work: area.work,
      };
    }),
    styles: input.styles,
    ...((input.sizeNotes ?? '').trim() ? { sizeNotes: (input.sizeNotes ?? '').trim() } : {}),
    ...(existing && (input.existingDetails ?? '').trim() ? { existingDetails: (input.existingDetails ?? '').trim() } : {}),
  };
}
