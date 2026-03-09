import { Request, Response } from 'express';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildAzureLayoutWebPayloadFromPdfDocument, buildRawExtractAccountWithPage } from './raw-extract.endpoint.js';

type Line = { y: number; text: string };
type GridItem = { str: string; norm: string; x: number; y: number; x0: number; x1: number; y0: number; y1: number };
type GridRow = { y: number; items: GridItem[]; text: string; norm: string };
type HospitalGridDiagnostic = {
  page: number;
  sectionTitleFound: boolean;
  headerSchemaDetected: boolean;
  prestacionRowsDetected: number;
  failureReason: 'SECTION_TITLE_NOT_FOUND' | 'HEADER_SCHEMA_NOT_FOUND' | 'PRESTACION_ROWS_NOT_FOUND' | 'UNKNOWN';
};
type M12SourcePage = {
  pageNumber: number;
  items: any[];
  text: string;
  ocrSource: string;
};

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

function normalizeUnitToken(raw: string): 'UF' | 'VA' | 'UNKNOWN' {
  const u = upper(raw).replace(/\./g, '');
  if (u === 'UF') return 'UF';
  if (u === 'VA' || u === 'VAM') return 'VA';
  return 'UNKNOWN';
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

function computeDynamicYTol(gridItems: GridItem[]): number {
  const heights = gridItems.map((i) => Math.max(1, i.y1 - i.y0)).filter(Number.isFinite);
  const base = median(heights) || 8;
  const tol = base * 0.35;
  return Math.max(2.5, Math.min(6, tol));
}

type HeaderSchema = {
  xPrestacionesRight: number;
  xOferta: number;
  xLibre: number;
  op: { pctLeft: number; pctRight: number; eventLeft: number; eventRight: number; annualLeft: number };
  le: { pctLeft: number; pctRight: number; eventLeft: number; eventRight: number; annualLeft: number };
};

type SingleModeHeaderSchema = {
  xPrestacionesRight: number;
  bonif: { left: number; right: number; anchor: number };
  event: { left: number; right: number; anchor: number };
  annual: { left: number; right: number; anchor: number };
  extension: { left: number; anchor: number } | null;
};

function rowIncludesAll(row: GridRow, tokens: string[]): boolean {
  return tokens.every((token) => row.norm.includes(token));
}

function rowIncludesAny(row: GridRow, tokens: string[]): boolean {
  return tokens.some((token) => row.norm.includes(token));
}

function findRowAnchorX(row: GridRow, tokens: string[]): number | null {
  const matches = row.items.filter((item) => tokens.some((token) => item.norm.includes(token)));
  if (matches.length === 0) return null;
  return Math.min(...matches.map((item) => item.x0));
}

function parsePctFromNorm(normText: string): number | null {
  const match = normText.match(/(\d{1,3})\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseTopeFromNorm(normText: string) {
  const match = normText.match(/(\d+(?:[.,]\d+)?)\s*(UF|V\.?A\.?|VA|VAM)\b/i);
  if (!match) return null;
  const valor = Number(match[1].replace(',', '.'));
  if (Number.isNaN(valor)) return null;
  const unidad = normalizeUnitToken(match[2]);
  if (unidad === 'UNKNOWN') return null;
  return { valor, unidad };
}

function detectHeaderSchema(items: GridItem[], sectionY: number): HeaderSchema | null {
  const hdr = items.filter((i) => i.y > sectionY && i.y < sectionY + 260);
  const headerRows = buildRows(hdr, computeDynamicYTol(hdr));

  const prestExact = hdr.filter((i) => i.norm === 'PRESTACIONES').sort((a, b) => a.x - b.x)[0];
  const prestRow = headerRows.find((row) => row.norm.includes('PRESTACIONES'));
  const prestX = prestExact?.x0 ?? (prestRow ? findRowAnchorX(prestRow, ['PRESTACIONES']) : null);

  const ofertaExact = hdr
    .filter((i) => i.norm.includes('OFERTA PREFERENTE') || i.norm.includes('PRESTADOR PREFERENTE'))
    .sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const ofertaRow =
    headerRows.find((row) => rowIncludesAll(row, ['OFERTA', 'PREFERENTE'])) ||
    headerRows.find((row) => rowIncludesAll(row, ['PRESTADOR', 'PREFERENTE'])) ||
    headerRows.find((row) => rowIncludesAny(row, ['PREFERENTE']) && !rowIncludesAny(row, ['LIBRE']));

  const libreExact = hdr.filter((i) => i.norm.includes('LIBRE ELECCION')).sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const libreRow =
    headerRows.find((row) => rowIncludesAll(row, ['LIBRE', 'ELECCION'])) ||
    headerRows.find((row) => rowIncludesAny(row, ['LIBRE']) && rowIncludesAny(row, ['ELECCION'])) ||
    headerRows.find((row) => rowIncludesAny(row, ['LIBRE']));

  const xOferta = ofertaExact?.x0 ?? (ofertaRow ? findRowAnchorX(ofertaRow, ['OFERTA', 'PRESTADOR', 'PREFERENTE']) : null);
  const xLibre = libreExact?.x0 ?? (libreRow ? findRowAnchorX(libreRow, ['LIBRE', 'ELECCION']) : null);

  if (xOferta == null || xLibre == null) return null;
  if (!(xOferta < xLibre)) return null;

  const pickSub = (fromX: number, toX: number) => {
    const subset = hdr.filter((i) => i.x >= fromX && i.x < toX);
    const pct = subset.filter((i) => i.norm === '%').sort((a, b) => a.x - b.x)[0]?.x ?? (fromX + 35);
    const tope = subset.filter((i) => i.norm === 'TOPE').sort((a, b) => a.x - b.x)[0]?.x ?? (fromX + 85);
    const annual = subset
      .filter((i) => i.norm.includes('TOPE MAX') || i.norm.includes('ANO') || i.norm.includes('BENEFICIARIO'))
      .sort((a, b) => a.x - b.x)[0]?.x ?? (fromX + 120);
    const pctLeft = Math.max(fromX - 25, pct - 20);
    const pctRight = (pct + tope) / 2;
    const eventLeft = pctRight;
    const annualLeft = (tope + annual) / 2;
    const eventRight = Math.max(eventLeft + 6, annualLeft);
    return { pctLeft, pctRight, eventLeft, eventRight, annualLeft };
  };

  return {
    xPrestacionesRight: Math.max((prestX ?? xOferta - 90) + 40, xOferta - 35),
    xOferta,
    xLibre,
    op: pickSub(xOferta - 25, xLibre),
    le: pickSub(xLibre - 25, xLibre + 200)
  };
}

function detectSingleModeHeaderSchema(items: GridItem[], sectionY: number): SingleModeHeaderSchema | null {
  const hdr = items.filter((i) => i.y > sectionY && i.y < sectionY + 260);
  const headerRows = buildRows(hdr, computeDynamicYTol(hdr));
  const prestRow = headerRows.find((row) => row.norm.includes('PRESTACIONES'));
  if (!prestRow) return null;

  const prestX = findRowAnchorX(prestRow, ['PRESTACIONES']) ?? 0;
  const bonifAnchor = hdr
    .filter((item) => (item.norm === '%' || item.norm.includes('BONIFICACION')) && item.x > prestX + 120 && item.x < 340)
    .sort((a, b) => a.x - b.x)[0]?.x0;
  const eventAnchor = hdr
    .filter(
      (item) =>
        (item.norm.includes('TOPE DE') ||
          item.norm.includes('VALOR REAL') ||
          item.norm.includes('VECES ARANCEL') ||
          item.norm.includes('DE LA PRESTACION')) &&
        item.x > (bonifAnchor ?? prestX) + 20 &&
        item.x < 390
    )
    .sort((a, b) => a.x - b.x)[0]?.x0;
  const annualAnchor = hdr
    .filter(
      (item) =>
        (item.norm.includes('TOPE MAX') ||
          item.norm.includes('ANO CONTRATO') ||
          item.norm.includes('BENEFICIARIO') ||
          item.norm === '(2)') &&
        item.x > (eventAnchor ?? 0) + 20 &&
        item.x < 520
    )
    .sort((a, b) => a.x - b.x)[0]?.x0;
  const extensionAnchor = hdr
    .filter(
      (item) =>
        (item.norm.includes('AMPLIACION') ||
          item.norm.includes('COBERTURA') ||
          item.norm.includes('INTERNACIONAL') ||
          item.norm === '(3)' ||
          item.norm === '(4)') &&
        item.x > (annualAnchor ?? 0) + 20
    )
    .sort((a, b) => a.x - b.x)[0]?.x0;

  if (bonifAnchor == null || eventAnchor == null || annualAnchor == null) return null;

  const bonifRight = Math.max(bonifAnchor + 24, (bonifAnchor + eventAnchor) / 2);
  const eventRight = Math.max(eventAnchor + 30, (eventAnchor + annualAnchor) / 2);
  const annualRight = Math.max(annualAnchor + 36, (annualAnchor + (extensionAnchor ?? annualAnchor + 110)) / 2);

  return {
    xPrestacionesRight: Math.max(prestX + 70, bonifAnchor - 25),
    bonif: {
      left: Math.max(0, bonifAnchor - 18),
      right: bonifRight,
      anchor: bonifAnchor
    },
    event: {
      left: bonifRight,
      right: eventRight,
      anchor: eventAnchor
    },
    annual: {
      left: eventRight,
      right: annualRight,
      anchor: annualAnchor
    },
    extension: extensionAnchor == null
      ? null
      : {
          left: annualRight,
          anchor: extensionAnchor
        }
  };
}

function cleanPrestacionLabel(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Cut accidental merge with provider list from central blocks.
  const cutTokens = ['VIDAINTEGRA', 'INTEGRAMEDICA', 'HOSPITAL UC', 'CENTROS RED UC'];
  const up = upper(s);
  let cut = -1;
  for (const t of cutTokens) {
    const idx = up.indexOf(t);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  if (cut > 0) s = s.slice(0, cut).trim();
  return s;
}

function detectLEHeaderBands(items: GridItem[], sectionY: number, xLibre: number) {
  const headerItems = items.filter((i) => i.y > sectionY && i.y < sectionY + 90);
  const pctCandidates = headerItems
    .filter((i) => i.norm === '%' && i.x >= xLibre - 70 && i.x <= xLibre + 40)
    .sort((a, b) => a.x - b.x);
  const topeCandidates = headerItems
    .filter((i) => i.norm === 'TOPE' && i.x > xLibre - 10)
    .sort((a, b) => a.x - b.x);
  const annualCandidates = headerItems
    .filter((i) => i.x > xLibre && (i.norm.includes('TOPE MAX') || i.norm.includes('ANO') || i.norm.includes('BENEFICIARIO')))
    .sort((a, b) => a.x - b.x);

  const pctX = pctCandidates[0]?.x ?? (xLibre - 18);
  const eventX = topeCandidates[0]?.x ?? (xLibre + 14);
  const annualX = annualCandidates[0]?.x ?? (xLibre + 46);

  const pctLeft = Math.max(0, pctX - 18);
  const pctRight = (pctX + eventX) / 2;
  const eventLeft = pctRight;
  const annualLeft = (eventX + annualX) / 2;
  const eventRight = Math.max(eventLeft + 6, annualLeft);

  return { pctLeft, pctRight, eventLeft, eventRight, annualLeft };
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

function getHospitalSectionBottom(rows: GridRow[], sectionY: number): number {
  const sectionEndCandidates = rows
    .filter(
      (r) =>
        r.y < sectionY &&
        (r.norm.includes('AMBULATORIAS') ||
          r.norm.includes('PRESTACIONES RESTRINGIDAS') ||
          r.norm.includes('OTRAS PRESTACIONES'))
    )
    .map((r) => r.y);
  return sectionEndCandidates.length ? Math.max(...sectionEndCandidates) : -Infinity;
}

function getHospitalPrestRows(rows: GridRow[], xPrestacionesRight: number, sectionY: number, sectionBottom: number) {
  return rows
    .filter((r) => r.y < sectionY && r.y > sectionBottom)
    .map((r) => {
      const leftItems = r.items.filter((i) => i.x < xPrestacionesRight);
      const leftRaw = cleanPrestacionLabel(leftItems.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
      const leftNorm = upper(leftRaw);
      return { y: r.y, leftRaw, leftNorm };
    })
    .filter((r) => r.leftRaw.length > 0)
    .filter(
      (r) =>
        !r.leftNorm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA') &&
        !r.leftNorm.includes('AMBULATORIAS') &&
        !r.leftNorm.includes('PRESTACIONES RESTRINGIDAS') &&
        !r.leftNorm.includes('OTRAS PRESTACIONES')
    )
    .filter((r) => !r.leftNorm.startsWith('CLINICA ') && !r.leftNorm.startsWith('HABITACION '))
    .filter((r) => r.leftNorm !== 'SIN TOPE')
    .filter((r) => !r.leftNorm.includes('SOLO CON MEDICOS STAFF') && !r.leftNorm.includes('SOLO CON BONOS'));
}

function diagnoseHospitalGrid(rawItems: any[], page: number): HospitalGridDiagnostic {
  const items = toGridItems(rawItems);
  const yTol = computeDynamicYTol(items);
  const rows = buildRows(items, yTol);
  const sectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));

  if (!sectionRow) {
    return {
      page,
      sectionTitleFound: false,
      headerSchemaDetected: false,
      prestacionRowsDetected: 0,
      failureReason: 'SECTION_TITLE_NOT_FOUND'
    };
  }

  const schema = detectHeaderSchema(items, sectionRow.y);
  const singleSchema = schema ? null : detectSingleModeHeaderSchema(items, sectionRow.y);

  if (!schema && !singleSchema) {
    return {
      page,
      sectionTitleFound: true,
      headerSchemaDetected: false,
      prestacionRowsDetected: 0,
      failureReason: 'HEADER_SCHEMA_NOT_FOUND'
    };
  }

  const xPrestacionesRight = schema?.xPrestacionesRight ?? singleSchema!.xPrestacionesRight;
  const sectionBottom = getHospitalSectionBottom(rows, sectionRow.y);
  const prestRows = getHospitalPrestRows(rows, xPrestacionesRight, sectionRow.y, sectionBottom);
  const prestacionRowsDetected = prestRows.length;

  return {
    page,
    sectionTitleFound: true,
    headerSchemaDetected: true,
    prestacionRowsDetected,
    failureReason: prestacionRowsDetected > 0 ? 'UNKNOWN' : 'PRESTACION_ROWS_NOT_FOUND'
  };
}

function tryExtractM12HospitalSingleMode(rawItems: any[]) {
  const items = toGridItems(rawItems);
  const yTol = computeDynamicYTol(items);
  const rows = buildRows(items, yTol);
  const warnings: string[] = [];

  const sectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));
  if (!sectionRow) return null;

  const schema = detectSingleModeHeaderSchema(items, sectionRow.y);
  if (!schema) return null;

  const sectionBottom = getHospitalSectionBottom(rows, sectionRow.y);
  const prestRows = getHospitalPrestRows(rows, schema.xPrestacionesRight, sectionRow.y, sectionBottom);
  if (prestRows.length === 0) return null;

  const prestSorted = [...prestRows].sort((a, b) => b.y - a.y);
  const rowBand = (rowY: number) => {
    const idx = prestSorted.findIndex((row) => row.y === rowY);
    const prev = idx > 0 ? prestSorted[idx - 1] : null;
    const next = idx >= 0 && idx < prestSorted.length - 1 ? prestSorted[idx + 1] : null;
    const top = prev ? (prev.y + rowY) / 2 : rowY + 6;
    const bottom = next ? (rowY + next.y) / 2 : rowY - 6;
    return { top, bottom };
  };

  const buildColumnRows = (left: number, right: number) =>
    buildRows(items.filter((i) => i.x >= left && i.x < right && i.y < sectionRow.y && i.y > sectionBottom), yTol).map((row) => ({
      y: row.y,
      norm: row.norm
    }));

  const bonifRows = buildColumnRows(schema.bonif.left, schema.bonif.right);
  const eventRows = buildColumnRows(schema.event.left, schema.event.right);
  const annualRows = buildColumnRows(schema.annual.left, schema.annual.right);

  const rowBonif = (rowY: number) => {
    const strict = bonifRows.find((row) => Math.abs(row.y - rowY) <= 4);
    if (strict) {
      const pct = parsePctFromNorm(strict.norm);
      if (pct != null) return pct;
    }
    const nearest = bonifRows
      .map((row) => ({ row, distance: Math.abs(row.y - rowY) }))
      .filter((entry) => entry.distance <= 28)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearest) return 'UNKNOWN' as const;
    const pct = parsePctFromNorm(nearest.row.norm);
    return pct == null ? ('UNKNOWN' as const) : pct;
  };

  const eventCandidates = eventRows
    .map((row) => ({
      y: row.y,
      parsed: parseTopeFromNorm(row.norm),
      sinTope: /\bSIN TOPE\b/.test(row.norm)
    }))
    .filter((row) => row.parsed || row.sinTope)
    .sort((a, b) => b.y - a.y);

  const annualCandidates = annualRows
    .map((row) => ({
      y: row.y,
      parsed: parseTopeFromNorm(row.norm),
      sinTope: /\bSIN TOPE\b/.test(row.norm)
    }))
    .filter((row) => row.parsed || row.sinTope)
    .sort((a, b) => b.y - a.y);

  const resolveCandidate = (
    candidates: Array<{ y: number; parsed: { valor: number; unidad: 'UF' | 'VA' } | null; sinTope: boolean }>,
    rowY: number
  ) => {
    const strict = candidates.find((candidate) => Math.abs(candidate.y - rowY) <= 4);
    if (strict) return { candidate: strict, source: 'direct' as const, confidence: 1 };

    for (let i = 0; i < candidates.length; i++) {
      const current = candidates[i];
      const previous = i > 0 ? candidates[i - 1] : null;
      const next = i < candidates.length - 1 ? candidates[i + 1] : null;
      const topBound = previous ? (previous.y + current.y) / 2 : Number.POSITIVE_INFINITY;
      const bottomBound = next ? (current.y + next.y) / 2 : Number.NEGATIVE_INFINITY;
      if (rowY <= topBound && rowY >= bottomBound) {
        return { candidate: current, source: 'merged_segment' as const, confidence: 0.85 };
      }
    }

    return null;
  };

  const rowTopeEvento = (rowY: number) => {
    const resolved = resolveCandidate(eventCandidates, rowY);
    const band = rowBand(rowY);
    if (!resolved) {
      return {
        valor: 'UNKNOWN' as const,
        unidad: 'UNKNOWN' as const,
        source: 'unknown' as const,
        confidence: 0,
        evidence: { column_id: 'LE_TOPE_EVENTO_SINGLE', bbox: [schema.event.left, band.bottom, schema.event.right, band.top], anchor_y: null }
      };
    }
    if (resolved.candidate.sinTope) {
      return {
        valor: 'SIN_TOPE_ITEM' as const,
        unidad: 'NONE' as const,
        source: resolved.source,
        confidence: resolved.confidence,
        evidence: { column_id: 'LE_TOPE_EVENTO_SINGLE', bbox: [schema.event.left, band.bottom, schema.event.right, band.top], anchor_y: resolved.candidate.y }
      };
    }
    return {
      valor: resolved.candidate.parsed!.valor,
      unidad: resolved.candidate.parsed!.unidad,
      source: resolved.source,
      confidence: resolved.confidence,
      evidence: { column_id: 'LE_TOPE_EVENTO_SINGLE', bbox: [schema.event.left, band.bottom, schema.event.right, band.top], anchor_y: resolved.candidate.y }
    };
  };

  const rowTopeAnual = (rowY: number) => {
    const resolved = resolveCandidate(annualCandidates, rowY);
    const band = rowBand(rowY);
    if (!resolved) {
      return {
        estado: 'UNKNOWN',
        source: 'unknown',
        confidence: 0,
        evidence: { column_id: 'LE_TOPE_ANUAL_SINGLE', bbox: [schema.annual.left, band.bottom, schema.annual.right, band.top], anchor_y: null }
      };
    }
    if (resolved.candidate.sinTope) {
      return {
        estado: 'SIN_TOPE_ITEM',
        source: resolved.source,
        confidence: resolved.confidence,
        evidence: { column_id: 'LE_TOPE_ANUAL_SINGLE', bbox: [schema.annual.left, band.bottom, schema.annual.right, band.top], anchor_y: resolved.candidate.y }
      };
    }
    return {
      estado: 'CON_TOPE',
      valor: resolved.candidate.parsed!.valor,
      unidad: resolved.candidate.parsed!.unidad,
      source: resolved.source,
      confidence: resolved.confidence,
      evidence: { column_id: 'LE_TOPE_ANUAL_SINGLE', bbox: [schema.annual.left, band.bottom, schema.annual.right, band.top], anchor_y: resolved.candidate.y }
    };
  };

  const oferta_preferente: Record<string, any[]> = {};
  const libre_eleccion: Record<string, any> = {};
  for (const prestacion of prestRows) {
    const key = prestacion.leftRaw;
    oferta_preferente[key] = [];
    const bonif = rowBonif(prestacion.y);
    const topeEvento = rowTopeEvento(prestacion.y);
    const topeAnual = rowTopeAnual(prestacion.y);
    libre_eleccion[key] = {
      bonificacion_pct: bonif,
      tope_evento: topeEvento,
      tope_anual: topeAnual
    };
  }

  warnings.push('Hospitalarias extraida en esquema de modalidad unica / libre eleccion.');

  return {
    section: 'HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA',
    oferta_preferente,
    libre_eleccion,
    warnings: Array.from(new Set(warnings))
  };
}

function summarizeHospitalDiagnostics(diagnostics: HospitalGridDiagnostic[]) {
  const failureReasons = diagnostics.reduce<Record<string, number>>((acc, diagnostic) => {
    acc[diagnostic.failureReason] = (acc[diagnostic.failureReason] || 0) + 1;
    return acc;
  }, {});

  return {
    checkedPages: diagnostics.length,
    pagesWithSectionTitle: diagnostics.filter((d) => d.sectionTitleFound).map((d) => d.page),
    pagesWithHeaderSchema: diagnostics.filter((d) => d.headerSchemaDetected).map((d) => d.page),
    pagesWithPrestacionRows: diagnostics.filter((d) => d.prestacionRowsDetected > 0).map((d) => d.page),
    failureReasons
  };
}

function buildHospitalFailureWarnings(mode: 'single' | 'full', diagnostics: HospitalGridDiagnostic[]) {
  const warnings = [
    mode === 'single'
      ? 'No fue posible extraer la grilla hospitalaria con evidencia geometrica en la pagina solicitada.'
      : 'No fue posible extraer la grilla hospitalaria con evidencia geometrica en ninguna pagina.'
  ];

  const hasSectionTitle = diagnostics.some((d) => d.sectionTitleFound);
  const hasHeaderSchema = diagnostics.some((d) => d.headerSchemaDetected);
  const hasPrestacionRows = diagnostics.some((d) => d.prestacionRowsDetected > 0);

  if (!hasSectionTitle) {
    warnings.push('Choque M12: no se detecto el titulo HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA.');
  } else if (!hasHeaderSchema) {
    warnings.push('Choque M12: se detecto la seccion hospitalaria, pero no el header PRESTACIONES / OFERTA PREFERENTE / LIBRE ELECCION.');
  } else if (!hasPrestacionRows) {
    warnings.push('Choque M12: se detectaron seccion y header, pero no filas hospitalarias interpretables en la banda de prestaciones.');
  }

  return warnings;
}

function buildEmptyM12Response(mode: 'single' | 'full', totalPages: number, diagnostics: HospitalGridDiagnostic[], page?: number) {
  return {
    oferta_preferente: { 'Dia Cama': [], 'Sala Cuna': [] },
    libre_eleccion: {
      'Dia Cama': { bonificacion_pct: 'UNKNOWN', tope_evento: { valor: 'UNKNOWN', unidad: 'UNKNOWN' }, tope_anual: 'UNKNOWN' },
      'Sala Cuna': { bonificacion_pct: 'UNKNOWN', tope_evento: { valor: 'UNKNOWN', unidad: 'UNKNOWN' }, tope_anual: 'UNKNOWN' }
    },
    warnings: buildHospitalFailureWarnings(mode, diagnostics),
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'M12_VISUAL_STRUCTURAL_AUDITOR',
      strategy: 'DETERMINISTIC_VISUAL_STRUCTURAL',
      mode,
      page,
      totalPages,
      fallbackUsed: true,
      useful: false,
      diagnostics: summarizeHospitalDiagnostics(diagnostics)
    }
  };
}

