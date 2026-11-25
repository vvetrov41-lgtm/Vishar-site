// Detailed body areas share the public enquiry catalogue; the four half
// sleeve variants are the same stable keys as TattooPricing.halves.
// Existing broad tags remain valid. Region-qualified keys avoid collisions.
import {V2_REGIONS,detailsToInput} from './enquiry-v2-catalogue';
import type {EnquiryProjectDetails} from './types';
import type {Language} from './i18n';

export const HALF_VARIANTS = [
 ['upper','Upper half · wraparound','Верхняя половина по кругу'],
 ['lower','Lower half · wraparound','Нижняя половина по кругу'],
 ['outer','Outer side · full length','Внешняя сторона по всей длине'],
 ['inner','Inner side · full length','Внутренняя сторона по всей длине'],
] as const;
export const BODY_ZONE_GROUPS=V2_REGIONS.map(region=>({
 ...region,
 zones:region.placements.filter(p=>p.key!=='other').flatMap(p=>[
 {key:region.key+':'+p.key,label:p.label,placement:p.key,variant:null as string|null},
 ...(['half_sleeve','half_leg_sleeve'].includes(p.key)?HALF_VARIANTS.map(([variant])=>({key:region.key+':'+p.key+':'+variant,label:p.label,placement:p.key,variant})):[])
 ])
}));
export function bodyZoneLabel(key:string, language:Language, translate:(s:string,l:Language)=>string):string {
 const [region,part,variant]=key.split(':');
 const group=BODY_ZONE_GROUPS.find(g=>g.key===region);
 if(!group)return key;
 if(!part)return translate(group.label,language);
 const zone=group.zones.find(z=>z.key===key);
 if(!zone)return key;
 const suffix=HALF_VARIANTS.find(v=>v[0]===variant);
 return translate(group.label,language)+': '+translate(zone.label,language)+(suffix?' · '+suffix[language==='ru'?2:1]:'');
}
export function suggestedBodyZones(details:EnquiryProjectDetails):string[]{
 const input=detailsToInput(details);
 if(!input)return [];
 // If available, prefer the exact half coverage submitted by the client.
 // Read defensively to remain compatible with enquiries before the calculator.
 const raw=details as EnquiryProjectDetails & {calculator_selection?:Array<{region:string;placements:string[];half?:string}>;calculator_estimate?:{project?:{areas?:Array<{region:string;placements:string[];half?:string}>}};calculator_estimate_superseded?:boolean};
 const selected=raw.calculator_selection??(raw.calculator_estimate_superseded?[]:raw.calculator_estimate?.project?.areas??[]);
 return input.areas.flatMap(a=>{
  const zones=a.placements.filter(p=>p!=='other').map(p=>{
   const half=selected.find(s=>s.region===a.region&&s.placements.includes(p))?.half;
   const candidate=a.region+':'+p+(half&&['half_sleeve','half_leg_sleeve'].includes(p)&&HALF_VARIANTS.some(v=>v[0]===half)?':'+half:'');
   return candidate;
  });
  return zones.length?zones:[a.region];
 });
}
