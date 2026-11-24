(() => {
const api=window.TattooPricing,geo=window.TattooBodyGeometry,$=id=>document.getElementById(id);
const body=$("calc-body"),next=$("calc-next"),p={areas:[],styles:[]};let view="front",started=false,active="",adding=false;
const embedded=!!body.closest("dialog");
const node=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt)e.textContent=txt;return e;};
function heading(txt,help){body.append(node("h2","ef-question",txt),node("p","ef-help",help));}
function event(name){try{if(location.hostname==="vishartattoo.com"&&localStorage.getItem("vishar-cookie-consent")==="granted")window.gtag?.("event",name,{calculator_version:2});}catch{}}
function start(){if(!started){started=true;event("tattoo_estimate_start");}}
function select(parent,label,entries,value,change,placeholder="Choose…"){
 const wrap=node("label","calc-field"),input=node("select","calc-select");input.setAttribute("aria-label",label);input.append(new Option(placeholder,""));for(const [k,v] of entries)input.append(new Option(v,k));input.value=value||"";input.onchange=()=>{start();change(input.value);render(label);};wrap.append(node("span","calc-label",label),input);parent.append(wrap);
}
function buttons(parent,label,entries,value,change){
 const wrap=node("fieldset","calc-field"),row=node("div","calc-toggle");wrap.append(node("legend","calc-label",label),row);
 for(const [k,v] of entries){const b=node("button","",v);b.type="button";b.dataset.focus=label+"|"+k;b.setAttribute("aria-pressed",String(value===k));b.onclick=()=>{start();change(k);render(b.dataset.focus);};row.append(b);}parent.append(wrap);
}
const areaFor=k=>p.areas.find(a=>a.region===k);
function addArea(k){let a=areaFor(k);if(!a){a={region:k,placements:[],work:["new"],side:"",scale:"",coverage:"",half:"",surface:"",other:""};p.areas.push(a);}active=k;adding=false;return a;}
function chooseRegion(k){if(!k)return;const previous=areaFor(active);if(!adding&&previous&&previous.region!==k&&!areaFor(k))p.areas=p.areas.filter(a=>a!==previous);addArea(k);}
function choosePlacement(a,k){a.placements=k?[k]:[];a.scale="";a.coverage="";a.half="";a.surface="";a.other="";}
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
 if(interactive)path.onclick=()=>{start();chooseRegion(key[0]);const a=areaFor(key[0]);if(key[0]==="other")a.other="Glutes";else{choosePlacement(a,key[1]);if(z.id==="armpit")a.other="Armpit";if(key[1]==="forearm")a.surface=z.id==="inner_forearm"?"inner":"outer";}if(z.paired&&(api.paired(a.region)||a.region==="chest_ribs"))a.side=side;render();};
 }}
 const d=geo.FIGURE_DETAIL[view];for(const line of d.centre)add("path",{d:line,class:"figure-line"});for(const mirror of [false,true])for(const part of ["trunk","arm"]){const g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+part+")"});for(const line of d[part])add("path",{d:line,class:"figure-line"},g);}
 box.append(svg,node("p","calc-help",interactive?"Tap a body area or use the options. Left and right refer to your body.":"Approximate coverage preview. Exact boundaries depend on your design."));parent.append(box);
}
function field(parent,value,change){
 const wrap=node("label","calc-field"),i=node("input","calc-select");i.type="text";i.maxLength=120;i.placeholder="Describe the placement";i.setAttribute("aria-label","Describe the placement");i.value=value||"";i.oninput=()=>{change(i.value);updateResult();};wrap.append(node("span","calc-label","Other placement"),i);parent.append(wrap);
}
function complete(){return api.valid(p)&&p.areas.every(a=>!a.placements.some(api.half)||!!a.half)&&p.areas.every(a=>!(a.placements.length===1&&a.placements[0]==="forearm"&&a.scale==="area"&&a.coverage==="panel")||!!a.surface);}
function updateResult(){
 const result=$("calc-estimate");result.replaceChildren();
 const ready=complete(),r=ready?api.estimate(p):null;
 result.append(node("p","calc-label","Estimated budget"));
 if(!r){result.append(node("p","calc-result calc-placeholder","—"),node("p","calc-help","Choose a placement, size and style to see your estimate."));}
 else{
 result.append(node("p","calc-result",r.price));const metrics=node("div","calc-metrics");
 if(r.numeric){const h=node("div",""),s=node("div","");h.append(node("span","calc-label","Tattooing time"),node("strong","",r.time));s.append(node("span","calc-label","Sessions"),node("strong","",r.visits));metrics.append(h,s);result.append(metrics);}
 result.append(node("p","calc-help",r.reason));
 }
 next.disabled=!ready||adding;
 next.textContent=embedded?"Use estimate in my enquiry":"Continue to enquiry";
}
function render(focus){
 body.replaceChildren();const layout=node("div","calc-layout"),controls=node("div","calc-controls");atlas(layout);layout.append(controls);body.append(layout);
 const selected=areaFor(active);
 if(p.areas.length){const tabs=node("div","calc-projects");for(const a of p.areas){const b=node("button","",api.regionByKey(a.region).label);b.type="button";b.setAttribute("aria-pressed",String(a.region===active&&!adding));b.onclick=()=>{active=a.region;adding=false;render();};tabs.append(b);}const add=node("button","","＋ Add area");add.type="button";add.disabled=p.areas.length>=api.REGIONS.length;add.onclick=()=>{adding=true;active="";render("Body area");};tabs.append(add);controls.append(tabs);}
 const a=adding?null:selected;
 select(controls,"Body area",api.REGIONS.map(r=>[r.key,r.label]),a?.region,k=>{if(k)chooseRegion(k);});
 if(a){
 const region=api.regionByKey(a.region),part=a.placements[0];
 if(region.placements.length)select(controls,"Placement",region.placements.map(x=>x.slice(0,2)),part,k=>choosePlacement(a,k));
 if(a.region==="other"||part==="other")field(controls,a.other,v=>a.other=v);
 if(api.paired(a.region)||part==="one_side_chest")buttons(controls,"Side",Object.entries(api.sides),a.side,k=>a.side=k);
 if(part&&api.half(part))select(controls,"Which half?",Object.entries(api.halves),a.half,k=>a.half=k);
 if(part&&!api.large(region,part)){
 select(controls,"Size / scale",Object.entries(api.scales),a.scale,k=>{a.scale=k;a.coverage="";});
 if(a.scale==="area"&&api.wraps(part))buttons(controls,"Coverage",Object.entries(api.coverage),a.coverage,k=>a.coverage=k);
 if(part==="forearm"&&a.scale==="area"&&a.coverage==="panel")buttons(controls,"Forearm surface",Object.entries(api.surfaces),a.surface,k=>{a.surface=k;if(k!=="unsure")view=k==="inner"?"front":"back";});
 }
 select(controls,"Type of work",api.WORK,a.work[0],k=>a.work=k?[k]:[]);
 const remove=node("button","calc-remove","Remove area");remove.type="button";remove.onclick=()=>{p.areas=p.areas.filter(x=>x!==a);active=p.areas.at(-1)?.region||"";adding=false;render();};if(p.areas.length>1)controls.append(remove);
 }
 select(controls,"Style",[...api.STYLES,["mixed","Black & Grey + Colour"]],p.styles.length===2?"mixed":p.styles[0],k=>p.styles=k==="mixed"?["black_grey","colour"]:k?[k]:[]);
 if(adding){const cancel=node("button","calc-remove","Cancel adding area");cancel.type="button";cancel.onclick=()=>{adding=false;active=p.areas.at(-1)?.region||"";render();};controls.append(cancel);}
 updateResult();if(focus){const target=Array.from(body.querySelectorAll("select,button[data-focus]")).find(x=>x.getAttribute("aria-label")===focus||x.dataset.focus===focus);target?.focus({preventScroll:true});}
}
next.onclick=()=>{if(!complete()||adding)return;event("tattoo_estimate_to_booking");if(embedded){const root=document.getElementById("enquiry-v2");if(!root)return;const accepted=!root.dispatchEvent(new CustomEvent("vishar-calculator-apply",{detail:p,cancelable:true}));if(accepted){body.closest("dialog").close();requestAnimationFrame(()=>root.scrollIntoView({block:"start",behavior:"smooth"}));}return;}location.href="/booking/#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)});};
$("calc-reset").onclick=()=>{p.areas=[];p.styles=[];active="";adding=false;view="front";render();};
render();body.closest(".planner").hidden=false;
})();
