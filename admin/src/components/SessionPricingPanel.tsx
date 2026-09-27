import { useEffect, useState, type FormEvent } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import { formatSessionMoney, type ArtistSessionPricing } from '../lib/session-pricing';
import { clearSessionPricingCache } from './SessionPriceSuggestion';

function field(value: number | null): string {
  return value === null ? '' : String(value);
}

function parseOptional(value: string): number | null | 'invalid' {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : 'invalid';
}

/**
 * The artist's own session rates and per-session deposit. The same form
 * serves every artist; nothing is copied from another artist's prices.
 */
export function SessionPricingPanel({
  artistId,
  artistName,
  canManage,
}: {
  artistId: string;
  artistName: string;
  canManage: boolean;
}) {
  const api = useApi();
  const { language, locale } = useLanguage();
  const ru = language === 'ru';
  const [pricing, setPricing] = useState<ArtistSessionPricing | null>(null);
  const [hourly, setHourly] = useState('');
  const [fullDay, setFullDay] = useState('');
  const [fullDayHours, setFullDayHours] = useState('');
  const [deposit, setDeposit] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPricing(null);
    setError(null);
    setNotice(null);
    api.getArtistSessionPricing(artistId)
      .then((value) => {
        if (cancelled) return;
        setPricing(value);
        setHourly(field(value.hourly_rate));
        setFullDay(field(value.full_day_rate));
        setFullDayHours(field(value.full_day_hours));
        setDeposit(field(value.session_deposit_amount));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { cancelled = true; };
  }, [api, artistId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const hourlyRate = parseOptional(hourly);
    const fullDayRate = parseOptional(fullDay);
    const hours = parseOptional(fullDayHours);
    const sessionDeposit = parseOptional(deposit);
    if ([hourlyRate, fullDayRate, hours, sessionDeposit].includes('invalid')) {
      setError(ru ? 'Проверь суммы: не больше двух знаков после точки.' : 'Check the amounts: at most two decimal places.');
      return;
    }
    if ((fullDayRate === null) !== (hours === null)) {
      setError(ru ? 'Для ставки за полный день укажи и длительность дня в часах.' : 'A full-day rate needs the length of the day in hours.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.setArtistSessionPricing({
        artistId,
        hourlyRate: hourlyRate as number | null,
        fullDayRate: fullDayRate as number | null,
        fullDayHours: hours as number | null,
        sessionDepositAmount: sessionDeposit as number | null,
        currency: pricing?.currency ?? 'GBP',
      });
      clearSessionPricingCache(artistId);
      setPricing(saved);
      setNotice(ru ? 'Ставки сохранены.' : 'Rates saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const currency = pricing?.currency ?? 'GBP';
  const summary = pricing?.configured
    ? [
      pricing.hourly_rate != null
        ? `${formatSessionMoney(pricing.hourly_rate, currency, locale)}${ru ? '/ч' : '/h'}` : null,
      pricing.full_day_rate != null && pricing.full_day_hours != null
        ? `${ru ? 'полный день' : 'full day'} ${formatSessionMoney(pricing.full_day_rate, currency, locale)} (${pricing.full_day_hours} ${ru ? 'ч' : 'h'})` : null,
      pricing.session_deposit_amount != null
        ? `${ru ? 'депозит за сеанс' : 'deposit per session'} ${formatSessionMoney(pricing.session_deposit_amount, currency, locale)}` : null,
    ].filter(Boolean).join(' · ')
    : null;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{ru ? 'Ставки сеансов' : 'Session rates'}</h2>
          <p>
            {ru
              ? `Ставки ${artistName} подставляют цену сеанса одним нажатием. Карточки записи берут только сохранённую цену сеанса. Депозит за сеанс распределяет оплаченный депозит проекта по сеансам.`
              : `${artistName}'s rates suggest a session price in one tap. Booking cards only use the stored session price. The per-session deposit splits a paid project deposit across its sessions.`}
          </p>
        </div>
      </div>
      {summary ? <div className="notice">{summary}</div> : null}
      {pricing && !pricing.configured ? (
        <div className="notice warn">{ru ? 'Ставки ещё не заданы.' : 'No rates set yet.'}</div>
      ) : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}
      {error ? <div className="notice warn" role="alert">{error}</div> : null}
      {canManage && pricing ? (
        <form onSubmit={save} className="form-grid">
          <label className="field">
            <span>{ru ? 'Ставка в час' : 'Hourly rate'} ({currency})</span>
            <input type="text" inputMode="decimal" value={hourly} onChange={(event) => setHourly(event.target.value)} />
          </label>
          <label className="field">
            <span>{ru ? 'Полный день' : 'Full day'} ({currency})</span>
            <input type="text" inputMode="decimal" value={fullDay} onChange={(event) => setFullDay(event.target.value)} />
          </label>
          <label className="field">
            <span>{ru ? 'Длительность полного дня, ч' : 'Full day length, hours'}</span>
            <input type="text" inputMode="decimal" value={fullDayHours} onChange={(event) => setFullDayHours(event.target.value)} />
          </label>
          <label className="field">
            <span>{ru ? 'Депозит за сеанс' : 'Deposit per session'} ({currency})</span>
            <input type="text" inputMode="decimal" value={deposit} onChange={(event) => setDeposit(event.target.value)} />
          </label>
          <div className="field-wide">
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? (ru ? 'Сохраняем…' : 'Saving…') : (ru ? 'Сохранить ставки' : 'Save rates')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