function toGridItems(items: any[]): GridItem[] {
  const out: GridItem[] = [];
  for (const it of items || []) {
    if (it?.transform && it.transform.length >= 6) {
      const str = String(it.str || '').trim();
      if (!str) continue;
      const x = Number(it.transform[4] || 0);
      const y = Number(it.transform[5] || 0);
      const w = Math.max(1, Number(it.width || 8));
      const h = Math.max(1, Number(it.height || 8));
      out.push({
        str,
        norm: upper(str),
        x,
        y,
        x0: x,
        x1: x + w,
        y0: y - h / 2,
        y1: y + h / 2
      });
      continue;
    }

    const rawText = typeof it?.text === 'string' ? it.text : typeof it?.str === 'string' ? it.str : '';
    const str = String(rawText || '').trim();
    if (!str) continue;
    const x0 = Number.isFinite(Number(it?.x0)) ? Number(it.x0) : Number(it?.x || 0);
    const x1 = Number.isFinite(Number(it?.x1)) ? Number(it.x1) : x0 + Math.max(1, Number(it?.width || 8));
    const y0 = Number.isFinite(Number(it?.y0)) ? Number(it.y0) : Number(it?.y || 0) - Math.max(1, Number(it?.height || 8)) / 2;
    const y1 = Number.isFinite(Number(it?.y1)) ? Number(it.y1) : Number(it?.y || 0) + Math.max(1, Number(it?.height || 8)) / 2;
    const x = Number.isFinite(Number(it?.x)) ? Number(it.x) : x0;
    const y = Number.isFinite(Number(it?.y)) ? Number(it.y) : (y0 + y1) / 2;
    out.push({
      str,
      norm: upper(str),
      x,
      y,
      x0,
      x1,
      y0,
      y1
    });
  }
  return out;
}

