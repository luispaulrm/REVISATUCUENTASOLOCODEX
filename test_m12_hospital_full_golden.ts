import fs from 'fs';
import assert from 'assert';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tryExtractM12HospitalFull } from './server/endpoints/m12.endpoint.js';

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      if (k === 'metadata') continue;
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

async function run() {
  const pdfPath = 'c:/Users/drlui/OneDrive/Documentos/INDISA/SANTIAGO/BSLU2109B4 (1) (3).pdf';
  const goldenPath = 'golden_set/m12_bslu2109b4_p3_hospital_full.json';

  if (!fs.existsSync(goldenPath)) {
    throw new Error(`Golden file not found: ${goldenPath}`);
  }

  const expected = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
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
  const actual = tryExtractM12HospitalFull(tc.items || []);

  assert.ok(actual, 'Extractor returned null');
  assert.deepStrictEqual(canonicalize(actual), canonicalize(expected));

  console.log('M12 hospital full golden snapshot passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

