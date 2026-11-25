// Preview-only 3D assets. No model binary is committed into this public repo.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const here=path.dirname(fileURLToPath(import.meta.url));
const models={"male_lod1.glb":"202053b7d055f93f5648061d58fac7313286f4e0","male_lod0.glb":"6b2284ea93cf763f63196eb5719690953fc3b6e8","male.regions.json":"a58c895e49c104f808aab96ad35e096ee9ef0051"};
export async function prepareCalculator3D(outDir){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"calculator3d-")),target=path.join(outDir,"assets","js","calculator3d");
 try{
 await fs.mkdir(target,{recursive:true});
 for(const [name,sha] of Object.entries(models)){
 const res=await fetch("https://tattoobodymap.com/models/"+name+"?v=2",{signal:AbortSignal.timeout(25000)});
 if(!res.ok)throw Error(name+": HTTP "+res.status);
 const data=Buffer.from(await res.arrayBuffer()),hash=createHash("sha1").update("blob "+data.length+"\0").update(data).digest("hex");
 if(hash!==sha)throw Error(name+": deployed model differs from reviewed TattooBodyMap revision; expected "+sha+", got "+hash);
 await fs.writeFile(path.join(target,name),data);
 }
 execFileSync("npm",["install","--prefix",tmp,"--no-save","--no-package-lock","--no-audit","--no-fund","three@0.186.0","esbuild@0.27.7"],{stdio:"inherit",timeout:120000});
 const esbuild=await import(pathToFileURL(path.join(tmp,"node_modules/esbuild/lib/main.js")).href);
 await esbuild.build({entryPoints:[path.join(here,"calculator-body3d-entry.mjs")],bundle:true,minify:true,format:"iife",platform:"browser",target:"es2020",nodePaths:[path.join(tmp,"node_modules")],outfile:path.join(target,"viewer.js"),legalComments:"linked"});
 await fs.copyFile(path.join(tmp,"node_modules/three/LICENSE"),path.join(target,"LICENSE"));
 console.log("Prepared TattooBodyMap preview GLB assets and 3D viewer");
 }catch(error){await fs.rm(target,{recursive:true,force:true});throw error;}finally{await fs.rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareCalculator3D(path.resolve(process.argv[2]||"."));