function collectM12SourcePages(rawEnvelope: any): { pages: M12SourcePage[]; totalPages: number; processedPages: number } {
  const rawPayload = rawEnvelope?.raw?.pages ? rawEnvelope.raw : rawEnvelope;
  const rawPages = Array.isArray(rawPayload?.pages) ? rawPayload.pages : [];
  const pages: M12SourcePage[] = rawPages
    .map((page: any) => ({
      pageNumber: Number(page?.pageNumber || 0),
      items: Array.isArray(page?.items) ? page.items : [],
      text: String(page?.text || ''),
      ocrSource: String(page?.ocrSource || 'unknown')
    }))
    .filter((page) => Number.isFinite(page.pageNumber) && page.pageNumber > 0);

  return {
    pages,
    totalPages: Number(rawPayload?.totalPages || pages.length || 0),
    processedPages: Number(rawPayload?.processedPages || pages.length || 0)
  };
}

function buildRawSourceDetails(pages: M12SourcePage[], processedPages: number, attemptedPage: number | null = null) {
  const azurePages = pages.filter((page) => page.ocrSource === 'azure-layout').map((page) => page.pageNumber);
  const nativePages = pages.filter((page) => page.ocrSource === 'native-textlayer').map((page) => page.pageNumber);
  const openAiPages = pages.filter((page) => page.ocrSource === 'openai-ocr').map((page) => page.pageNumber);

  return {
    extractor: 'raw-extract',
    attemptedPage,
    processedPages,
    azureLayoutUsed: azurePages.length > 0,
    azurePages,
    nativePages,
    openAiPages
  };
}

