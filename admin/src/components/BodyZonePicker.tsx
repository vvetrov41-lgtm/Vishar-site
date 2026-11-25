import {BODY_ZONE_GROUPS,bodyZoneLabel} from '../lib/body-zones';
import type {Language} from '../lib/i18n';
import {catalogueLabel} from './EnquiryProjectDetails';

export function BodyZonePicker({value,onChange,language,label}:{value:string;onChange:(value:string)=>void;language:Language;label:string}){
 const copy=language==='ru'?{pick:'Добавить конкретную зону',limit:'Максимум 160 символов. Уточни расположение в описании.'}:{pick:'Add a specific body area',limit:'Maximum 160 characters. Add more detail in the description.'};
 return <div style={{minWidth:0,display:'grid',gap:6}}>
 <label>{label}<input value={value} maxLength={160} onChange={e=>onChange(e.target.value)}/></label>
 <label>{copy.pick}<select value="" onChange={e=>{
  const key=e.target.value;if(!key)return;
  // Existing text stays editable and is never truncated silently.
  const next=bodyZoneLabel(key,'en',catalogueLabel);
  const parts=value.split('; ').filter(Boolean);
  if(!parts.includes(next)){const combined=[...parts,next].join('; ');if(combined.length<=160)onChange(combined);}
 }} style={{width:'100%',minHeight:44}}>
 <option value="">{copy.pick}</option>
 {BODY_ZONE_GROUPS.map(g=><optgroup key={g.key} label={catalogueLabel(g.label,language)}>
 {g.zones.map(z=><option key={z.key} value={z.key} disabled={value.split('; ').includes(bodyZoneLabel(z.key,'en',catalogueLabel))||[value,bodyZoneLabel(z.key,'en',catalogueLabel)].filter(Boolean).join('; ').length>160}>{bodyZoneLabel(z.key,language,catalogueLabel)}</option>)}
 </optgroup>)}
 </select></label>
 <small className="meta">{copy.limit}</small>
 </div>;
}
