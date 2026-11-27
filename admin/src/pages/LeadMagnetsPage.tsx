import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useApi } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import './LeadMagnetsPage.css';

export function LeadMagnetsPage() {
  const api=useApi();
  const {selectedArtistId}=useArtistScope();
  const {language}=useLanguage();
  const ru=language==='ru';
  const {data,loading,error,reload}=useAsync(()=>api.loadLeadMagnets(selectedArtistId),[api,selectedArtistId]);
  if(loading)return <LoadingState/>;
  if(error)return <ErrorState message={error} onRetry={reload}/>;
  if(!data?.length)return <EmptyState title={ru?'Нет доступных лид-магнитов':'No lead magnets yet'} hint={ru?'Запросы гайда будут учитываться отдельно от заявок.':'Guide requests are tracked separately from tattoo enquiries.'}/>;
  return <div className="lead-magnets-page">
    <p>{ru?'Запросы материалов и доставка. Сопоставленные по email заявки не доказывают причинную связь с рекламой.':'Guide requests and delivery. Later email-matched enquiries are not proof of advertising attribution.'}</p>
    {data.map(row=><Section key={row.artist_id+':'+row.slug} title={row.slug==='cover-up-guide'?'The Art of Tattoo Cover-Ups':row.slug} action={<button type="button" onClick={reload}>{ru?'Обновить':'Refresh'}</button>}>
      <p>{row.artist_name} · {row.version} · {row.active?(ru?'Доступен':'Active'):(ru?'Отключён':'Disabled')}</p>
      <div className="lead-magnet-metrics">
      {[[ru?'Получатели':'Recipients',row.recipients],[ru?'Запросы':'Requests',row.requests],[ru?'Доставлено':'Delivered',row.delivered],[ru?'Согласия':'Opted in',row.opted_in],[ru?'Совпадения с заявками':'Matched enquiries',row.matched_enquiries],[ru?'Требуют внимания':'Delivery attention',row.delivery_attention]].map(([label,value])=><div key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <h3>{ru?'Источники (с согласия)':'Sources (with consent)'}</h3>
      {row.sources.length?<ul className="lead-magnet-sources">{row.sources.map(s=><li key={s.source+':'+s.campaign}><span>{s.source==='unattributed'?(ru?'Без атрибуции':'Unattributed'):s.source}{s.campaign?' / '+s.campaign:''}</span><strong>{s.requests}</strong></li>)}</ul>:<p>{ru?'Пока нет запросов':'No requests yet'}</p>}
    </Section>)}
  </div>;
}
