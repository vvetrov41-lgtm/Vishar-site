(() => {
const api=window.TattooPricing,geo=window.TattooBodyGeometry,$=id=>document.getElementById(id);
const body=$("calc-body"),next=$("calc-next"),back=$("calc-back"),p={areas:[],styles:[]};let step=0,view="front",started=false,uid=0;
const steps=["Placement","Coverage","Existing work","Style","Estimate"];
const node=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt)e.textContent=txt;return e;};
function heading(txt,help){body.append(node("h2","ef-question",txt),node("p","ef-help",help));}
function event(name){try{if(location.hostname==="vishartattoo.com"&&localStorage.getItem("vishar-cookie-consent")==="granted")window.gtag?.("event",name,{calculator_version:2});}catch{}}
function start(){if(!started){started=true;event("tattoo_estimate_start");}}
function choice(parent,entries,selected,change,multi,label){
 const group=node("fieldset","ef-fieldset"),legend=node("legend","ef-legend-small",label),grid=node("div","ef-choices"),name="calc-"+(++uid);group.append(legend,grid);
 for(const [key,title] of entries){const l=node("label","ef-choice"),i=node("input","ef-choice-input");i.type=multi?"checkbox":"radio";i.name=name;i.value=key;i.checked=selected.includes(key);l.classList.toggle("is-selected",i.checked);l.append(i,node("span","ef-choice-label",title));i.onchange=()=>{start();change(key,i.checked);render(false);};grid.append(l);}parent.append(group);
}
const areaFor=k=>p.areas.find(a=>a.region===k);
function addArea(k){let a=areaFor(k);if(!a){a={region:k,placements:[],work:[],side:"",scale:"",coverage:"",other:""};p.areas.push(a);}return a;}
function selectPart(a,k,on){const r=api.regionByKey(a.region),m=r.placements.find(x=>x[0]===k);if(on){if(m?.[2])a.placements=a.placements.filter(v=>r.placements.find(x=>x[0]===v)?.[2]!==m[2]);if(!a.placements.includes(k))a.placements.push(k);}else a.placements=a.placements.filter(v=>v!==k);a.scale="";a.coverage="";}
const map={head:["neck_head","head"],throat:["neck_head","front_neck"],nape:["neck_head","back_neck"],collarbone:["chest_ribs","collarbone"],ribs:["chest_ribs","ribs"],chest:["chest_ribs","one_side_chest"],sternum:["chest_ribs","sternum"],areola:["chest_ribs","one_side_chest"],stomach:["stomach_sides","stomach"],pelvis:["stomach_sides","hip"],armpit:["arm","other"],shoulder:["arm","shoulder"],outer_upper_arm:["arm","upper_arm"],inner_bicep:["arm","inner_bicep"],triceps:["arm","upper_arm"],inner_forearm:["arm","forearm"],outer_forearm:["arm","forearm"],elbow:["arm","elbow"],wrist:["arm","wrist"],hand:["hand","back_of_hand"],fingers:["hand","fingers"],outer_thigh:["leg","thigh"],inner_thigh:["leg","thigh"],hamstring:["leg","thigh"],knee:["leg","knee"],shin:["leg","shin"],inner_lower_leg:["leg","shin"],calf:["leg","calf"],ankle:["leg","ankle"],foot:["foot","top_of_foot"],shoulder_blade:["back","shoulder_blade"],spine:["back","spine"],lower_back:["back","lower_back"],glutes:["other","other"]};
function atlas(parent){
 const box=node("div","calc-atlas"),tabs=node("div","calc-views");
 for(const v of ["front","back"]){const b=node("button","",v==="front"?"Front":"Back");b.type="button";b.setAttribute("aria-pressed",String(v===view));b.onclick=()=>{view=v;render(false);};tabs.append(b);}box.append(tabs);
 const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("class","calc-figure");svg.setAttribute("viewBox",Object.values(geo.VIEW).join(" "));svg.setAttribute("aria-hidden","true");
 function add(tag,attrs,to=svg){const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);to.append(e);return e;}
 const defs=add("defs",{}),trunk=add("clipPath",{id:"calc-trunk"},defs),arm=add("clipPath",{id:"calc-arm"},defs);add("path",{d:geo.TRUNK},trunk);add("path",{d:geo.ARM},arm);
 const mask=add("mask",{id:"calc-mask",maskUnits:"userSpaceOnUse",x:geo.VIEW.x,y:geo.VIEW.y,width:geo.VIEW.w,height:geo.VIEW.h},defs);add("path",{d:geo.TRUNK,fill:"#fff"},mask);add("path",{d:geo.ARM,fill:"#000"},mask);add("path",{d:geo.ARM,fill:"#000",transform:geo.MIRROR_TRANSFORM},mask);
 add("path",{d:geo.TRUNK,class:"figure-fill"});for(const mirror of [false,true])add("path",{d:geo.ARM,class:"figure-fill",...(mirror?{transform:geo.MIRROR_TRANSFORM}:{})});
 function selected(z,side){const key=map[z.id],a=areaFor(key[0]);if(!a)return false;if(api.limb(a.region)&&z.paired&&a.side!==side&&a.side!=="both")return false;
 if(a.placements.includes("full_sleeve")&&key[0]==="arm")return true;if(a.placements.includes("full_leg_sleeve")&&key[0]==="leg")return true;if(a.placements.includes("full_back")&&key[0]==="back")return true;
 if(a.placements.includes("full_chest")&&["chest","sternum","areola","collarbone"].includes(z.id))return true;
 if(a.placements.includes("upper_back")&&z.id==="shoulder_blade")return true;
 return a.placements.includes(key[1])&&!(key[1]==="one_side_chest"&&z.paired&&a.side!==side&&a.side!=="both");}
 for(const z of geo.REGIONS[view]){const key=map[z.id];if(!key)continue;for(const mirror of z.paired?[false,true]:[false]){
 const side=view==="front"?(mirror?"left":"right"):(mirror?"right":"left"),outer=add("g",z.part==="trunk"?{mask:"url(#calc-mask)"}:{}),g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+z.part+")"},outer);
 const path=add("path",{d:z.d,class:"hit"+(selected(z,side)?" on":""),"data-area":z.id,"data-side":side},g);
 path.onclick=()=>{start();const a=addArea(key[0]);if(key[0]==="other")a.other="Glutes";else{selectPart(a,key[1],true);if(z.id==="armpit")a.other="Armpit";}if(z.paired&&(api.limb(a.region)||a.region==="chest_ribs"))a.side=a.side&&a.side!==side&&a.side!=="unsure"?"both":side;render(false);};
 }}
 const d=geo.FIGURE_DETAIL[view];for(const line of d.centre)add("path",{d:line,class:"figure-line"});for(const mirror of [false,true])for(const part of ["trunk","arm"]){const g=add("g",{...(mirror?{transform:geo.MIRROR_TRANSFORM}:{}),"clip-path":"url(#calc-"+part+")"});for(const line of d[part])add("path",{d:line,class:"figure-line"},g);}
 box.append(svg,node("p","ef-help","Tap a body area or use the options. Left and right refer to your body."));parent.append(box);
}
function field(parent,value,change){const i=node("input","");i.type="text";i.maxLength=120;i.placeholder="Describe the placement";i.setAttribute("aria-label",i.placeholder);i.value=value||"";i.oninput=()=>change(i.value);parent.append(i);}
function render(focus=true){$("calc-error").hidden=true;body.replaceChildren();$("calc-step").textContent="Step "+(step+1)+" of "+steps.length+" · "+steps[step];$("calc-progress").style.transform="scaleX("+((step+1)/steps.length)+")";back.hidden=step===0;next.textContent=step===4?"Continue to enquiry":"Continue";
 if(step===0){heading("Where would you like your tattoo?","Choose one or more body areas and specify the exact placement.");const layout=node("div","calc-layout"),controls=node("div","");atlas(layout);layout.append(controls);body.append(layout);
 choice(controls,api.REGIONS.map(r=>[r.key,r.label]),p.areas.map(a=>a.region),(k,on)=>{if(on)addArea(k);else p.areas=p.areas.filter(a=>a.region!==k);},true,"Body areas");
 for(const a of p.areas){const r=api.regionByKey(a.region),group=node("div","calc-group");controls.append(group);if(r.placements.length)choice(group,r.placements.map(x=>x.slice(0,2)),a.placements,(k,on)=>selectPart(a,k,on),true,r.label);if(a.region==="other"||a.placements.includes("other"))field(group,a.other,v=>a.other=v);if(api.limb(a.region)||a.placements.includes("one_side_chest"))choice(group,Object.entries(api.sides),[a.side],k=>a.side=k,false,"Which side?");}
 }else if(step===1){heading("How much skin should it cover?","Sleeves already define the coverage; for other areas choose the intended scale.");
 for(const a of p.areas){const r=api.regionByKey(a.region),group=node("div","calc-group");body.append(group);group.append(node("h3","ef-legend-small",r.label+" · "+a.placements.map(k=>r.placements.find(x=>x[0]===k)?.[1]).join(", ")));
 if(a.region==="other"||a.placements.length!==1||api.large(r,a.placements[0])){group.append(node("p","ef-help","Coverage will be assessed from your placement and references."));continue;}
 choice(group,Object.entries(api.scales),[a.scale],k=>{a.scale=k;a.coverage="";},false,"Scale");if(a.scale==="area"&&api.wraps(a.placements[0]))choice(group,Object.entries(api.coverage),[a.coverage],k=>a.coverage=k,false,"Coverage");}
 }else if(step===2){heading("Is there existing tattoo work?","Choose all that apply for each area.");for(const a of p.areas)choice(body,api.WORK,a.work,(k,on)=>{if(on){if(k==="new")a.work=["new"];else a.work=[...a.work.filter(v=>v!=="new"),k];}else a.work=a.work.filter(v=>v!==k);},true,api.regionByKey(a.region).label);
 }else if(step===3){heading("What style are you interested in?","Black & Grey and Colour can be combined.");choice(body,api.STYLES,p.styles,(k,on)=>{if(on){if(k==="not_sure")p.styles=[k];else p.styles=[...p.styles.filter(v=>v!=="not_sure"),k];}else p.styles=p.styles.filter(v=>v!==k);},true,"Style");
 }else{const r=api.estimate(p);heading("Your estimated budget","An initial planning guide, subject to reviewing your design and references.");if(r){body.append(node("p","calc-result",r.price));const metrics=node("div","calc-metrics");metrics.append(node("span","",r.time),node("span","",r.visits));body.append(metrics,node("p","ef-note",r.reason),node("p","ef-note ef-note-visible",api.booking(p).notes));}body.append(node("p","ef-note","Continue to the enquiry form to add your idea, photos and contact details. Your selections will be carried over."));}
 if(focus)$("calc-step").focus();}
