// Shared catalogue and FAQ-based pricing.
(function(root){
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
    // Artist-approved lower half sleeve; remaining partial sleeve bands are draft estimates.
    lowerHalf: {black_grey:[3,4],colour:[4,5]},
    draftPartial: {half_sleeve:{upper:{black_grey:[3,5],colour:[4,6]}},three_quarter_sleeve:{black_grey:[4,7],colour:[5,9]}}
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
const halves={upper:"Upper half",lower:"Lower half",unsure:"Not decided"};
const surfaces={inner:"Inner surface",outer:"Outer surface",unsure:"Not decided"};
const half=k=>["half_sleeve","half_leg_sleeve"].includes(k);
const wraps=k=>["forearm","upper_arm","thigh","calf","shin"].includes(k);
function valid(p){
 if(!p||!Array.isArray(p.areas)||!p.areas.length||p.areas.length>REGIONS.length||new Set(p.areas.map(a=>a?.region)).size!==p.areas.length||!validList(p.styles,STYLES.map(x=>x[0]))||(p.styles.includes("not_sure")&&p.styles.length>1))return false;
 return p.areas.every(a=>{
 const r=regionByKey(a?.region);if(!r||!validList(a.work,WORK.map(x=>x[0]))||(a.work.includes("new")&&a.work.length>1))return false;
 if(r.key==="other")return Array.isArray(a.placements)&&!a.placements.length&&typeof a.other==="string"&&!!a.other.trim()&&a.other.length<=120;
 if(!validList(a.placements,r.placements.map(x=>x[0])))return false;
 if(a.placements.includes("other")&&(typeof a.other!=="string"||!a.other.trim()||a.other.length>120))return false;
 if(a.placements.filter(k=>r.placements.find(x=>x[0]===k)?.[2]).length>1)return false;
 if((paired(a.region)||a.placements.includes("one_side_chest"))&&!Object.hasOwn(sides,a.side))return false;
 return a.placements.length!==1||large(r,a.placements[0])||(Object.hasOwn(scales,a.scale)&&(!wraps(a.placements[0])||a.scale!=="area"||Object.hasOwn(coverage,a.coverage)));
 });
}
const gbp=n=>"£"+n.toLocaleString("en-GB");
const review=reason=>({price:"Individual estimate",time:"To be confirmed",visits:"To be confirmed",reason,numeric:false});
function estimate(p){
 if(!valid(p))return null;
 if(p.areas.some(a=>a.work.some(w=>w!=="new")))return review("Existing ink needs individual assessment. Send photos of the tattoo and surrounding skin.");
 if(p.areas.length!==1)return review("Multiple areas need an individual plan to avoid counting overlapping work twice.");
 const a=p.areas[0],r=regionByKey(a.region),part=a.placements.find(k=>r.placements.find(x=>x[0]===k)?.[2])||a.placements[0];
 if(paired(a.region)&&a.side==="both"||a.placements.includes("one_side_chest")&&a.side==="both")return review("The FAQ ranges refer to one limb. Both limbs need an individual plan.");
 if(a.placements.length!==1&&!["full_sleeve","full_leg_sleeve","half_sleeve","three_quarter_sleeve","half_leg_sleeve"].includes(part))return review("Combined placements need a personalised estimate.");
 let hours,sessions,open=false,reason,provisional=false;
 if(["full_sleeve","full_leg_sleeve"].includes(part)){
 const extra=part==="full_leg_sleeve"?rules.legExtra:0;
 const band=p.styles.length===1&&p.styles[0]!=="not_sure"?rules[p.styles[0]]:[rules.black_grey[0],rules.colour[1]];
 sessions=band.map(n=>n+extra);open=true;reason="Guide for one full sleeve. Mixed or undecided styles use the combined FAQ range. Detailed designs may take longer.";
 }else if(["full_back","full_chest"].includes(part)){sessions=rules.torso;open=true;reason="Broad FAQ range for major back or torso projects, not a placement-specific quote.";}
 else if(["half_sleeve","three_quarter_sleeve"].includes(part)){
 const approved=part==="half_sleeve"&&a.half==="lower";
 const band=approved?rules.lowerHalf:part==="half_sleeve"?rules.draftPartial[part][a.half]:rules.draftPartial[part];
 if(!band||!band.black_grey)return review("Choose the upper or lower half of the arm for a planning range.");
 sessions=p.styles.length===1&&band[p.styles[0]]?band[p.styles[0]]:[band.black_grey[0],band.colour[1]];open=!approved;provisional=!approved;reason=approved?"Artist-approved guide for a lower half sleeve. Actual time depends on the composition and wraparound coverage.":"Provisional planning range for partial sleeves; not an established FAQ estimate. Actual time depends on the composition and wraparound coverage.";
 }else if(part==="half_leg_sleeve")return review("Partial leg sleeves need an individual estimate.");
 else if(a.scale==="small"&&!["neck_head","hand","foot","other"].includes(a.region)&&part!=="other"){hours=rules.small;sessions=[1,1];reason="Possible for a smaller idea if the placement, detail and realism style are suitable.";}
 else if(a.scale==="area"&&["forearm","upper_arm","shoulder"].includes(part)){
 if(part!=="shoulder"&&a.coverage!=="panel")return review("Wraparound or uncertain coverage needs individual assessment.");
 sessions=part==="forearm"?rules.forearm:rules.upper;reason="General FAQ guide. Colour and dense detail can affect the final time; no unverified multiplier is applied.";
 }else return review("The FAQ does not specify a reliable range for this exact placement and size.");
 const fullDays=!hours;hours ||= sessions.map(n=>n*rules.day);
 const range=(arr,fmt=String)=>fmt(arr[0])+(arr[0]===arr[1]?"":"–"+fmt(arr[1]))+(open?"+":"");
 return {price:range(hours.map(n=>n*rules.hourly),gbp),time:range(hours)+" hours",visits:range(sessions)+(sessions[1]===1?" session":" sessions"),numeric:true,hours,sessions,open,provisional,reason:reason+(fullDays?" Budget assumes up to "+rules.day+" hours per full day. You pay for tattooing time used.":"")};
}
function booking(p){
 if(!valid(p))return null;
 const notes=[],labels=[];
 for(const a of p.areas){
 const r=regionByKey(a.region),label=a.region==="other"?a.other:a.placements.map(k=>k==="other"?a.other:r.placements.find(x=>x[0]===k)[1]).join(", ");
 labels.push(label);notes.push([label,sides[a.side],a.placements.some(half)?halves[a.half]:null,a.placements.length===1&&!large(r,a.placements[0])?scales[a.scale]:null,a.scale==="area"&&a.placements.length===1&&wraps(a.placements[0])?coverage[a.coverage]:null,a.placements.includes("forearm")&&a.coverage==="panel"?surfaces[a.surface]:null].filter(Boolean).join(" / "));
 }
 return {areas:p.areas.map(a=>({region:a.region,placements:a.placements.slice(),work:a.work.slice(),other:a.other||""})),styles:p.styles.slice(),notes:notes.join("; ").slice(0,160),label:labels.join("; ").slice(0,160),result:estimate(p),project:p};
}
function fromHash(hash){const q=new URLSearchParams(hash.slice(1));if(q.get("estimate")!=="2")return null;try{const raw=q.get("project");return raw&&raw.length<=6000?booking(JSON.parse(raw)):null;}catch{return null;}}
function budgetPlan(amount){if(!Number.isFinite(amount)||amount<0)return null;const hours=Math.floor(amount/rules.hourly*4)/4;return {hours,fullDays:Math.floor(hours/rules.day),remainderHours:hours%rules.day,unused:Math.round((amount-hours*rules.hourly)*100)/100};}
const api={rules,budgetPlan,REGIONS,WORK,STYLES,sides,scales,coverage,regionByKey,large,limb,paired,wraps,half,halves,surfaces,valid,estimate,booking,fromHash};
if(typeof module==="object"&&module.exports)module.exports=api;else root.TattooPricing=api;
})(globalThis);
