import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {resolve, extname, sep} from 'node:path';
import {chromium} from 'playwright';

const root=resolve('.');
const mime={'.html':'text/html','.css':'text/css','.js':'application/javascript','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.webp':'image/webp'};
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  let file=resolve(root,'.'+decodeURIComponent(url.pathname));
  if(file!==root && !file.startsWith(root+sep)){res.writeHead(403).end();return}
  if(existsSync(file)&&statSync(file).isDirectory())file=resolve(file,'index.html');
  if(!existsSync(file)){res.writeHead(404).end();return}
  res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address='http://127.0.0.1:'+server.address().port+'/aftercare/';
const browser=await chromium.launch({headless:true});
const errors=[];
async function checkViewport(width,height,mobile=false){
  const page=await browser.newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile});
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(address,{waitUntil:'networkidle'});
    const decline=page.getByRole('button',{name:'Decline',exact:true});
    if(await decline.count())await decline.click();
    assert.equal(await page.locator('#site-footer').count(),0,'Aftercare should not have global footer');
    await page.locator('label[for="vv-route-film"]').click();
    assert(await page.locator('#film').isVisible(),'Film selected');
    assert(!(await page.locator('#nofilm').isVisible()),'Other route hidden');
    const filmBg=await page.locator('#film').evaluate(el=>getComputedStyle(el).backgroundImage);
    const nofilmBg=await page.locator('#nofilm').evaluate(el=>getComputedStyle(el).backgroundImage);
    assert.notEqual(filmBg,nofilmBg,'distinct film/no-film materials');
    assert.match(filmBg,/radial-gradient/,'film glow');
    await page.locator('#film').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const filmMotion=await page.locator('#film').evaluate(el=>getComputedStyle(el,'::before').animationName);
    assert.match(filmMotion,/filmLiquid/,'original liquid motion preserved');
    const breathing=await page.locator('#film .photo').evaluate(el=>getComputedStyle(el).animationName);
    assert.match(breathing,/filmBreath/,'photo breathing preserved');
    const sheen=await page.locator('.vv-film-choice').evaluate(el=>getComputedStyle(el,'::after').animationName);
    assert.match(sheen,/acChoiceSheen/,'film choice sheen restored');
    const selectedCard=await page.locator('#film .rule').first().evaluate(el=>getComputedStyle(el).backgroundImage);
    assert.match(selectedCard,/linear-gradient/,'film card depth');
    const imgCount=await page.locator('.photo').evaluateAll(els=>els.filter(e=>e.naturalWidth>0).length);
    assert.equal(imgCount,2,'both healing-route photographs loaded');
    await page.locator('.mf-dock a[href="#nofilm"]').click();
    assert(await page.locator('#nofilm').isVisible(),'No-film selected from dock');
    assert(!(await page.locator('#film').isVisible()),'Film hidden from dock');
    await page.locator('#nofilm').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const morph=await page.locator('#nofilm').evaluate(el=>el.classList.contains('ac-section-in'));
    assert(morph,'section enter observer');
    const scrollWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
    assert(scrollWidth<=width+1,'no horizontal overflow');
    await page.screenshot({path:'/tmp/aftercare-'+width+'.png'});
    console.log('Aftercare '+width+'px film/no-film, CSS effects, reveal, images PASS');
  }finally{await page.close()}
}
try {
  await checkViewport(390,844,true);
  await checkViewport(1440,900,false);
  const p=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await p.goto(address,{waitUntil:'networkidle'});
  const stop=await p.locator('.vv-film-choice').evaluate(el=>getComputedStyle(el,'::after').animationName);
  assert.equal(stop,'none','reduced motion disables sheen');
  await p.close();
  assert.equal(errors.length,0,'uncaught errors: '+errors.join('; '));
  console.log('Aftercare reduced-motion and console PASS');
}finally{await browser.close();server.close()}
