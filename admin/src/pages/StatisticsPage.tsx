// Statistics - how the business is going, readable on a phone in 15 seconds.
//
// Every figure comes from one call to public.get_statistics, which reads
// crm_private.statistics_core: the same definitions GPT answers with, and the
// same reply evidence Today uses. This file formats; it does not define a
// metric. Order follows how often a question is asked: what needs attention,
// the four headline numbers, the diary ahead, the enquiry path, channels,
// money, then detail.
//
// Rules carried from the definitions: tattoo work and consultations are never
// added together; conversion is judged only on enquiries old enough to book;
// no change is stated against a window the CRM holds no history for; actual
// money and expected money are never added together, and the expected figure
// is shown only once most future sessions carry a price.

import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { DiscoverySourceSection } from '../components/DiscoverySourceSection';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can, canAccess } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import {
  CONVERSION_MATURITY_DAYS,
  periodForDates,
  periodForPreset,
  type Channel,
  type CurrencyAmount,
  type Delta,
  type PeriodPair,
} from '../lib/statistics';
import type { StatisticsChannelRow, StatisticsForecast, StatisticsResult, StatisticsWeek } from '../lib/statistics-api';
import { buildOverview, type StatisticsOverview } from '../lib/statistics-overview';
import './StatisticsPage.css';

const PRESETS = ['7d', '30d', '90d', '12m'] as const;
type Preset = (typeof PRESETS)[number];

