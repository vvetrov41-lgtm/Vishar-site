// Booking form v2: structured project details.
//
// The browser sends keys from config/enquiry-form-v2.json. Everything here is
// re-derived on the server: unknown keys are refused, exclusive choices are
// enforced, labels come from the catalogue rather than the client, and the
// legacy text columns are computed so the CRM, AI, GPT and Telegram readers of
// project_type/placement/approximate_size/cover_up keep working unchanged.

import catalogue from '../../config/enquiry-form-v2.json' with { type: 'json' };
import { RequestError } from './http.js';

export const ENQUIRY_V2_SCHEMA = catalogue.schema;
export const ENQUIRY_V2_LIMITS = Object.freeze({ ...catalogue.limits });
export const INTAKE_ROLES = Object.freeze({
  design: 'design_reference',
  existing: 'existing_tattoo',
});

const REGIONS = new Map(catalogue.regions.map((region) => [region.key, {
  ...region,
  placements: new Map(region.placements.map((placement) => [placement.key, placement])),
}]));
const WORK = new Map(catalogue.work.map((work) => [work.key, work]));
const STYLES = new Map(catalogue.styles.map((style) => [style.key, style]));
const EXISTING_WORK = new Set(['extension', 'cover_up', 'rework']);
const MAX_DETAILS_JSON = 8000;

function invalid(message = 'Please check the project details and try again.') {
  return new RequestError('invalid_project_details', message);
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}

function keyList(value) {
  if (!Array.isArray(value)) throw invalid();
  const keys = value.map((entry) => (typeof entry === 'string' ? entry : ''));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw invalid();
  return keys;
}

/**
 * Parses and normalises the client's structured answers. Returns the object
 * stored in enquiries.project_details plus the derived requirement flags.
 */
export function parseProjectDetails(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_DETAILS_JSON) throw invalid();
  let input;
  try { input = JSON.parse(raw); } catch { throw invalid(); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();

  if (!Array.isArray(input.areas) || input.areas.length < 1 || input.areas.length > ENQUIRY_V2_LIMITS.maxAreas) {
    throw new RequestError('missing_body_area', 'Please choose where you would like your tattoo.');
  }

  const seenRegions = new Set();
  const areas = input.areas.map((area) => {
    if (!area || typeof area !== 'object') throw invalid();
    const region = REGIONS.get(area.region);
    if (!region || seenRegions.has(region.key)) throw invalid();
    seenRegions.add(region.key);

    const placementKeys = keyList(area.placements ?? []);
    const placements = placementKeys.map((key) => {
      const placement = region.placements.get(key);
      if (!placement) throw invalid();
      return placement;
    });
    const groups = placements.map((placement) => placement.group).filter(Boolean);
    if (new Set(groups).size !== groups.length) {
      throw invalid('Please choose one sleeve length per area.');
    }

    const needsOtherText = region.key === 'other' || placementKeys.includes('other');
    const otherPlacement = needsOtherText ? text(area.otherPlacement, ENQUIRY_V2_LIMITS.otherText) : '';
    if (region.key !== 'other' && placements.length === 0) {
      throw new RequestError('missing_placement', `Please choose a placement for ${region.label}.`);
    }
    if (needsOtherText && !otherPlacement) {
      throw new RequestError('missing_placement', 'Please describe the placement.');
    }

    const workKeys = keyList(area.work ?? []);
    if (workKeys.length === 0) {
      throw new RequestError('missing_existing_work', `Please say whether ${region.label} has existing tattoo work.`);
    }
    if (workKeys.some((key) => !WORK.has(key))) throw invalid();
    if (workKeys.includes('new') && workKeys.length > 1) {
      throw invalid('No existing tattoo cannot be combined with other options for the same area.');
    }

    return {
      key: region.key,
      region: region.label,
      placementKeys,
      placements: placements.map((placement) => placement.label),
      otherPlacement: otherPlacement || null,
      workKeys,
      work: workKeys.map((key) => WORK.get(key).label),
      large: placements.some((placement) => placement.large),
    };
  });

  const styleKeys = keyList(input.styles ?? []);
  if (styleKeys.length === 0) {
    throw new RequestError('missing_style', 'Please choose a style or Not sure yet.');
  }
  if (styleKeys.some((key) => !STYLES.has(key))) throw invalid();
  if (styleKeys.includes('not_sure') && styleKeys.length > 1) throw invalid();

  const hasExistingWork = areas.some((area) => area.workKeys.some((key) => EXISTING_WORK.has(key)));
  const sizeNotes = text(input.sizeNotes, ENQUIRY_V2_LIMITS.sizeNotes);
  const existingDetails = hasExistingWork
    ? text(input.existingDetails, ENQUIRY_V2_LIMITS.existingDetails)
    : '';

  // A cover-up or rework inside a sleeve or panel is part of a larger new
  // design, so it needs a design reference as well as the existing photo.
  const requiresDesignReference = areas.some((area) => (
    area.workKeys.includes('new')
    || area.workKeys.includes('extension')
    || (area.large && area.workKeys.some((key) => key === 'cover_up' || key === 'rework'))
  ));
  const requiresExistingPhoto = hasExistingWork;

  const details = {
    schema: ENQUIRY_V2_SCHEMA,
    areas: areas.map((area) => ({
      region: area.region,
      placements: area.placements,
      ...(area.otherPlacement ? { otherPlacement: area.otherPlacement } : {}),
      work: area.work,
    })),
    styles: styleKeys.map((key) => STYLES.get(key).label),
    ...(sizeNotes ? { sizeNotes } : {}),
    ...(existingDetails ? { existingDetails } : {}),
    imageRequirements: {
      designReference: requiresDesignReference,
      existingTattooPhoto: requiresExistingPhoto,
    },
  };

  return {
    details,
    areas,
    styleKeys,
    sizeNotes,
    requiresDesignReference,
    requiresExistingPhoto,
  };
}

function areaSummary(area) {
  const where = [...area.placements.filter((label) => label !== 'Other')];
  if (area.otherPlacement) where.push(area.otherPlacement);
  return where.length ? `${area.region}: ${where.join(', ')}` : area.region;
}

/** Legacy column values for readers that predate project_details. */
export function deriveLegacyFields(parsed) {
  const { areas, styleKeys, sizeNotes } = parsed;
  const allWork = new Set(areas.flatMap((area) => area.workKeys));

  let projectType;
  if (allWork.has('cover_up')) projectType = 'Cover-up';
  else if (areas.some((area) => area.large)) projectType = 'Large-scale project / sleeve';
  else if (styleKeys.includes('not_sure')) projectType = 'Not sure yet';
  else if (styleKeys.length === 2) projectType = 'Colour and black and grey realism';
  else if (styleKeys[0] === 'colour') projectType = 'Colour realism';
  else projectType = 'Black and grey realism';

  let coverUp = 'No';
  if (allWork.has('cover_up')) coverUp = 'Yes';
  else if (allWork.has('rework') || allWork.has('extension')) coverUp = 'Existing tattoo';

  return {
    projectType,
    placement: areas.map(areaSummary).join('; ').slice(0, 160),
    size: (sizeNotes || 'Not specified').slice(0, 120),
    coverUp,
  };
}
