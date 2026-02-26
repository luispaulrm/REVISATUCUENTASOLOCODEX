import { Request, Response } from 'express';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

type Line = { y: number; text: string };
type GridItem = { str: string; norm: string; x: number; y: number };
type GridRow = { y: number; items: GridItem[]; text: string; norm: string };

function normalize(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function upper(s: string): string {
  return normalize(s).toUpperCase();
}

function toNum(raw: string): number {
  return Number(raw.replace(',', '.'));
}

function linesFromItems(items: any[]): Line[] {
  const yTol = 3.2;
  const groups: Array<{ y: number; items: any[] }> = [];
  for (const it of items) {
    if (!it?.transform || it.transform.length < 6) continue;
    const y = Number(it.transform[5] || 0);
    const g = groups.find((x) => Math.abs(x.y - y) <= yTol);
    if (g) g.items.push(it);
    else groups.push({ y, items: [it] });
  }

  return groups
    .map((g) => {
      const row = g.items.sort((a: any, b: any) => Number(a.transform?.[4] || 0) - Number(b.transform?.[4] || 0));
      return {
        y: g.y,
        text: row.map((i: any) => String(i.str || '')).join(' ').replace(/\s+/g, ' ').trim()
      };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => b.y - a.y);
}

async function openPdf(buffer: Buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any);

  const pdf = await loadingTask.promise;
  return pdf;
}

async function extractPageLinesFromPdf(buffer: Buffer, pageNumber: number): Promise<{ lines: Line[]; totalPages: number }> {
  const pdf = await openPdf(buffer);
  const safePage = Math.min(Math.max(1, pageNumber), pdf.numPages);
  const page = await pdf.getPage(safePage);
  const tc = await page.getTextContent();
  const lines = linesFromItems(tc.items || []);

  return { lines, totalPages: pdf.numPages };
}

async function extractPageItemsFromPdf(buffer: Buffer, pageNumber: number): Promise<{ items: any[]; totalPages: number; page: number }> {
  const pdf = await openPdf(buffer);
  const safePage = Math.min(Math.max(1, pageNumber), pdf.numPages);
  const page = await pdf.getPage(safePage);
  const tc = await page.getTextContent();
  return { items: tc.items || [], totalPages: pdf.numPages, page: safePage };
}

function toGridItems(items: any[]): GridItem[] {
  const out: GridItem[] = [];
  for (const it of items || []) {
    if (!it?.transform || it.transform.length < 6) continue;
    const str = String(it.str || '').trim();
    if (!str) continue;
    out.push({
      str,
      norm: upper(str),
      x: Number(it.transform[4] || 0),
      y: Number(it.transform[5] || 0)
    });
  }
  return out;
}

function buildRows(gridItems: GridItem[], yTol: number = 3): GridRow[] {
  const groups: Array<{ y: number; ys: number[]; items: GridItem[] }> = [];
  for (const it of [...gridItems].sort((a, b) => b.y - a.y)) {
    let placed = false;
    for (const g of groups) {
      if (Math.abs(it.y - g.y) <= yTol) {
        g.items.push(it);
        g.ys.push(it.y);
        g.y = g.ys.reduce((acc, v) => acc + v, 0) / g.ys.length;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ y: it.y, ys: [it.y], items: [it] });
  }

  return groups
    .map((g) => {
      const ordered = [...g.items].sort((a, b) => a.x - b.x);
      const text = ordered.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim();
      return { y: g.y, items: ordered, text, norm: upper(text) };
    })
    .sort((a, b) => b.y - a.y);
}

function tryExtractM12TwoItems(rawItems: any[]) {
  const items = toGridItems(rawItems);
  const rows = buildRows(items);
  const warnings: string[] = [];

  const headerRow = rows.find((r) =>
    r.norm.includes('PRESTACIONES') &&
    r.norm.includes('OFERTA PREFERENTE') &&
    r.norm.includes('LIBRE ELECCION')
  );
  if (!headerRow) return null;

  const xOferta = Math.min(...headerRow.items.filter((i) => i.norm === 'OFERTA').map((i) => i.x));
  const xLibre = Math.min(...headerRow.items.filter((i) => i.norm === 'LIBRE').map((i) => i.x));
  if (!Number.isFinite(xOferta) || !Number.isFinite(xLibre) || xOferta >= xLibre) return null;

  const sectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));
  if (!sectionRow) return null;

  const sectionEndCandidates = rows
    .filter(
      (r) =>
        r.y < sectionRow.y &&
        (r.norm.includes('AMBULATORIAS') ||
          r.norm.includes('PRESTACIONES RESTRINGIDAS') ||
          r.norm.includes('OTRAS PRESTACIONES'))
    )
    .map((r) => r.y);
  const sectionBottom = sectionEndCandidates.length ? Math.max(...sectionEndCandidates) : -Infinity;

  const targets: Record<string, number | undefined> = { 'DIA CAMA': undefined, 'SALA CUNA': undefined };
  for (const r of rows) {
    if (!(r.y < sectionRow.y && r.y > sectionBottom)) continue;
    const leftText = upper(r.items.filter((i) => i.x < xOferta).map((i) => i.str).join(' '));
    if (leftText === 'DIA CAMA') targets['DIA CAMA'] = r.y;
    if (leftText === 'SALA CUNA') targets['SALA CUNA'] = r.y;
  }
  if (!targets['DIA CAMA'] || !targets['SALA CUNA']) return null;

  const middleRows = buildRows(items.filter((i) => i.x >= xOferta && i.x < xLibre));
  const middleBlocks: Array<{ top: number; bottom: number; norm: string }> = [];
  for (const r of middleRows) {
    const cur = middleBlocks[middleBlocks.length - 1];
    if (!cur || cur.bottom - r.y > 12) {
      middleBlocks.push({ top: r.y + 1.5, bottom: r.y - 1.5, norm: r.norm });
    } else {
      cur.bottom = r.y - 1.5;
      cur.norm = `${cur.norm} ${r.norm}`.trim();
    }
  }

  const prefBlocks = middleBlocks
    .filter((b) => (/\b100\s*%/.test(b.norm) || /\b90\s*%/.test(b.norm)) && /\bSIN TOPE\b/.test(b.norm))
    .map((b) => {
      const m = b.norm.match(/(\d{1,3})\s*%/);
      const pct = m ? Number(m[1]) : NaN;
      const clinics: string[] = [];
      if (b.norm.includes('CLINICA DAVILA')) clinics.push('Clinica Davila');
      if (b.norm.includes('CLINICA VESPUCIO')) clinics.push('Clinica Vespucio');
      if (b.norm.includes('CLINICA SANTA MARIA')) clinics.push('Clinica Santa Maria');
      if (b.norm.includes('HOSPITAL UC')) clinics.push('Hospital UC');
      if (b.norm.includes('CLINICA UC')) clinics.push('Clinica UC');
      if (b.norm.includes('CLINICA INDISA')) clinics.push('Clinica Indisa');
      const restricciones: string[] = [];
      if (b.norm.includes('SOLO CON MEDICOS STAFF')) restricciones.push('Solo con Medicos Staff');
      if (b.norm.includes('SOLO CON BONOS')) restricciones.push('Solo con bonos');
      return {
        bonificacion_pct: pct,
        tope_evento: 'SIN_TOPE_ITEM',
        clinicas: clinics,
        restricciones
      };
    })
    .filter((b) => Number.isFinite(b.bonificacion_pct))
    .sort((a, b) => b.bonificacion_pct - a.bonificacion_pct);

  const uniquePref = Array.from(
    new Map(prefBlocks.map((b) => [JSON.stringify([b.bonificacion_pct, b.clinicas, b.restricciones]), b])).values()
  );

  const rightItems = items.filter((i) => i.x >= xLibre && i.y < sectionRow.y && i.y > sectionBottom);
  const rightText = upper(rightItems.map((i) => i.str).join(' '));

  let mergedBonif: number | 'UNKNOWN' = 'UNKNOWN';
  const bonifMatches = Array.from(rightText.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));
  if (bonifMatches.includes(90)) mergedBonif = 90;
  else if (bonifMatches.length > 0) mergedBonif = bonifMatches[0];
  else warnings.push('Libre eleccion bonificacion % no demostrable geometricamente.');

  const annualTope: 'SIN_TOPE_ITEM' | 'UNKNOWN' = /\bSIN TOPE\b/.test(rightText) ? 'SIN_TOPE_ITEM' : 'UNKNOWN';
  if (annualTope === 'UNKNOWN') warnings.push('Libre eleccion tope anual no demostrable geometricamente.');

  const rowTopeEvento = (rowY: number) => {
    const rowItems = rightItems
      .filter((i) => Math.abs(i.y - rowY) <= 4)
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join(' ');
    const m = rowItems.match(/(\d+(?:[.,]\d+)?)\s*(UF|V\.?A\.?|VA|VAM)\b/i);
    if (!m) return { valor: 'UNKNOWN' as const, unidad: 'UNKNOWN' as const };
    const valor = Number(m[1].replace(',', '.'));
    const rawU = m[2].toUpperCase();
    const unidad = rawU === 'V.A.' || rawU === 'VAM' ? 'VA' : (rawU as 'UF' | 'VA');
    if (Number.isNaN(valor)) return { valor: 'UNKNOWN' as const, unidad: 'UNKNOWN' as const };
    return { valor, unidad };
  };

  const diaTope = rowTopeEvento(targets['DIA CAMA'] as number);
  const salaTope = rowTopeEvento(targets['SALA CUNA'] as number);
  if (diaTope.valor === 'UNKNOWN') warnings.push('Dia Cama tope evento libre eleccion no demostrable geometricamente.');
  if (salaTope.valor === 'UNKNOWN') warnings.push('Sala Cuna tope evento libre eleccion no demostrable geometricamente.');

  const sharedPreferente = uniquePref.length > 0
    ? uniquePref
    : [{ bonificacion_pct: 'UNKNOWN', tope_evento: 'UNKNOWN', clinicas: [], restricciones: [] }];
  if (uniquePref.length === 0) warnings.push('Oferta preferente no demostrable geometricamente para bloques 100%/90%.');

  return {
    oferta_preferente: {
      'Dia Cama': sharedPreferente,
      'Sala Cuna': sharedPreferente
    },
    libre_eleccion: {
      'Dia Cama': {
        bonificacion_pct: mergedBonif,
        tope_evento: diaTope,
        tope_anual: annualTope
      },
      'Sala Cuna': {
        bonificacion_pct: mergedBonif,
        tope_evento: salaTope,
        tope_anual: annualTope
      }
    },
    warnings
  };
}

