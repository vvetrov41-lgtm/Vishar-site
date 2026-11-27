import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {prepareGalleryAssets,applyPreparedGalleryMarkup} from './prepare-gallery-assets.mjs';

test('new JPEG and PNG prepare WebP previews without changing originals; markup keeps lightbox link',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-test-'));
 try{
  for(const [d,f,format] of [['portraits','27.jpg','jpeg'],['healed/fresh','26.png','png']]){
    const dir=path.join(root,'assets',d);await fs.mkdir(dir,{recursive:true});
    const p=path.join(dir,f);
    await sharp({create:{width:1100,height:1400,channels:3,background:'#884455'}}).toFormat(format).toFile(p);
  }
  const original=await fs.readFile(path.join(root,'assets/portraits/27.jpg'));
  const changes=await prepareGalleryAssets(root,{baseline:{},sharp});
  assert.ok(changes.get('/assets/portraits/27.jpg'));
  assert.deepEqual(await fs.readFile(path.join(root,'assets/portraits/27.jpg')),original);
  assert.equal((await sharp(path.join(root,'assets/portraits/27.webp')).metadata()).format,'webp');
  assert.equal((await sharp(path.join(root,'assets/healed/fresh/thumbs/26-480.webp')).metadata()).width,480);
  const p=path.join(root,'portrait-tattoo-artist-london/index.html');
  await fs.mkdir(path.dirname(p),{recursive:true});
  await fs.writeFile(p,'<!-- build:gallery --><a href="/assets/portraits/27.webp"><img src="/assets/portraits/27.webp" alt="Example" loading="lazy"></a><!-- /build:gallery -->');
  await applyPreparedGalleryMarkup(root,changes);
  const html=await fs.readFile(p,'utf8');
  assert.match(html,/href="\/assets\/portraits\/27.webp"/);
  assert.match(html,/srcset="[^"]+27-320\.webp 320w/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
