// Statistics - what the studio's own records say, and nothing else.
//
// Every figure on this screen comes from a CRM table the artist already works
// in, aggregated by `src/lib/statistics.ts`, whose comments carry the formulas.
// Four rules shaped what is here.
//
// Tattoo work and consultations are never added together. A consultation is
// not a conversion, not a session worked and not a repeat visit.
//
// Nothing is shown that cannot be defined. There is no utilisation percentage,
// because a percentage needs a denominator and this CRM holds no provable one;
// booked hours ahead are stated as hours instead. A conversion rate counts only
// enquiries old enough to have booked, and no change is stated against a
// period the CRM holds no history for.
//
// Nothing is filtered for security in this file. The artist selector narrows
// the question; the database decides the answer. A finance block appears only
// when the database returned finance rows.
//
// What asks for a decision comes first. The insights sit directly under the
// period controls, because on a phone the bottom of this page is three screens
// away.

import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { DiscoverySourceSection } from '../components/DiscoverySourceSection';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { canAccess } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import {
  CONVERSION_MATURITY_DAYS,
  bookingsMade,
  buildInsights,
  channelBreakdown,
  delta,
  enquiryConversion,
  financeTotals,
  funnel,
  granularityFor,
  isTattooWork,
  periodForDates,
  periodForPreset,
  previousPeriodComparable,
  rateDelta,
  repeatClients,
  sessionTotals,
  sessionsByWeekday,
  timeSeries,
  upcomingLoad,
  within,
  type Channel,
  type ChannelRow,
  type CurrencyAmount,
  type Delta,
  type PeriodPair,
} from '../lib/statistics';
import type { StatisticsDataset } from '../lib/statistics-api';
import './StatisticsPage.css';

const PRESETS = ['7d', '30d', '90d', '12m'] as const;
type Preset = (typeof PRESETS)[number];

/**
 * How far ahead the diary is read for the upcoming-load figures.
 *
 * Ninety days rather than thirty. Tattoo work is booked months out, so a
 * thirty-day horizon would report an empty diary for a studio that is fully
 * booked. The window is named in the label beside every figure it produces.
 */
const FORWARD_DAYS = 90;