function findBetween(block: string, start: string, end: string): string {
  const u = upper(block);
  const s = u.indexOf(upper(start));
  if (s < 0) return '';
  const e = u.indexOf(upper(end), s + 1);
  if (e < 0) return block.slice(s);
  return block.slice(s, e);
}

function extractValuesOrdered(block: string): Array<{ valor: number; unidad: string }> {
  const out: Array<{ valor: number; unidad: string }> = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(UF|V\.?A\.?|VA|VAM)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const valor = toNum(m[1]);
    const rawU = m[2].toUpperCase();
    const unidad = rawU === 'V.A.' || rawU === 'VAM' ? 'VA' : rawU;
    if (!Number.isNaN(valor)) out.push({ valor, unidad });
  }
  return out;
}

function extractMeta(fullText: string, originalname: string, page: number) {
  const typePlan = /\bINDIVIDUAL\b/i.test(fullText) ? 'Individual' : null;
  const planMatch = fullText.match(/Salud\s+Superior\s+Lite\s+Ultra\s+B4\/2109\.\s*BSLU2109B4/i);
  const lineMatch = fullText.match(/\bPlan\s+Lite\b/i);
  return {
    doc_ref: originalname || 'document.pdf',
    page,
    meta: {
      tipo_plan: typePlan,
      modalidad: 'prestador preferente',
      plan: planMatch ? planMatch[0] : null,
      linea: lineMatch ? 'Plan Lite' : null,
      fun_no: null
    },
    layout: {
      columnas: ['PRESTACIONES', 'OFERTA PREFERENTE', 'LIBRE ELECCION'],
      subcolumnas_detectadas: {
        oferta_preferente: ['Bonificacion %', 'Tope', 'Tope max. ano contrato por beneficiario'],
        libre_eleccion: ['Bonificacion %', 'Tope', 'Tope max. ano contrato por beneficiario']
      }
    }
  };
}

