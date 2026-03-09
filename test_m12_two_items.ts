import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tryExtractM12TwoItems } from './server/endpoints/m12.endpoint.js';

async function run() {
  const pdfPath = 'c:/Users/drlui/OneDrive/Documentos/INDISA/SANTIAGO/BSLU2109B4 (1) (3).pdf';
  const data = fs.readFileSync(pdfPath);
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any).promise;

  const page = await pdf.getPage(3);
  const tc = await page.getTextContent();
  const out = tryExtractM12TwoItems(tc.items || []);

  if (!out) throw new Error('Extraction returned null');

  const checks = [
    out.libre_eleccion?.['Dia Cama']?.bonificacion_pct === 90,
    out.libre_eleccion?.['Sala Cuna']?.bonificacion_pct === 90,
    out.libre_eleccion?.['Dia Cama']?.tope_evento?.valor === 5,
    out.libre_eleccion?.['Sala Cuna']?.tope_evento?.valor === 2.2,
    out.libre_eleccion?.['Dia Cama']?.tope_anual === 'SIN_TOPE_ITEM',
    out.oferta_preferente?.['Dia Cama']?.length === 2,
    out.oferta_preferente?.['Sala Cuna']?.length === 2
  ];

  if (checks.some((c) => !c)) {
    console.error(JSON.stringify(out, null, 2));
    throw new Error('M12 two-items regression failed');
  }

  console.log('M12 two-items regression passed');
  console.log(JSON.stringify(out, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

