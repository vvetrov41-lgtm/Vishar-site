(() => {
const api=window.TattooPricing,geo=window.TattooBodyGeometry,$=id=>document.getElementById(id);
const body=$("calc-body"),next=$("calc-next"),p={areas:[],styles:["black_grey"]};
const embedded=!!body.closest("dialog");
let view="front",mode="project",hours=7,started=false;
const node=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;};
const money=n=>"£"+n.toLocaleString("en-GB",{maximumFractionDigits:0});
function event(name){try{if(location.hostname==="vishartattoo.com"&&localStorage.getItem("vishar-cookie-consent")==="granted")window.gtag?.("event",name,{calculator_version:3});}catch{}}
function start(){if(!started){started=true;event("tattoo_estimate_start");}}
const areaFor=k=>p.areas.find(a=>a.region===k);
function choose(region,part,side,surface="unsure",other=""){
 const prev=p.areas[0],same=prev?.region===region;
 const a={region,placements:region==="other"?[]:[part],work:same?prev.work.slice():["new"],side:side||(same&&prev.side)||"left",scale:"area",coverage:"panel",half:api.half(part)?"upper":"",surface,other:other||(region==="other"||part==="other"?"Other placement":"")};
 p.areas=[a];mode="project";start();return a;
}
function group(parent,label,entries,selected,change,cls=""){
 const wrap=node("fieldset","calc-keys "+cls),row=node("div","calc-key-row");wrap.append(node("legend","calc-label",label),row);
 for(const [k,v] of entries){const b=node("button","calc-key",v);b.type="button";b.dataset.key=label+"|"+k;b.setAttribute("aria-pressed",String(selected===k));b.onclick=()=>{start();change(k);render(b.dataset.key);};row.append(b);}parent.append(wrap);
}
const presets=[["forearm","Forearm","arm","forearm"],["upper","Upper arm","arm","upper_arm"],["half","Half sleeve","arm","half_sleeve"],["three","¾ sleeve","arm","three_quarter_sleeve"],["sleeve","Full sleeve","arm","full_sleeve"],["leg","Full leg","leg","full_leg_sleeve"],["back","Full back","back","full_back"],["chest","Full chest","chest_ribs","full_chest"]];
const styleKey=()=>p.styles.length===2?"mixed":p.styles[0];
function setStyle(k){p.styles=k==="mixed"?["black_grey","colour"]:[k];}
const map={head:["neck_head","head"],throat:["neck_head","front_neck"],nape:["neck_head","back_neck"],collarbone:["chest_ribs","collarbone"],ribs:["chest_ribs","ribs"],chest:["chest_ribs","one_side_chest"],sternum:["chest_ribs","sternum"],areola:["chest_ribs","one_side_chest"],stomach:["stomach_sides","stomach"],pelvis:["stomach_sides","hip"],armpit:["arm","other"],shoulder:["arm","shoulder"],outer_upper_arm:["arm","upper_arm"],inner_bicep:["arm","inner_bicep"],triceps:["arm","upper_arm"],inner_forearm:["arm","forearm"],outer_forearm:["arm","forearm"],elbow:["arm","elbow"],wrist:["arm","wrist"],hand:["hand","back_of_hand"],fingers:["hand","fingers"],outer_thigh:["leg","thigh"],inner_thigh:["leg","thigh"],hamstring:["leg","thigh"],knee:["leg","knee"],shin:["leg","shin"],inner_lower_leg:["leg","shin"],calf:["leg","calf"],ankle:["leg","ankle"],foot:["foot","top_of_foot"],shoulder_blade:["back","shoulder_blade"],spine:["back","spine"],lower_back:["back","lower_back"],glutes:["other","other"]};
function atlas(parent,interactive=true){
 const box=node("div","calc-atlas"),tabs=node("div","calc-views");
 for(const v of ["front","back"]){const b=node("button","",v==="front"?"Front":"Back");b.type="button";b.setAttribute("aria-pressed",String(v===view));b.onclick=()=>{view=v;render();};tabs.append(b);}box.append(tabs);
 const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("class","calc-figure");svg.setAttribute("viewBox",Object.values(geo.VIEW).join(" "));svg.setAttribute("aria-hidden","true");
 function add(tag,attrs,to=svg){const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);to.append(e);return e;}
 const defs=add("defs",{}),trunk=add("clipPath",{id:"calc-trunk"},defs),arm=add("clipPath",{id:"calc-arm"},defs);add("path",{d:geo.TRUNK},trunk);add("path",{d:geo.ARM},arm);
 const mask=add("mask",{id:"calc-mask",maskUnits:"userSpaceOnUse",x:geo.VIEW.x,y:geo.VIEW.y,width:geo.VIEW.w,height:geo.VIEW.h},defs);add("path",{d:geo.TRUNK,fill:"#fff"},mask);add("path",{d:geo.ARM,fill:"#000"},mask);add("path",{d:geo.ARM,fill:"#000",transform:geo.MIRROR_TRANSFORM},mask);
 add("path",{d:geo.TRUNK,class:"figure-fill"});for(const mirror of [false,true])add("path",{d:geo.ARM,class:"figure-fill",...(mirror?{transform:geo.MIRROR_TRANSFORM}:{})});
 function selected(z,side){const key=map[z.id],a=areaFor(key[0]);if(!a)return false;if(api.paired(a.region)&&z.paired&&a.side!==side&&a.side!=="both")return false;
 if(a.placements.includes("full_sleeve")&&key[0]==="arm")return true;if(a.placements.includes("full_leg_sleeve")&&key[0]==="leg")return true;
 if(a.placements.includes("half_sleeve")&&key[0]==="arm")return a.half==="upper"?["shoulder","upper_arm","inner_bicep","elbow"].includes(key[1]):a.half==="lower"?["elbow","forearm","wrist"].includes(key[1]):false;
 if(a.placements.includes("three_quarter_sleeve")&&key[0]==="arm")return ["shoulder","upper_arm","inner_bicep","elbow","forearm"].includes(key[1]);
 if(a.placements.includes("half_leg_sleeve")&&key[0]==="leg")return a.half==="upper"?["thigh","knee"].includes(key[1]):a.half==="lower"?["knee","shin","calf","ankle"].includes(key[1]):false;
 if(a.placements.includes("forearm")&&key[1]==="forearm"&&a.coverage==="panel"&&a.surface&&a.surface!=="unsure")return z.id===(a.surface==="inner"?"inner_forearm":"outer_forearm");if(a.placements.includes("full_back")&&key[0]==="back")return true;
 if(a.placements.includes("full_chest")&&["chest","sternum","areola","collarbone"].includes(z.id))return true;
 if(a.placements.includes("upper_back")&&z.id==="shoulder_blade")return true;
 return a.placements.includes(key[1])&&!(key[1]==="one_side_chest"&&z.paired&&a.side!==side&&a.side!=="both");}
 for(const z of geo.REGIONS[view]){const key=map[z.id];if(!key)continue;for(const mirror of z.paired?[false,true]:[false]){
 const side=view==="front"?(mirror?"left":"right"):(mirror?"right":"left"),outer=add("g",z.part==="trunk"?{mask:"url(#calc-mask)"}:{}),g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+z.part+")"},outer);
 const path=add("path",{d:z.d,class:"hit"+(selected(z,side)?" on":""),"data-area":z.id,"data-side":side},g);
 if(interactive)path.onclick=()=>{start();choose(key[0],key[1],side,z.id==="inner_forearm"?"inner":z.id==="outer_forearm"?"outer":"unsure",z.id==="armpit"?"Armpit":z.id==="glutes"?"Glutes":"");render();};
 }}
 const d=geo.FIGURE_DETAIL[view];for(const line of d.centre)add("path",{d:line,class:"figure-line"});for(const mirror of [false,true])for(const part of ["trunk","arm"]){const g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+part+")"});for(const line of d[part])add("path",{d:line,class:"figure-line"},g);}
 box.append(svg,node("p","calc-map-hint","Tap a zone to estimate its cost."));parent.append(box);
}

