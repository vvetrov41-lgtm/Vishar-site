// Local-only real WebGL rendering and scroll regression; no CRM or external requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium }=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=resolve('.');
const evidence=resolve(process.env.RUNNER_TEMP??'.','machine-evidence');
await mkdir(evidence,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.glb':'model/gltf-binary','.woff2':'font/woff2','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
 try{
  let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(p.endsWith('/'))p+='index.html';
  const f=resolve(root,'.'+p);
  if(!f.startsWith(root+sep))throw Error('outside');
  const body=await readFile(f);
  res.writeHead(200,{'Content-Type':types[extname(f).toLowerCase()]??'application/octet-stream'});res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const scroll=async(page,y)=>page.evaluate(y=>window.scrollTo({top:Math.max(0,y),behavior:'instant'}),y);
const get=page=>page.evaluate(()=>({mode:window.__machine.mode,ready:window.__machine.ready,reason:window.__machine.staticReason,loadMs:window.__machine.loadMs,scroll:window.scrollY,state:window.__machine.debugState(),stats:window.__machine.stats()}));
try{
 for(const [label,viewport,scale] of [['mobile',{width:390,height:844},3],['desktop',{width:1280,height:900},1]]){
  const context=await browser.newContext({viewport,deviceScaleFactor:scale,isMobile:label==='mobile',hasTouch:label==='mobile',reducedMotion:'no-preference'});
  try{
   const page=await context.newPage();
   const requests=[];
   const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   page.on('request',r=>requests.push(r.url()));
   await page.route('**/*',async route=>{
    const url=route.request().url();
    if(!url.startsWith(base+'/'))return route.abort();
    if(label==='mobile'&&/\.glb(?:\?|$)/.test(url))await new Promise(r=>setTimeout(r,1600));
    return route.continue();
   });
   await page.goto(base+'/',{waitUntil:'load',timeout:90000});
   await page.waitForFunction(()=>!!window.__machine);
   await page.waitForTimeout(1500);
   assert.equal((await get(page)).mode,'pending');
   assert.equal(requests.filter(u=>/three\.min\.js|tattoo-machine\.glb/.test(u)).length,0);
   await scroll(page,60);
   if(label==='mobile'){
    await page.waitForFunction(()=>document.querySelector('#machine-seq .machine-poster')?.complete);
    await scroll(page,await page.locator('#machine-seq').evaluate(el=>el.getBoundingClientRect().top+scrollY+100));
    await page.screenshot({path:resolve(evidence,label+'-loading.png'),timeout:60000});
   }
   await page.waitForFunction(()=>window.__machine.ready||window.__machine.mode==='static',{},{timeout:120000});
   const ready=await get(page);
   assert.equal(ready.mode,'live',JSON.stringify(ready));
   assert.ok(ready.stats?.triangles>0);
   const anchors=ready.state;
   const midpoint=anchors.assemblyStart+(anchors.assemblyEnd-anchors.assemblyStart)*.42;
   const late=anchors.assemblyStart+(anchors.assemblyEnd-anchors.assemblyStart)*.9;
   const early=anchors.assemblyStart+(anchors.assemblyEnd-anchors.assemblyStart)*.15;
   const snapshots=[];
   for(const [name,y] of [['assembly-middle',midpoint],['assembly-late',late],['reverse',early]]){
    await scroll(page,y);
    // Wait for the scroll handler to observe the new position before testing
    // convergence. A settled previous pose is not evidence of this scroll.
    const expected=(y-anchors.assemblyStart)/(anchors.assemblyEnd-anchors.assemblyStart);
    await page.waitForFunction(expected=>Math.abs(window.__machine.debugState().target-expected)<.03,expected,{timeout:45000});
    await page.waitForFunction(()=>Math.abs(window.__machine.debugState().target-window.__machine.debugState().current)<.06,{},{timeout:45000});
    const state=await get(page);
    assert.equal(state.mode,'live');
    assert.ok(state.stats.frames>0&&state.stats.triangles>0);
    snapshots.push({name,...state});
    console.log('MACHINE_POSE '+JSON.stringify({label,name,expected,actual:state}));
    await page.screenshot({path:resolve(evidence,label+'-'+name+'.png'),timeout:60000});
   }
   assert.ok(snapshots[1].state.target>snapshots[0].state.target+.25);
   assert.ok(snapshots[2].state.target<snapshots[0].state.target-.15);
   assert.ok(snapshots[2].stats.frames>snapshots[0].stats.frames);
   assert.equal(requests.filter(u=>/tattoo-machine\.glb/.test(u)).length,1);
   assert.deepEqual(errors,[]);
   const result={label,ready,snapshots,heavy:requests.filter(u=>/three\.min\.js|tattoo-machine\.glb/.test(u))};
   await writeFile(resolve(evidence,label+'.json'),JSON.stringify(result,null,2));
   console.log('MACHINE_BROWSER_RESULT '+JSON.stringify(result));
  }finally{await context.close();}
 }
 const reduced=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 try{
  const page=await reduced.newPage();
  const heavy=[];
  page.on('request',r=>{if(/three\.min\.js|tattoo-machine\.glb/.test(r.url()))heavy.push(r.url());});
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
  await page.goto(base+'/');
  await page.waitForFunction(()=>window.__machine?.mode==='static');
  assert.deepEqual(heavy,[]);
  console.log('MACHINE_REDUCED_MOTION_OK');
 }finally{await reduced.close();}
}finally{await browser.close();await new Promise(r=>server.close(r));}
