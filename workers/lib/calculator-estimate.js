// Optional non-binding calculator estimate: use the same versioned engine as the website.
// Never accept client-supplied prices or use this to set confirmed finance fields.
import pricing from '../../assets/js/tattoo-pricing.js';
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every(x=>b.includes(x));
const pick=(map,value)=>typeof value==='string'&&Object.hasOwn(map,value)?value:undefined;
export function normaliseCalculatorEstimate(raw,areas,styleKeys){
 try{
  if(!raw||raw.schema!=='tattoo-estimate-v1'||raw.rules_version!==pricing.rulesVersion)return null;
  const project=raw.project;
  if(!project||!Array.isArray(project.areas)||project.areas.length!==areas.length||!same(project.styles,styleKeys))return null;
  const clean={styles:styleKeys.slice(),areas:[]};
  for(const source of project.areas){
   const match=areas.find(a=>a.key===source?.region);
   if(!match||!same(source.placements,match.placementKeys)||!same(source.work,match.workKeys))return null;
   if((match.otherPlacement||'')!==(typeof source.other==='string'?source.other.trim():''))return null;
   clean.areas.push({region:match.key,placements:match.placementKeys.slice(),work:match.workKeys.slice(),other:match.otherPlacement||'',side:pick(pricing.sides,source.side),scale:pick(pricing.scales,source.scale),coverage:pick(pricing.coverage,source.coverage),half:pick(pricing.halves,source.half),surface:pick(pricing.surfaces,source.surface)});
  }
  if(!pricing.valid(clean))return null;
  const result=pricing.estimate(clean);if(!result)return null;
  const summarize=r=>r&&({numeric:r.numeric,price:r.price,time:r.time,visits:r.visits,hours:r.hours??null,sessions:r.sessions??null,cost_gbp:r.numeric?r.hours.map(h=>Math.round(h*pricing.rules.hourly*100)/100):null,open:!!r.open,provisional:!!r.provisional,cover_up:!!r.coverUp});
  return {schema:'tattoo-estimate-v1',rules_version:pricing.rulesVersion,currency:'GBP',non_binding:true,project:clean,result:summarize(result),breakdown:pricing.breakdown(clean).map(a=>({region:a.region,result:summarize(a.result)}))};
 }catch{return null;} // Invalid optional metadata never prevents ordinary intake.
}