function description(a){
 if(!a)return "Choose a tattoo";
 const region=api.regionByKey(a.region),part=a.placements[0];
 const label=region.key==="other"?a.other:part==="other"?a.other:region.placements.find(x=>x[0]===part)?.[1]||region.label;
 return label+(api.paired(a.region)||part==="one_side_chest"?" · "+api.sides[a.side]:"");
}
function actualProject(){return api.valid(p)?api.estimate(p):null;}
function updateResult(){
 const root=$("calc-estimate");root.replaceChildren();
 const a=p.areas[0],r=actualProject();
 let price,caption,metrics,help;
 if(mode==="hours"){
 const sessions=Math.ceil(hours/api.rules.day);
 price=money(hours*api.rules.hourly);caption="Your time-based budget";
 metrics=[[hours+" h","Tattooing time"],[String(sessions),"Visits if full days"]];
 help="Based on the time you enter, not an assessment of your tattoo. Final duration may differ.";
 }else if(r?.numeric){
 price=r.price;caption="Estimated project cost";metrics=[[r.time,"Tattooing time"],[r.visits,"Sessions"]];help=r.reason;
 }else if(r){
 price="By assessment";caption="Project needs a personal estimate";metrics=[[money(api.rules.hourly)+"/h","Hourly rate"],[money(api.rules.hourly*api.rules.day),"Full day"]];
 help=r.reason+" You can still plan a budget with the hours calculator.";
 }else{
 price=money(api.rules.hourly)+"/h";caption="Tattooing rate";metrics=[[money(api.rules.hourly*api.rules.day),"Full day"],[api.rules.day+" h","Full-day duration"]];help="Tap the body or a quick project below to see the estimated range.";
 }
 root.append(node("p","calc-label",caption),node("p","calc-result",price));
 const row=node("div","calc-stat-row");for(const [value,label] of metrics){const card=node("div","calc-stat");card.append(node("strong","",value),node("span","",label));row.append(card);}root.append(row,node("p","calc-help",help));
 next.disabled=mode==="project"&&!r;
 next.textContent=mode==="hours"?"Continue to enquiry":embedded?"Use project in enquiry":"Continue to enquiry";
}
function render(focus){
 body.replaceChildren();
 const modeRow=node("div","calc-mode");for(const [key,label] of [["project","By tattoo"],["hours","By time"]]){const b=node("button","",label);b.type="button";b.setAttribute("aria-pressed",String(mode===key));b.onclick=()=>{mode=key;render();};modeRow.append(b);}body.append(modeRow);
 if(mode==="hours"){
 const panel=node("div","calc-time-panel"),label=node("label","calc-label","Planned tattooing time"),range=node("input","calc-range");
 range.type="range";range.min="1";range.max="84";range.step="1";range.value=String(hours);range.id="calc-hours";label.htmlFor=range.id;range.setAttribute("aria-label","Tattooing hours");
 const value=node("strong","calc-time-value",hours+" h"),bounds=node("div","calc-range-bounds");bounds.append(node("span","","1 hour"),node("span","","12 full days"));range.oninput=()=>{hours=Number(range.value);value.textContent=hours+" h";start();updateResult();};
 panel.append(label,value,range,bounds);group(panel,"Quick time",[[3,"3h"],[4,"4h"],[7,"1 day"],[14,"2 days"],[35,"5 days"],[56,"8 days"]],hours,k=>hours=Number(k));
 panel.append(node("p","calc-help","Adjust the slider to explore your budget at the studio's hourly rate."));body.append(panel);
 }else{
 const layout=node("div","calc-layout"),controls=node("div","calc-controls");atlas(layout);layout.append(controls);body.append(layout);
 const a=p.areas[0],part=a?.placements[0],activePreset=presets.find(x=>x[2]===a?.region&&x[3]===part)?.[0];
 group(controls,"Quick projects",presets.map(x=>[x[0],x[1]]),activePreset,k=>{const x=presets.find(z=>z[0]===k);choose(x[2],x[3],null);if(k==="back")view="back";if(k==="chest")view="front";},"calc-presets");
 if(a){
 const selection=node("div","calc-selection");selection.append(node("span","calc-label","Selected area"),node("strong","",description(a)));controls.append(selection);
 if(api.paired(a.region)||part==="one_side_chest")group(controls,"Side",[["left","Left"],["right","Right"],["both","Both"]],a.side,k=>a.side=k);
 if(api.half(part))group(controls,"Length",[["upper","Upper half"],["lower","Lower half"]],a.half,k=>a.half=k);
 if(part&&!api.large(api.regionByKey(a.region),part)){
 group(controls,"Size",[["small","Small piece"],["area","Area-sized"]],a.scale,k=>{a.scale=k;a.coverage="panel";});
 if(a.scale==="area"&&api.wraps(part))group(controls,"Coverage",[["panel","One side"],["wrap","Wraparound"]],a.coverage,k=>a.coverage=k);
 }
 }
 group(controls,"Style",[["black_grey","Black & Grey"],["colour","Colour"],["mixed","Mixed"]],styleKey(),setStyle);
 if(a){const ink=node("button","calc-ink",a.work[0]==="new"?"＋ Existing tattoo / cover-up":"✓ Existing tattoo · assessment needed");ink.type="button";ink.setAttribute("aria-pressed",String(a.work[0]!=="new"));ink.onclick=()=>{a.work=a.work[0]==="new"?["cover_up"]:["new"];render();};controls.append(ink);}
 }
 updateResult();if(focus)Array.from(body.querySelectorAll("button[data-key]")).find(x=>x.dataset.key===focus)?.focus({preventScroll:true});
}
next.onclick=()=>{
 if(mode==="hours"){event("tattoo_estimate_to_booking");if(embedded){body.closest("dialog").close();return;}location.href="/booking/";return;}
 if(!actualProject())return;event("tattoo_estimate_to_booking");
 if(embedded){const root=document.getElementById("enquiry-v2");if(!root)return;const accepted=!root.dispatchEvent(new CustomEvent("vishar-calculator-apply",{detail:p,cancelable:true}));if(accepted){body.closest("dialog").close();requestAnimationFrame(()=>root.scrollIntoView({block:"start",behavior:"smooth"}));}return;}
 location.href="/booking/#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)});
};
$("calc-reset").onclick=()=>{p.areas=[];p.styles=["black_grey"];view="front";mode="project";hours=7;render();};
render();body.closest(".planner").hidden=false;
})();
