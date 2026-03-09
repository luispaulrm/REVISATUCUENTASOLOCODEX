import fs from 'node:fs';
import { extractRawPdfPayload } from './server/endpoints/raw-extract.endpoint.ts';

const pdfPath = 'C:/Users/drlui/OneDrive/Documentos/INDISA/SANTIAGO/pag1.pdf';
const b64 = fs.readFileSync(pdfPath).toString('base64');
const out = await extractRawPdfPayload(b64, 1);
for (const r of out.pages[0].rows) {
  const t = r.text.trim();
  const isDetail = /^CODIGO\s+\d{5,8}\b/i.test(t) || /^\d{5,8}\s+[A-Zаимсзя]/i.test(t.toUpperCase());
  const tokens = t.match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g) || [];
  const isSubtotal = (t.toUpperCase().includes('TOTAL') || t.toUpperCase().includes('SUBTOTAL')) || (tokens.length >= 6 && !/[A-Z]/.test(t.toUpperCase().replace(/[0-9\s.,/-]/g, '')));
  if (isDetail || isSubtotal || /\d{3,5}\s+[A-Z]/i.test(t)) {
    console.log(r.rowIndex, t, 'DETAIL=', isDetail, 'SUB=', isSubtotal, 'TOK=', tokens.length);
  }
}