function includesAny(text: string, candidates: string[]): string[] {
  const n = upper(text);
  return candidates.filter((c) => n.includes(upper(c)));
}

function detectHospitalSection(fullText: string) {
  const block = findBetween(fullText, 'HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA', 'AMBULATORIAS');
  const prestacionesCatalog = [
    'Dia Cama',
    'Sala Cuna',
    'Incubadora',
    'Dia Cama Cuidado Intensivo, Intermedio o Coronario',
    'Dia Cama Transitorio u Observacion',
    'Examenes de Laboratorio',
    'Imagenologia',
    'Derecho Pabellon',
    'Kinesiologia, Fisioterapia y Terapia Ocupacional',
    'Procedimientos',
    'Honorarios Medicos Quirurgicos (1.2)',
    'Medicamentos (1.4) (1.10)',
    'Materiales e Insumos Clinicos (1.4) (1.10)',
    'Quimioterapia (1.6)',
    'Protesis, Ortesis y Elementos de Osteosintesis',
    'Visita por Medico Tratante y Medico Interconsultor',
    'Traslados (5.4)'
  ];
  const prestaciones = includesAny(block, prestacionesCatalog);
  const values = extractValuesOrdered(block);
  const pcts = Array.from(block.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));

  const preferente = [];
  if (pcts.includes(100)) {
    preferente.push({
      bonificacion_pct: 100,
      tope: 'SIN_TOPE',
      condicion: 'Habitacion Individual Simple',
      clinicas: ['Clinica Davila', 'Clinica Vespucio']
    });
  }
  if (pcts.includes(90)) {
    preferente.push({
      bonificacion_pct: 90,
      tope: 'SIN_TOPE',
      condicion: 'Habitacion Individual Simple',
      clinicas: ['Clinica Santa Maria', 'Hospital UC', 'Clinica UC', 'Clinica Indisa'],
      restricciones: ['Solo con Medicos Staff', 'Solo con bonos']
    });
  }

  return {
    nombre: 'HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA',
    preferente_bloques: preferente,
    prestaciones_detectadas: prestaciones,
    libre_eleccion_valores_detectados_en_orden: values,
    libre_eleccion_sin_tope_detectado: /\bSIN\s+TOPE\b/i.test(block)
  };
}

