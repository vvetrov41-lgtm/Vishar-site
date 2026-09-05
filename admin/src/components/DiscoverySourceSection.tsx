import { EmptyState, Section } from './StateViews';
import {
  discoveryBreakdown,
  type DiscoverySourceKey,
} from '../lib/discovery-statistics';
import type { StatisticsEnquiryWithDiscovery } from '../lib/statistics-api';
import type { Period } from '../lib/statistics';
import type { Language } from '../lib/i18n';

const ENGLISH_LABELS: Record<DiscoverySourceKey, string> = {
  instagram: 'Instagram',
  chatgpt: 'ChatGPT',
  other_ai: 'Other AI assistant',
  friend_referral: 'Friend / recommendation',
  google: 'Google',
  other: 'Other',
  not_recorded: 'Not recorded',
};

const RUSSIAN_LABELS: Record<DiscoverySourceKey, string> = {
  instagram: 'Instagram',
  chatgpt: 'ChatGPT',
  other_ai: 'Другой AI-ассистент',
  friend_referral: 'Рекомендация друзей',
  google: 'Google',
  other: 'Другое',
  not_recorded: 'Не указано',
};

export function DiscoverySourceSection({
  enquiries,
  period,
  language,
  locale,
}: {
  enquiries: StatisticsEnquiryWithDiscovery[];
  period: Period;
  language: Language;
  locale: string;
}) {
  const rows = discoveryBreakdown(enquiries, period);
  const labels = language === 'ru' ? RUSSIAN_LABELS : ENGLISH_LABELS;
  const copy = language === 'ru'
    ? {
        title: 'Как о вас узнали',
        source: 'Ответ',
        enquiries: 'Заявки',
        share: 'Доля',
        empty: 'За этот период ответов пока нет.',
      }
    : {
        title: 'How clients heard about you',
        source: 'Answer',
        enquiries: 'Enquiries',
        share: 'Share',
        empty: 'No discovery answers in this period.',
      };

  return (
    <Section title={copy.title}>
      {rows.length === 0 ? (
        <EmptyState compact title={copy.empty} />
      ) : (
        <div className="stats-table-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th scope="col">{copy.source}</th>
                <th scope="col">{copy.enquiries}</th>
                <th scope="col">{copy.share}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{labels[row.key]}</th>
                  <td>{new Intl.NumberFormat(locale).format(row.count)}</td>
                  <td>{new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(row.share)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
