import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
// TattooBodyMap canonical surface taxonomy, from src/lib/body3d/regionAreas.ts.
const BASES={"head":{"label":"Head","sides":"c","facets":["all"],"area":"head"},"neck":{"label":"Neck","sides":"c","facets":["front","back"],"area":{"front":"throat","back":"nape"}},"chest":{"label":"Chest","sides":"c","facets":["all"],"area":"chest"},"abdomen":{"label":"Stomach","sides":"c","facets":["all"],"area":"stomach"},"pelvis":{"label":"Pelvis","sides":"c","facets":["all"],"area":"pelvis"},"upper_back":{"label":"Upper back","sides":"c","facets":["all"],"area":"shoulder_blade"},"lower_back":{"label":"Lower back","sides":"c","facets":["all"],"area":"lower_back"},"ribs":{"label":"Ribs","sides":"lr","facets":["all"],"area":"ribs"},"hip":{"label":"Hip","sides":"lr","facets":["all"],"area":"pelvis"},"glutes":{"label":"Glute","sides":"lr","facets":["all"],"area":"glutes"},"shoulder":{"label":"Shoulder","sides":"lr","facets":["front","back"],"area":"shoulder"},"armpit":{"label":"Armpit","sides":"lr","facets":["all"],"area":"armpit"},"upper_arm":{"label":"Upper arm","sides":"lr","facets":["front","back","inner","outer"],"area":{"inner":"inner_bicep","back":"triceps","*":"outer_upper_arm"}},"elbow":{"label":"Elbow","sides":"lr","facets":["front","back","inner","outer"],"area":"elbow"},"forearm":{"label":"Forearm","sides":"lr","facets":["front","back","inner","outer"],"area":{"inner":"inner_forearm","*":"outer_forearm"}},"hand":{"label":"Hand","sides":"lr","facets":["palm","back","fingers"],"area":{"fingers":"fingers","*":"hand"}},"thigh":{"label":"Thigh","sides":"lr","facets":["front","back","inner","outer"],"area":{"inner":"inner_thigh","back":"hamstring","*":"outer_thigh"}},"knee":{"label":"Knee","sides":"lr","facets":["front","back","inner","outer"],"area":"knee"},"calf":{"label":"Lower leg","sides":"lr","facets":["front","back","inner","outer"],"area":{"front":"shin","inner":"inner_lower_leg","*":"calf"}},"foot":{"label":"Foot","sides":"lr","facets":["top","sole"],"area":"foot"},"nipple":{"label":"Nipple / areola","sides":"lr","facets":["all"],"area":"areola"},"collarbone":{"label":"Collarbone","sides":"lr","facets":["all"],"area":"collarbone"},"sternum":{"label":"Sternum","sides":"c","facets":["all"],"area":"sternum"},"spine":{"label":"Spine","sides":"c","facets":["all"],"area":"spine"},"wrist":{"label":"Wrist","sides":"lr","facets":["front","back","inner","outer"],"area":"wrist"},"ankle":{"label":"Ankle","sides":"lr","facets":["front","back","inner","outer"],"area":"ankle"}};
window.VisharCalculator3D=async function mount(host,{base,onPick,isSelected,coverage,onError}){
 let renderer,controls,observer,visibleObserver,mesh,geometry,material,dead=false,frame=0,visible=true;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(34,1,.05,30);
 const invalidate=()=>{if(!dead&&visible&&!frame)frame=requestAnimationFrame(()=>{frame=0;if(!dead&&visible){controls.update();renderer.render(scene,camera);}});};
 function dispose(){if(dead)return;dead=true;cancelAnimationFrame(frame);observer?.disconnect();visibleObserver?.disconnect();controls?.dispose();geometry?.dispose();material?.dispose();renderer?.dispose();renderer?.domElement.remove();}
 try{
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"low-power"});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setClearColor(0,0);
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
 const canvas=renderer.domElement;canvas.setAttribute("aria-hidden","true");canvas.className="calc-webgl";host.replaceChildren(canvas);
 camera.position.set(0,.85,3.65);controls=new OrbitControls(camera,canvas);controls.target.set(0,.84,0);controls.enablePan=false;controls.enableDamping=false;controls.minDistance=.75;controls.maxDistance=4.8;controls.minPolarAngle=.35;controls.maxPolarAngle=Math.PI-.35;controls.update();controls.addEventListener("change",invalidate);
 scene.add(new THREE.HemisphereLight(0xffffff,0x454545,2.1));const key=new THREE.DirectionalLight(0xffffff,3);key.position.set(2,3,3);scene.add(key);const rim=new THREE.DirectionalLight(0xffffff,1.9);rim.position.set(-2,2,-2);scene.add(rim);
 const manifest=await fetch(new URL("male.regions.json",base)).then(r=>{if(!r.ok)throw Error("Region manifest unavailable");return r.json();});
 const groups=new Map(manifest.groups.map(g=>[g.id,g]));
 const regions=new Map(manifest.regions.map(v=>{const g=groups.get(v.group),def=BASES[g.base];if(!def)throw Error("Unmapped model region: "+v.key);const area=typeof def.area==="string"?def.area:(def.area[v.facet]||def.area["*"]);if(!area)throw Error("Unmapped model facet: "+v.key);return [v.id,{...v,area,base:g.base,side:g.side==="l"?"left":g.side==="r"?"right":null}];}));
 const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
 let color,ids,positions,world,worldPoints,worldNormals,forearmBounds={},armSections={},legSections={};let currentView="front",lastPick=null;
 const dark=new THREE.Color("#303030"),light=new THREE.Color("#eeeeee"),vec=new THREE.Vector3();
 function sideFor(region,i){if(region.side)return region.side;if(region.area==="chest")return worldPoints[i*3]>0?"left":"right";return null;}
 function cacheGeometry(){
 worldPoints=new Float32Array(ids.count*3);worldNormals=new Float32Array(ids.count*3);forearmBounds={};armSections={};legSections={};
 const normal=geometry.attributes.normal,normalMatrix=new THREE.Matrix3().getNormalMatrix(world),n=new THREE.Vector3();
 if(!normal)throw Error("Model normals unavailable");
 for(let i=0;i<ids.count;i++){vec.fromBufferAttribute(positions,i).applyMatrix4(world);worldPoints.set([vec.x,vec.y,vec.z],i*3);n.fromBufferAttribute(normal,i).applyNormalMatrix(normalMatrix);worldNormals.set([n.x,n.y,n.z],i*3);
 const region=regions.get(Math.round(ids.getX(i)));if(region.area==="inner_forearm"||region.area==="outer_forearm"){const b=forearmBounds[region.side]??=[Infinity,-Infinity];b[0]=Math.min(b[0],vec.y);b[1]=Math.max(b[1],vec.y);}}
 // A smoothed centreline from horizontal cross-sections of the actual limb mesh.
 // The selected hemisphere is a spatial half-plane, not a single mesh facet
 // or a normal-based patch that changes with local muscle curvature.
 for(const limb of ["arm","leg"]){const armBases=new Set(limb==="arm"?["shoulder","upper_arm","elbow","forearm","wrist"]:["thigh","knee","calf","ankle"]);const sections=limb==="arm"?armSections:legSections;
 for(const side of ["left","right"]){
 const points=[];let minY=Infinity,maxY=-Infinity;
 for(let i=0;i<ids.count;i++){const region=regions.get(Math.round(ids.getX(i)));if(region.side!==side||!armBases.has(region.base))continue;const j=i*3,x=worldPoints[j],y=worldPoints[j+1],z=worldPoints[j+2];points.push([x,y,z]);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
 if(!points.length||maxY<=minY)continue;
 const bins=32,step=(maxY-minY)/bins,centres=[];
 for(let n=0;n<=bins;n++){const y=minY+n*step;let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;for(const [x,py,z] of points){if(Math.abs(py-y)>step*1.25)continue;x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);}centres.push(x0!==Infinity?[(x0+x1)/2,(z0+z1)/2]:null);}
 const fallback=points[Math.floor(points.length/2)];for(let n=0;n<=bins;n++){if(centres[n])continue;let j=n;while(j>0&&!centres[j])j--;let k=n;while(k<bins&&!centres[k])k++;centres[n]=centres[j]||centres[k]||[fallback[0],fallback[2]];}
 const smooth=centres.map((v,n)=>{const a=centres[Math.max(0,n-1)],b=centres[Math.min(bins,n+1)];return [(a[0]+2*v[0]+b[0])/4,(a[1]+2*v[1]+b[1])/4];});
 const elbow=[...groups.values()].find(g=>g.base===(limb==="arm"?"elbow":"knee")&&g.side===(side==="left"?"l":"r"));
 const shoulder=[...groups.values()].find(g=>g.base==="shoulder"&&g.side===(side==="left"?"l":"r"));
 sections[side]={minY,step,centres:smooth,elbowY:elbow?.center[1],shoulder};
 }
 }
 }
 function recolor(){
 if(!geometry||!ids||!worldPoints)return;
 const patches=new Map(),candidates=new Map(),panels=new Map();
 const keyFor=(info,side)=>info.region+"|"+(side||"centre");
 const broadPanel=info=>info?.scale==="area"&&info.single&&info.coverage==="panel"&&["forearm","upper_arm"].includes(info.part);
 const onePanel=info=>info?.scale==="area"&&info.single&&info.coverage==="panel"&&["thigh","calf","shin"].includes(info.part);
 function panelFacing(info,side,i){
 const face=info.half==="inner"||info.half==="outer"?info.half:info.surface==="unsure"?"front":info.surface||"front",s=(info.region==="leg"?legSections:armSections)[side],j=i*3,outer=side==="left"?1:-1;
 let x=worldNormals[j],z=worldNormals[j+2];
 if(s){const t=THREE.MathUtils.clamp((worldPoints[j+1]-s.minY)/s.step,0,s.centres.length-1),a=Math.floor(t),b=Math.min(a+1,s.centres.length-1),cx=THREE.MathUtils.lerp(s.centres[a][0],s.centres[b][0],t-a),cz=THREE.MathUtils.lerp(s.centres[a][1],s.centres[b][1],t-a);x=worldPoints[j]-cx;z=worldPoints[j+2]-cz;}
 return face==="inner"?x*outer<=0:face==="outer"?x*outer>=0:face==="back"?z<=0:z>=0;
 }
 // Choose one anatomical surface for a small design, preferring the last tapped surface.
 for(let i=0;i<ids.count;i++){
 const region=regions.get(Math.round(ids.getX(i))),side=sideFor(region,i),info=coverage(region.area,side);
 if(info?.scale!=="small"&&!onePanel(info))continue;
 const k=keyFor(info,side),score=(lastPick?.id===region.id&&lastPick.side===side?100:0)+(info.part==="forearm"&&info.surface===region.facet?10:0)+(currentView==="front"?region.normal[2]:-region.normal[2]);
 const before=candidates.get(k);if(!before||score>before.score)candidates.set(k,{region,side,score,info});
 }
 for(const [k,{region,side,info}] of candidates){
 if(onePanel(info)){panels.set(k,region.id);continue;}
 const center=lastPick?.id===region.id&&lastPick.side===side?lastPick.point:region.center;
 const radius=Math.max(.016,Math.min(.065,region.radius*.43));
 patches.set(k,{id:region.id,center,radius,min:Infinity});
 }
 for(let i=0;i<ids.count;i++){
 const region=regions.get(Math.round(ids.getX(i))),side=sideFor(region,i),info=coverage(region.area,side);
 if(info?.scale!=="small")continue;
 const patch=patches.get(keyFor(info,side));if(!patch||patch.id!==region.id)continue;
 const d=Math.hypot(worldPoints[i*3]-patch.center[0],worldPoints[i*3+1]-patch.center[1],worldPoints[i*3+2]-patch.center[2]);
 patch.min=Math.min(patch.min,d);
 }
 let count=0,shoulderTrimmed=0;const highlighted={};
 for(let i=0;i<ids.count;i++){
 const region=regions.get(Math.round(ids.getX(i))),side=sideFor(region,i),info=coverage(region.area,side);
 let active=!!info;
 if(active&&info.scale==="area"){
 const j=i*3,x=Math.abs(worldPoints[j]),y=worldPoints[j+1],z=worldPoints[j+2],g=groups.get(region.group);
 switch(info.part){
 case "upper_back": if(region.base==="spine")active=y>=1.19;break;
 case "shoulder_blade": if(region.base==="upper_back")active=x>=.055&&y>=1.18;break;
 case "side_neck": active=region.base==="neck"&&x>=.025;break;
 case "behind_ear": active=region.base==="head"&&x>=.055&&y>=1.51&&y<=1.62&&z<=.02;break;
 case "back_of_hand": active=region.base==="hand"&&region.facet==="back";break;
 case "side_of_hand": active=region.base==="hand"&&g&&Math.abs(x-Math.abs(g.center[0]))>=.018;break;
 case "top_of_foot": active=region.base==="foot"&&region.facet==="top";break;
 case "side_of_foot": active=region.base==="foot"&&g&&Math.abs(x-Math.abs(g.center[0]))>=.035;break;
 case "toes": active=region.base==="foot"&&region.facet==="top"&&g&&z>g.center[2]+.055;break;
 case "side": if(region.base==="abdomen")active=x>=.09;break;
 }
 }
 if(active&&info.scale==="area"&&region.base==="elbow"){
 const upper=info.part==="upper_arm"||info.part==="half_sleeve"&&info.half==="upper",lower=info.part==="forearm"||info.part==="half_sleeve"&&info.half==="lower",cut=armSections[side]?.elbowY;
 if(Number.isFinite(cut)){if(upper)active=worldPoints[i*3+1]>=cut;else if(lower)active=worldPoints[i*3+1]<cut;}
 }
 if(active&&(broadPanel(info)||["half_sleeve","half_leg_sleeve"].includes(info.part)&&["inner","outer"].includes(info.half)))active=panelFacing(info,side,i);
 if(active&&info.part==="half_leg_sleeve"&&region.base==="knee"){const cut=legSections[side]?.elbowY;if(Number.isFinite(cut)){if(info.half==="upper")active=worldPoints[i*3+1]>=cut;else if(info.half==="lower")active=worldPoints[i*3+1]<cut;}}
 // Arm projects stop at the deltoid cap. The source shoulder label also
 // contains medial/top vertices on the trapezius; keep those out of arm coverage.
 if(active&&info.scale==="area"&&region.base==="shoulder"&&["upper_arm","half_sleeve","three_quarter_sleeve","full_sleeve"].includes(info.part)){
 const shoulder=armSections[side]?.shoulder;
 if(shoulder){const y=worldPoints[i*3+1],lateral=Math.abs(worldPoints[i*3]),rise=Math.max(0,y-shoulder.center[1]);
 const medialLimit=Math.abs(shoulder.center[0])-shoulder.radius*.30+.85*rise;
 const topLimit=shoulder.center[1]+shoulder.radius*.72;
 if(lateral<medialLimit||y>topLimit){active=false;shoulderTrimmed++;}}
 }
 if(active&&onePanel(info))active=panels.get(keyFor(info,side))===region.id;
 if(active&&info.part==="three_quarter_sleeve"&&(region.area==="inner_forearm"||region.area==="outer_forearm")){const b=forearmBounds[region.side];active=!!b&&worldPoints[i*3+1]>=(b[0]+b[1])/2;}
 if(active&&info.scale==="small"){
 const patch=patches.get(keyFor(info,side));
 active=!!patch&&patch.id===region.id&&Math.hypot(worldPoints[i*3]-patch.center[0],worldPoints[i*3+1]-patch.center[1],worldPoints[i*3+2]-patch.center[2])<=Math.max(patch.radius,patch.min+.008);
 }
 if(active){count++;const key=region.base+"|"+(side||"centre");highlighted[key]=(highlighted[key]||0)+1;}
 const c=active?light:dark;color.setXYZ(i,c.r,c.g,c.b);
 }
 canvas.dataset.shoulderTrimmed=String(shoulderTrimmed);canvas.dataset.highlightedRegions=JSON.stringify(highlighted);canvas.dataset.selectedVertices=String(count);canvas.dataset.vertexCount=String(ids.count);color.needsUpdate=true;invalidate();
 }
 async function load(file){const gltf=await loader.loadAsync(new URL(file,base).href);if(dead){gltf.scene.traverse(o=>{if(o.isMesh){o.geometry.dispose();o.material.dispose();}});return;}
 let src;gltf.scene.traverse(o=>{if(o.isMesh&&!src)src=o;});if(!src||!src.geometry.attributes._data)throw Error("Missing region-labelled mesh");src.updateWorldMatrix(true,false);const next=src.geometry,nextIds=next.attributes._data;
 for(let i=0;i<nextIds.count;i++)if(!regions.has(Math.round(nextIds.getX(i))))throw Error("Invalid GLB region id");
 if(mesh){scene.remove(mesh);geometry.dispose();}
 geometry=next;ids=nextIds;positions=geometry.attributes.position;world=src.matrixWorld.clone();src.material.dispose();
 color=new THREE.BufferAttribute(new Float32Array(ids.count*3),3);geometry.setAttribute("color",color);
 material??=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.78,metalness:0});
 mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;mesh.matrix.copy(world);scene.add(mesh);mesh.updateMatrixWorld(true);cacheGeometry();recolor();invalidate();
 }
 const ray=new THREE.Raycaster(),ndc=new THREE.Vector2();let down=null,multi=false;
 canvas.addEventListener("pointerdown",e=>{if(!e.isPrimary){multi=true;down=null;return;}multi=false;down={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now()};});
 canvas.addEventListener("pointercancel",()=>{down=null;multi=true;});
 canvas.addEventListener("pointerup",e=>{const d=down;down=null;if(!d||multi||d.id!==e.pointerId||Math.hypot(e.clientX-d.x,e.clientY-d.y)>8||performance.now()-d.t>500||!mesh)return;const b=canvas.getBoundingClientRect();ndc.set((e.clientX-b.left)/b.width*2-1,-((e.clientY-b.top)/b.height)*2+1);ray.setFromCamera(ndc,camera);const hit=ray.intersectObject(mesh,false)[0];if(!hit)return;const region=regions.get(Math.round(ids.getX(hit.face.a)));if(region){const side=region.side||(region.area==="chest"?(hit.point.x>0?"left":"right"):null);lastPick={id:region.id,side,point:hit.point.toArray()};onPick(region.area,side||(hit.point.x>0?"left":"right"),region.facet);}});
 function resize(){const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false);invalidate();}
 observer=new ResizeObserver(resize);observer.observe(host);
 visibleObserver=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible){resize();invalidate();}});visibleObserver.observe(host);
 canvas.addEventListener("webglcontextlost",e=>{e.preventDefault();dispose();onError();},{once:true});
 await load("male_lod1.glb");canvas.dataset.ready="true";resize();invalidate();
 if(!navigator.connection?.saveData)load("male_lod0.glb").then(()=>{if(!dead)canvas.dataset.detail="high";}).catch(err=>console.warn("High-detail model unavailable",err));
 return {update:recolor,focus(regionKey){
 if(!mesh||!worldPoints||!regionKey)return;
 const bounds=new THREE.Box3();for(let i=0;i<ids.count;i++){const region=regions.get(Math.round(ids.getX(i))),side=sideFor(region,i),info=coverage(region.area,side);if(info?.region===regionKey)bounds.expandByPoint(vec.fromArray(worldPoints,i*3));}
 if(bounds.isEmpty())return;const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(.22,size.length()/2);const delta=camera.position.clone().sub(controls.target).normalize();const halfFov=THREE.MathUtils.degToRad(camera.fov/2),horizontal=Math.atan(Math.tan(halfFov)*camera.aspect);const distance=Math.max(controls.minDistance,Math.min(controls.maxDistance,1.35*radius/Math.sin(Math.min(halfFov,horizontal))));controls.target.copy(center);camera.position.copy(center).addScaledVector(delta,distance);controls.update();canvas.dataset.focusedArea=regionKey;invalidate();
 },view(v){delete canvas.dataset.focusedArea;currentView=v;camera.position.set(0,.85,v==="back"?-3.65:3.65);controls.target.set(0,.84,0);controls.update();recolor();invalidate();},zoom(f){const delta=camera.position.clone().sub(controls.target);delta.multiplyScalar(f);delta.clampLength(controls.minDistance,controls.maxDistance);camera.position.copy(controls.target).add(delta);controls.update();invalidate();},dispose};
 }catch(err){dispose();throw err;}
};