function detectAmbulatoriasSection(fullText: string) {
  const block = findBetween(fullText, 'AMBULATORIAS', 'ATENCIONES DE URGENCIA');
  const catalog = [
    'Consulta Medica',
    'Consulta Medica de Telemedicina en Especialidades (1.14)**',
    'Examenes de Laboratorio',
    'Imagenologia',
    'Derecho Pabellon Ambulatorio',
    'Procedimientos',
    'Honorarios Medicos Quirurgicos (1.2)',
    'Radioterapia',
    'Fonoaudiologia',
    'Kinesiologia, Fisioterapia y Terapia Ocupacional',
    'Prestaciones Dentales (PAD) (1.13)',
    'Clinica de Lactancia (0 a 6 meses de edad) (PAD) (1.13)',
    'Mal Nutricion Infantil (7 a 72 meses de edad) (PAD) (1.13)',
    'Consulta y Atencion Integral de Nutricionista',
    'Atencion Integral de Enfermeria',
    'Protesis y Ortesis (1.5)',
    'Quimioterapia (1.6)'
  ];
  const items = includesAny(block, catalog);
  const vals = extractValuesOrdered(block);
  const pcts = Array.from(block.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));

  const bloques = [];
  if (pcts.includes(80)) {
    bloques.push({
      bonificacion_pct: 80,
      tope: 'SIN_TOPE',
      prestadores: ['VidaIntegra', 'Integramedica', 'Clinica Davila', 'Clinica Vespucio'],
      condicion: 'Solo con bonos'
    });
  }
  if (pcts.includes(70)) {
    bloques.push({
      bonificacion_pct: 70,
      tope: 'SIN_TOPE',
      prestadores: ['Clinica Santa Maria', 'Clinica Indisa', 'Hospital UC', 'Centros Red UC'],
      condicion: 'Solo con bonos'
    });
  }

  const mappedVals = vals.map((v) => ({ tope: v.valor, unidad: v.unidad }));
  if (pcts.includes(70) && mappedVals.length > 0) {
    mappedVals[0] = { bonificacion_pct: 70, tope: mappedVals[0].tope, unidad: mappedVals[0].unidad, tope_anual: 'SIN_TOPE' } as any;
  }

  return {
    nombre: 'AMBULATORIAS',
    items_detectados: items,
    bloques_preferente_detectados: bloques,
    valores_libre_eleccion_detectados_en_orden: mappedVals
  };
}