export function StatisticsPage() {
  const api = useApi();
  const { t, language, locale } = useLanguage();
  const { selectedArtistId, artists } = useArtistScope();
  const { profile, memberships } = useSession();
  // Payments opens only for finance managers; a view-only viewer still sees
  // the count, without a link to a page that would refuse them.
  const mayOpenPayments = canAccess(profile?.role, 'manageFinance', memberships);
  // The outcome buttons live on the calendar for those who manage sessions.
  const mayRecordOutcomes = can(profile?.role, 'manageSessions');

  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);

  const period: PeriodPair = useMemo(() => {
    const now = new Date();
    if (customApplied) {
      return periodForDates(customApplied.from, customApplied.to) ?? periodForPreset('30d', now);
    }
    return periodForPreset(preset, now);
  }, [preset, customApplied]);

  const { data, loading, error, reload } = useAsync<StatisticsResult>(
    () => api.loadStatistics({ window: period.current, artistId: selectedArtistId ?? undefined }),
    [api, period.current.from, period.current.to, selectedArtistId],
  );

  const view = useMemo(
    () => (data ? buildOverview(data, (row) => channelLabel(row, language)) : null),
    [data, language],
  );

  const controls = (
    <PeriodControls
      preset={preset}
      custom={customApplied}
      customFrom={customFrom}
      customTo={customTo}
      onPreset={(next) => { setPreset(next); setCustomApplied(null); }}
      onCustomFrom={setCustomFrom}
      onCustomTo={setCustomTo}
      onApplyCustom={() => {
        if (periodForDates(customFrom, customTo)) setCustomApplied({ from: customFrom, to: customTo });
      }}
    />
  );

  if (loading) return <>{controls}<LoadingState label={t('stats.loading')} /></>;
  if (error) return <>{controls}<ErrorState message={error} onRetry={reload} /></>;
  if (!view) return <>{controls}<EmptyState title={t('stats.emptyTitle')} hint={t('stats.emptyHint')} /></>;

  const { current } = view;
  const change = (value: Delta) => (view.comparable ? value : undefined);
  const nameOf = (id: string) => artists.find((artist) => artist.id === id)?.display_name ?? '';
  const hasAnything = current.enquiries > 0 || current.bookings_made.tattoo > 0
    || current.sessions.booked > 0 || current.sessions.consultations_held > 0;

  return (
    <>
      {controls}

      <p className="stats-context">
        {view.comparable ? t('stats.comparison', { days: period.days }) : t('stats.noComparison')}
      </p>

      {!hasAnything ? <EmptyState title={t('stats.emptyTitle')} hint={t('stats.emptyHint')} /> : null}

      {/* First screen on a phone: the four headline figures, then what needs
          attention. Charts follow below the fold. */}
      <section className="stats-headline" aria-labelledby="stats-headline-title">
        <h2 id="stats-headline-title" className="visually-hidden">{t('stats.headline')}</h2>
        <div className="stats-kpis">
          <Kpi label={t('stats.kpi.enquiries')} hint={t('stats.kpi.enquiriesHint')} value={format(current.enquiries, locale)} change={change(view.enquiries)} />
          <Kpi
            label={t('stats.kpi.booked')}
            hint={t('stats.kpi.bookedHint')}
            value={format(current.bookings_made.tattoo, locale)}
            detail={current.bookings_made.tattoo_cancelled > 0
              ? t('stats.kpi.bookedDetail', { cancelled: current.bookings_made.tattoo_cancelled })
              : undefined}
            change={change(view.bookings)}
          />
          <Kpi
            label={t('stats.kpi.reply')}
            hint={t('stats.kpi.replyHint')}
            value={replyValue(view, nameOf, locale)}
            detail={t('stats.kpi.replyDetail', {
              timed: current.reply.timed,
              untimed: current.reply.answered_without_time,
            })}
          />
          <Kpi
            label={t('stats.kpi.conversion')}
            hint={t('stats.kpi.conversionHint')}
            value={percentOrDash(view.conversion, locale)}
            detail={current.conversion.mature === 0
              ? t('stats.kpi.conversionTooYoung', { pending: current.conversion.pending, days: CONVERSION_MATURITY_DAYS })
              : t('stats.kpi.conversionDetail', { converted: current.conversion.converted, total: current.conversion.mature })}
            change={view.comparable ? view.conversionDelta ?? undefined : undefined}
            changeIsPoints
          />
        </div>
        {current.conversion.pending > 0 ? (
          <p className="stats-caveat">
            {t('stats.conversionPending', {
              pending: current.conversion.pending,
              booked: current.conversion.pending_converted,
              days: CONVERSION_MATURITY_DAYS,
            })}
          </p>
        ) : null}
      </section>

      {view.attention.length > 0 ? (
        <section className="stats-attention" aria-labelledby="stats-attention-title">
          <h2 id="stats-attention-title">{t('stats.attention')}</h2>
          <ul>
            {view.attention.map((item) => {
              const text = t(`stats.attention.${item.id}`, {
                ...item.params,
                first: typeof item.params.first === 'string' ? dayMonth(item.params.first, locale) : '',
              });
              const linked = item.target === '/payments'
                ? mayOpenPayments
                : item.id === 'consultationsAwaitingOutcome' ? mayRecordOutcomes : true;
              return (
                <li key={`${item.id}-${JSON.stringify(item.params)}`}>
                  {linked ? (
                    <a href={item.target}><span>{text}</span><span aria-hidden="true">›</span></a>
                  ) : (
                    <span className="stats-attention-text">{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Section title={t('stats.diary')}>
        <DiaryChart weeks={current.upcoming.weeks} locale={locale} />
        <p className="stats-diary-summary">
          {t('stats.diarySummary', {
            sessions: current.upcoming.weeks.reduce((total, week) => total + week.tattoo_sessions, 0),
            hours: formatHours(current.upcoming.weeks.reduce((total, week) => total + Number(week.tattoo_hours), 0), locale),
            later: current.upcoming.tattoo_sessions_later,
          })}
        </p>
        <p className="stats-caveat">{t('stats.noUtilisation')}</p>
      </Section>

      <Section title={t('stats.funnel')}>
        <FunnelChart overview={view} locale={locale} />
        <p className="stats-caveat">{t('stats.funnelNote')}</p>
        {bookingMedianText(view, nameOf) ? (
          <p className="stats-caveat">{t('stats.daysToBooking', { days: bookingMedianText(view, nameOf) })}</p>
        ) : null}
        {!view.replyCoverage ? <p className="stats-caveat">{t('stats.replyCoverage')}</p> : null}
      </Section>

      <Section title={t('stats.sources')}>
        <div id="stats-channels" />
        {current.channels.length === 0 ? (
          <EmptyState compact title={t('stats.noSources')} />
        ) : (
          <ChannelTable
            rows={current.channels}
            depositsPaid={current.finance ? current.finance.deposits_paid_by_channel : null}
            locale={locale}
            language={language}
          />
        )}
      </Section>

      <DiscoverySourceSection counts={current.discovery} language={language} locale={locale} />

      {current.finance ? (
        <Section title={t('stats.finance')}>
          <h3 className="stats-subhead">{t('stats.money.actual')}</h3>
          <div className="stats-money">
            <MoneyBlock title={t('stats.money.received')} hint={t('stats.money.receivedHint')} amounts={current.finance.received} language={language} />
            <MoneyBlock title={t('stats.money.refunded')} hint={t('stats.money.refundedHint')} amounts={current.finance.refunded} language={language} />
          </div>
          <h3 className="stats-subhead">{t('stats.money.expected')}</h3>
          <div className="stats-money">
            <MoneyBlock
              title={t('stats.money.open')}
              hint={current.finance.partially_paid > 0
                ? `${t('stats.money.openHint')} ${t('stats.money.partiallyPaid', { count: current.finance.partially_paid })}`
                : t('stats.money.openHint')}
              amounts={current.finance.open}
              language={language}
            />
          </div>
          <ForecastPanel forecast={current.finance.forecast} language={language} locale={locale} mayOpenPayments={mayOpenPayments} />
        </Section>
      ) : null}

      <details className="stats-details">
        <summary>{t('stats.detailsTitle')}</summary>
        <dl className="definition stats-definition">
          <dt>{t('stats.kpi.completed')}</dt>
          <dd>{format(current.sessions.completed, locale)}{view.comparable ? ` · ${t('stats.change.previous', { value: format(view.completed.previous, locale) })}` : ''}</dd>
          <dt>{t('stats.kpi.hours')}</dt>
          <dd>{formatHours(Number(current.sessions.hours), locale)}</dd>
          <dt>{t('stats.kpi.repeat')}</dt>
          <dd>{t('stats.kpi.repeatDetail', {
            rate: current.returning_clients.active === 0 ? '—' : percentOrDash((current.returning_clients.returning / current.returning_clients.active) * 100, locale),
            active: current.returning_clients.active,
          })} ({format(current.returning_clients.returning, locale)})</dd>
          <dt>{t('stats.kpi.cancelled')}</dt>
          <dd>{format(current.sessions.cancelled, locale)}</dd>
          <dt>{t('stats.noShows')}</dt>
          <dd>{format(current.sessions.no_show, locale)}</dd>
          <dt>{t('stats.consultationsHeld')}</dt>
          <dd>{format(current.sessions.consultations_held, locale)}</dd>
          <dt>{t('stats.consultationsUnverified')}</dt>
          <dd>{format(current.sessions.consultations_unverified, locale)}</dd>
          <dt>{t('stats.consultationsNoShow')}</dt>
          <dd>{format(current.sessions.consultations_no_show, locale)}</dd>
          <dt>{t('stats.uniqueClients')}</dt>
          <dd>{format(current.unique_clients, locale)}</dd>
        </dl>
      </details>

      {view.insights.length > 0 ? (
        <Section title={t('stats.insights')}>
          <ul className="stats-insights">
            {view.insights.map((insight) => (
              <li key={insight.id} className={`stats-insight ${insight.tone}`}>{t(insight.id, insight.params)}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <details className="stats-definitions">
        <summary>{t('stats.definitionsTitle')}</summary>
        <dl className="definition">
          <dt>{t('stats.kpi.enquiries')}</dt><dd>{t('stats.def.enquiries')}</dd>
          <dt>{t('stats.kpi.booked')}</dt><dd>{t('stats.def.booked')}</dd>
          <dt>{t('stats.kpi.reply')}</dt><dd>{t('stats.def.reply')}</dd>
          <dt>{t('stats.kpi.conversion')}</dt><dd>{t('stats.def.conversion')}</dd>
          <dt>{t('stats.kpi.completed')}</dt><dd>{t('stats.def.completed')}</dd>
          <dt>{t('stats.kpi.cancelled')}</dt><dd>{t('stats.def.cancelled')}</dd>
          <dt>{t('stats.kpi.repeat')}</dt><dd>{t('stats.def.repeat')}</dd>
          <dt>{t('stats.sources')}</dt><dd>{t('stats.def.sources')}</dd>
          <dt>{t('stats.finance')}</dt><dd>{t('stats.def.finance')}</dd>
        </dl>
      </details>
    </>
  );
}

function replyValue(view: StatisticsOverview, nameOf: (id: string) => string, locale: string): string {
  const known = view.replyMedians.filter((entry) => entry.hours !== null);
  if (known.length === 0) return '—';
  if (view.replyMedians.length === 1) return formatHours(Number(known[0].hours), locale);
  // Medians do not add up; one per artist, initial first.
  return known.map((entry) => `${nameOf(entry.artistId).slice(0, 1)} ${formatHours(Number(entry.hours), locale)}`).join(' · ');
}

function bookingMedianText(view: StatisticsOverview, nameOf: (id: string) => string): string {
  const known = view.bookingMedians.filter((entry) => entry.days !== null);
  if (known.length === 0) return '';
  if (view.bookingMedians.length === 1) return String(known[0].days);
  return known.map((entry) => `${nameOf(entry.artistId).slice(0, 1)} ${entry.days}`).join(' · ');
}

function dayMonth(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(`${isoDate}T00:00:00`));
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function PeriodControls({
  preset, custom, customFrom, customTo, onPreset, onCustomFrom, onCustomTo, onApplyCustom,
}: {
  preset: Preset;
  custom: { from: string; to: string } | null;
  customFrom: string;
  customTo: string;
  onPreset: (preset: Preset) => void;
  onCustomFrom: (value: string) => void;
  onCustomTo: (value: string) => void;
  onApplyCustom: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <div className="stats-periods">
      <div className="stats-period-row" role="group" aria-label={t('stats.periodLabel')}>
        {PRESETS.map((option) => (
          <button
            key={option}
            type="button"
            className={!custom && preset === option ? 'stats-period active' : 'stats-period'}
            aria-pressed={!custom && preset === option}
            onClick={() => { onPreset(option); setOpen(false); }}
          >
            {t(`stats.period.${option}`)}
          </button>
        ))}
        <button
          type="button"
          className={custom ? 'stats-period active' : 'stats-period'}
          aria-pressed={Boolean(custom)}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t('stats.period.custom')}
        </button>
      </div>

      {open ? (
        <div className="stats-custom">
          <label className="stats-custom-field">
            {t('stats.period.from')}
            <input type="date" value={customFrom} onChange={(event) => onCustomFrom(event.target.value)} />
          </label>
          <label className="stats-custom-field">
            {t('stats.period.to')}
            <input type="date" value={customTo} onChange={(event) => onCustomTo(event.target.value)} />
          </label>
          <button
            type="button"
            className="primary"
            disabled={!periodForDates(customFrom, customTo)}
            onClick={onApplyCustom}
          >
            {t('stats.period.apply')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Kpi({
  label, hint, value, detail, change, changeIsPoints = false, invert = false,
}: {
  label: string;
  hint: string;
  value: string;
  detail?: string;
  change?: Delta;
  /** The metric is itself a percentage, so a change in it is points, not per cent. */
  changeIsPoints?: boolean;
  /** More is worse. Cancellations going up is not good news. */
  invert?: boolean;
}) {
  const { t, locale } = useLanguage();
  return (
    <div className="card stats-kpi">
      <div className="stats-kpi-label" title={hint}>{label}</div>
      <div className="stats-kpi-value">{value}</div>
      {detail ? <div className="stats-kpi-detail">{detail}</div> : null}
      {change ? <ChangeBadge change={change} isPoints={changeIsPoints} invert={invert} locale={locale} t={t} /> : null}
    </div>
  );
}

function ChangeBadge({
  change, isPoints, invert, locale, t,
}: {
  change: Delta;
  isPoints: boolean;
  invert: boolean;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (change.difference === 0) {
    return <div className="stats-change flat">{t('stats.change.flat')}</div>;
  }
  const better = invert ? change.difference < 0 : change.difference > 0;
  const tone = better ? 'good' : 'bad';
  // Percentage points for a rate, per cent for a count, and the plain
  // difference when there was nothing to divide by. Never a made-up ratio.
  const text = isPoints
    ? t('stats.change.points', { value: signed(change.difference, locale) })
    : change.percent === null
      ? t('stats.change.absolute', { value: signed(change.difference, locale) })
      : t('stats.change.percent', { value: signed(Math.round(change.percent), locale) });

  return (
    <div className={`stats-change ${tone}`}>
      {text}
      <span className="stats-change-previous">{t('stats.change.previous', { value: format(change.previous, locale) })}</span>
    </div>
  );
}

function DiaryChart({ weeks, locale }: { weeks: StatisticsWeek[]; locale: string }) {
  const { t } = useLanguage();
  const peak = Math.max(1, ...weeks.map((week) => Number(week.tattoo_hours)));
  return (
    <div className="stats-diary" role="list" aria-label={t('stats.diary')}>
      {weeks.map((week, index) => (
        <div
          key={week.week_start}
          className={week.tattoo_sessions === 0 ? 'stats-diary-week empty' : 'stats-diary-week'}
          role="listitem"
          aria-label={t('stats.diaryWeek', {
            week: dayMonth(week.week_start, locale),
            hours: formatHours(Number(week.tattoo_hours), locale),
            consultations: week.consultations,
          })}
        >
          <div className="stats-diary-bar-track">
            <span className="stats-diary-bar" style={{ height: `${(Number(week.tattoo_hours) / peak) * 100}%` }} />
          </div>
          <div className="stats-diary-consult" aria-hidden="true">{week.consultations > 0 ? `●${week.consultations}` : ''}</div>
          <div className="stats-diary-tick" aria-hidden="true">{index % 2 === 0 ? dayMonth(week.week_start, locale) : ''}</div>
        </div>
      ))}
    </div>
  );
}

function FunnelChart({ overview, locale }: { overview: StatisticsOverview; locale: string }) {
  const { t } = useLanguage();
  const { funnel } = overview.current;
  const stages: Array<{ id: string; count: number }> = [
    { id: 'enquiries', count: funnel.enquiries },
    { id: 'answered', count: funnel.answered },
    { id: 'consultations', count: funnel.consultations },
    { id: 'booked', count: funnel.booked },
    { id: 'completed', count: funnel.completed },
  ];
  const top = Math.max(1, funnel.enquiries);
  return (
    <div className="stats-funnel">
      {stages.map((stage) => (
        <div key={stage.id} className="stats-funnel-stage">
          <div className="stats-funnel-head">
            <span>{t(`stats.funnel.${stage.id}`)}</span>
            <strong>{format(stage.count, locale)}</strong>
          </div>
          <div className="stats-funnel-track">
            <span className="stats-funnel-fill" style={{ width: `${(stage.count / top) * 100}%` }} />
          </div>
          <div className="stats-funnel-rate">
            {stage.id === 'enquiries' || funnel.enquiries === 0 ? '' : t('stats.funnelRate', {
              rate: percentOrDash((stage.count / funnel.enquiries) * 100, locale),
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelTable({
  rows, depositsPaid, locale, language,
}: {
  rows: StatisticsChannelRow[];
  depositsPaid: Record<string, number> | null;
  locale: string;
  language: Language;
}) {
  const { t } = useLanguage();
  return (
    <div className="stats-table-scroll">
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">{t('stats.sourceColumn')}</th>
            <th scope="col">{t('stats.enquiriesColumn')}</th>
            <th scope="col">{t('stats.consultedColumn')}</th>
            <th scope="col">{t('stats.bookedColumn')}</th>
            {depositsPaid ? <th scope="col">{t('stats.depositColumn')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{channelLabel(row, language)}</th>
              <td>{format(row.enquiries, locale)}</td>
              <td>{format(row.consulted, locale)}</td>
              <td>{format(row.booked, locale)}</td>
              {depositsPaid ? <td>{format(depositsPaid[row.key] ?? 0, locale)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoneyBlock({
  title, hint, amounts, language,
}: {
  title: string;
  hint: string;
  amounts: CurrencyAmount[];
  language: Language;
}) {
  return (
    <div className="card stats-money-block">
      <div className="stats-kpi-label">{title}</div>
      {amounts.length === 0 ? (
        <div className="stats-kpi-value stats-money-none">—</div>
      ) : (
        // One line per currency, never a total across them: a sum of GBP and
        // anything else is denominated in nothing.
        amounts.map((entry) => (
          <div key={entry.currency} className="stats-money-line">
            <span className="stats-kpi-value">{formatMoney(entry.amount, entry.currency, language)}</span>
          </div>
        ))
      )}
      <div className="stats-kpi-detail">{hint}</div>
    </div>
  );
}

/**
 * Upcoming confirmed tattoo work. Confirmed value (the price saved on a
 * session) and estimated value (computed from rates, never saved) are shown
 * side by side and labelled, so an estimate is never read as an agreed price.
 */
function ForecastPanel({
  forecast, language, locale, mayOpenPayments,
}: {
  forecast: StatisticsForecast;
  language: Language;
  locale: string;
  mayOpenPayments: boolean;
}) {
  const { t } = useLanguage();
  const lines = (amounts: CurrencyAmount[], approximate = false) => (amounts.length === 0 ? (
    <div className="stats-kpi-value stats-money-none">—</div>
  ) : amounts.map((entry) => (
    <div key={entry.currency} className="stats-money-line">
      <span className="stats-kpi-value">{approximate ? '≈ ' : ''}{formatMoney(entry.amount, entry.currency, language)}</span>
    </div>
  )));

  if (forecast.sessions === 0) {
    return (
      <div className="card stats-forecast">
        <div className="stats-kpi-label">{t('stats.forecast.title')}</div>
        <div className="stats-kpi-detail">{t('stats.forecast.none')}</div>
      </div>
    );
  }

  return (
    <div className="card stats-forecast">
      <div className="stats-kpi-label">{t('stats.forecast.title')}</div>
      {lines(forecast.expected_value, forecast.estimated.sessions > 0)}
      <div className="stats-kpi-detail">{t('stats.forecast.titleHint')}</div>
      <div className="stats-forecast-split">
        <div className="stats-forecast-part confirmed">
          <div className="stats-kpi-label">{t('stats.forecast.confirmed')}</div>
          {lines(forecast.confirmed.value)}
          <div className="stats-kpi-detail">{t('stats.forecast.confirmedHint', { count: forecast.confirmed.sessions })}</div>
        </div>
        <div className="stats-forecast-part estimated">
          <div className="stats-kpi-label">{t('stats.forecast.estimated')}</div>
          {lines(forecast.estimated.value, true)}
          <div className="stats-kpi-detail">{t('stats.forecast.estimatedHint', { count: forecast.estimated.sessions })}</div>
        </div>
      </div>
      <div className="stats-forecast-remaining">
        <div className="stats-kpi-label">{t('stats.forecast.remaining')}</div>
        {lines(forecast.remaining_after_deposits, forecast.estimated.sessions > 0)}
        <div className="stats-kpi-detail">
          {forecast.deposits_paid.length > 0
            ? t('stats.forecast.remainingHint', {
              deposits: forecast.deposits_paid.map((entry) => formatMoney(entry.amount, entry.currency, language)).join(' · '),
            })
            : t('stats.forecast.remainingNoDeposits')}
        </div>
      </div>
      <p className="stats-caveat">
        {t('stats.forecast.coverage', { confirmed: forecast.confirmed.sessions, total: forecast.sessions })}
      </p>
      {forecast.no_basis.sessions > 0 ? (
        <p className="stats-caveat stats-forecast-gap">
          {t('stats.forecast.noBasis', {
            count: forecast.no_basis.sessions,
            hours: formatHours(Number(forecast.no_basis.hours), locale),
          })}
          {mayOpenPayments ? <> <a href="/payments">{t('stats.forecast.setRates')}</a></> : null}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function format(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatHours(value: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(round1(value))} h`;
}

function percentOrDash(value: number | null, locale: string): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)}%`;
}

function signed(value: number, locale: string): string {
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(value));
  return value > 0 ? `+${formatted}` : `−${formatted}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const PLATFORM_NAMES: Record<string, string> = {
  meta: 'Meta',
  facebook: 'Facebook',
  instagram: 'Instagram',
  google: 'Google',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Copilot',
  bing: 'Bing',
  duckduckgo: 'DuckDuckGo',
  whatsapp: 'WhatsApp',
};

function platformName(value: string | null): string {
  if (!value) return '';
  return PLATFORM_NAMES[value] ?? value;
}

/**
 * What to call a channel. Platform names are proper nouns; the descriptive
 * part is translated. An unknown platform or referring site is printed as
 * recorded - rewriting it would be guessing.
 */
export function channelLabel(channel: Channel, language: Language): string {
  const ru = language === 'ru';
  const name = platformName(channel.value);
  switch (channel.kind) {
    case 'paid': return ru ? `Реклама ${name}` : `${name} ads`;
    case 'campaign': return ru ? `Метка кампании: ${name}` : `Campaign tag: ${name}`;
    case 'social': return name;
    case 'search': return ru ? `Поиск ${name}` : `${name} search`;
    case 'ai': return name;
    case 'referral': return name;
    case 'internal': return ru ? 'Свой сайт, источник неизвестен' : 'Own website, origin unknown';
    case 'conversation': return ru ? `Переписка ${name}` : `${name} conversation`;
    case 'manual': return ru ? 'Добавлено в CRM вручную' : 'Added in the CRM by hand';
    case 'direct': return ru ? 'Прямой заход или не записано' : 'Direct or not recorded';
    default: return channel.key;
  }
}