function buildM12SuccessPayload(
  extracted: any,
  mode: 'single' | 'full',
  page: number,
  totalPages: number,
  strategy: string,
  sourceDetails?: any
) {
  return {
    ...extracted,
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'M12_VISUAL_STRUCTURAL_AUDITOR',
      strategy,
      mode,
      page,
      totalPages,
      fallbackUsed: false,
      useful: true,
      ...(sourceDetails ? { sourceDetails } : {})
    }
  };
}

async function tryM12RawFirst(
  imageBase64: string,
  originalname: string,
  pageNum: number,
  singleMode: boolean
): Promise<any | null> {
  const traceId = `m12-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const rawEnvelope = await buildRawExtractAccountWithPage(
    imageBase64,
    0,
    singleMode ? pageNum : 0,
    traceId,
    { mode: 'fast', renderScale: 1.8 }
  );
  const { pages, totalPages, processedPages } = collectM12SourcePages(rawEnvelope);
  if (pages.length === 0) return null;

  const sourceDetails = buildRawSourceDetails(pages, processedPages, singleMode ? pageNum : null);

  if (singleMode) {
    const candidate = pages.find((page) => page.pageNumber === pageNum) || pages[0];
    if (!candidate) return null;
    const extracted = buildM12Page3Combined(candidate.items, originalname || 'document.pdf', candidate.pageNumber);
    if (!extracted?.page3_sections?.hospitalarias) return null;

    return buildM12SuccessPayload(extracted, 'single', candidate.pageNumber, totalPages, 'AZURE_LAYOUT_FIRST', {
      ...sourceDetails,
      pageOcrSource: candidate.ocrSource
    });
  }

  let best: any = null;
  for (const candidate of pages) {
    const extracted = buildM12Page3Combined(candidate.items, originalname || 'document.pdf', candidate.pageNumber);
    if (!extracted?.page3_sections?.hospitalarias) continue;
    const unknownCount = JSON.stringify(extracted.page3_sections.hospitalarias).match(/UNKNOWN/g)?.length || 0;
    if (!best || unknownCount < best.unknownCount) {
      best = {
        unknownCount,
        payload: extracted,
        page: candidate.pageNumber,
        ocrSource: candidate.ocrSource
      };
    }
  }

  if (!best) return null;

  return buildM12SuccessPayload(best.payload, 'full', best.page, totalPages, 'AZURE_LAYOUT_FIRST', {
    ...sourceDetails,
    selectedPageOcrSource: best.ocrSource
  });
}

async function extractM12WithPdfJsFallback(
  buffer: Buffer,
  originalname: string,
  pageNum: number,
  singleMode: boolean
): Promise<any> {
  const pdf = await openPdf(buffer);
  const totalPages = pdf.numPages;

  if (singleMode) {
    const { items, page: safePage } = await extractPageItemsFromPdf(buffer, pageNum);
    const extracted = buildM12Page3Combined(items, originalname || 'document.pdf', safePage);
    if (!extracted?.page3_sections?.hospitalarias) {
      return buildEmptyM12Response('single', totalPages, [diagnoseHospitalGrid(items, safePage)], safePage);
    }
    return buildM12SuccessPayload(extracted, 'single', safePage, totalPages, 'DETERMINISTIC_VISUAL_STRUCTURAL', {
      extractor: 'pdfjs',
      pageOcrSource: 'native-textlayer'
    });
  }

  let best: any = null;
  const diagnostics: HospitalGridDiagnostic[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pg = await pdf.getPage(p);
    const tc = await pg.getTextContent();
    diagnostics.push(diagnoseHospitalGrid(tc.items || [], p));
    const extracted = buildM12Page3Combined(tc.items || [], originalname || 'document.pdf', p);
    if (extracted?.page3_sections?.hospitalarias) {
      const unknownCount = JSON.stringify(extracted.page3_sections.hospitalarias).match(/UNKNOWN/g)?.length || 0;
      if (!best || unknownCount < best.unknownCount) {
        best = { unknownCount, payload: extracted, page: p };
      }
    }
  }

  if (!best) {
    return buildEmptyM12Response('full', totalPages, diagnostics);
  }

  return buildM12SuccessPayload(best.payload, 'full', best.page, totalPages, 'DETERMINISTIC_VISUAL_STRUCTURAL', {
    extractor: 'pdfjs',
    pageOcrSource: 'native-textlayer'
  });
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

export function tryExtractM12TwoItems(rawItems: any[]) {
  const items = toGridItems(rawItems);
  const rows = buildRows(items);
  const warnings: string[] = [];

  const sectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));
  if (!sectionRow) return null;

  const topItems = items.filter((i) => i.y > sectionRow.y);
  const schema = detectHeaderSchema(items, sectionRow.y);
  if (!schema) return null;
  const xOferta = schema.xOferta;
  const xLibre = schema.xLibre;
  const middleStart = Math.max(0, schema.xOferta - 40);

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
    const leftText = upper(r.items.filter((i) => i.x < middleStart).map((i) => i.str).join(' '));
    if (leftText === 'DIA CAMA') targets['DIA CAMA'] = r.y;
    if (leftText === 'SALA CUNA') targets['SALA CUNA'] = r.y;
  }
  if (!targets['DIA CAMA'] || !targets['SALA CUNA']) {
    warnings.push('No se encontraron filas exactas DIA CAMA / SALA CUNA en leftBand.');
    return {
      oferta_preferente: { 'Dia Cama': [], 'Sala Cuna': [] },
      libre_eleccion: {
        'Dia Cama': { bonificacion_pct: 'UNKNOWN', tope_evento: { valor: 'UNKNOWN', unidad: 'UNKNOWN' }, tope_anual: 'UNKNOWN' },
        'Sala Cuna': { bonificacion_pct: 'UNKNOWN', tope_evento: { valor: 'UNKNOWN', unidad: 'UNKNOWN' }, tope_anual: 'UNKNOWN' }
      },
      warnings
    };
  }

  const middleSectionItems = items.filter((i) => i.x >= middleStart && i.x < xLibre && i.y < sectionRow.y && i.y > sectionBottom);
  const middleSectionText = upper(middleSectionItems.map((i) => i.str).join(' '));
  const middleRows = buildRows(middleSectionItems);
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
      const source = `${b.norm} ${middleSectionText}`;
      if (pct === 100) {
        if (source.includes('CLINICA DAVILA')) clinics.push('Clinica Davila');
        if (source.includes('CLINICA VESPUCIO')) clinics.push('Clinica Vespucio');
      }
      if (pct === 90) {
        if (source.includes('CLINICA SANTA MARIA')) clinics.push('Clinica Santa Maria');
        if (source.includes('HOSPITAL UC')) clinics.push('Hospital UC');
        if (source.includes('CLINICA UC')) clinics.push('Clinica UC');
        if (source.includes('CLINICA INDISA')) clinics.push('Clinica Indisa');
      }
      const restricciones: string[] = [];
      if (pct === 90) {
        if (middleSectionText.includes('SOLO CON MEDICOS STAFF')) restricciones.push('Solo con Medicos Staff');
        if (middleSectionText.includes('SOLO CON BONOS')) restricciones.push('Solo con bonos');
      }
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
  else {
    // Fallback: merged LE % can sit slightly left of LIBRE anchor in some PDFs.
    const nearBoundaryText = upper(
      items
        .filter((i) => i.x >= ((xLibre as number) - 40) && i.x < ((xLibre as number) + 120) && i.y < sectionRow.y && i.y > sectionBottom)
        .map((i) => i.str)
        .join(' ')
    );
    const nearMatches = Array.from(nearBoundaryText.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));
    if (nearMatches.includes(90)) mergedBonif = 90;
    else if (nearMatches.length > 0) mergedBonif = nearMatches[0];
    else warnings.push('Libre eleccion bonificacion % no demostrable geometricamente.');
  }

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
    const unidad = normalizeUnitToken(m[2]);
    if (Number.isNaN(valor)) return { valor: 'UNKNOWN' as const, unidad: 'UNKNOWN' as const };
    if (unidad === 'UNKNOWN') return { valor: 'UNKNOWN' as const, unidad: 'UNKNOWN' as const };
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

export function tryExtractM12HospitalFull(rawItems: any[]) {
  const items = toGridItems(rawItems);
  const yTol = computeDynamicYTol(items);
  const rows = buildRows(items, yTol);
  const warnings: string[] = [];

  const sectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));
  if (!sectionRow) return null;

  const topItems = items.filter((i) => i.y > sectionRow.y);
  const schema = detectHeaderSchema(items, sectionRow.y);
  if (!schema) return tryExtractM12HospitalSingleMode(rawItems);
  const xOferta = schema.xOferta;
  const xLibre = schema.xLibre;
  const middleStart = Math.max(0, schema.xOferta - 40);

  const sectionBottom = getHospitalSectionBottom(rows, sectionRow.y);
  const prestRows = getHospitalPrestRows(rows, schema.xPrestacionesRight, sectionRow.y, sectionBottom);

  if (prestRows.length === 0) return null;

  const middleSectionItems = items.filter((i) => i.x >= middleStart && i.x < xLibre && i.y < sectionRow.y && i.y > sectionBottom);
  const middleSectionText = upper(middleSectionItems.map((i) => i.str).join(' '));
  const middleRows = buildRows(middleSectionItems, yTol);
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
      const source = `${b.norm} ${middleSectionText}`;
      if (pct === 100) {
        if (source.includes('CLINICA DAVILA')) clinics.push('Clinica Davila');
        if (source.includes('CLINICA VESPUCIO')) clinics.push('Clinica Vespucio');
      }
      if (pct === 90) {
        if (source.includes('CLINICA SANTA MARIA')) clinics.push('Clinica Santa Maria');
        if (source.includes('HOSPITAL UC')) clinics.push('Hospital UC');
        if (source.includes('CLINICA UC')) clinics.push('Clinica UC');
        if (source.includes('CLINICA INDISA')) clinics.push('Clinica Indisa');
      }
      const restricciones: string[] = [];
      if (pct === 90) {
        if (middleSectionText.includes('SOLO CON MEDICOS STAFF')) restricciones.push('Solo con Medicos Staff');
        if (middleSectionText.includes('SOLO CON BONOS')) restricciones.push('Solo con bonos');
      }
      return {
        bonificacion_pct: pct,
        tope_evento: 'SIN_TOPE_ITEM',
        clinicas: clinics,
        restricciones
      };
    })
    .filter((b) => Number.isFinite(b.bonificacion_pct))
    .sort((a, b) => b.bonificacion_pct - a.bonificacion_pct);

  const sharedPreferente = Array.from(
    new Map(prefBlocks.map((b) => [JSON.stringify([b.bonificacion_pct, b.clinicas, b.restricciones]), b])).values()
  );
  if (sharedPreferente.length === 0) {
    warnings.push('Oferta preferente no demostrable geometricamente para bloques 100%/90%.');
  }

  const leBands = schema.le;
  const rightItems = items.filter((i) => i.x >= leBands.pctLeft && i.y < sectionRow.y && i.y > sectionBottom);
  const rightText = upper(rightItems.map((i) => i.str).join(' '));
  const sectionSpan = Math.max(1, sectionRow.y - sectionBottom);

  const annualStart = leBands.annualLeft;

  const rightEventRows = buildRows(rightItems.filter((i) => i.x >= leBands.eventLeft && i.x < leBands.eventRight && i.y < sectionRow.y && i.y > sectionBottom), yTol)
    .map((r) => ({ y: r.y, norm: r.norm }));
  const annualRows = buildRows(items.filter((i) => i.x >= annualStart && i.y < sectionRow.y && i.y > sectionBottom), yTol)
    .map((r) => ({ y: r.y, norm: r.norm }));

  let mergedBonif: number | 'UNKNOWN' = 'UNKNOWN';
  const bonifRows = buildRows(
    items.filter((i) => i.x >= leBands.pctLeft && i.x < leBands.pctRight && i.y < sectionRow.y && i.y > sectionBottom),
    yTol
  ).map((r) => ({ y: r.y, norm: r.norm })).filter((r) => /(\d{1,3})\s*%/.test(r.norm));
  const bonifMatches = Array.from(rightText.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));
  if (bonifRows.length > 0) {
    const top = Math.max(...bonifRows.map((r) => r.y));
    const bottom = Math.min(...bonifRows.map((r) => r.y));
    const coverageRatio = Math.max(0, top - bottom) / sectionSpan;
    if (bonifRows.length === 1) {
      const m = bonifRows[0].norm.match(/(\d{1,3})\s*%/);
      if (m) mergedBonif = Number(m[1]);
    } else if (coverageRatio >= 0.45) {
      if (bonifMatches.includes(90)) mergedBonif = 90;
      else if (bonifMatches.length > 0) mergedBonif = bonifMatches[0];
    } else {
      warnings.push(`Bonificacion LE detectada con cobertura vertical baja (${coverageRatio.toFixed(2)}).`);
    }
  } else if (bonifMatches.length > 0) {
    mergedBonif = bonifMatches[0];
  }
  if (mergedBonif === 'UNKNOWN') {
    const nearBoundaryText = upper(
      items
        .filter((i) => i.x >= leBands.pctLeft && i.x < leBands.eventRight && i.y < sectionRow.y && i.y > sectionBottom)
        .map((i) => i.str)
        .join(' ')
    );
    const nearMatches = Array.from(nearBoundaryText.matchAll(/(\d{1,3})\s*%/g)).map((m) => Number(m[1]));
    if (nearMatches.includes(90)) mergedBonif = 90;
    else if (nearMatches.length > 0) mergedBonif = nearMatches[0];
    else warnings.push('Libre eleccion bonificacion % no demostrable geometricamente.');
  }

  const parseTopeFromNorm = (normText: string) => {
    const m = normText.match(/(\d+(?:[.,]\d+)?)\s*(UF|V\.?A\.?|VA|VAM)\b/i);
    if (!m) return null;
    const valor = Number(m[1].replace(',', '.'));
    if (Number.isNaN(valor)) return null;
    const unidad = normalizeUnitToken(m[2]);
    if (unidad === 'UNKNOWN') return null;
    return { valor, unidad };
  };

  const eventCandidates = rightEventRows
    .map((r) => ({ y: r.y, parsed: parseTopeFromNorm(r.norm), norm: r.norm }))
    .filter((r) => !!r.parsed)
    .map((r) => ({ y: r.y, valor: r.parsed!.valor, unidad: r.parsed!.unidad, norm: r.norm }))
    .sort((a, b) => b.y - a.y);

  const yExamenes = prestRows.find((r) => r.leftNorm.includes('EXAMENES DE LABORATORIO'))?.y;
  const yProcedimientos = prestRows.find((r) => r.leftNorm === 'PROCEDIMIENTOS')?.y;
  const vaAnchor = eventCandidates.find((c) => c.unidad === 'VA');
  const prestSorted = [...prestRows].sort((a, b) => b.y - a.y);
  const rowBand = (rowY: number) => {
    const idx = prestSorted.findIndex((r) => r.y === rowY);
    const prev = idx > 0 ? prestSorted[idx - 1] : null;
    const next = idx >= 0 && idx < prestSorted.length - 1 ? prestSorted[idx + 1] : null;
    const top = prev ? (prev.y + rowY) / 2 : rowY + 6;
    const bottom = next ? (rowY + next.y) / 2 : rowY - 6;
    return { top, bottom };
  };

  const rowTopeEvento = (rowY: number) => {
    const strict = eventCandidates.find((r) => Math.abs(r.y - rowY) <= 4);
    if (strict) {
      const band = rowBand(rowY);
      return {
        valor: strict.valor,
        unidad: strict.unidad,
        source: 'direct' as const,
        confidence: 1.0,
        evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: strict.y }
      };
    }

    // Explicit merged VA block seen in many hospital grids: Examenes -> Procedimientos.
    if (vaAnchor && Number.isFinite(yExamenes as number) && Number.isFinite(yProcedimientos as number)) {
      const top = Math.max(yExamenes as number, yProcedimientos as number);
      const bottom = Math.min(yExamenes as number, yProcedimientos as number);
      if (rowY <= top && rowY >= bottom) {
        const band = rowBand(rowY);
        return {
          valor: vaAnchor.valor,
          unidad: vaAnchor.unidad,
          source: 'merged_segment' as const,
          confidence: 0.9,
          evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: vaAnchor.y }
        };
      }
    }

    // Merged-cell vertical segment assignment:
    // each value owns the vertical band delimited by midpoints to adjacent values.
    for (let i = 0; i < eventCandidates.length; i++) {
      const cur = eventCandidates[i];
      const prev = i > 0 ? eventCandidates[i - 1] : null;   // higher y
      const next = i < eventCandidates.length - 1 ? eventCandidates[i + 1] : null; // lower y
      let topBound = prev ? (prev.y + cur.y) / 2 : Number.POSITIVE_INFINITY;
      const bottomBound = next ? (cur.y + next.y) / 2 : Number.NEGATIVE_INFINITY;
      if (cur.unidad === 'VA' && Number.isFinite(topBound)) topBound += 20;
      if (rowY <= topBound && rowY >= bottomBound) {
        const band = rowBand(rowY);
        return {
          valor: cur.valor,
          unidad: cur.unidad,
          source: 'merged_segment' as const,
          confidence: 0.85,
          evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: cur.y }
        };
      }
    }

    const band = rowBand(rowY);
    return {
      valor: 'UNKNOWN' as const,
      unidad: 'UNKNOWN' as const,
      source: 'unknown' as const,
      confidence: 0,
      evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: null }
    };
  };

  const annualColumnItems = items.filter((i) => i.x >= annualStart && i.y < sectionRow.y && i.y > sectionBottom);
  const annualColumnText = upper(annualColumnItems.map((i) => i.str).join(' '));
  const rowTopeAnual = (rowY: number) => {
    const band = rowBand(rowY);
    const strict = annualRows.find((r) => Math.abs(r.y - rowY) <= 4);
    if (strict) {
      if (/\bSIN TOPE\b/i.test(strict.norm)) {
        return {
          estado: 'SIN_TOPE_ITEM',
          source: 'direct',
          confidence: 1,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: strict.y }
        };
      }
      const p = parseTopeFromNorm(strict.norm);
      if (p) {
        return {
          estado: 'CON_TOPE',
          valor: p.valor,
          unidad: p.unidad,
          source: 'direct',
          confidence: 1,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: strict.y }
        };
      }
    }
    const nearest = annualRows
      .map((r) => ({ r, d: Math.abs(r.y - rowY) }))
      .filter((x) => x.d <= 40)
      .sort((a, b) => a.d - b.d)[0];
    if (nearest) {
      if (/\bSIN TOPE\b/i.test(nearest.r.norm)) {
        return {
          estado: 'SIN_TOPE_ITEM',
          source: 'merged_segment',
          confidence: 0.85,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: nearest.r.y }
        };
      }
      const p = parseTopeFromNorm(nearest.r.norm);
      if (p) {
        return {
          estado: 'CON_TOPE',
          valor: p.valor,
          unidad: p.unidad,
          source: 'merged_segment',
          confidence: 0.85,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: nearest.r.y }
        };
      }
    }
    if (/\bSIN TOPE\b/i.test(annualColumnText)) {
      return {
        estado: 'SIN_TOPE_ITEM',
        source: 'column_level',
        confidence: 0.7,
        evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, sectionBottom, annualStart + 40, sectionRow.y], anchor_y: null }
      };
    }
    return {
      estado: 'UNKNOWN',
      source: 'unknown',
      confidence: 0,
      evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: null }
    };
  };

  const oferta_preferente: Record<string, any[]> = {};
  const libre_eleccion: Record<string, any> = {};
  for (const p of prestRows) {
    const key = p.leftRaw;
    oferta_preferente[key] = sharedPreferente.length
      ? sharedPreferente
      : [{ bonificacion_pct: 'UNKNOWN', tope_evento: 'UNKNOWN', clinicas: [], restricciones: [] }];
    const te = rowTopeEvento(p.y);
    if (te.valor === 'UNKNOWN') warnings.push(`${key}: tope evento libre eleccion no demostrable geometricamente.`);
    const ta = rowTopeAnual(p.y);
    if (ta?.estado === 'CON_TOPE' && te.source === 'unknown') {
      warnings.push(`${key}: tope_anual con valor pero tope_evento sin evidencia.`);
    }
    libre_eleccion[key] = {
      bonificacion_pct: mergedBonif,
      tope_evento: {
        valor: te.valor,
        unidad: te.unidad,
        source: te.source,
        confidence: te.confidence,
        evidence: te.evidence
      },
      tope_anual: ta
    };
  }

  return {
    section: 'HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA',
    oferta_preferente,
    libre_eleccion,
    warnings: Array.from(new Set(warnings))
  };
}

export function tryExtractM12AmbulatoriasFull(rawItems: any[]) {
  const items = toGridItems(rawItems);
  const yTol = computeDynamicYTol(items);
  const rows = buildRows(items, yTol);
  const warnings: string[] = [];

  const sectionRow = rows.find((r) => r.norm === 'AMBULATORIAS' || r.norm.includes(' AMBULATORIAS'));
  if (!sectionRow) return null;

  const topItems = items.filter((i) => i.y > sectionRow.y);
  const schema = detectHeaderSchema(items, sectionRow.y);
  if (!schema) return null;
  const xOferta = schema.xOferta;
  const xLibre = schema.xLibre;
  const middleStart = Math.max(0, schema.xOferta - 40);

  const sectionEndCandidates = rows
    .filter((r) => r.y < sectionRow.y && (r.norm.includes('ATENCIONES DE URGENCIA') || r.norm.includes('PRESTACIONES RESTRINGIDAS')))
    .map((r) => r.y);
  const sectionBottom = sectionEndCandidates.length ? Math.max(...sectionEndCandidates) : -Infinity;

  const prestRows = rows
    .filter((r) => r.y < sectionRow.y && r.y > sectionBottom)
    .map((r) => {
      const leftItems = r.items.filter((i) => i.x < schema.xPrestacionesRight);
      const leftRaw = cleanPrestacionLabel(leftItems.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
      const leftNorm = upper(leftRaw);
      return { y: r.y, leftRaw, leftNorm };
    })
    .filter((r) => r.leftRaw.length > 0)
    .filter((r) => !r.leftNorm.includes('ATENCIONES DE URGENCIA') && !r.leftNorm.includes('PRESTACIONES RESTRINGIDAS'))
    .filter(
      (r) =>
        !/^CLINICA (SANTA MARIA|INDISA|DAVILA|VESPUCIO|UC)\b/.test(r.leftNorm) &&
        !r.leftNorm.startsWith('VIDAINTEGRA') &&
        !r.leftNorm.startsWith('HOSPITAL ')
    )
    .filter((r) => !r.leftNorm.includes('SOLO CON BONOS'))
    .filter((r) => r.leftNorm !== 'SIN TOPE');
  if (prestRows.length === 0) return null;

  const middleSectionItems = items.filter((i) => i.x >= middleStart && i.x < xLibre && i.y < sectionRow.y && i.y > sectionBottom);
  const middleSectionText = upper(middleSectionItems.map((i) => i.str).join(' '));
  const middleRows = buildRows(middleSectionItems, yTol);
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
    .filter((b) => (/\b80\s*%/.test(b.norm) || /\b70\s*%/.test(b.norm)) && /\bSIN TOPE\b/.test(b.norm))
    .map((b) => {
      const m = b.norm.match(/(\d{1,3})\s*%/);
      const pct = m ? Number(m[1]) : NaN;
      const source = `${b.norm} ${middleSectionText}`;
      const prestadores: string[] = [];
      if (pct === 80) {
        if (source.includes('VIDAINTEGRA')) prestadores.push('VidaIntegra');
        if (source.includes('INTEGRAMEDICA')) prestadores.push('Integramedica');
        if (source.includes('CLINICA DAVILA')) prestadores.push('Clinica Davila');
        if (source.includes('CLINICA VESPUCIO')) prestadores.push('Clinica Vespucio');
      }
      if (pct === 70) {
        if (source.includes('CLINICA SANTA MARIA')) prestadores.push('Clinica Santa Maria');
        if (source.includes('CLINICA INDISA')) prestadores.push('Clinica Indisa');
        if (source.includes('HOSPITAL UC')) prestadores.push('Hospital UC');
        if (source.includes('CENTROS RED UC')) prestadores.push('Centros Red UC');
      }
      const restricciones: string[] = [];
      if (source.includes('SOLO CON BONOS')) restricciones.push('Solo con bonos');
      return { bonificacion_pct: pct, tope_evento: 'SIN_TOPE_ITEM', prestadores, restricciones };
    })
    .filter((b) => Number.isFinite(b.bonificacion_pct))
    .sort((a, b) => b.bonificacion_pct - a.bonificacion_pct);
  const sharedPreferente = Array.from(
    new Map(prefBlocks.map((b) => [JSON.stringify([b.bonificacion_pct, b.prestadores, b.restricciones]), b])).values()
  );

  const leBands = schema.le;
  const rightItems = items.filter((i) => i.x >= leBands.pctLeft && i.y < sectionRow.y && i.y > sectionBottom);
  const rightText = upper(rightItems.map((i) => i.str).join(' '));
  const annualStart = leBands.annualLeft;

  const rightEventRows = buildRows(rightItems.filter((i) => i.x >= leBands.eventLeft && i.x < leBands.eventRight && i.y < sectionRow.y && i.y > sectionBottom), yTol)
    .map((r) => ({ y: r.y, norm: r.norm }));
  const annualRows = buildRows(items.filter((i) => i.x >= annualStart && i.y < sectionRow.y && i.y > sectionBottom), yTol)
    .map((r) => ({ y: r.y, norm: r.norm }));

  const parseTopeFromNorm = (normText: string) => {
    const m = normText.match(/(\d+(?:[.,]\d+)?)\s*(UF|V\.?A\.?|VA|VAM)\b/i);
    if (!m) return null;
    const valor = Number(m[1].replace(',', '.'));
    if (Number.isNaN(valor)) return null;
    const unidad = normalizeUnitToken(m[2]);
    if (unidad === 'UNKNOWN') return null;
    return { valor, unidad };
  };
  const eventCandidates = rightEventRows
    .map((r) => ({ y: r.y, parsed: parseTopeFromNorm(r.norm), norm: r.norm }))
    .filter((r) => !!r.parsed)
    .map((r) => ({ y: r.y, valor: r.parsed!.valor, unidad: r.parsed!.unidad, norm: r.norm }))
    .sort((a, b) => b.y - a.y);

  const bonifRows = buildRows(
    items.filter((i) => i.x >= leBands.pctLeft && i.x < leBands.pctRight && i.y < sectionRow.y && i.y > sectionBottom),
    yTol
  ).map((r) => ({ y: r.y, norm: r.norm }));
  const bonifCandidates = bonifRows
    .map((r) => ({ y: r.y, m: r.norm.match(/(\d{1,3})\s*%/) }))
    .filter((x) => !!x.m)
    .map((x) => ({ y: x.y, pct: Number(x.m![1]) }))
    .sort((a, b) => b.y - a.y);
  if (bonifCandidates.length === 0) {
    const nearBonifRows = buildRows(
      items.filter((i) => i.x >= leBands.pctLeft && i.x < leBands.pctRight && i.y < sectionRow.y && i.y > sectionBottom),
      yTol
    );
    for (const r of nearBonifRows) {
      const m = r.norm.match(/(\d{1,3})\s*%/);
      if (m) bonifCandidates.push({ y: r.y, pct: Number(m[1]) });
    }
    bonifCandidates.sort((a, b) => b.y - a.y);
  }
  const sectionSpan = Math.max(1, sectionRow.y - sectionBottom);
  const bonifCoverage = bonifCandidates.length > 0 ? (Math.max(...bonifCandidates.map((x) => x.y)) - Math.min(...bonifCandidates.map((x) => x.y))) / sectionSpan : 0;

  const prestSorted = [...prestRows].sort((a, b) => b.y - a.y);
  const rowBand = (rowY: number) => {
    const idx = prestSorted.findIndex((r) => r.y === rowY);
    const prev = idx > 0 ? prestSorted[idx - 1] : null;
    const next = idx >= 0 && idx < prestSorted.length - 1 ? prestSorted[idx + 1] : null;
    const top = prev ? (prev.y + rowY) / 2 : rowY + 6;
    const bottom = next ? (rowY + next.y) / 2 : rowY - 6;
    return { top, bottom };
  };
  const rowBonif = (rowY: number) => {
    const band = rowBand(rowY);
    const strict = bonifCandidates.find((b) => Math.abs(b.y - rowY) <= 4);
    if (strict) {
      return {
        valor: strict.pct,
        source: 'direct',
        confidence: 1,
        evidence: { column_id: 'LE_%', bbox: [leBands.pctLeft, band.bottom, leBands.pctRight, band.top], anchor_y: strict.y }
      };
    }
    if (bonifCoverage >= 0.45 && bonifCandidates.length > 0) {
      return {
        valor: bonifCandidates[0].pct,
        source: 'merged_segment',
        confidence: 0.85,
        evidence: { column_id: 'LE_%', bbox: [leBands.pctLeft, band.bottom, leBands.pctRight, band.top], anchor_y: bonifCandidates[0].y }
      };
    }
    const nearest = bonifCandidates
      .map((b) => ({ ...b, d: Math.abs(b.y - rowY) }))
      .filter((b) => b.d <= 35)
      .sort((a, b) => a.d - b.d)[0];
    if (nearest) {
      return {
        valor: nearest.pct,
        source: 'merged_segment',
        confidence: 0.8,
        evidence: { column_id: 'LE_%', bbox: [leBands.pctLeft, band.bottom, leBands.pctRight, band.top], anchor_y: nearest.y }
      };
    }
    return {
      valor: 'UNKNOWN',
      source: 'unknown',
      confidence: 0,
      evidence: { column_id: 'LE_%', bbox: [leBands.pctLeft, band.bottom, leBands.pctRight, band.top], anchor_y: null }
    };
  };
  const rowTopeEvento = (rowY: number) => {
    const strict = eventCandidates.find((r) => Math.abs(r.y - rowY) <= 4);
    if (strict) {
      const band = rowBand(rowY);
      return { valor: strict.valor, unidad: strict.unidad, source: 'direct', confidence: 1, evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: strict.y } };
    }

    const yConsulta = prestRows.find((r) => r.leftNorm === 'CONSULTA MEDICA')?.y;
    const yTelemed = prestRows.find((r) => r.leftNorm.includes('TELEMEDICINA'))?.y;
    const yExamenes = prestRows.find((r) => r.leftNorm.includes('EXAMENES DE LABORATORIO'))?.y;
    const yAtencionEnf = prestRows.find((r) => r.leftNorm.includes('ATENCION INTEGRAL DE ENFERMERIA'))?.y;
    const topUF04 = eventCandidates.find((c) => c.unidad === 'UF' && c.valor === 0.4);
    const vaAnchor = eventCandidates.find((c) => c.unidad === 'VA');
    if (topUF04 && Number.isFinite(yConsulta as number) && Number.isFinite(yTelemed as number)) {
      const top = Math.max(yConsulta as number, yTelemed as number);
      const bottom = Math.min(yConsulta as number, yTelemed as number);
      if (rowY <= top && rowY >= bottom) {
        const band = rowBand(rowY);
        return { valor: topUF04.valor, unidad: topUF04.unidad, source: 'merged_segment', confidence: 0.9, evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: topUF04.y } };
      }
    }
    if (vaAnchor && Number.isFinite(yExamenes as number) && Number.isFinite(yAtencionEnf as number)) {
      const top = Math.max(yExamenes as number, yAtencionEnf as number);
      const bottom = Math.min(yExamenes as number, yAtencionEnf as number);
      if (rowY <= top && rowY >= bottom) {
        const band = rowBand(rowY);
        return { valor: vaAnchor.valor, unidad: vaAnchor.unidad, source: 'merged_segment', confidence: 0.9, evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: vaAnchor.y } };
      }
    }

    for (let i = 0; i < eventCandidates.length; i++) {
      const cur = eventCandidates[i];
      const prev = i > 0 ? eventCandidates[i - 1] : null;
      const next = i < eventCandidates.length - 1 ? eventCandidates[i + 1] : null;
      let topBound = prev ? (prev.y + cur.y) / 2 : Number.POSITIVE_INFINITY;
      const bottomBound = next ? (cur.y + next.y) / 2 : Number.NEGATIVE_INFINITY;
      if (cur.unidad === 'VA' && Number.isFinite(topBound)) topBound += 16;
      if (rowY <= topBound && rowY >= bottomBound) {
        const band = rowBand(rowY);
        return { valor: cur.valor, unidad: cur.unidad, source: 'merged_segment', confidence: 0.85, evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: cur.y } };
      }
    }
    const band = rowBand(rowY);
    return { valor: 'UNKNOWN', unidad: 'UNKNOWN', source: 'unknown', confidence: 0, evidence: { column_id: 'LE_TOPE_EVENTO', bbox: [leBands.eventLeft, band.bottom, leBands.eventRight, band.top], anchor_y: null } };
  };
  const annualColumnText = upper(items.filter((i) => i.x >= annualStart && i.y < sectionRow.y && i.y > sectionBottom).map((i) => i.str).join(' '));
  const rowTopeAnual = (rowY: number) => {
    const band = rowBand(rowY);
    const strict = annualRows.find((r) => Math.abs(r.y - rowY) <= 4);
    if (strict) {
      if (/\bSIN TOPE\b/i.test(strict.norm)) {
        return {
          estado: 'SIN_TOPE_ITEM',
          source: 'direct',
          confidence: 1,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: strict.y }
        };
      }
      const p = parseTopeFromNorm(strict.norm);
      if (p) {
        return {
          estado: 'CON_TOPE',
          valor: p.valor,
          unidad: p.unidad,
          source: 'direct',
          confidence: 1,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: strict.y }
        };
      }
    }
    const nearest = annualRows
      .map((r) => ({ r, d: Math.abs(r.y - rowY) }))
      .filter((x) => x.d <= 35)
      .sort((a, b) => a.d - b.d)[0];
    if (nearest) {
      if (/\bSIN TOPE\b/i.test(nearest.r.norm)) {
        return {
          estado: 'SIN_TOPE_ITEM',
          source: 'merged_segment',
          confidence: 0.85,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: nearest.r.y }
        };
      }
      const p = parseTopeFromNorm(nearest.r.norm);
      if (p) {
        return {
          estado: 'CON_TOPE',
          valor: p.valor,
          unidad: p.unidad,
          source: 'merged_segment',
          confidence: 0.85,
          evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: nearest.r.y }
        };
      }
    }
    if (/\bSIN TOPE\b/i.test(annualColumnText)) {
      return {
        estado: 'SIN_TOPE_ITEM',
        source: 'column_level',
        confidence: 0.7,
        evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, sectionBottom, annualStart + 40, sectionRow.y], anchor_y: null }
      };
    }
    return {
      estado: 'UNKNOWN',
      source: 'unknown',
      confidence: 0,
      evidence: { column_id: 'LE_TOPE_ANUAL', bbox: [annualStart, band.bottom, annualStart + 40, band.top], anchor_y: null }
    };
  };

  const oferta_preferente: Record<string, any[]> = {};
  const libre_eleccion: Record<string, any> = {};
  for (const p of prestRows) {
    const key = p.leftRaw;
    oferta_preferente[key] = sharedPreferente.length
      ? sharedPreferente
      : [{ bonificacion_pct: 'UNKNOWN', tope_evento: 'UNKNOWN', prestadores: [], restricciones: [] }];
    const te = rowTopeEvento(p.y);
    const ta = rowTopeAnual(p.y);
    const bp = rowBonif(p.y);
    libre_eleccion[key] = {
      bonificacion_pct: {
        valor: bp.valor,
        source: bp.source,
        confidence: bp.confidence,
        evidence: bp.evidence
      },
      tope_evento: te,
      tope_anual: ta
    };
  }

  return {
    section: 'AMBULATORIAS',
    oferta_preferente,
    libre_eleccion,
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
    const unidad = normalizeUnitToken(m[2]);
    if (!Number.isNaN(valor) && unidad !== 'UNKNOWN') out.push({ valor, unidad });
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

function buildM12Page3Combined(rawItems: any[], originalname: string, page: number) {
  const hospital = tryExtractM12HospitalFull(rawItems);
  const ambulatoriasGeom = tryExtractM12AmbulatoriasFull(rawItems);
  const gridItems = toGridItems(rawItems);
  const yTol = computeDynamicYTol(gridItems);
  const rows = buildRows(gridItems, yTol);
  const fullText = rows.map((r) => r.text).join('\n');
  const meta = extractMeta(fullText, originalname || 'document.pdf', page);
  const hospitalSectionRow = rows.find((r) => r.norm.includes('HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA'));
  const headerSchema = hospitalSectionRow ? detectHeaderSchema(gridItems, hospitalSectionRow.y) : null;
  if (headerSchema) {
    (meta.layout as any).header_schema = {
      level1: ['PRESTACIONES', 'OFERTA_PREFERENTE', 'LIBRE_ELECCION'],
      level2: {
        oferta_preferente: ['BONIFICACION', 'TOPE', 'TOPE_MAX_ANO'],
        libre_eleccion: ['BONIFICACION', 'TOPE', 'TOPE_MAX_ANO']
      },
      columns: {
        prestaciones_right: headerSchema.xPrestacionesRight,
        op_pct: [headerSchema.op.pctLeft, headerSchema.op.pctRight],
        op_tope_evento: [headerSchema.op.eventLeft, headerSchema.op.eventRight],
        op_tope_anual_left: headerSchema.op.annualLeft,
        le_pct: [headerSchema.le.pctLeft, headerSchema.le.pctRight],
        le_tope_evento: [headerSchema.le.eventLeft, headerSchema.le.eventRight],
        le_tope_anual_left: headerSchema.le.annualLeft
      }
    };
  }

  const ambulatorias = ambulatoriasGeom || detectAmbulatoriasSection(fullText);
  const urgencia = detectUrgenciaSection(fullText);
  const restringidas = detectRestringidasSection(fullText);
  const otras = detectOtrasSection(fullText);
  const prestadoresDerivados = detectPrestadoresDerivados(fullText);

  const warnings = [
    ...(hospital?.warnings || []),
    ...((ambulatoriasGeom?.warnings) || []),
    ambulatoriasGeom ? 'Ambulatorias extraida en modo geometrico v2.' : 'Secciones no hospitalarias extraidas en modo textual+estructural (v1).',
    'Para contratos atipicos, revisar campos ambiguos con evidencia visual.'
  ];

  return {
    ...meta,
    section: hospital?.section || 'HOSPITALARIAS Y CIRUGIA MAYOR AMBULATORIA',
    oferta_preferente: hospital?.oferta_preferente || {},
    libre_eleccion: hospital?.libre_eleccion || {},
    page3_sections: {
      hospitalarias: hospital,
      ambulatorias,
      atenciones_urgencia: urgencia,
      prestaciones_restringidas: restringidas,
      otras_prestaciones: otras,
      prestadores_derivados: prestadoresDerivados
    },
    warnings: Array.from(new Set(warnings))
  };
}

export async function handleM12VisualExtraction(req: Request, res: Response) {
  try {
    const { image, mimeType, originalname, page = 3, mode = 'single', output = 'm12-structured' } = req.body || {};
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
    const outputMode = String(output || 'm12-structured').trim().toLowerCase();

    if (outputMode === 'azure-web') {
      const traceId = `m12-azure-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const azureWebPayload = await buildAzureLayoutWebPayloadFromPdfDocument(image, traceId, 'fast');
      if (!azureWebPayload || String(azureWebPayload?.status || '').toLowerCase() !== 'succeeded') {
        res.status(502).json({ error: 'Azure prebuilt-layout no devolvio un payload valido.' });
        return;
      }
      res.json(azureWebPayload);
      return;
    }

    try {
      const azureFirst = await tryM12RawFirst(image, originalname || 'document.pdf', pageNum, singleMode);
      if (azureFirst) {
        res.json(azureFirst);
        return;
      }
    } catch (rawError: any) {
      console.warn('[M12] Azure/raw-first failed, falling back to pdfjs:', rawError?.message || rawError);
    }

    const fallbackResponse = await extractM12WithPdfJsFallback(buffer, originalname || 'document.pdf', pageNum, singleMode);
    res.json(fallbackResponse);
  } catch (error: any) {
    console.error('[M12] Visual extraction error:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