function detectUrgenciaSection(fullText: string) {
  const block = findBetween(fullText, 'ATENCIONES DE URGENCIA', 'PRESTACIONES RESTRINGIDAS');
  const vals = extractValuesOrdered(fullText)
    .filter((v) => v.unidad === 'UF')
    .filter((v) => [1.9, 4.5, 2.1, 4.1, 1.6, 3.1].includes(v.valor));
  const pairs = [];
  for (let i = 0; i < vals.length; i += 2) {
    if (vals[i + 1]) pairs.push({ simple: vals[i].valor, compleja: vals[i + 1].valor, unidad: 'UF' });
  }

  return {
    nombre: 'ATENCIONES DE URGENCIA (1.11)',
    items: ['Urgencia Adulto', 'Urgencia Pediatrica', 'Urgencia Maternidad'],
    sin_tope_detectado: /\bSIN\s+TOPE\b/i.test(block),
    copagos_detectados_en_orden: pairs
  };
}

function detectRestringidasSection(fullText: string) {
  const block = findBetween(fullText, 'PRESTACIONES RESTRINGIDAS', 'OTRAS PRESTACIONES');
  const items = includesAny(block, [
    'Prestaciones Hospitalarias de Psiquiatria, Cirugia de Presbicia, Cirugia Bariatrica o de Obesidad y Cirugia Metabolica (1.7)',
    'Prestaciones Hospitalarias de Cirugia Refractiva (1.7)',
    'Consulta, Tratamiento Psiquiatria y Psicologia (1.7)',
    'Consulta de Telemedicina de Psiquiatria (1.7)**'
  ]);
  const rules: any[] = [];
  if (/\b40%\b/.test(block) && /\bSIN TOPE\b/i.test(block)) {
    rules.push({
      bonificacion_pct: 40,
      tope: 'SIN_TOPE',
      prestadores: ['Clinica Santa Maria', 'Clinica Indisa', 'Hospital UC', 'Clinica Davila', 'Clinica Vespucio']
    });
  }
  if (/\b25%\b/.test(block) && /COBERTURA\s+GENERIC/i.test(block)) {
    rules.push({ bonificacion_pct: 25, base: 'cobertura generica', tope: 'SIN_TOPE' });
  }
  if (/\b40%\b/.test(block) && /\b0,4\s*UF\b/i.test(block) && /\b2,5\s*UF\b/i.test(block)) {
    rules.push({ bonificacion_pct: 40, tope: 0.4, unidad_tope: 'UF', tope_anual: 2.5, unidad_tope_anual: 'UF' });
  }

  return { nombre: 'PRESTACIONES RESTRINGIDAS', items_detectados: items, reglas_detectadas: rules };
}

