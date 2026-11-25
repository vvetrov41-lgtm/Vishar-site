import type { Language } from '../lib/i18n';
import type { EnquiryProjectDetails, TattooCoverage } from '../lib/types';
import { COVERAGE_KEYS, V2_REGIONS, currentCalculatorSelection } from '../lib/enquiry-v2-catalogue';
import { catalogueLabel } from './EnquiryProjectDetails';
import './TattooSelection.css';

const labels = {
 en:{side:'Side',half:'Half sleeve',scale:'Size',coverage:'Coverage',surface:'Surface',estimate:'Client calculator estimate',historical:'Original estimate · needs review',note:'Indicative only, not an agreed price.',stale:'The project has changed. This original estimate no longer applies.',touch:'Possible touch-up after healing is not included.',time:'Tattooing time',sessions:'Sessions',cost:'Estimated cost',review:'Individual estimate',areas:'Selected coverage'},
 ru:{side:'Сторона',half:'Полурукав',scale:'Размер',coverage:'Покрытие',surface:'Поверхность',estimate:'Оценка клиента из калькулятора',historical:'Исходная оценка · требует пересмотра',note:'Ориентир, не согласованная стоимость.',stale:'Параметры проекта изменились. Исходная оценка больше не актуальна.',touch:'Возможная коррекция после заживления не включена.',time:'Время работы',sessions:'Сеансы',cost:'Стоимость',review:'Индивидуальная оценка',areas:'Выбранное покрытие'}
} as const;
const values: Record<string, Record<string, [string,string]>> = {
 side:{left:['Left','Левая'],right:['Right','Правая'],both:['Both sides','Обе стороны'],unsure:['Not decided','Не определено']},
 half:{upper:['Upper half · wraparound','Верхняя половина по кругу'],lower:['Lower half · wraparound','Нижняя половина по кругу'],outer:['Outer side · full length','Внешняя сторона по всей длине'],inner:['Inner side · full length','Внутренняя сторона по всей длине'],unsure:['Not decided','Не определено']},
 scale:{small:['Small piece','Небольшая татуировка'],area:['Full area','Вся область'],unsure:['Not decided','Не определено']},
 coverage:{panel:['One surface','Одна поверхность'],wrap:['Wraparound','По кругу'],unsure:['Not decided','Не определено']},
 surface:{front:['Front','Передняя'],back:['Back','Задняя'],inner:['Inner','Внутренняя'],outer:['Outer','Внешняя'],unsure:['Not decided','Не определено']}
};
export function coverageLabel(key:keyof TattooCoverage,language:Language){return labels[language][key];}
export function coverageValue(key:keyof TattooCoverage,value:string,language:Language){return values[key]?.[value]?.[language==='ru'?1:0]??value;}
export function TattooSelection({details,language}:{details:EnquiryProjectDetails;language:Language}){
 const copy=labels[language], selection=currentCalculatorSelection(details), estimate=details.calculator_estimate, result=estimate?.result;
 if(!selection.length&&!result)return null;
 const range=(numbers:number[]|null,unit:string,open:boolean)=>numbers?.length?numbers.join('–')+(open?'+':'')+' '+unit:'—';
 return <div className="tattoo-selection" data-testid="tattoo-selection">
 {selection.length>0?<section aria-label={copy.areas}><h3>{copy.areas}</h3>{selection.map(a=>{
 const region=V2_REGIONS.find(r=>r.key===a.region);
 return <div className="tattoo-selection-area" key={a.region}><strong>{catalogueLabel(region?.label??a.region,language)} · {a.placements.map(p=>catalogueLabel(region?.placements.find(x=>x.key===p)?.label??p,language)).join(', ')}</strong>
 <div className="tattoo-selection-tags">{COVERAGE_KEYS.filter(k=>a[k]&&a[k]!=='unsure').map(k=><span key={k}>{coverageValue(k,a[k]!,language)}</span>)}</div></div>;
 })}</section>:null}
 {result?<section className="tattoo-estimate" aria-label={details.calculator_estimate_superseded?copy.historical:copy.estimate}>
 <h3>{details.calculator_estimate_superseded?copy.historical:copy.estimate}</h3>
 <div className="tattoo-estimate-price">{result.numeric?result.price:copy.review}</div>
 {result.numeric?<div className="tattoo-estimate-metrics"><div><strong>{range(result.hours,language==='ru'?'ч':'h',result.open)}</strong><span>{copy.time}</span></div><div><strong>{range(result.sessions,language==='ru'?'':'',result.open).trim()}</strong><span>{copy.sessions}</span></div></div>:null}
 <p className="meta">{details.calculator_estimate_superseded?copy.stale:copy.note}</p>
 {result.cover_up?<p className="meta">{copy.touch}</p>:null}
 {estimate?.breakdown&&estimate.breakdown.length>1?<details><summary>{language==='ru'?'Оценки по зонам':'Area estimates'}</summary>{estimate.breakdown.map(b=><div className="tattoo-selection-area" key={b.region}>{catalogueLabel(V2_REGIONS.find(r=>r.key===b.region)?.label??b.region,language)}: {b.result?.numeric?b.result.price:copy.review}</div>)}</details>:null}
 </section>:null}</div>;
}