function error(msg){$("calc-error").textContent=msg;$("calc-error").hidden=false;}
next.onclick=()=>{start();
 if(step===0&&(!p.areas.length||p.areas.some(a=>a.region==="other"?!a.other.trim():!a.placements.length||(a.placements.includes("other")&&!a.other.trim())||((api.limb(a.region)||a.placements.includes("one_side_chest"))&&!a.side))))return error("Choose the exact placement and side for each area.");
 if(step===1&&p.areas.some(a=>a.region!=="other"&&a.placements.length===1&&!api.large(api.regionByKey(a.region),a.placements[0])&&(!a.scale||(a.scale==="area"&&api.wraps(a.placements[0])&&!a.coverage))))return error("Choose scale and coverage for each applicable area.");
 if(step===2&&p.areas.some(a=>!a.work.length))return error("Choose the type of work for each area.");
 if(step===3&&!api.valid(p))return error("Choose a style or Not sure yet and review your project choices.");
 if(step===4){if(!api.valid(p))return error("Review your choices before continuing.");event("tattoo_estimate_to_booking");location.href="/booking/#"+new URLSearchParams({estimate:"2",project:JSON.stringify(p)});return;}step++;render();};
back.onclick=()=>{if(step>0){step--;render();}};render(false);document.querySelector(".planner").hidden=false;
})();