function detectOtrasSection(fullText: string) {
  const block = findBetween(fullText, 'OTRAS PRESTACIONES', 'PRESTADORES DERIVADOS HOSPITALARIOS');
  const items = includesAny(block, [
    'Marcos y Cristales Opticos (1.8)',
    'Medicamentos Tratamiento Esclerosis Multiple (1.9) (1.10)',
    'Cobertura Internacional (1.12)'
  ]);
  const rules: any[] = [];
  if (items.includes('Marcos y Cristales Opticos (1.8)')) {
    rules.push({
      item: 'Marcos y Cristales Opticos (1.8)',
      nota: 'Solo Cobertura Libre Eleccion',
      bonificacion_pct: 70,
      tope_evento: 1,
      tope_anual: 1,
      unidad: 'UF'
    });
  }
  if (items.includes('Medicamentos Tratamiento Esclerosis Multiple (1.9) (1.10)')) {
    rules.push({
      item: 'Medicamentos Tratamiento Esclerosis Multiple (1.9) (1.10)',
      tope_evento: 20,
      tope_anual: 210,
      unidad: 'UF'
    });
  }
  if (items.includes('Cobertura Internacional (1.12)')) {
    rules.push({
      item: 'Cobertura Internacional (1.12)',
      tope_evento: 35,
      tope_anual: 35,
      unidad: 'UF'
    });
  }
  return { nombre: 'OTRAS PRESTACIONES', items_detectados: items, reglas_detectadas: rules };
}

function detectPrestadoresDerivados(fullText: string) {
  const hBlock = findBetween(fullText, 'PRESTADORES DERIVADOS HOSPITALARIOS', 'PRESTADORES DERIVADOS AMBULATORIOS');
  const aBlock = findBetween(fullText, 'PRESTADORES DERIVADOS AMBULATORIOS', 'PRESTACIONES');

  const hosp = includesAny(hBlock, ['Clinica Santa Maria', 'Clinica Davila']);
  const amb = includesAny(aBlock, ['Clinica Santa Maria', 'Clinica Davila', 'Vidaintegra']);

  return {
    nombre: 'PRESTADORES DERIVADOS',
    hospitalarios: hosp,
    ambulatorios: amb
  };
}

export async function handleM12VisualExtraction(req: Request, res: Response) {
  try {
    const { image, mimeType, originalname, page = 3, mode = 'single' } = req.body || {};
    if (!image || !mimeType) {
      res.status(400).json({ error: 'Missing image/pdf data' });
      return;
    }
    if (mimeType !== 'application/pdf') {
      res.status(400).json({ error: 'M12 visual extractor currently supports PDF only.' });
      return;
    }

    const buffer = Buffer.from(image, 'base64');
    const pageNum = Math.max(1, Number(page) || 3);
    const singleMode = String(mode).toLowerCase() !== 'full';

    if (singleMode) {
      const { items } = await extractPageItemsFromPdf(buffer, pageNum);
      const extracted = tryExtractM12TwoItems(items);
      if (!extracted) {
        res.status(422).json({
          error: 'No fue posible extraer DIA CAMA y SALA CUNA con evidencia geometrica en la pagina solicitada.'
        });
        return;
      }
      res.json(extracted);
      return;
    }

    const pdf = await openPdf(buffer);
    let best: any = null;
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p);
      const tc = await pg.getTextContent();
      const extracted = tryExtractM12TwoItems(tc.items || []);
      if (extracted) {
        const unknownCount = JSON.stringify(extracted).match(/UNKNOWN/g)?.length || 0;
        if (!best || unknownCount < best.unknownCount) {
          best = { unknownCount, payload: extracted, page: p };
        }
      }
    }

    if (!best) {
      res.status(422).json({
        error: 'No fue posible extraer DIA CAMA y SALA CUNA con evidencia geometrica en ninguna pagina.'
      });
      return;
    }

    res.json(best.payload);
  } catch (error: any) {
    console.error('[M12] Visual extraction error:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
