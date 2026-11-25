(() => {
const api=window.TattooPricing,geo=window.TattooBodyGeometry,$=id=>document.getElementById(id);
const body=$("calc-body"),next=$("calc-next"),p={areas:[],styles:["black_grey"]};
const embedded=!!body.closest("dialog");
let view="front",mode="project",hours=7,budget=2000,started=false,combine=false,activeRegion="";
const assetBase=new URL("calculator3d/",document.currentScript.src);
let modelMode=embedded?"2d":"3d",modelHost=null,modelViewer=null,modelLoad=null,modelFailed=false;
const node=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;};
const money=n=>"£"+n.toLocaleString("en-GB",{maximumFractionDigits:0});
function event(name){try{if(location.hostname==="vishartattoo.com"&&localStorage.getItem("vishar-cookie-consent")==="granted")window.gtag?.("event",name,{calculator_version:3});}catch{}}
function start(){if(!started){started=true;event("tattoo_estimate_start");}}
const areaFor=k=>p.areas.find(a=>a.region===k);
const activeArea=()=>areaFor(activeRegion)||p.areas[0];
const lengthSteps=[["forearm","Forearm panel"],["half_sleeve","Half sleeve"],["three_quarter_sleeve","¾ sleeve"],["full_sleeve","Full sleeve"]];
function choose(region,part,side,surface="unsure",other=""){
 const prev=areaFor(region),same=!!prev;
 const a={region,placements:region==="other"?[]:[part],work:same?prev.work.slice():["new"],side:side||(same&&prev.side)||"left",scale:"area",coverage:"panel",half:api.half(part)?(same&&prev.half&&prev.half!=="unsure"?prev.half:same&&prev.placements.includes("forearm")?"lower":"upper"):"",surface,other:other||(region==="other"||part==="other"?"Other placement":"")};
 if(combine){p.areas=p.areas.filter(x=>x.region!==region);p.areas.push(a);}else p.areas=[a];activeRegion=region;mode="project";start();return a;
}
function pickZone(area,side){
 const key=map[area];if(!key)return;
 const [region,part]=key,existing=areaFor(region),surface=area==="inner_forearm"?"inner":area==="outer_forearm"?"outer":"unsure",other=area==="armpit"?"Armpit":area==="glutes"?"Glutes":"";
 if(!combine||!existing){choose(region,part,side,surface,other);render();return;}
 activeRegion=region;
 const isPaired=api.paired(region)||part==="one_side_chest"||existing.placements.includes("one_side_chest");
 // The enquiry schema has one side per region. Never silently merge different placements on opposite sides.
 if(isPaired&&side&&existing.side!==side&&existing.side!=="both"){
  if(existing.placements.length===1&&existing.placements[0]===part){existing.side="both";render();return;}
  modelMessage="Choose the same side or start a separate calculation for the opposite limb.";render();return;
 }
 if(region==="other"||part==="other"||existing.placements.includes("other")){
  modelMessage="This placement needs a separate calculation.";render();return;
 }
 const old=existing.placements;
 if(old.some(k=>api.large(api.regionByKey(region),k))){modelMessage="A full or partial sleeve already covers its component zones. Use the coverage controls to change it.";render();return;}
 if(old.includes(part)){
  if(part==="forearm"&&existing.surface!==surface&&surface!=="unsure"&&existing.coverage!=="wrap"){existing.coverage="wrap";existing.surface="unsure";render();return;}
  existing.placements=old.filter(k=>k!==part);
 }else existing.placements=[...old,part];
 if(!existing.placements.length){p.areas=p.areas.filter(x=>x!==existing);activeRegion=p.areas.at(-1)?.region||"";}
 else if(existing.placements.length>1){existing.scale="area";existing.coverage="unsure";existing.surface="unsure";}
 else if(existing.coverage==="unsure"){existing.coverage="panel";existing.surface="unsure";}
 render();
}
let modelMessage="";
function group(parent,label,entries,selected,change,cls=""){
 const wrap=node("fieldset","calc-keys "+cls),row=node("div","calc-key-row");wrap.append(node("legend","calc-label",label),row);
 for(const [k,v] of entries){const b=node("button","calc-key",v);b.type="button";b.dataset.key=label+"|"+k;b.setAttribute("aria-pressed",String(selected===k));b.onclick=()=>{start();change(k);render(b.dataset.key);};row.append(b);}parent.append(wrap);
}
const presets=[["forearm","Forearm","arm","forearm"],["upper","Upper arm","arm","upper_arm"],["half","Half sleeve","arm","half_sleeve"],["three","¾ sleeve","arm","three_quarter_sleeve"],["sleeve","Full sleeve","arm","full_sleeve"],["leg","Full leg","leg","full_leg_sleeve"],["back","Full back","back","full_back"],["chest","Full chest","chest_ribs","full_chest"]];
const styleKey=()=>p.styles.length===2?"mixed":p.styles[0];
function setStyle(k){p.styles=k==="mixed"?["black_grey","colour"]:[k];}
const map={head:["neck_head","head"],throat:["neck_head","front_neck"],nape:["neck_head","back_neck"],collarbone:["chest_ribs","collarbone"],ribs:["chest_ribs","ribs"],chest:["chest_ribs","one_side_chest"],sternum:["chest_ribs","sternum"],areola:["chest_ribs","one_side_chest"],stomach:["stomach_sides","stomach"],pelvis:["stomach_sides","hip"],armpit:["arm","other"],shoulder:["arm","shoulder"],outer_upper_arm:["arm","upper_arm"],inner_bicep:["arm","inner_bicep"],triceps:["arm","upper_arm"],inner_forearm:["arm","forearm"],outer_forearm:["arm","forearm"],elbow:["arm","elbow"],wrist:["arm","wrist"],hand:["hand","back_of_hand"],fingers:["hand","fingers"],outer_thigh:["leg","thigh"],inner_thigh:["leg","thigh"],hamstring:["leg","thigh"],knee:["leg","knee"],shin:["leg","shin"],inner_lower_leg:["leg","shin"],calf:["leg","calf"],ankle:["leg","ankle"],foot:["foot","top_of_foot"],shoulder_blade:["back","shoulder_blade"],spine:["back","spine"],lower_back:["back","lower_back"],glutes:["other","other"]};
function selectedArea(area,side){
 const key=map[area],a=key&&areaFor(key[0]);if(!a)return false;
 if((api.paired(a.region)||a.placements.includes("one_side_chest"))&&side&&a.side!==side&&a.side!=="both")return false;
 const part=a.placements[0];
 if(part==="full_sleeve")return key[0]==="arm"&&key[1]!=="other";
 if(part==="full_leg_sleeve")return key[0]==="leg";
 if(part==="half_sleeve")return key[0]==="arm"&&(a.half==="upper"?["shoulder","upper_arm","inner_bicep","elbow"]:["elbow","forearm","wrist"]).includes(key[1]);
 if(part==="three_quarter_sleeve")return key[0]==="arm"&&["shoulder","upper_arm","inner_bicep","elbow","forearm"].includes(key[1]);
 if(part==="half_leg_sleeve")return key[0]==="leg"&&(a.half==="upper"?["thigh","knee"]:["knee","shin","calf","ankle"]).includes(key[1]);
 if(part==="full_back")return key[0]==="back";
 if(part==="full_chest")return ["chest","sternum","areola","collarbone"].includes(area);
 if(a.placements.length===1&&part==="forearm"&&a.coverage==="panel"&&a.surface!=="unsure")return key[1]==="forearm"&&area===(a.surface==="inner"?"inner_forearm":"outer_forearm");
 return a.placements.includes(key[1])||(key[0]==="other"&&a.other==="Glutes");
}
function load3D(){
 if(modelLoad)return modelLoad;
 modelHost??=node("div","calc-model-host");
 modelHost.textContent="Loading 3D model…";
 const script=document.createElement("script");script.src=new URL("viewer.js",assetBase).href;
 modelLoad=new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error("3D viewer unavailable"));document.head.append(script);}).then(()=>window.VisharCalculator3D(modelHost,{base:assetBase,isSelected:selectedArea,coverage(){const a=areaFor("arm");return a?{part:a.placements[0],side:a.side,scale:a.scale}:null;},onPick:pickZone,onError(){modelViewer=null;modelLoad=null;modelFailed=true;modelMode="2d";render();}})).then(v=>{modelViewer=v;v.view(view);v.update();return v;}).catch(err=>{console.warn("Tattoo calculator 3D:",err);modelViewer=null;modelLoad=null;script.remove();modelFailed=true;modelMode="2d";render();});
 return modelLoad;
}
function atlas(parent,interactive=true){
 const box=node("div","calc-atlas"),tabs=node("div","calc-views");
 const combineButton=node("button","calc-combine",combine?"Combine zones: on":"Combine zones: off");combineButton.type="button";combineButton.setAttribute("aria-pressed",String(combine));combineButton.onclick=()=>{combine=!combine;if(!combine&&p.areas.length>1){const a=activeArea();p.areas=a?[a]:[];}if(!combine&&activeArea()?.placements.length>1){const a=activeArea();a.placements=a.placements.slice(0,1);a.coverage="panel";a.surface="unsure";}render();};box.append(combineButton);if(modelMessage){const msg=node("p","calc-map-hint",modelMessage);msg.setAttribute("role","status");box.append(msg);modelMessage="";}
 const switches=node("div","calc-model-switch");for(const m of ["3d","2d"]){const b=node("button","",m.toUpperCase());b.type="button";b.setAttribute("aria-pressed",String(m===modelMode));b.onclick=()=>{modelMode=m;if(m==="3d"){modelFailed=false;load3D();}render();};switches.append(b);}box.append(switches);
 for(const v of ["front","back"]){const b=node("button","",v==="front"?"Front":"Back");b.type="button";b.setAttribute("aria-pressed",String(v===view));b.onclick=()=>{view=v;modelViewer?.view(v);render();};tabs.append(b);}box.append(tabs);
 if(modelMode==="3d"){
 modelHost??=node("div","calc-model-host");box.append(modelHost);
 const tools=node("div","calc-model-switch");for(const [label,f] of [["Zoom in",.8],["Zoom out",1.25]]){const b=node("button","",label);b.type="button";b.onclick=()=>modelViewer?.zoom(f);tools.append(b);}box.append(tools,node("p","calc-map-hint","Drag to rotate · pinch to zoom · tap a zone"));
 parent.append(box);load3D();modelViewer?.update();return;
 }
 if(modelFailed)box.append(node("p","calc-map-hint","3D could not load. Tap 3D to retry, or use the 2D map."));
 const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("class","calc-figure");svg.setAttribute("viewBox","0 0 420 1030");svg.setAttribute("aria-hidden","true");
 function add(tag,attrs,to=svg){const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);to.append(e);return e;}
 const defs=add("defs",{}),trunk=add("clipPath",{id:"calc-trunk"},defs),arm=add("clipPath",{id:"calc-arm"},defs);add("path",{d:geo.TRUNK},trunk);add("path",{d:geo.ARM},arm);
 const mask=add("mask",{id:"calc-mask",maskUnits:"userSpaceOnUse",x:geo.VIEW.x,y:geo.VIEW.y,width:geo.VIEW.w,height:geo.VIEW.h},defs);add("path",{d:geo.TRUNK,fill:"#fff"},mask);add("path",{d:geo.ARM,fill:"#000"},mask);add("path",{d:geo.ARM,fill:"#000",transform:geo.MIRROR_TRANSFORM},mask);
 add("path",{d:geo.TRUNK,class:"figure-fill"});for(const mirror of [false,true])add("path",{d:geo.ARM,class:"figure-fill",...(mirror?{transform:geo.MIRROR_TRANSFORM}:{})});
 function selected(z,side){return selectedArea(z.id,z.paired?side:null);}
 for(const z of geo.REGIONS[view]){const key=map[z.id];if(!key)continue;for(const mirror of z.paired?[false,true]:[false]){
 const side=view==="front"?(mirror?"left":"right"):(mirror?"right":"left"),outer=add("g",z.part==="trunk"?{mask:"url(#calc-mask)"}:{}),g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+z.part+")"},outer);
 const path=add("path",{d:z.d,class:"hit"+(selected(z,side)?" on":""),"data-area":z.id,"data-side":side,"data-paired":String(z.paired)},g);
 if(interactive)path.onclick=()=>{start();pickZone(z.id,side);};
 }}
 const d=geo.FIGURE_DETAIL[view];for(const line of d.centre)add("path",{d:line,class:"figure-line"});for(const mirror of [false,true])for(const part of ["trunk","arm"]){const g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+part+")"});for(const line of d[part])add("path",{d:line,class:"figure-line"},g);}
 box.append(svg,node("p","calc-map-hint","Tap a zone to estimate its cost."));parent.append(box);
}