export function StatisticsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, language, locale } = useLanguage();
  const { selectedArtistId } = useArtistScope();

  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);

  // Finance is asked for only where the role could hold it. The database
  // refuses it to everyone else regardless, so this decides what is requested,
  // never what is permitted.
  const mayViewFinance = canAccess(profile?.role, 'viewFinance', memberships);

  const period: PeriodPair = useMemo(() => {
    const now = new Date();
    if (customApplied) {
      return periodForDates(customApplied.from, customApplied.to) ?? periodForPreset('30d', now);
    }
    return periodForPreset(preset, now);
  }, [preset, customApplied]);

  const windowFrom = period.previous.from;
  const windowTo = period.current.to;

  const { data, loading, error, reload } = useAsync<StatisticsDataset>(
    () => api.loadStatistics({
      window: { from: windowFrom, to: windowTo },
      forwardDays: FORWARD_DAYS,
      artistId: selectedArtistId ?? undefined,
      includeFinance: mayViewFinance,
    }),
    [api, windowFrom, windowTo, selectedArtistId, mayViewFinance],
  );

  const view = useMemo(
    () => (data ? summarise(data, period, (row) => channelLabel(row, language)) : null),
    [data, period, language],
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
  if (!view || !data) return <>{controls}<EmptyState title={t('stats.emptyTitle')} hint={t('stats.emptyHint')} /></>;

  const hasAnything = view.enquiries.current > 0
    || view.sessions.current.booked > 0
    || view.sessions.current.consultations.held > 0
    || view.bookings.current.tattoo > 0;

  // No change badge at all when the previous window predates the CRM's
  // history: "+53, was 0" would claim growth from records that never existed.
  const change = (value: Delta) => (view.comparable ? value : undefined);

  return (
    <>
      {controls}

      <p className="stats-context">
        {view.comparable
          ? t('stats.comparison', { days: period.days })
          : t('stats.noComparison')}
      </p>

      {data.truncated ? (
        <div className="notice stats-notice" role="status">{t('stats.truncated')}</div>
      ) : null}

      {!hasAnything ? (
        <EmptyState title={t('stats.emptyTitle')} hint={t('stats.emptyHint')} />
      ) : null}

      {view.insights.length > 0 ? (
        <Section title={t('stats.insights')}>
          <ul className="stats-insights">
            {view.insights.map((insight) => (
              <li key={`${insight.id}-${JSON.stringify(insight.params)}`} className={`stats-insight ${insight.tone}`}>
                {t(insight.id, insight.params)}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t('stats.headline')}>
        <div className="stats-kpis">
          <Kpi label={t('stats.kpi.enquiries')} hint={t('stats.kpi.enquiriesHint')} value={format(view.enquiries.current, locale)} change={change(view.enquiries)} />
          <Kpi
            label={t('stats.kpi.booked')}
            hint={t('stats.kpi.bookedHint')}
            value={format(view.bookings.current.tattoo, locale)}
            detail={view.bookings.current.tattooCancelled > 0
              ? t('stats.kpi.bookedDetail', { cancelled: view.bookings.current.tattooCancelled })
              : undefined}
            change={change(view.bookingsDelta)}
          />
          <Kpi
            label={t('stats.kpi.conversion')}
            hint={t('stats.kpi.conversionHint')}
            value={percentOrDash(view.conversion.current.rate, locale)}
            detail={view.conversion.current.denominator === 0
              ? t('stats.kpi.conversionTooYoung', { pending: view.conversion.current.pending, days: CONVERSION_MATURITY_DAYS })
              : t('stats.kpi.conversionDetail', {
                converted: view.conversion.current.converted,
                total: view.conversion.current.denominator,
              })}
            change={view.comparable ? view.conversionDelta ?? undefined : undefined}
            changeIsPoints
          />
          <Kpi label={t('stats.kpi.completed')} hint={t('stats.kpi.completedHint')} value={format(view.sessions.current.completed, locale)} change={change(view.completed)} />
          <Kpi label={t('stats.kpi.hours')} hint={t('stats.kpi.hoursHint')} value={formatHours(view.sessions.current.hours, locale)} change={change(view.hours)} />
          <Kpi
            label={t('stats.kpi.repeat')}
            hint={t('stats.kpi.repeatHint')}
            value={format(view.repeat.repeat, locale)}
            detail={t('stats.kpi.repeatDetail', {
              active: view.repeat.active,
              rate: percentOrDash(view.repeat.rate, locale),
            })}
          />
        </div>

        {view.conversion.current.pending > 0 ? (
          <p className="stats-caveat">
            {t('stats.conversionPending', {
              pending: view.conversion.current.pending,
              booked: view.conversion.current.pendingConverted,
              days: CONVERSION_MATURITY_DAYS,
            })}
          </p>
        ) : null}
      </Section>

      <Section title={t('stats.funnel')}>
        <FunnelChart funnel={view.funnel} locale={locale} />
        <p className="stats-caveat">{t('stats.funnelNote')}</p>
        {view.funnel.unlinkedProjects > 0 || view.funnel.unlinkedSessions > 0 ? (
          <p className="stats-caveat">
            {t('stats.funnelUnlinked', {
              projects: view.funnel.unlinkedProjects,
              sessions: view.funnel.unlinkedSessions,
            })}
          </p>
        ) : null}
      </Section>

      <Section title={t('stats.sources')}>
        {view.channels.length === 0 ? (
          <EmptyState compact title={t('stats.noSources')} />
        ) : (
          <ChannelTable rows={view.channels} locale={locale} language={language} />
        )}
      </Section>

      <DiscoverySourceSection
        enquiries={data.enquiries}
        period={period.current}
        language={language}
        locale={locale}
      />

      <Section title={t('stats.trend')}>
        <TrendChart points={view.series} granularity={view.granularity} locale={locale} />
        <p className="stats-legend">
          <span className="stats-swatch stats-swatch-enquiries" aria-hidden="true" />
          {t('stats.legend.enquiries')}
          <span className="stats-swatch stats-swatch-sessions" aria-hidden="true" />
          {t('stats.legend.sessions')}
        </p>
      </Section>

      <Section title={t('stats.sessionsSection')}>
        <dl className="definition stats-definition">
          <dt>{t('stats.upcomingSessions', { days: FORWARD_DAYS })}</dt>
          <dd>{format(view.upcoming.sessions, locale)}</dd>
          <dt>{t('stats.upcomingHours', { days: FORWARD_DAYS })}</dt>
          <dd>{formatHours(view.upcoming.hours, locale)}</dd>
          <dt>{t('stats.upcomingConsultations', { days: FORWARD_DAYS })}</dt>
          <dd>{format(view.upcoming.consultations, locale)}</dd>
          <dt>{t('stats.consultationsHeld')}</dt>
          <dd>{format(view.sessions.current.consultations.held, locale)}</dd>
          <dt>{t('stats.kpi.cancelled')}</dt>
          <dd>
            {format(view.sessions.current.cancelled, locale)}
            {view.sessions.current.cancellationRate === null
              ? ''
              : ` · ${t('stats.kpi.cancelledDetail', { rate: percentOrDash(view.sessions.current.cancellationRate, locale) })}`}
          </dd>
          <dt>{t('stats.noShows')}</dt>
          <dd>{format(view.sessions.current.noShow, locale)}</dd>
          <dt>{t('stats.averageLength')}</dt>
          <dd>{view.sessions.current.averageHours === null ? '—' : formatHours(view.sessions.current.averageHours, locale)}</dd>
        </dl>
        <WeekdayChart counts={view.weekday} locale={locale} />
        <p className="stats-caveat">{t('stats.noUtilisation')}</p>
      </Section>

      {data.finance && view.finance ? (
        <Section title={t('stats.finance')}>
          <div className="stats-money">
            <MoneyBlock title={t('stats.money.received')} hint={t('stats.money.receivedHint')} amounts={view.finance.received} language={language} />
            <MoneyBlock title={t('stats.money.refunded')} hint={t('stats.money.refundedHint')} amounts={view.finance.refunded} language={language} />
            <MoneyBlock
              title={t('stats.money.open')}
              hint={view.finance.partiallyPaid > 0
                ? `${t('stats.money.openHint')} ${t('stats.money.partiallyPaid', { count: view.finance.partiallyPaid })}`
                : t('stats.money.openHint')}
              amounts={view.finance.open}
              language={language}
            />
          </div>
        </Section>
      ) : null}

      <details className="stats-definitions">
        <summary>{t('stats.definitionsTitle')}</summary>
        <dl className="definition">
          <dt>{t('stats.kpi.enquiries')}</dt><dd>{t('stats.def.enquiries')}</dd>
          <dt>{t('stats.kpi.booked')}</dt><dd>{t('stats.def.booked')}</dd>
          <dt>{t('stats.kpi.conversion')}</dt><dd>{t('stats.def.conversion')}</dd>
          <dt>{t('stats.kpi.completed')}</dt><dd>{t('stats.def.completed')}</dd>
          <dt>{t('stats.kpi.hours')}</dt><dd>{t('stats.def.hours')}</dd>
          <dt>{t('stats.kpi.cancelled')}</dt><dd>{t('stats.def.cancelled')}</dd>
          <dt>{t('stats.kpi.repeat')}</dt><dd>{t('stats.def.repeat')}</dd>
          <dt>{t('stats.sources')}</dt><dd>{t('stats.def.sources')}</dd>
          <dt>{t('stats.finance')}</dt><dd>{t('stats.def.finance')}</dd>
        </dl>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Every figure the screen renders, computed once per load.
 *
 * Both windows come out of one dataset, so the comparison is between two slices
 * of the same read rather than two reads taken moments apart.
 */
function summarise(
  data: StatisticsDataset,
  period: PeriodPair,
  label: (row: ChannelRow) => string,
) {
  const now = new Date();
  const { current, previous } = period;
  const maturity = { now, days: CONVERSION_MATURITY_DAYS };
  const comparable = previousPeriodComparable(period, data.historyStart);

  const enquiriesIn = (window: typeof current) =>
    data.enquiries.filter((enquiry) => within(window, enquiry.created_at)).length;

  const sessionsNow = sessionTotals(data.sessions, current);
  const sessionsBefore = sessionTotals(data.sessions, previous);
  const bookingsNow = bookingsMade(data.sessions, current);
  const bookingsBefore = bookingsMade(data.sessions, previous);
  const conversionNow = enquiryConversion(data.enquiries, data.projects, data.sessions, current, maturity);
  const conversionBefore = enquiryConversion(data.enquiries, data.projects, data.sessions, previous, maturity);
  const channels = channelBreakdown(data.enquiries, data.projects, data.sessions, current, maturity);
  const granularity = granularityFor(period.days);
  const enquiries = delta(enquiriesIn(current), enquiriesIn(previous));

  return {
    comparable,
    enquiries,
    bookings: { current: bookingsNow, previous: bookingsBefore },
    bookingsDelta: delta(bookingsNow.tattoo, bookingsBefore.tattoo),
    completed: delta(sessionsNow.completed, sessionsBefore.completed),
    hours: delta(round1(sessionsNow.hours), round1(sessionsBefore.hours)),
    // Conversion moves in percentage points. null whenever either side has no
    // rate: a cohort with no mature enquiries has no conversion, not 0%.
    conversionDelta: rateDelta(conversionNow.rate, conversionBefore.rate),
    conversion: { current: conversionNow, previous: conversionBefore },
    sessions: { current: sessionsNow, previous: sessionsBefore },
    repeat: repeatClients(data.sessions, current),
    upcoming: upcomingLoad(data.sessions, now, FORWARD_DAYS),
    weekday: sessionsByWeekday(data.sessions, current),
    funnel: funnel(data.enquiries, data.projects, data.sessions, current),
    channels,
    granularity,
    // The sessions bar is tattoo work, the same population as every other
    // session figure on the screen.
    series: timeSeries(data.enquiries, data.sessions.filter(isTattooWork), current, granularity),
    finance: data.finance
      ? financeTotals(data.finance.transactions, data.finance.openRequests, current, now)
      : null,
    insights: buildInsights({
      comparable,
      enquiries,
      conversion: { current: conversionNow, previous: conversionBefore },
      sessions: { current: sessionsNow, previous: sessionsBefore },
      channels,
      channelLabel: label,
    }),
  };
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

function TrendChart({
  points, granularity, locale,
}: {
  points: Array<{ bucket: string; enquiries: number; sessions: number }>;
  granularity: 'day' | 'week' | 'month';
  locale: string;
}) {
  const { t } = useLanguage();
  const peak = Math.max(1, ...points.map((point) => Math.max(point.enquiries, point.sessions)));

  return (
    <div className="stats-chart" role="list" aria-label={t('stats.trend')}>
      {points.map((point) => (
        <div
          key={point.bucket}
          className="stats-chart-column"
          role="listitem"
          aria-label={t('stats.trendPoint', {
            bucket: bucketLabel(point.bucket, granularity, locale),
            enquiries: point.enquiries,
            sessions: point.sessions,
          })}
        >
          <div className="stats-chart-bars">
            <span
              className="stats-bar stats-bar-enquiries"
              style={{ height: `${(point.enquiries / peak) * 100}%` }}
            />
            <span
              className="stats-bar stats-bar-sessions"
              style={{ height: `${(point.sessions / peak) * 100}%` }}
            />
          </div>
          <div className="stats-chart-tick">{bucketLabel(point.bucket, granularity, locale)}</div>
        </div>
      ))}
    </div>
  );
}

function FunnelChart({
  funnel: stages, locale,
}: {
  funnel: ReturnType<typeof funnel>;
  locale: string;
}) {
  const { t } = useLanguage();
  const top = Math.max(1, stages.stages[0].count);
  return (
    <div className="stats-funnel">
      {stages.stages.map((stage) => (
        <div key={stage.id} className="stats-funnel-stage">
          <div className="stats-funnel-head">
            <span>{t(`stats.funnel.${stage.id}`)}</span>
            <strong>{format(stage.count, locale)}</strong>
          </div>
          <div className="stats-funnel-track">
            <span className="stats-funnel-fill" style={{ width: `${(stage.count / top) * 100}%` }} />
          </div>
          <div className="stats-funnel-rate">
            {stage.shareOfEnquiries === null ? '' : t('stats.funnelRate', { rate: percentOrDash(stage.shareOfEnquiries, locale) })}
          </div>
        </div>
      ))}
    </div>
  );
}

function WeekdayChart({ counts, locale }: { counts: number[]; locale: string }) {
  const { t } = useLanguage();
  const peak = Math.max(1, ...counts);
  return (
    <div className="stats-weekday" role="list" aria-label={t('stats.weekdayTitle')}>
      {counts.map((count, index) => (
        <div
          key={index}
          className="stats-weekday-row"
          role="listitem"
          aria-label={`${weekdayName(index, locale)}: ${count}`}
        >
          <span className="stats-weekday-name">{weekdayName(index, locale)}</span>
          <span className="stats-weekday-track">
            <span className="stats-weekday-fill" style={{ width: `${(count / peak) * 100}%` }} />
          </span>
          <span className="stats-weekday-count">{format(count, locale)}</span>
        </div>
      ))}
    </div>
  );
}

function ChannelTable({
  rows, locale, language,
}: {
  rows: ChannelRow[];
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{channelLabel(row, language)}</th>
              <td>{format(row.enquiries, locale)}</td>
              <td>{format(row.consulted, locale)}</td>
              <td>{format(row.booked, locale)}</td>
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

function weekdayName(index: number, locale: string): string {
  // 2026-01-05 is a Monday, so index 0 lands on it.
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2026, 0, 5 + index));
}

function bucketLabel(bucket: string, granularity: 'day' | 'week' | 'month', locale: string): string {
  const date = new Date(`${bucket}T00:00:00`);
  if (granularity === 'month') return new Intl.DateTimeFormat(locale, { month: 'short' }).format(date);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
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
