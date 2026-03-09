import fs from 'node:fs';
import { buildRawExtractAccount } from './server/endpoints/raw-extract.endpoint.ts';

const pdfPath = 'C:/Users/drlui/OneDrive/Documentos/INDISA/SANTIAGO/pag1.pdf';
const b64 = fs.readFileSync(pdfPath).toString('base64');
const out = await buildRawExtractAccount(b64, 1);
console.log('SECTIONS', out.sections?.length || 0);
console.log('ITEMS', out.totalItems || 0);
for (const s of (out.sections || [])) {
  console.log('SEC', s.category, 'ITEMS', s.items?.length || 0, 'TOTAL', s.sectionTotal || 0);
}
