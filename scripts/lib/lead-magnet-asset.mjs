import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const GUIDE_PDF_PATH='assets/lead-magnets/cover-up-guide-v7.pdf';
const SOURCE='source-assets/lead-magnets/Vladimir_Vishar_The_Art_of_Tattoo_Cover_Ups_v7.pdf';
export async function readGuidePdf(root, built=false) {
  const bytes=await fs.readFile(path.join(root,built?GUIDE_PDF_PATH:SOURCE));
  if(bytes.length!==4182928||createHash('sha256').update(bytes).digest('hex')!=='97415c63539508270d81ffb90fe637bb1495678cf724b7a24cb2ebd8ae76e59b')throw Error('Guide PDF checksum mismatch');
  return bytes;
}