function description(a){
 if(!a)return "Choose a tattoo";
 const region=api.regionByKey(a.region),part=a.placements[0];
 const label=region.key==="other"?a.other:a.placements.map(k=>k==="other"?a.other:api.half(k)&&a.half&&a.half!=="unsure"?(a.half==="lower"?"Lower ":"Upper ")+(k==="half_sleeve"?"half sleeve":"half leg sleeve"):region.placements.find(x=>x[0]===k)?.[1]||region.label).join(" + ");
 return label+(api.paired(a.region)||part==="one_side_chest"?" · "+api.sides[a.side]:"");
}
function actualProject(){return api.valid(p)?api.estimate(p):null;}
function updateResult(){
 const root=$("calc-estimate");root.replaceChildren();
 const a=p.areas[0],r=actualProject();
 let price,caption,metrics,help;
 if(mode==="budget"){
 const plan=api.budgetPlan(budget);price=money(budget);caption="Your available budget";
 metrics=[[plan.hours+" h","Tattooing time (rounded down)"],[plan.fullDays+" + "+plan.remainderHours+" h","Full days + remaining time"]];
 help="At "+money(api.rules.hourly)+"/h. This is a time allowance, not a guarantee that a specific design fits the budget.";
 }else if(mode==="hours"){
 const sessions=Math.ceil(hours/api.rules.day);
 price=money(hours*api.rules.hourly);caption="Your time-based budget";
 metrics=[[hours+" h","Tattooing time"],[String(sessions),"Visits if full days"]];
 help="Based on the time you enter, not an assessment of your tattoo. Final duration may differ.";
 }else if(r?.numeric){
 price=r.price;caption=r.combined?"Combined planning estimate":r.provisional?"Provisional project estimate":"Estimated project cost";metrics=[[r.time,"Tattooing time"],[r.visits,"Sessions"]];help=r.reason;
 }else if(r){
 price="By assessment";caption="Project needs a personal estimate";metrics=[[money(api.rules.hourly)+"/h","Hourly rate"],[money(api.rules.hourly*api.rules.day),"Full day"]];
 help=r.reason+" You can still plan a budget with the hours calculator.";
 }else{
 price=money(api.rules.hourly)+"/h";caption="Tattooing rate";metrics=[[money(api.rules.hourly*api.rules.day),"Full day"],[api.rules.day+" h","Full-day duration"]];help="Tap the body or choose a quick project to calculate its estimated cost. No enquiry needed.";
 }
 root.append(node("p","calc-label",caption),node("p","calc-result",price));
 const row=node("div","calc-stat-row");for(const [value,label] of metrics){const card=node("div","calc-stat");card.append(node("strong","",value),node("span","",label));row.append(card);}root.append(row,node("p","calc-help",help));
 if(mode==="project"&&r?.combined){
 const detail=node("div","calc-breakdown");detail.append(node("p","calc-label","Separate area guides"));
 for(const item of api.breakdown(p)){
 const a=areaFor(item.region),result=item.result,line=node("div","calc-breakdown-row");
 line.append(node("span","",description(a)),node("strong","",result?.numeric?result.price+(result.provisional?" (draft)":""):"By assessment"));detail.append(line);
 }
 root.append(detail);
 }
 const small=$("calc-current-price");if(small)small.textContent=price;
 next.hidden=mode!=="project"||!r;
 next.disabled=next.hidden;
 next.textContent=embedded?"Apply selection to enquiry (optional)":"Use this selection in an enquiry (optional)";
}
function render(focus){
 body.replaceChildren();
 const modeRow=node("div","calc-mode");for(const [key,label] of [["project","By tattoo"],["hours","By time"],["budget","By budget"]]){const b=node("button","",label);b.type="button";b.setAttribute("aria-pressed",String(mode===key));b.onclick=()=>{mode=key;render();};modeRow.append(b);}body.append(modeRow);
 if(mode==="budget"){
 const panel=node("div","calc-time-panel"),label=node("label","calc-label","Your budget (£)"),amount=node("input","calc-budget-input");
 amount.type="number";amount.min="0";amount.max="20000";amount.step="50";amount.value=String(budget);amount.id="calc-budget";label.htmlFor=amount.id;
 const range=node("input","calc-range");range.type="range";range.min="0";range.max="12000";range.step="100";range.value=String(Math.min(12000,budget));range.setAttribute("aria-label","Budget slider");
 amount.oninput=()=>{if(amount.value==="")return;budget=Math.min(20000,Math.max(0,Number(amount.value)||0));range.value=String(Math.min(12000,budget));start();updateResult();updateSuggestions();};amount.onblur=()=>{amount.value=String(budget);};range.oninput=()=>{budget=Number(range.value);amount.value=String(budget);start();updateResult();updateSuggestions();};
 panel.append(label,amount,range);group(panel,"Quick budget",[[500,"£500"],[1000,"£1,000"],[2000,"£2,000"],[4000,"£4,000"],[8000,"£8,000"]],budget,k=>budget=k);
 const suggestions=node("div","calc-budget-suggestions");panel.append(suggestions);body.append(panel);
 function updateSuggestions(){suggestions.replaceChildren(node("h3","calc-label","Typical projects to compare"));const options=[["Small piece",api.rules.small.map(h=>h*api.rules.hourly)],["Forearm",api.rules.forearm.map(d=>d*api.rules.day*api.rules.hourly)],["Upper arm",api.rules.upper.map(d=>d*api.rules.day*api.rules.hourly)],["Lower half sleeve · Black & Grey",api.rules.lowerHalf.black_grey.map(d=>d*api.rules.day*api.rules.hourly)],["Lower half sleeve · Colour",api.rules.lowerHalf.colour.map(d=>d*api.rules.day*api.rules.hourly)],["Full arm · Black & Grey",api.rules.black_grey.map(d=>d*api.rules.day*api.rules.hourly)],["Full arm · Colour",api.rules.colour.map(d=>d*api.rules.day*api.rules.hourly)]];for(const [label,band] of options){const item=node("div","calc-budget-item"),status=budget<band[0]?"Below typical range":budget<band[1]?"Within typical range":"Covers typical range";item.append(node("strong","",label),node("span","",money(band[0])+"–"+money(band[1])+(label.startsWith("Full arm")?"+":"")),node("span","calc-budget-status",status));suggestions.append(item);}suggestions.append(node("p","calc-help","Compare guide ranges only. Detailed designs can cost more."));}updateSuggestions();
 }else if(mode==="hours"){
 const panel=node("div","calc-time-panel"),label=node("label","calc-label","Planned tattooing time"),range=node("input","calc-range");
 range.type="range";range.min="1";range.max="84";range.step="1";range.value=String(hours);range.id="calc-hours";label.htmlFor=range.id;range.setAttribute("aria-label","Tattooing hours");
 const value=node("strong","calc-time-value",hours+" h"),bounds=node("div","calc-range-bounds");bounds.append(node("span","","1 hour"),node("span","","12 full days"));range.oninput=()=>{hours=Number(range.value);value.textContent=hours+" h";start();updateResult();};
 panel.append(label,value,range,bounds);group(panel,"Quick time",[[3,"3h"],[4,"4h"],[7,"1 day"],[14,"2 days"],[35,"5 days"],[56,"8 days"]],hours,k=>hours=Number(k));
 panel.append(node("p","calc-help","Adjust the slider to explore your budget at the studio's hourly rate."));body.append(panel);
 }else{
 const layout=node("div","calc-layout"),controls=node("div","calc-controls");atlas(layout);layout.append(controls);body.append(layout);
 const a=activeArea(),part=a?.placements.length===1?a.placements[0]:undefined,activePreset=presets.find(x=>x[2]===a?.region&&x[3]===part)?.[0];
 group(controls,"Quick projects",presets.map(x=>[x[0],x[1]]),activePreset,k=>{const x=presets.find(z=>z[0]===k);choose(x[2],x[3],null);if(k==="back"){view="back";modelViewer?.view(view);}if(k==="chest"){view="front";modelViewer?.view(view);}},"calc-presets");
 if(combine&&p.areas.length){const list=node("div","calc-area-list");list.append(node("span","calc-label","Selected zones"));for(const item of p.areas){const row=node("div","calc-area-row"),edit=node("button","",description(item)),remove=node("button","","×");edit.type="button";edit.setAttribute("aria-pressed",String(item===a));edit.onclick=()=>{activeRegion=item.region;render();};remove.type="button";remove.setAttribute("aria-label","Remove "+description(item));remove.onclick=()=>{p.areas=p.areas.filter(x=>x!==item);activeRegion=p.areas.at(-1)?.region||"";render();};row.append(edit,remove);list.append(row);}controls.append(list);}
 if(a){
 const selection=node("div","calc-selection");selection.append(node("span","calc-label","Selected area"),node("strong","",description(a)));controls.append(selection);
 if(api.paired(a.region)||part==="one_side_chest")group(controls,"Side",[["left","Left"],["right","Right"],["both","Both"]],a.side,k=>a.side=k);
 if(a.region==="arm"&&lengthSteps.some(x=>x[0]===part)){
 const length=node("div","calc-length"),label=node("label","calc-label","Arm coverage"),track=node("input","calc-range");track.type="range";track.min="0";track.max="3";track.step="1";track.value=String(lengthSteps.findIndex(x=>x[0]===part));track.id="calc-arm-length";label.htmlFor=track.id;track.setAttribute("aria-valuetext",lengthSteps[Number(track.value)][1]);
 const labels=node("div","calc-length-labels");for(const [key,name] of lengthSteps){const b=node("span","",name);b.dataset.active=String(key===part);labels.append(b);}
 track.oninput=()=>{const [key,name]=lengthSteps[Number(track.value)];track.setAttribute("aria-valuetext",name);Array.from(labels.children).forEach((el,i)=>el.dataset.active=String(i===Number(track.value)));choose("arm",key,a.side,a.surface);modelViewer?.update();body.querySelectorAll(".calc-figure .hit").forEach(el=>el.classList.toggle("on",selectedArea(el.dataset.area,el.dataset.paired==="true"?el.dataset.side:null)));updateResult();};track.onchange=()=>{render();$("calc-arm-length")?.focus({preventScroll:true});};length.append(label,track,labels);controls.append(length);
 }
 if(api.half(part))group(controls,"Half sleeve",[["upper","Upper half"],["lower","Lower half"]],a.half,k=>a.half=k);
 if(part&&!api.large(api.regionByKey(a.region),part)){
 group(controls,"Size",[["small","Small piece"],["area","Area-sized"]],a.scale,k=>{a.scale=k;a.coverage="panel";});
 if(a.scale==="area"&&api.wraps(part))group(controls,"Coverage",[["panel","One side"],["wrap","Wraparound"]],a.coverage,k=>a.coverage=k);
 if(part==="forearm"&&a.scale==="area"&&a.coverage==="wrap"){const lower=node("button","calc-ink","Estimate a lower half sleeve instead (elbow to wrist)");lower.type="button";lower.onclick=()=>{const s=choose("arm","half_sleeve",a.side);s.half="lower";render();};controls.append(lower);}
 }
 }
 group(controls,"Style",[["black_grey","Black & Grey"],["colour","Colour"],["mixed","Mixed"]],styleKey(),setStyle);
 if(a){const ink=node("button","calc-ink",a.work[0]==="new"?"＋ Existing tattoo / cover-up":"✓ Existing tattoo · assessment needed");ink.type="button";ink.setAttribute("aria-pressed",String(a.work[0]!=="new"));ink.onclick=()=>{a.work=a.work[0]==="new"?["cover_up"]:["new"];render();};controls.append(ink);}
 }
 const strip=node("div","calc-current");strip.append(node("span","calc-label","Current calculation"));const current=node("strong","","");current.id="calc-current-price";strip.append(current);body.append(strip);
 updateResult();if(focus)Array.from(body.querySelectorAll("button[data-key]")).find(x=>x.dataset.key===focus)?.focus({preventScroll:true});
}
next.onclick=()=>{
 if(mode!=="project")return;
 if(!actualProject())return;event("tattoo_estimate_to_booking");
 if(embedded){const root=document.getElementById("enquiry-v2");if(!root)return;const accepted=!root.dispatchEvent(new CustomEvent("vishar-calculator-apply",{detail:p,cancelable:true}));if(accepted){body.closest("dialog").close();requestAnimationFrame(()=>root.scrollIntoView({block:"start",behavior:"smooth"}));}return;}
 location.href="/booking/#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)});
};
$("calc-reset").onclick=()=>{p.areas=[];p.styles=["black_grey"];view="front";mode="project";hours=7;budget=2000;combine=false;activeRegion="";render();};
body.closest(".planner").hidden=false;render();
// Standalone calculator loads 3D; booking dialog starts with lightweight 2D.
window.addEventListener("pagehide",()=>modelViewer?.dispose(),{once:true});
})();
