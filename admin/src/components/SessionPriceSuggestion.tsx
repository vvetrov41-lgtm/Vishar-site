import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import {
  priceSuggestionLabel,
  suggestSessionPrice,
  type ArtistSessionPricing,
  type PriceSuggestion,
} from '../lib/session-pricing';

// One read per artist / project per page load; rates change rarely and a
// stale suggestion is harmless because the operator still sees the price.
const pricingCache = new Map<string, Promise<ArtistSessionPricing | null>>();
const projectRateCache = new Map<string, Promise<{ rate: number | null; currency: string | null }>>();

export function clearSessionPricingCache(artistId?: string) {
  if (artistId) pricingCache.delete(artistId);
  else pricingCache.clear();
  projectRateCache.clear();
}

export function useArtistSessionPricing(artistId: string | null | undefined, enabled: boolean) {
  const api = useApi();
  const [pricing, setPricing] = useState<ArtistSessionPricing | null>(null);

  useEffect(() => {
    if (!enabled || !artistId) {
      setPricing(null);
      return undefined;
    }
    let cancelled = false;
    let request = pricingCache.get(artistId);
    if (!request) {
      request = api.getArtistSessionPricing(artistId).catch(() => null);
      pricingCache.set(artistId, request);
    }
    void request.then((value) => {
      if (!cancelled) setPricing(value);
    });
    return () => { cancelled = true; };
  }, [api, artistId, enabled]);

  return pricing;
}

function useProjectHourlyRate(projectId: string | null | undefined, enabled: boolean) {
  const api = useApi();
  const [value, setValue] = useState<{ rate: number | null; currency: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !projectId) {
      setValue(null);
      return undefined;
    }
    let cancelled = false;
    let request = projectRateCache.get(projectId);
    if (!request) {
      request = api.getProjectFinance(projectId)
        .then((finance) => ({
          rate: finance?.hourly_rate != null ? Number(finance.hourly_rate) : null,
          currency: finance?.currency ?? null,
        }))
        .catch(() => ({ rate: null, currency: null }));
      projectRateCache.set(projectId, request);
    }
    void request.then((result) => {
      if (!cancelled) setValue(result);
    });
    return () => { cancelled = true; };
  }, [api, projectId, enabled]);

  return value;
}

/**
 * Price suggestion for one tattoo session. A project's own hourly rate is
 * passed in when the caller already has it, or read for `projectId`.
 */
export function useSessionPriceSuggestion({
  artistId,
  projectId,
  projectHourlyRate,
  projectCurrency,
  durationMinutes,
  enabled,
}: {
  artistId: string | null | undefined;
  projectId?: string | null;
  projectHourlyRate?: number | null;
  projectCurrency?: string | null;
  durationMinutes: number | null;
  enabled: boolean;
}): PriceSuggestion | null {
  const artistPricing = useArtistSessionPricing(artistId, enabled);
  const fetched = useProjectHourlyRate(projectId, enabled && projectHourlyRate === undefined);
  if (!enabled) return null;
  const rate = projectHourlyRate !== undefined ? projectHourlyRate : fetched?.rate ?? null;
  const currency = projectCurrency ?? fetched?.currency ?? null;
  return suggestSessionPrice(durationMinutes, {
    projectHourlyRate: rate,
    projectCurrency: currency,
    artistPricing,
  });
}

/**
 * One-tap price from the project's rate or the artist's own rates. It never
 * fills the field on its own; the stored session price is what cards use.
 */
export function SessionPriceSuggestion({
  suggestion,
  currentValue,
  onUse,
}: {
  suggestion: PriceSuggestion | null;
  currentValue: string;
  onUse: (price: string) => void;
}) {
  const { language, locale } = useLanguage();
  if (!suggestion) return null;
  const value = suggestion.price.toFixed(2);
  if (currentValue.trim() !== '' && Number(currentValue) === suggestion.price) return null;
  return (
    <button
      type="button"
      className="secondary price-suggestion"
      onClick={() => onUse(value)}
    >
      {language === 'ru' ? 'Подставить ' : 'Use '}
      {priceSuggestionLabel(suggestion, language, locale)}
    </button>
  );
}
