import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import {
  priceSuggestionLabel,
  suggestSessionPrice,
  type ArtistSessionPricing,
} from '../lib/session-pricing';

// One read per artist per page load; rates change rarely and a stale
// suggestion is harmless because the operator still confirms the price.
const pricingCache = new Map<string, Promise<ArtistSessionPricing | null>>();

export function clearSessionPricingCache(artistId?: string) {
  if (artistId) pricingCache.delete(artistId);
  else pricingCache.clear();
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

/**
 * One-tap price from the artist's own rates. It never fills the field on its
 * own: the operator chooses it, and the stored session price is what cards use.
 */
export function SessionPriceSuggestion({
  artistId,
  durationMinutes,
  enabled,
  currentValue,
  onUse,
}: {
  artistId: string | null | undefined;
  durationMinutes: number | null;
  enabled: boolean;
  currentValue: string;
  onUse: (price: string) => void;
}) {
  const { language, locale } = useLanguage();
  const pricing = useArtistSessionPricing(artistId, enabled);
  const suggestion = enabled ? suggestSessionPrice(durationMinutes, pricing) : null;
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
