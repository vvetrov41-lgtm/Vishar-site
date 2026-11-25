// Shared catalogue and FAQ-based pricing.
(function(root){
const SHOW_DRAFT_RANGES=true; // Artist authorised indicative estimates in public; provisional estimates remain labelled.
const rules = {
    hourly: 140,
    day: 7,
    small: [3, 4],
    forearm: [1, 2],
    upper: [2, 3],
    black_grey: [6, 8],
    colour: [8, 10],
    legExtra: 2,
    torso: [6, 12],
    // Indicative, not a fixed quote. Colour may take longer because of layering and saturation.
    colourPlanningFactor: 1.25,
    chest: {black_grey:[3,5],colour:[4,6]},
    // Artist-approved lower half sleeve; remaining partial sleeve bands are draft estimates.
    lowerHalf: {black_grey:[3,4],colour:[4,5]},
    draftPartial: {
 half_sleeve:{upper:{black_grey:[3,5],colour:[4,6]},outer:{black_grey:[3,5],colour:[4,6]},inner:{black_grey:[3,5],colour:[4,6]}},
 half_leg_sleeve:{upper:{black_grey:[4,6],colour:[5,7]},lower:{black_grey:[4,5],colour:[5,6]},outer:{black_grey:[4,6],colour:[5,7]},inner:{black_grey:[4,6],colour:[5,7]}},
 three_quarter_sleeve:{black_grey:[4,7],colour:[5,9]}
 },
 // Draft hours for one new area-sized realism project. No centimetre-based
 // pricing and no claim these are measured historical session averages.
 draftHours:{
 inner_bicep:[7,14],elbow:[4,7],wrist:[3,6],thigh:[14,28],knee:[4,7],calf:[7,21],shin:[7,21],ankle:[3,7],
 sternum:[7,14],one_side_chest:[7,21],collarbone:[3,7],ribs:[14,28],upper_back:[21,42],shoulder_blade:[14,28],spine:[7,14],lower_back:[14,28],
 stomach:[14,35],side:[14,28],hip:[7,21],front_neck:[7,14],side_neck:[4,10],back_neck:[4,10],behind_ear:[2,4],head:[14,35],
 back_of_hand:[4,7],fingers:[1,3],side_of_hand:[2,5],top_of_foot:[4,10],side_of_foot:[2,5],toes:[1,3]
 },
 draftWrap:{thigh:[28,42],calf:[21,35],shin:[21,35]}
  };
  var REGIONS = [
    { key: 'arm', label: 'Arm', placements: [
      ['shoulder', 'Shoulder'], ['upper_arm', 'Upper arm'], ['inner_bicep', 'Inner bicep'], ['elbow', 'Elbow'],
      ['forearm', 'Forearm'], ['wrist', 'Wrist'], ['half_sleeve', 'Half sleeve', 'arm_sleeve', true],
      ['three_quarter_sleeve', '3/4 sleeve', 'arm_sleeve', true], ['full_sleeve', 'Full sleeve', 'arm_sleeve', true],
      ['other', 'Other'] ] },
    { key: 'leg', label: 'Leg', placements: [
      ['thigh', 'Thigh'], ['knee', 'Knee'], ['calf', 'Calf'], ['shin', 'Shin'], ['ankle', 'Ankle'],
      ['half_leg_sleeve', 'Half leg sleeve', 'leg_sleeve', true], ['full_leg_sleeve', 'Full leg sleeve', 'leg_sleeve', true],
      ['other', 'Other'] ] },
    { key: 'chest_ribs', label: 'Chest & Ribs', placements: [
      ['sternum', 'Sternum'], ['one_side_chest', 'One side of chest'], ['collarbone', 'Collarbone'], ['ribs', 'Ribs'],
      ['full_chest', 'Full chest', null, true], ['other', 'Other'] ] },
    { key: 'back', label: 'Back', placements: [
      ['upper_back', 'Upper back'], ['shoulder_blade', 'Shoulder blade'], ['spine', 'Spine'], ['lower_back', 'Lower back'],
      ['full_back', 'Full back', null, true], ['other', 'Other'] ] },
    { key: 'stomach_sides', label: 'Stomach & Sides', placements: [
      ['stomach', 'Stomach'], ['side', 'Side'], ['hip', 'Hip'], ['other', 'Other'] ] },
    { key: 'neck_head', label: 'Neck & Head', placements: [
      ['front_neck', 'Front of neck'], ['side_neck', 'Side of neck'], ['back_neck', 'Back of neck'],
      ['behind_ear', 'Behind the ear'], ['head', 'Head'], ['other', 'Other'] ] },
    { key: 'hand', label: 'Hand', placements: [
      ['back_of_hand', 'Back of hand'], ['fingers', 'Fingers'], ['side_of_hand', 'Side of hand'], ['other', 'Other'] ] },
    { key: 'foot', label: 'Foot', placements: [
      ['top_of_foot', 'Top of foot'], ['side_of_foot', 'Side of foot'], ['toes', 'Toes'], ['other', 'Other'] ] },
    { key: 'other', label: 'Other', placements: [] }
  ];
  var WORK = [['new', 'No existing tattoo'], ['extension', 'Extend existing tattoo'], ['cover_up', 'Cover-up'], ['rework', 'Rework']];
  var WORK_REVIEW = { new: 'New tattoo', extension: 'Extension', cover_up: 'Cover-up', rework: 'Rework' };
  var STYLES = [['black_grey', 'Black & Grey realism'], ['colour', 'Colour realism'], ['not_sure', 'Not sure yet']];

const regionByKey=k=>REGIONS.find(r=>r.key===k);
const sides={left:"Left",right:"Right",both:"Both sides",unsure:"Not decided"};
const scales={small:"Small idea (3–4 hours if suitable)",area:"Area-sized design",unsure:"Not decided"};
const coverage={panel:"One surface",wrap:"Wraps around",unsure:"Not decided"};
const validList=(list,keys)=>Array.isArray(list)&&list.length>0&&new Set(list).size===list.length&&list.every(k=>keys.includes(k));
const large=(r,k)=>r.placements.find(x=>x[0]===k)?.[3];
const limb=r=>["arm","leg"].includes(r);
const paired=r=>["arm","leg","hand","foot"].includes(r);
const halves={upper:"Upper half · wraparound",lower:"Lower half · wraparound",outer:"Full-length outer side",inner:"Full-length inner side",unsure:"Not decided"};
const longitudinal=h=>h==="outer"||h==="inner";
const surfaces={front:"Front surface",back:"Back surface",inner:"Inner surface",outer:"Outer surface",unsure:"Not decided"};
const half=k=>["half_sleeve","half_leg_sleeve"].includes(k);
const sidedPlacement=k=>["one_side_chest","collarbone","ribs","shoulder_blade","side","hip","side_neck","behind_ear"].includes(k);
const sided=a=>paired(a.region)||a.placements.some(sidedPlacement);
const wraps=k=>["forearm","upper_arm","thigh","calf","shin"].includes(k);
function valid(p){
 if(!p||!Array.isArray(p.areas)||!p.areas.length||p.areas.length>REGIONS.length||new Set(p.areas.map(a=>a?.region)).size!==p.areas.length||!validList(p.styles,STYLES.map(x=>x[0]))||(p.styles.includes("not_sure")&&p.styles.length>1))return false;
 return p.areas.every(a=>{
 const r=regionByKey(a?.region);if(!r||!validList(a.work,WORK.map(x=>x[0]))||(a.work.includes("new")&&a.work.length>1))return false;
 if(r.key==="other")return Array.isArray(a.placements)&&!a.placements.length&&typeof a.other==="string"&&!!a.other.trim()&&a.other.length<=120;
 if(!validList(a.placements,r.placements.map(x=>x[0])))return false;
 if(a.placements.includes("other")&&(typeof a.other!=="string"||!a.other.trim()||a.other.length>120))return false;
 if(a.placements.filter(k=>r.placements.find(x=>x[0]===k)?.[2]).length>1)return false;
 if(sided(a)&&!Object.hasOwn(sides,a.side))return false;
 if(a.placements.some(half)&&a.half!==undefined&&!Object.hasOwn(halves,a.half))return false;
 return a.placements.length!==1||large(r,a.placements[0])||(Object.hasOwn(scales,a.scale)&&(!wraps(a.placements[0])||a.scale!=="area"||Object.hasOwn(coverage,a.coverage)));
 });
}
const gbp=n=>"£"+n.toLocaleString("en-GB");
const review=reason=>({price:"Individual estimate",time:"To be confirmed",visits:"To be confirmed",reason,numeric:false});
function estimateSingle(p){
 if(!valid(p))return null;
 if(p.areas.length!==1)return review("Multiple areas need an individual plan to avoid counting overlapping work twice.");
 const existing=p.areas[0].work;
 if(existing.length===1&&existing[0]==="cover_up"){
  const base=estimateSingle({areas:[{...p.areas[0],work:["new"]}],styles:["colour"]});
  const advice="Cover-ups usually take a similar amount of time to colour realism, even in black and grey. A touch-up may be needed after full healing; its time and cost are not included. Photos of the existing tattoo are needed to confirm suitability and the estimate.";
  if(!base?.numeric)return {...review(advice),coverUp:true};
  return {...base,provisional:true,coverUp:true,reason:advice+(base.provisional?" The underlying area range is also provisional.":"")};
 }
 if(existing.some(w=>w!=="new"))return review("Existing ink needs individual assessment. Send photos of the tattoo and surrounding skin.");
 const a=p.areas[0],r=regionByKey(a.region),part=a.placements.find(k=>r.placements.find(x=>x[0]===k)?.[2])||a.placements[0];
 if(sided(a)&&a.side==="both")return review("This range is for one side. Both sides need an individual plan.");
 if(a.placements.length!==1)return review("Combined placements need a personalised estimate.");
 let hours,sessions,open=false,reason,provisional=false;
 if(["full_sleeve","full_leg_sleeve"].includes(part)){
 const extra=part==="full_leg_sleeve"?rules.legExtra:0;
 const band=p.styles.length===1&&p.styles[0]!=="not_sure"?rules[p.styles[0]]:[rules.black_grey[0],rules.colour[1]];
 sessions=band.map(n=>n+extra);open=true;reason="Guide for one full sleeve. Mixed or undecided styles use the combined FAQ range. Detailed designs may take longer.";
 }else if(part==="full_back"){sessions=p.styles.includes("colour")&&p.styles.length===1?[8,12]:rules.torso;open=true;reason="Broad FAQ range for major back projects.";}
 else if(part==="full_chest"){const b=rules.chest;sessions=p.styles.length===1&&b[p.styles[0]]?b[p.styles[0]]:[b.black_grey[0],b.colour[1]];open=true;provisional=true;reason="Indicative chest-specific planning range.";}
 else if(["half_sleeve","half_leg_sleeve","three_quarter_sleeve"].includes(part)){
 const approved=part==="half_sleeve"&&a.half==="lower";
 if(!approved&&!SHOW_DRAFT_RANGES)return review("This coverage needs a personal estimate.");
 const band=approved?rules.lowerHalf:half(part)?rules.draftPartial[part][a.half]:rules.draftPartial[part];
 if(!band||!band.black_grey)return review("Choose a half-sleeve coverage pattern for a planning range.");
 sessions=p.styles.length===1&&band[p.styles[0]]?band[p.styles[0]]:[band.black_grey[0],band.colour[1]];open=!approved;provisional=!approved;reason=approved?"Artist-approved guide for a lower half sleeve. Actual time depends on the composition and wraparound coverage.":"Provisional planning range for partial sleeves; not an established FAQ estimate. Actual time depends on the composition and wraparound coverage.";
 }else if(a.scale==="small"&&!["neck_head","hand","foot","other"].includes(a.region)&&part!=="other"){hours=rules.small;sessions=[1,1];reason="Possible for a smaller idea if the placement, detail and realism style are suitable.";}
 else if(a.scale==="area"&&["forearm","upper_arm","shoulder"].includes(part)){
 if(part!=="shoulder"&&a.coverage==="wrap"){
 const approved=part==="forearm";if(!approved&&!SHOW_DRAFT_RANGES)return review("Wraparound coverage needs a personal estimate.");
 const band=approved?rules.lowerHalf:rules.draftPartial.half_sleeve.upper;
 sessions=p.styles.length===1&&band[p.styles[0]]?band[p.styles[0]]:[band.black_grey[0],band.colour[1]];open=!approved;provisional=!approved;reason=approved?"Artist-approved lower half sleeve guide.":"Provisional upper half sleeve guide.";
 }else{if(part!=="shoulder"&&a.coverage!=="panel")return review("Uncertain coverage needs individual assessment.");
 sessions=part==="forearm"?rules.forearm:rules.upper;if(p.styles.length===1&&p.styles[0]==="colour"){hours=part==="forearm"?[10,14]:[18,21];sessions=hours.map(h=>Math.ceil(h/rules.day));provisional=true;}reason="General FAQ guide; colour may need more time.";}
 }else if(SHOW_DRAFT_RANGES&&rules.draftHours[part]){
 const band=a.coverage==="wrap"&&rules.draftWrap[part]?rules.draftWrap[part]:rules.draftHours[part];
 hours=band.slice();if(a.scale==="small")hours=[Math.min(3,band[0]),Math.min(4,band[1])];
 // A conservative preliminary allowance, rounded to whole hours rather than false minute precision.
 if(p.styles.includes("colour")||p.styles.includes("not_sure")){const longer=hours.map(h=>Math.ceil(h*rules.colourPlanningFactor));hours=p.styles.length===1&&p.styles[0]==="colour"?longer:[hours[0],longer[1]];}
 sessions=hours.map(h=>Math.ceil(h/rules.day));provisional=true;reason="Preliminary planning range, not a published FAQ or artist-confirmed quote. Suitability, colour, skin and detail can change the duration.";
 }else return review("The FAQ does not specify a reliable range for this exact placement and size.");
 const fullDays=!hours;hours ||= sessions.map(n=>n*rules.day);
 const range=(arr,fmt=String)=>fmt(arr[0])+(arr[0]===arr[1]?"":"–"+fmt(arr[1]))+(open?"+":"");
 return {price:range(hours.map(n=>n*rules.hourly),gbp),time:range(hours)+" hours",visits:range(sessions)+(sessions[1]===1?" session":" sessions"),numeric:true,hours,sessions,open,provisional,reason:reason+(fullDays?" Budget assumes up to "+rules.day+" hours per full day. You pay for tattooing time used.":"")};
}
// Only add independent arm/leg estimates with established pricing.
function breakdown(p){
 if(!valid(p))return [];
 return p.areas.map(a=>({region:a.region,result:estimateSingle({areas:[a],styles:p.styles})}));
}
function estimate(p){
 if(!valid(p))return null;
 if(p.areas.length===1)return estimateSingle(p);
 const parts=breakdown(p);
 if(p.areas.every(a=>limb(a.region))&&parts.every(x=>x.result?.numeric&&!x.result.provisional)){
  const hours=[0,0],sessions=[0,0];
  for(const {result} of parts){for(let i=0;i<2;i++){hours[i]+=result.hours[i];sessions[i]+=result.sessions[i];}}
  const open=parts.some(x=>x.result.open);
  const range=(arr,fmt=String)=>fmt(arr[0])+(arr[0]===arr[1]?"":"–"+fmt(arr[1]))+(open?"+":"");
  return {price:range(hours.map(n=>n*rules.hourly),gbp),time:range(hours)+" hours",visits:range(sessions)+" sessions",numeric:true,hours,sessions,open,provisional:true,combined:true,reason:"Planning total for separate arm and leg projects, assuming they are tattooed independently. The actual design and scheduling may change the total."};
 }
 return {...review("A combined project needs an individual assessment. The separate area guides below are not a total and should not be added together."),combined:true};
}
function booking(p){
 if(!valid(p))return null;
 const notes=[],labels=[];
 for(const a of p.areas){
 const r=regionByKey(a.region),label=a.region==="other"?a.other:a.placements.map(k=>k==="other"?a.other:r.placements.find(x=>x[0]===k)[1]).join(", ");
 labels.push(label);notes.push([label,sides[a.side],a.placements.some(half)?halves[a.half]:null,a.placements.length===1&&!large(r,a.placements[0])?scales[a.scale]:null,a.scale==="area"&&a.placements.length===1&&wraps(a.placements[0])?coverage[a.coverage]:null,a.placements.some(k=>["forearm","upper_arm","thigh"].includes(k))&&a.coverage==="panel"?surfaces[a.surface]:null].filter(Boolean).join(" / "));
 }
 return {areas:p.areas.map(a=>({region:a.region,placements:a.placements.slice(),work:a.work.slice(),other:a.other||""})),styles:p.styles.slice(),notes:notes.join("; ").slice(0,160),notesFull:notes.join("; "),label:labels.join("; ").slice(0,160),result:estimate(p),project:p};
}
function fromHash(hash){const q=new URLSearchParams(hash.slice(1));if(q.get("estimate")!=="2")return null;try{const raw=q.get("project");return raw&&raw.length<=6000?booking(JSON.parse(raw)):null;}catch{return null;}}
function budgetPlan(amount){if(!Number.isFinite(amount)||amount<0)return null;const hours=Math.floor(amount/rules.hourly*4)/4;return {hours,fullDays:Math.floor(hours/rules.day),remainderHours:hours%rules.day,unused:Math.round((amount-hours*rules.hourly)*100)/100};}
const api={rulesVersion:'2026-11-25.1',rules,budgetPlan,breakdown,REGIONS,WORK,STYLES,sides,scales,coverage,regionByKey,large,limb,paired,sided,sidedPlacement,wraps,half,halves,longitudinal,surfaces,valid,estimate,booking,fromHash};
if(typeof module==="object"&&module.exports)module.exports=api;else root.TattooPricing=api;
})(globalThis);
