import { EmptyState, Section } from './StateViews';
import { discoveryBreakdown } from '../lib/discovery-statistics';
import { discoverySourceLabel } from '../lib/discovery-source-registry';
import type { StatisticsEnquiryWithDiscovery } from '../lib/statistics-api';
import type { Period } from '../lib/statistics';
import type { Language } from '../lib/i18n';

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
                  <th scope="row">{discoverySourceLabel(row.key, language)}</th>
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
