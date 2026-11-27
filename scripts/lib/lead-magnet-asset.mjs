import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const GUIDE_PDF_PATH='assets/lead-magnets/cover-up-guide-v6.pdf';
const SOURCE='source-assets/lead-magnets/cover-up-guide-v6';
export async function readGuidePdf(root) {
  // A connector could not transfer the complete blob. Build one PDF from
  // explicitly ordered source parts; these sources are never served.
  const parts=await Promise.all(Array.from({length:13},(_,i)=>fs.readFile(path.join(root,SOURCE,'part-'+String(i+1).padStart(2,'0')+'.b64'),'utf8')));
  if(parts.some((part,i)=>!part||!(/^[A-Za-z0-9+/]+={0,2}$/).test(part)||part.length%4|| (i<12&&(part.length!==360000||part.includes('=')))))throw Error('Invalid guide asset parts');
  const bytes=Buffer.from(parts.join(''),'base64');
  if(bytes.length!==3462065||createHash('sha256').update(bytes).digest('hex')!=='c79e8510bdc992c852863c3df7962cdd7a580f454b06e31d320fb42f0050b1f7')throw Error('Guide PDF checksum mismatch');
  return bytes;
}
