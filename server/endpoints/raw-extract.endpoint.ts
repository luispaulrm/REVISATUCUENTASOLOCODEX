import { Request, Response } from 'express';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

type RawCell = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  dir: string;
  fontName: string;
};

type RawRow = {
  rowIndex: number;
  y: number;
  text: string;
  cells: RawCell[];
};

type RawPage = {
  pageNumber: number;
  width: number;
  height: number;
  yTolerance: number;
  text: string;
  rows: RawRow[];
  items: RawCell[];
  ocrSource?: 'azure-layout' | 'openai-ocr' | 'native-textlayer' | 'unknown';
  pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown';
  pageClassConfidence?: number;
  pageClassReason?: string;
};

type RawExtractPayload = {
  mode: 'RAW_PDF_1_1';
  sourceMimeType: string;
  totalPages: number;
  processedPages: number;
  fullText: string;
  pages: RawPage[];
};

type RawExtractOptions = {
  mode?: 'fast' | 'robust';
  renderScale?: number;
  force?: boolean;
  ocrVisionTimeoutMs?: number;
};

type VisionPageClass = {
  pageClass: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown';
  confidence: number;
  reason: string;
};

type AzureLayoutLine = {
  content: string;
  pageNumber: number;
  y: number;
  x: number;
  width: number;
  sourceHeight?: number;
  sourceWidth?: number;
};

type AzureDocLayoutCacheEntry = {
  createdAt: number;
  pagesByNumber: Map<number, AzureLayoutLine[]>;
  rawPayload: any;
};

type AzureDocLayoutResult = {
  pagesByNumber: Map<number, AzureLayoutLine[]>;
  rawPayload: any;
};

type ColumnBands = {
  headerY: number;
  cantLeft: number;
  priceLeft: number;
  isaLeft: number;
  bonifLeft: number;
  copagoLeft: number;
};

type TypedStatementRow = {
  page: number;
  rowIndex: number;
  y: number;
  kind: 'title' | 'metadata' | 'section_header' | 'column_header' | 'detail_row' | 'subtotal' | 'other';
  text: string;
};

let openaiClientCache: OpenAI | null = null;
function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return null;
  if (!openaiClientCache) {
    openaiClientCache = new OpenAI({ apiKey: key });
  }
  return openaiClientCache;
}

function toNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveOcrVisionTimeoutMs(mode: 'fast' | 'robust' = 'fast'): number {
  const envFast = toNum(process.env.RAW_EXTRACT_OCR_TIMEOUT_MS, 45000);
  const envRobust = toNum(process.env.RAW_EXTRACT_OCR_TIMEOUT_MS_ROBUST, 90000);
  const timeout = mode === 'robust' ? envRobust : envFast;
  return clamp(timeout, 10000, 180000);
}

function resolveRequestTimeoutMs(requestedTimeoutMs = 0): number {
  const envTimeout = toNum(process.env.RAW_EXTRACT_REQUEST_TIMEOUT_MS, 70000);
  return clamp(requestedTimeoutMs > 0 ? requestedTimeoutMs : envTimeout, 15000, 240000);
}

function resolveAzureLayoutKeys(): string[] {
  const primary = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || '').trim();
  const secondary = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY_SECONDARY || process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY2 || '').trim();
  return [...new Set([primary, secondary].filter((k) => k.length > 0))];
}

function resolveAzureLayoutEnabled(): boolean {
  const endpoint = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').trim();
  const keys = resolveAzureLayoutKeys();
  const flag = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENABLED || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return endpoint.length > 0 && keys.length > 0;
  return endpoint.length > 0 && keys.length > 0;
}

function resolveAzureLayoutTimeoutMs(mode: 'fast' | 'robust' = 'fast'): number {
  const envFast = toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS, 35000);
  const envRobust = toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS_ROBUST, 90000);
  return clamp(mode === 'robust' ? envRobust : envFast, 10000, 180000);
}

function resolveAzureOnlyMode(): boolean {
  if (!resolveAzureLayoutEnabled()) return false;
  const flag = String(process.env.RAW_EXTRACT_AZURE_ONLY || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function resolveAzureDocCacheTtlMs(): number {
  return clamp(toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_DOC_CACHE_TTL_MS, 20 * 60 * 1000), 60 * 1000, 2 * 60 * 60 * 1000);
}

function resolveAzureDocTimeoutMs(mode: 'fast' | 'robust' = 'fast'): number {
  const envFast = toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_DOC_TIMEOUT_MS, 120000);
  const envRobust = toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_DOC_TIMEOUT_MS_ROBUST, 180000);
  return clamp(mode === 'robust' ? envRobust : envFast, 30000, 300000);
}

function resolveAzurePollIntervalMs(): number {
  return clamp(toNum(process.env.AZURE_DOCUMENT_INTELLIGENCE_POLL_INTERVAL_MS, 2500), 1000, 10000);
}

function buildPdfFingerprint(base64Pdf: string): string {
  return createHash('sha1').update(base64Pdf).digest('hex');
}

function indexAzureLinesByPage(lines: AzureLayoutLine[]): Map<number, AzureLayoutLine[]> {
  const map = new Map<number, AzureLayoutLine[]>();
  for (const line of lines) {
    const page = Number(line.pageNumber || 0);
    if (!(page > 0)) continue;
    const current = map.get(page) || [];
    current.push(line);
    map.set(page, current);
  }
  for (const [page, pageLines] of map.entries()) {
    map.set(page, [...pageLines].sort((a, b) => a.y - b.y));
  }
  return map;
}

const azureDocLayoutCache = new Map<string, AzureDocLayoutCacheEntry>();
const azureDocLayoutInFlight = new Map<string, Promise<AzureDocLayoutResult>>();

function pruneAzureDocCache(): void {
  const ttlMs = resolveAzureDocCacheTtlMs();
  const now = Date.now();
  for (const [key, entry] of azureDocLayoutCache.entries()) {
    if (now - entry.createdAt > ttlMs) {
      azureDocLayoutCache.delete(key);
    }
  }
  if (azureDocLayoutCache.size <= 4) return;
  const sorted = [...azureDocLayoutCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < sorted.length - 4; i += 1) {
    azureDocLayoutCache.delete(sorted[i][0]);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAzureLinesFromAnalyzePayload(payload: any, defaultPage = 1): AzureLayoutLine[] {
  const pages = Array.isArray(payload?.analyzeResult?.pages) ? payload.analyzeResult.pages : [];
  const lines: AzureLayoutLine[] = [];
  for (const page of pages) {
    const pNum = Number(page?.pageNumber || defaultPage || 1);
    const sourceHeight = toNum(page?.height, 0);
    const sourceWidth = toNum(page?.width, 0);
    const pageLines = Array.isArray(page?.lines) ? page.lines : [];
    for (let lineIdx = 0; lineIdx < pageLines.length; lineIdx += 1) {
      const line = pageLines[lineIdx];
      const content = String(line?.content || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const poly = Array.isArray(line?.polygon) ? line.polygon : [];
      const xValues = poly.filter((_: any, idx: number) => idx % 2 === 0).map((v: any) => toNum(v, 0));
      const yValues = poly.filter((_: any, idx: number) => idx % 2 === 1).map((v: any) => toNum(v, 0));
      const fallbackY = sourceHeight > 0 ? ((lineIdx + 1) * sourceHeight) / Math.max(1, pageLines.length + 1) : lineIdx + 1;
      const y = yValues.length ? Math.min(...yValues) : fallbackY;
      const x0 = xValues.length ? Math.min(...xValues) : 0;
      const x1 = xValues.length ? Math.max(...xValues) : (sourceWidth > 0 ? Math.min(sourceWidth, x0 + sourceWidth * 0.9) : x0 + 1);
      const width = Math.max(0.001, x1 - x0);
      lines.push({ content, pageNumber: pNum, y, x: x0, width, sourceHeight, sourceWidth });
    }
  }
  lines.sort((a, b) => {
    const byPage = a.pageNumber - b.pageNumber;
    if (byPage !== 0) return byPage;
    return a.y - b.y;
  });
  return lines;
}

async function azureAnalyzeLayoutFromPdfDocumentDetailed(
  pdfBase64: string,
  traceId = '',
  mode: 'fast' | 'robust' = 'fast'
): Promise<AzureDocLayoutResult> {
  if (!resolveAzureLayoutEnabled()) {
    return { pagesByNumber: new Map(), rawPayload: null };
  }
  pruneAzureDocCache();
  const cacheKey = buildPdfFingerprint(pdfBase64);
  const cached = azureDocLayoutCache.get(cacheKey);
  const ttlMs = resolveAzureDocCacheTtlMs();
  if (cached && Date.now() - cached.createdAt <= ttlMs) {
    console.log(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc cache hit pages=${cached.pagesByNumber.size}`);
    return {
      pagesByNumber: cached.pagesByNumber,
      rawPayload: cached.rawPayload
    };
  }
  const inflight = azureDocLayoutInFlight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const run = (async () => {
    const endpoint = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').trim().replace(/\/+$/, '');
    const keys = resolveAzureLayoutKeys();
    if (!keys.length) throw new Error('Azure DI doc: no API key configured');
    const apiVersion = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION || '2024-11-30');
    const timeoutMs = resolveAzureDocTimeoutMs(mode);
    const pollStepMs = resolveAzurePollIntervalMs();
    const startedAt = Date.now();
    const analyzeUrl =
      `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze` +
      `?api-version=${encodeURIComponent(apiVersion)}&stringIndexType=utf16CodeUnit`;
    const failures: string[] = [];

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];
      const keyLabel = keyIndex === 0 ? 'primary' : `secondary-${keyIndex}`;
      try {
        const analyzeResponse = await withTimeout(
          fetch(analyzeUrl, {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              base64Source: pdfBase64
            })
          }),
          timeoutMs,
          `Azure DI doc submit (${keyLabel})`
        );
        if (!analyzeResponse.ok) {
          const body = await analyzeResponse.text().catch(() => '');
          throw new Error(`Azure DI doc submit HTTP ${analyzeResponse.status}${body ? `: ${body.slice(0, 220)}` : ''}`);
        }

        const operationLocation = analyzeResponse.headers.get('operation-location') || '';
        if (!operationLocation) {
          throw new Error('Azure DI doc missing operation-location');
        }

        const pollStartedAt = Date.now();
        let pollPayload: any = null;
        while (Date.now() - pollStartedAt < timeoutMs) {
          await sleep(pollStepMs);
          const pollResponse = await fetch(operationLocation, {
            method: 'GET',
            headers: {
              'Ocp-Apim-Subscription-Key': key
            }
          });

          if (pollResponse.status === 429) {
            const retryAfter = Number(pollResponse.headers.get('retry-after') || 0);
            const waitMs = clamp((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : pollStepMs * 2), pollStepMs, 30000);
            console.warn(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc poll 429 (${keyLabel}), waiting ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }

          if (!pollResponse.ok) {
            const body = await pollResponse.text().catch(() => '');
            throw new Error(`Azure DI doc poll HTTP ${pollResponse.status}${body ? `: ${body.slice(0, 220)}` : ''}`);
          }
          pollPayload = await pollResponse.json();
          const status = String(pollPayload?.status || '').toLowerCase();
          if (status === 'succeeded') break;
          if (status === 'failed' || status === 'canceled') {
            throw new Error(`Azure DI doc status=${status}`);
          }
        }

        if (!pollPayload || String(pollPayload?.status || '').toLowerCase() !== 'succeeded') {
          throw new Error(`Azure DI doc timeout (${Math.round(timeoutMs / 1000)}s)`);
        }

        const lines = extractAzureLinesFromAnalyzePayload(pollPayload, 1);
        const pagesByNumber = indexAzureLinesByPage(lines);
        azureDocLayoutCache.set(cacheKey, {
          createdAt: Date.now(),
          pagesByNumber,
          rawPayload: pollPayload
        });
        pruneAzureDocCache();
        console.log(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc analyzed pages=${pagesByNumber.size} lines=${lines.length} mode=${mode} key=${keyLabel} (${Date.now() - startedAt}ms)`
        );
        return {
          pagesByNumber,
          rawPayload: pollPayload
        };
      } catch (error: any) {
        const msg = String(error?.message || 'unknown');
        failures.push(`${keyLabel}: ${msg}`);
        console.warn(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc failed with ${keyLabel}: ${msg}`);
      }
    }

    throw new Error(`Azure DI doc failed for all keys. ${failures.join(' | ')}`);
  })();

  azureDocLayoutInFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    azureDocLayoutInFlight.delete(cacheKey);
  }
}

async function azureAnalyzeLayoutFromPdfDocument(
  pdfBase64: string,
  traceId = '',
  mode: 'fast' | 'robust' = 'fast'
): Promise<Map<number, AzureLayoutLine[]>> {
  const result = await azureAnalyzeLayoutFromPdfDocumentDetailed(pdfBase64, traceId, mode);
  return result.pagesByNumber;
}

export async function buildAzureLayoutWebPayloadFromPdfDocument(
  pdfBase64: string,
  traceId = '',
  mode: 'fast' | 'robust' = 'fast'
): Promise<any> {
  const result = await azureAnalyzeLayoutFromPdfDocumentDetailed(pdfBase64, traceId, mode);
  return result.rawPayload;
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout (${Math.round(timeoutMs / 1000)}s).`)), timeoutMs);
    });
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function azureAnalyzeLayoutFromPageImage(
  imageBase64: string,
  pageNumber: number,
  traceId = '',
  mode: 'fast' | 'robust' = 'fast'
): Promise<AzureLayoutLine[]> {
  if (!resolveAzureLayoutEnabled()) return [];
  const endpoint = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').trim().replace(/\/+$/, '');
  const keys = resolveAzureLayoutKeys();
  if (!keys.length) return [];
  const apiVersion = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION || '2024-11-30');
  const timeoutMs = resolveAzureLayoutTimeoutMs(mode);
  const startedAt = Date.now();

  const analyzeUrl =
    `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze` +
    `?api-version=${encodeURIComponent(apiVersion)}&stringIndexType=utf16CodeUnit`;
  const pollStepMs = 1200;
  const failures: string[] = [];

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    const keyLabel = keyIndex === 0 ? 'primary' : `secondary-${keyIndex}`;
    try {
      const analyzeResponse = await withTimeout(
        fetch(analyzeUrl, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            base64Source: imageBase64
          })
        }),
        timeoutMs,
        `Azure DI submit page=${pageNumber} (${keyLabel})`
      );

      if (!analyzeResponse.ok) {
        const body = await analyzeResponse.text().catch(() => '');
        throw new Error(`Azure DI submit HTTP ${analyzeResponse.status}${body ? `: ${body.slice(0, 220)}` : ''}`);
      }

      const operationLocation = analyzeResponse.headers.get('operation-location') || '';
      if (!operationLocation) {
        throw new Error('Azure DI missing operation-location');
      }

      const pollStartedAt = Date.now();
      const maxPollMs = timeoutMs;
      let pollPayload: any = null;
      while (Date.now() - pollStartedAt < maxPollMs) {
        await sleep(pollStepMs);
        const pollResponse = await fetch(operationLocation, {
          method: 'GET',
          headers: {
            'Ocp-Apim-Subscription-Key': key
          }
        });
        if (!pollResponse.ok) {
          const body = await pollResponse.text().catch(() => '');
          throw new Error(`Azure DI poll HTTP ${pollResponse.status}${body ? `: ${body.slice(0, 220)}` : ''}`);
        }
        pollPayload = await pollResponse.json();
        const status = String(pollPayload?.status || '').toLowerCase();
        if (status === 'succeeded') break;
        if (status === 'failed' || status === 'canceled') {
          throw new Error(`Azure DI status=${status}`);
        }
      }

      const lines = extractAzureLinesFromAnalyzePayload(pollPayload, pageNumber);
      console.log(
        `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI layout page=${pageNumber} lines=${lines.length} mode=${mode} key=${keyLabel} (${Date.now() - startedAt}ms)`
      );
      return lines;
    } catch (error: any) {
      const msg = String(error?.message || 'unknown');
      failures.push(`${keyLabel}: ${msg}`);
      console.warn(
        `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI layout failed page=${pageNumber} mode=${mode} key=${keyLabel}: ${msg}`
      );
    }
  }

  console.warn(
    `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI layout failed page=${pageNumber} mode=${mode} all-keys: ${failures.join(' | ')}`
  );
  return [];
}

function stripDataUrlPrefix(base64OrDataUrl: string): string {
  if (!base64OrDataUrl) return '';
  const marker = 'base64,';
  const idx = base64OrDataUrl.indexOf(marker);
  if (idx >= 0) return base64OrDataUrl.slice(idx + marker.length);
  return base64OrDataUrl;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function normalize(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parseMoney(text: string): number {
  const cleaned = String(text || '').replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return 0;
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseQuantity(text: string): number {
  const cleaned = String(text || '').replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return 0;
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function extractNumericTokens(text: string): string[] {
  return String(text || '').match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g) || [];
}

function parseMoneyFromFirstToken(text: string): number {
  const tokens = extractNumericTokens(text);
  if (!tokens.length) return 0;
  return parseMoney(tokens[0]);
}

function parseMoneyFromLastToken(text: string): number {
  const tokens = extractNumericTokens(text);
  if (!tokens.length) return 0;
  return parseMoney(tokens[tokens.length - 1]);
}

function canonicalDescriptionForDedup(text: string): string {
  return normalize(text)
    .replace(/\b\d[\d.,/-]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_REASONABLE_LINE_TOTAL = 100;
const MAX_REASONABLE_LINE_TOTAL = 20000000;

function hasDetailSignature(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  const hasCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(t) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(t);
  const hasDate = /\b\d{2}[/-]\d{2}[/-]\d{4}\b/.test(t);
  const moneyTokenCount = extractNumericTokens(t).length;
  return hasCode || (hasDate && moneyTokenCount >= 3);
}

function isLikelySummaryOrCarryLine(description: string, fullRowText: string): boolean {
  const desc = String(description || '').trim();
  if (!desc) return true;
  const hasLetters = /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(desc);
  const numericTokens = extractNumericTokens(fullRowText).length;
  const mostlyNumeric = !hasLetters || /^[\d\s.,-]+$/.test(desc);
  if (mostlyNumeric && numericTokens >= 4) return true;
  if (desc.toUpperCase().includes('SUBTOTAL') || desc.toUpperCase().includes('TOTAL')) return true;
  return false;
}

function isLikelyAdministrativeLine(text: string): boolean {
  const n = normalize(text);
  if (/^CTA\d+_\d+_/.test(n)) return true;
  const patterns = [
    'INFORME DE CUENTAS',
    'PAGINA',
    'HORA IMPRESION',
    'PLAN:',
    'FACTOR/CONV',
    'FECHA EMISION',
    'FOLIO PAM',
    'FOLIO P.A.M',
    'COTIZANTE',
    'NOMBRE COTIZANTE',
    'BENEFICIARIO',
    'PRESTADOR',
    'SOCIEDAD',
    'BONO DEBE SER COBRADO',
    'TOTAL GENERAL',
    'NOMBRE PLAN',
    'NOMBRE PRODUCTO',
    'FECHA DE LIQUIDACION',
    'TOTAL BONIFICACION',
    'TOTAL COPAGO',
    'EMPRESA RUT',
    'RUT ',
    'PREVISION',
    'SUCURSAL',
    'CUENTA ',
    'NOMBRE PACIENTE',
    'FECHA INGRESO',
    'CODIGO DESCRIPCION FECHA',
    'DETALLE'
  ];
  return patterns.some((p) => n.includes(p));
}

function isLikelyPamLine(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  const patterns = [
    'PROGRAMA DE ATENCION MEDICA',
    'DEPARTAMENTO DE BENEFICIOS',
    'DEPARTAMENTOS DE BENEFICIOS',
    'DOCUMENTOS VALORIZADOS',
    'FOLIO PAM',
    'FOLIO P.A.M',
    'BONO DEBE SER COBRADO',
    'NOMBRE COTIZANTE',
    'COTIZANTE',
    'BENEFICIARIO',
    'PRESTADOR',
    'SOCIEDAD',
    'NOMBRE PLAN',
    'NOMBRE PRODUCTO',
    'LIBRE ELECCION',
    'P.A.M'
  ];
  return patterns.some((p) => n.includes(p));
}

function isLikelyPamResidualNoise(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  const patterns = [
    'PRESTACION NO CONTEMPLADA EN EL ARANCEL',
    'CARECE DE CODIGO EN EL ARANCEL',
    'ARANCEL FONASA',
    'NO TIENE COBERTURA',
    'DOCUMENTOS VALORIZADOS',
    'HORA IMPRESION',
    'DOCUMENTO VALIDO POR'
  ];
  return patterns.some((p) => n.includes(p));
}

function isCodeOnlyDescription(text: string): boolean {
  return /^\s*\d{7,}(?:-[A-Z0-9])?\s*$/i.test(String(text || '').trim());
}

function looksLikeBillDetailRow(row: RawRow, description: string, unitPrice: number, total: number): boolean {
  if (isLikelyAdministrativeLine(row.text) || isLikelyAdministrativeLine(description)) return false;
  if (isLikelyPamLine(row.text) || isLikelyPamLine(description)) return false;
  if (isLikelyPamResidualNoise(row.text) || isLikelyPamResidualNoise(description)) return false;
  if (isCodeOnlyDescription(description)) return false;
  if (isLikelySummaryOrCarryLine(description, row.text)) return false;
  if (!(unitPrice > 0 || total > 0)) return false;
  if (row.cells.length < 8) return false;

  const hasCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(description) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(description.trim());
  const hasDate = /\b\d{2}[/-]\d{2}[/-]\d{4}\b/.test(row.text);
  const hasMoney = extractNumericTokens(row.text).length >= 3;
  return hasCode || (hasDate && hasMoney);
}

function isLikelyAuditableRawItem(item: any): boolean {
  const description = String(item?.description || '').trim();
  const total = Number(item?.total || 0);
  if (!description) return false;
  if (isLikelyAdministrativeLine(description)) return false;
  if (isLikelyPamLine(description)) return false;
  if (isLikelyPamResidualNoise(description)) return false;
  if (isCodeOnlyDescription(description)) return false;
  if (isLikelySummaryOrCarryLine(description, description)) return false;
  if (!hasDetailSignature(description) && item?.rawOcrDetail !== true) return false;
  if (!Number.isFinite(total) || total < MIN_REASONABLE_LINE_TOTAL || total > MAX_REASONABLE_LINE_TOTAL) return false;
  return true;
}

function isOcrCodeDetailLine(text: string): boolean {
  const t = String(text || '').trim();
  return (
    /^\d{2}-\d{2}-\d{3}-\d{2}\b/.test(t) ||
    /^CODIGO\s+\d{5,8}\b/i.test(t) ||
    /^\d{5,8}\s+[A-Z]/i.test(t.toUpperCase())
  );
}


function isSectionHeaderRow(text: string): boolean {
  const t = normalize(text);
  return /^\d{3,5}\s+[A-Z/.\-?]/.test(t) && !t.includes('CODIGO') && !t.includes('DESCRIPCION');
}

function isColumnHeaderRow(text: string): boolean {
  const t = normalize(text);
  return t.includes('CODIGO') && t.includes('DESCRIPCION') && t.includes('CANT') && t.includes('PRECIO');
}

function isSubtotalRow(text: string): boolean {
  const t = normalize(text);
  if (t.includes('TOTAL') || t.includes('SUBTOTAL')) return true;
  const tokens = extractNumericTokens(t);
  return tokens.length >= 6 && !/[A-Z]/.test(t.replace(/[0-9\s.,/-]/g, ''));
}

function parseSectionHeader(text: string): { code: string; label: string } | null {
  const m = String(text).trim().match(/^(\d{3,5})\s+(.+)$/);
  if (!m) return null;
  return { code: m[1], label: m[2].trim() };
}

function splitMergedMoneyTokens(text: string): string {
  // OCR often merges adjacent money values (e.g. 192.7491.265.690)
  return String(text || '').replace(/(\d{1,3}(?:\.\d{3})+)(?=\d{1,3}\.\d{3}\b)/g, '$1 ');
}

function parseOcrDetailDescription(text: string): string {
  const withoutCode = String(text || '')
    .replace(/^\d{2}-\d{2}-\d{3}-\d{2}\s+/, '')
    .replace(/^CODIGO\s+\d{5,8}\s+/i, '')
    .replace(/^\d{5,8}\s+/, '')
    .trim();
  const cutAtDate = withoutCode.replace(/\b\d{2}\/\d{2}\/\d{4}\b.*$/, '').trim();
  return cutAtDate || withoutCode;
}


function buildSectionsFromOcrRows(payload: RawExtractPayload): any[] {
  const byCategory = new Map<string, any>();
  const order: string[] = [];

  const ensureSection = (category: string) => {
    if (!byCategory.has(category)) {
      byCategory.set(category, {
        category,
        items: [],
        sectionTotal: 0,
        calculatedSectionTotal: 0,
        hasSectionError: false,
        isTaxConfusion: false,
        isUnjustifiedCharge: false
      });
      order.push(category);
    }
    return byCategory.get(category);
  };

  for (const page of payload.pages) {
    let currentCategory = `RAW PAGE ${page.pageNumber}`;
    ensureSection(currentCategory);

    for (let i = 0; i < page.rows.length; i++) {
      const row = page.rows[i];
      const text = row.text.trim();
      if (!text) continue;

      if (isSectionHeaderRow(text)) {
        const parsed = parseSectionHeader(text);
        currentCategory = parsed ? `${parsed.code} ${parsed.label}` : text;
        ensureSection(currentCategory);
        continue;
      }

      if (!isOcrCodeDetailLine(text)) continue;

      const next = page.rows[i + 1];
      const nextText = next?.text || '';
      const rowLine = splitMergedMoneyTokens(text);
      const rowTokens = extractNumericTokens(rowLine);
      const summaryLine = isSubtotalRow(nextText) ? splitMergedMoneyTokens(nextText) : '';
      const summaryTokens = summaryLine ? extractNumericTokens(summaryLine) : [];

      const dateMatch = rowLine.match(/\b\d{2}[/-]\d{2}[/-]\d{4}\b/);
      const afterDateTokens = dateMatch
        ? extractNumericTokens(rowLine.slice((dateMatch.index || 0) + dateMatch[0].length))
        : [];

      const quantity = parseQuantity(afterDateTokens[0] || rowTokens[2] || '1') || 1;
      const unitPrice = parseMoney(afterDateTokens[1] || rowTokens[3] || '0');

      let total = parseMoney(rowTokens[rowTokens.length - 1] || '0');
      if (!(total > 0) && summaryTokens.length > 0) {
        total = parseMoney(summaryTokens[summaryTokens.length - 1] || '0');
      }
      const valorIsa = parseMoney(afterDateTokens[3] || rowTokens[rowTokens.length - 2] || '0');
      const bonificacion = parseMoney(afterDateTokens[4] || summaryTokens[summaryTokens.length - 1] || '0');

      if (!Number.isFinite(total) || total < MIN_REASONABLE_LINE_TOTAL || total > MAX_REASONABLE_LINE_TOTAL) {
        continue;
      }

      const calculatedTotal = Math.round(quantity * unitPrice);

      const section = ensureSection(currentCategory);
      section.items.push({
        index: row.rowIndex,
        rawPage: page.pageNumber,
        description: parseOcrDetailDescription(text),
        quantity,
        unitPrice,
        total,
        calculatedTotal,
        hasCalculationError: total > 0 && unitPrice > 0 && Math.abs(total - calculatedTotal) > Math.max(5, calculatedTotal * 0.03),
        valorIsa,
        bonificacion,
        copago: 0,
        rawY: row.y,
        rawCells: row.cells,
        rawOcrDetail: true
      });
    }
  }

  const sections = order
    .map((category) => byCategory.get(category))
    .filter((s: any) => (s?.items?.length || 0) > 0)
    .map((section: any) => {
      const sectionTotal = Math.round(section.items.reduce((acc: number, it: any) => acc + (Number(it.total) || 0), 0));
      const calculatedSectionTotal = Math.round(section.items.reduce((acc: number, it: any) => acc + (Number(it.calculatedTotal) || 0), 0));
      return {
        ...section,
        sectionTotal,
        calculatedSectionTotal,
        hasSectionError: Math.abs(sectionTotal - calculatedSectionTotal) > Math.max(10, calculatedSectionTotal * 0.03)
      };
    });

  return sections;
}

function buildTypedRowsFromPage(page: RawPage): TypedStatementRow[] {
  const typed: TypedStatementRow[] = [];
  for (const row of page.rows) {
    const text = row.text.trim();
    const upper = normalize(text);
    let kind: TypedStatementRow['kind'] = 'other';
    if (upper.includes('INFORME DE CUENTAS') || upper === 'DETALLE') kind = 'title';
    else if (isSectionHeaderRow(text)) kind = 'section_header';
    else if (isColumnHeaderRow(text)) kind = 'column_header';
    else if (isSubtotalRow(text)) kind = 'subtotal';
    else if (isLikelyAdministrativeLine(text)) kind = 'metadata';
    typed.push({
      page: page.pageNumber,
      rowIndex: row.rowIndex,
      y: row.y,
      kind,
      text
    });
  }
  return typed;
}

function computeYTolerance(cells: RawCell[]): number {
  const heights = cells.map((c) => Math.max(1, c.height)).filter((h) => Number.isFinite(h));
  const base = median(heights) || 8;
  return clamp(base * 0.35, 2.5, 6);
}

function groupCellsIntoRows(cells: RawCell[], yTolerance: number): RawRow[] {
  const groups: Array<{ y: number; ys: number[]; cells: RawCell[] }> = [];

  for (const cell of [...cells].sort((a, b) => b.y - a.y)) {
    let matched = false;
    for (const group of groups) {
      if (Math.abs(cell.y - group.y) <= yTolerance) {
        group.cells.push(cell);
        group.ys.push(cell.y);
        group.y = group.ys.reduce((acc, value) => acc + value, 0) / group.ys.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      groups.push({ y: cell.y, ys: [cell.y], cells: [cell] });
    }
  }

  return groups
    .map((group, index) => {
      const ordered = [...group.cells].sort((a, b) => a.x - b.x);
      const text = ordered.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim();
      return {
        rowIndex: index + 1,
        y: group.y,
        text,
        cells: ordered
      };
    })
    .filter((row) => row.text.length > 0)
    .sort((a, b) => b.y - a.y)
    .map((row, index) => ({ ...row, rowIndex: index + 1 }));
}

function detectColumnBands(rows: RawRow[]): ColumnBands[] {
  const detected: ColumnBands[] = [];
  for (const row of rows) {
    const norm = normalize(row.text);
    const hasDesc = norm.includes('DESCRIPCION') || norm.includes('DESCRIP');
    const hasCant = norm.includes('CANT');
    const hasPrecio = norm.includes('PRECIO');
    const hasIsa = norm.includes('VALOR') && norm.includes('ISA');
    if (!hasDesc || !hasCant || !hasPrecio || !hasIsa) {
      continue;
    }

    const sorted = [...row.cells].sort((a, b) => a.x - b.x);
    const findX = (pred: (n: string) => boolean, fallback: number): number => {
      const found = sorted.find((c) => pred(normalize(c.text)));
      return found ? found.x0 : fallback;
    };

    const cantLeft = findX((t) => t.includes('CANT'), sorted[Math.max(1, Math.floor(sorted.length * 0.65))]?.x0 || 0);
    const priceLeft = findX((t) => t.includes('PRECIO'), sorted[Math.max(1, Math.floor(sorted.length * 0.75))]?.x0 || cantLeft + 50);
    const isaLeft = findX((t) => t.includes('VALOR') || t.includes('ISA'), sorted[Math.max(1, Math.floor(sorted.length * 0.82))]?.x0 || priceLeft + 50);
    const maxX = sorted.length ? Math.max(...sorted.map((c) => c.x1)) : isaLeft + 120;
    const bonifLeft = findX((t) => t.includes('BONIF'), sorted[Math.max(1, Math.floor(sorted.length * 0.9))]?.x0 || isaLeft + 30);
    const copagoLeft = findX((t) => t.includes('COPAGO'), maxX + 1);

    detected.push({
      headerY: row.y,
      cantLeft,
      priceLeft,
      isaLeft,
      bonifLeft,
      copagoLeft
    });
  }
  return detected.sort((a, b) => b.headerY - a.headerY);
}

function splitRowByBands(row: RawRow, bands: ColumnBands) {
  const descCells: RawCell[] = [];
  const qtyCells: RawCell[] = [];
  const priceCells: RawCell[] = [];
  const isaCells: RawCell[] = [];
  const bonifCells: RawCell[] = [];
  const copagoCells: RawCell[] = [];

  for (const cell of row.cells) {
    const x = cell.x0;
    if (x < bands.cantLeft) {
      descCells.push(cell);
    } else if (x < bands.priceLeft) {
      qtyCells.push(cell);
    } else if (x < bands.isaLeft) {
      priceCells.push(cell);
    } else if (x < bands.bonifLeft) {
      isaCells.push(cell);
    } else if (x < bands.copagoLeft) {
      bonifCells.push(cell);
    } else {
      copagoCells.push(cell);
    }
  }

  const joinText = (cells: RawCell[]) =>
    [...cells]
      .sort((a, b) => a.x0 - b.x0)
      .map((c) => c.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  return {
    description: joinText(descCells),
    quantityText: joinText(qtyCells),
    priceText: joinText(priceCells),
    isaText: joinText(isaCells),
    bonifText: joinText(bonifCells),
    copagoText: joinText(copagoCells)
  };
}

function findBestHeaderForRow(row: RawRow, headers: ColumnBands[]): ColumnBands | null {
  const candidates = headers.filter((h) => row.y < h.headerY && row.y > h.headerY - 320);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.headerY - row.y) - (b.headerY - row.y));
  return candidates[0];
}

function pickNearestNumericCell(cells: RawCell[], targetX: number, minX: number, maxX: number): RawCell | null {
  const numerics = cells.filter((c) => {
    const x = c.x0;
    return x >= minX && x <= maxX && /\d/.test(c.text);
  });
  if (!numerics.length) return null;
  numerics.sort((a, b) => Math.abs(a.x0 - targetX) - Math.abs(b.x0 - targetX));
  return numerics[0];
}

function toRawCells(pdfItems: any[]): RawCell[] {
  const out: RawCell[] = [];
  for (const item of pdfItems || []) {
    const rawText = typeof item?.str === 'string' ? item.str : '';
    if (!rawText || !item?.transform || item.transform.length < 6) continue;

    const x = toNum(item.transform[4]);
    const y = toNum(item.transform[5]);
    const width = Math.max(0, toNum(item.width, 0));
    const inferredHeight = Math.abs(toNum(item.transform[3], 0)) || 8;
    const height = Math.max(1, toNum(item.height, inferredHeight));

    out.push({
      text: rawText,
      x,
      y,
      width,
      height,
      x0: x,
      x1: x + width,
      y0: y - height / 2,
      y1: y + height / 2,
      dir: typeof item?.dir === 'string' ? item.dir : 'ltr',
      fontName: typeof item?.fontName === 'string' ? item.fontName : ''
    });
  }
  return out;
}

async function renderPageToPngBase64(page: any, scale = 2.0): Promise<string> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({
    canvasContext: context as any,
    viewport
  } as any).promise;
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.split(',')[1];
}

async function visionOcrRowsFromImage(
  imageBase64: string,
  pageNumber?: number,
  traceId = '',
  opts?: { mode?: 'fast' | 'robust'; timeoutMs?: number }
): Promise<string[]> {
  const client = getOpenAIClient();
  if (!client) {
    console.warn(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] OCR vision omitido: OPENAI_API_KEY no configurada.`);
    return [];
  }
  const startedAt = Date.now();
  const mode = opts?.mode === 'robust' ? 'robust' : 'fast';
  const fallbackTimeout = resolveOcrVisionTimeoutMs(mode);
  const visionTimeoutMs = clamp(toNum(opts?.timeoutMs, fallbackTimeout), 10000, 180000);
  const model = mode === 'robust'
    ? (process.env.RAW_EXTRACT_OCR_MODEL_ROBUST || process.env.RAW_EXTRACT_OCR_MODEL || 'gpt-4o-mini')
    : (process.env.RAW_EXTRACT_OCR_MODEL_FAST || process.env.RAW_EXTRACT_OCR_MODEL || 'gpt-4o-mini');
  const imageDetail = mode === 'robust' ? 'high' : 'auto';
  try {
    console.log(
      `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] OCR vision start page=${pageNumber ?? '?'} mode=${mode} model=${model} timeoutMs=${visionTimeoutMs}`
    );
    const requestBody: any = {
      model,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'OCR estricto en español. Devuelve SOLO JSON válido con formato {"rows":[{"text":"..."}]} ' +
                'con cada fila visual de arriba hacia abajo. No resumas. No inventes.'
            },
            {
              type: 'input_image',
              detail: imageDetail,
              image_url: `data:image/png;base64,${imageBase64}`
            }
          ]
        }
      ],
      temperature: 0
    };
    const requestOptions: any = {
      timeout: visionTimeoutMs,
      maxRetries: 0
    };
    const response = await withTimeout(
      client.responses.create(requestBody, requestOptions),
      visionTimeoutMs + 5000,
      `OCR vision page=${pageNumber ?? '?'}`
    );
    const text = String(response.output_text || '').trim();
    const stripFences = (s: string) =>
      s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsedRows: string[] = [];
    try {
      const parsed = JSON.parse(stripFences(text));
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      parsedRows = rows.map((r: any) => String(r?.text || '').trim()).filter((t: string) => t.length > 0);
    } catch {
      // Fallback: use line-by-line OCR text when model ignores strict JSON format.
      parsedRows = stripFences(text)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l !== '{' && l !== '}' && l !== '[' && l !== ']');
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] OCR vision page=${pageNumber ?? '?'} mode=${mode} rows=${parsedRows.length} (${elapsedMs}ms)`
    );
    return parsedRows;
  } catch (error: any) {
    const elapsedMs = Date.now() - startedAt;
    console.warn(
      `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] OCR vision failed page=${pageNumber ?? '?'} mode=${mode} (${elapsedMs}ms): ${error?.message || 'unknown'}`
    );
    return [];
  }
}

async function classifyPageWithVision(
  imageBase64: string,
  pageNumber?: number,
  traceId = '',
  opts?: { mode?: 'fast' | 'robust'; timeoutMs?: number }
): Promise<VisionPageClass> {
  const client = getOpenAIClient();
  if (!client) return { pageClass: 'unknown', confidence: 0, reason: 'OPENAI_API_KEY missing' };

  const mode = opts?.mode === 'robust' ? 'robust' : 'fast';
  const timeoutMs = clamp(toNum(opts?.timeoutMs, resolveOcrVisionTimeoutMs(mode)), 10000, 180000);
  const model = process.env.RAW_EXTRACT_PAGE_CLASS_MODEL || 'gpt-4o-mini';

  try {
    const response = await withTimeout(
      client.responses.create({
        model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Clasifica ESTA pagina de cuenta clinica en EXACTAMENTE uno: BILL, PAM, ADMIN, SUMMARY, UNKNOWN. ' +
                  'Devuelve SOLO JSON valido: {"pageClass":"BILL|PAM|ADMIN|SUMMARY|UNKNOWN","confidence":0..1,"reason":"<breve>"}'
              },
              {
                type: 'input_image',
                detail: mode === 'robust' ? 'high' : 'auto',
                image_url: `data:image/png;base64,${imageBase64}`
              }
            ]
          }
        ],
        temperature: 0
      } as any, {
        timeout: timeoutMs,
        maxRetries: 0
      } as any),
      timeoutMs + 5000,
      `Page classify page=${pageNumber ?? '?'}`
    );

    const raw = String((response as any)?.output_text || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(raw || '{}');
    const normalized = String(parsed?.pageClass || 'UNKNOWN').toUpperCase();
    const mapped: VisionPageClass['pageClass'] =
      normalized === 'BILL' ? 'bill' :
      normalized === 'PAM' ? 'pam' :
      normalized === 'ADMIN' ? 'admin' :
      normalized === 'SUMMARY' ? 'summary' :
      'unknown';
    const confidence = clamp(toNum(parsed?.confidence, 0), 0, 1);
    const reason = String(parsed?.reason || '').slice(0, 220);
    console.log(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber ?? '?'} classified=${mapped} conf=${confidence.toFixed(2)} reason=${reason}`);
    return { pageClass: mapped, confidence, reason };
  } catch (error: any) {
    console.warn(`[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber ?? '?'} classify failed: ${error?.message || 'unknown'}`);
    return { pageClass: 'unknown', confidence: 0, reason: 'classification_failed' };
  }
}

function synthCellsFromOcrRows(rows: string[], pageHeight: number): RawCell[] {
  const out: RawCell[] = [];
  const step = 12;
  let y = pageHeight - 20;
  for (const row of rows) {
    out.push({
      text: row,
      x: 10,
      y,
      width: Math.max(10, row.length * 6),
      height: 10,
      x0: 10,
      x1: 10 + Math.max(10, row.length * 6),
      y0: y - 5,
      y1: y + 5,
      dir: 'ltr',
      fontName: 'ocr'
    });
    y -= step;
  }
  return out;
}

function synthCellsFromAzureLines(lines: AzureLayoutLine[], pageHeight: number, pageWidth: number): RawCell[] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const out: RawCell[] = [];
  for (const line of sorted) {
    const text = String(line.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const rawY = toNum(line.y, 0);
    const sourceHeight = toNum(line.sourceHeight, 0);
    const rawX = toNum(line.x, 0);
    const rawWidth = toNum(line.width, 0);
    const sourceWidth = toNum(line.sourceWidth, 0);
    const scaledY = sourceHeight > 0
      ? pageHeight - clamp(rawY / sourceHeight, 0, 1) * pageHeight
      : pageHeight - rawY;
    const scaledX = sourceWidth > 0
      ? clamp(rawX / sourceWidth, 0, 1) * pageWidth
      : rawX;
    const scaledWidth = sourceWidth > 0
      ? clamp(rawWidth / sourceWidth, 0.001, 1) * pageWidth
      : Math.max(10, text.length * 6);
    const y = clamp(scaledY, 8, Math.max(8, pageHeight - 8));
    const x = clamp(scaledX, 4, Math.max(4, pageWidth - 12));
    const width = clamp(scaledWidth, 10, Math.max(10, pageWidth - x - 4));
    out.push({
      text,
      x,
      y,
      width,
      height: 10,
      x0: x,
      x1: x + width,
      y0: y - 5,
      y1: y + 5,
      dir: 'ltr',
      fontName: 'ocr'
    });
  }
  return out;
}

export async function extractRawPdfPayload(
  base64Pdf: string,
  maxPages = 0,
  page = 0,
  traceId = '',
  opts?: RawExtractOptions
): Promise<RawExtractPayload> {
  const pureBase64 = stripDataUrlPrefix(base64Pdf);
  const data = new Uint8Array(Buffer.from(pureBase64, 'base64'));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any);

  const pdf = await loadingTask.promise;
  const safePage = Math.max(0, Math.floor(toNum(page, 0)));
  const pageNumbers = safePage > 0
    ? [Math.min(Math.max(1, safePage), pdf.numPages)]
    : Array.from(
      { length: maxPages > 0 ? Math.min(pdf.numPages, maxPages) : pdf.numPages },
      (_, idx) => idx + 1
    );
  const processedPages = pageNumbers.length;
  const pages: RawPage[] = [];
  const mode = opts?.mode === 'robust' ? 'robust' : 'fast';
  const renderScale = clamp(toNum(opts?.renderScale, mode === 'robust' ? 2.2 : 1.4), 1.0, 3.2);
  const forceVision = opts?.force === true;
  const ocrVisionTimeoutMs = clamp(toNum(opts?.ocrVisionTimeoutMs, resolveOcrVisionTimeoutMs(mode)), 10000, 180000);
  const azureOnlyMode = resolveAzureOnlyMode();
  let effectiveAzureOnlyMode = azureOnlyMode;
  let azureDocPagesByNumber: Map<number, AzureLayoutLine[]> | null = null;
  if (resolveAzureLayoutEnabled()) {
    try {
      azureDocPagesByNumber = await azureAnalyzeLayoutFromPdfDocument(pureBase64, traceId, mode);
      if (azureDocPagesByNumber.size > 0) {
        console.log(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc layout ready pages=${azureDocPagesByNumber.size}`
        );
      }
    } catch (error: any) {
      const msg = String(error?.message || 'unknown');
      console.warn(
        `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure DI doc analyze failed: ${msg}`
      );
      if (effectiveAzureOnlyMode) {
        effectiveAzureOnlyMode = false;
        console.warn(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] Azure-only desactivado para esta corrida por falla en Azure doc analyze.`
        );
      }
    }
  }

  for (const pageNumber of pageNumbers) {
    const pageStartedAt = Date.now();
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    let cells = toRawCells((textContent as any).items || []);
    let pageOcrSource: RawPage['ocrSource'] = cells.length > 0 ? 'native-textlayer' : 'unknown';
    let pageClass: VisionPageClass = { pageClass: 'unknown', confidence: 0, reason: 'not_classified' };
    let baseVisionPng: string | null = null;
    let seededByAzure = false;
    console.log(
      `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} mode=${mode} nativeCells=${cells.length} forceVision=${forceVision} renderScale=${renderScale}`
    );

    const azureDocLines = azureDocPagesByNumber?.get(pageNumber) || [];
    if (azureDocLines.length > 0) {
      let azureCells = synthCellsFromAzureLines(azureDocLines, viewport.height, viewport.width);
      let azureRows = groupCellsIntoRows(azureCells, computeYTolerance(azureCells));
      if (azureRows.length <= 2 && azureDocLines.length >= 20) {
        const sequentialRows = azureDocLines.map((line) => String(line.content || '').trim()).filter((text) => text.length > 0);
        const sequentialCells = synthCellsFromOcrRows(sequentialRows, viewport.height);
        const sequentialGrouped = groupCellsIntoRows(sequentialCells, computeYTolerance(sequentialCells));
        if (sequentialGrouped.length > azureRows.length) {
          azureCells = sequentialCells;
          azureRows = sequentialGrouped;
          console.warn(
            `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} Azure DI doc y-normalized fallback -> sequential rows=${azureRows.length}`
          );
        }
      }
      if (azureRows.length > 0) {
        cells = azureCells;
        seededByAzure = true;
        pageOcrSource = 'azure-layout';
        console.log(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} using Azure DI doc rows=${azureRows.length}`
        );
      }
    }

    // Azure-first for all pages: fallback to per-page Azure call when doc cache has no rows for this page.
    if (!seededByAzure) {
      baseVisionPng = await renderPageToPngBase64(page, renderScale);
      const azureLinesFast = await azureAnalyzeLayoutFromPageImage(baseVisionPng, pageNumber, traceId, mode);
      if (azureLinesFast.length > 0) {
        const azureCells = synthCellsFromAzureLines(azureLinesFast, viewport.height, viewport.width);
        const azureRows = groupCellsIntoRows(azureCells, computeYTolerance(azureCells));
        if (azureRows.length > 0) {
          cells = azureCells;
          seededByAzure = true;
          pageOcrSource = 'azure-layout';
          console.log(
            `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} using Azure DI rows=${azureRows.length}`
          );
        }
      }
    }

    if (!seededByAzure && (cells.length === 0 || forceVision)) {
      if (!baseVisionPng) {
        baseVisionPng = await renderPageToPngBase64(page, renderScale);
      }
      if (!effectiveAzureOnlyMode) {
        const ocrRows = await visionOcrRowsFromImage(baseVisionPng, pageNumber, traceId, { mode, timeoutMs: ocrVisionTimeoutMs });
        if (ocrRows.length > 0) {
          cells = synthCellsFromOcrRows(ocrRows, viewport.height);
          pageOcrSource = 'openai-ocr';
        } else if (cells.length === 0) {
          console.warn(
            `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} mode=${mode} OCR vision returned 0 rows.`
          );
        }
      } else {
        console.warn(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} mode=${mode} Azure-only activo: se omite fallback OpenAI OCR.`
        );
      }
    }
    const yTolerance = computeYTolerance(cells);
    let rows = groupCellsIntoRows(cells, yTolerance);

    // Hard-page reinforcement: if OCR result is too sparse, run a second stronger pass.
    const weakRows = rows.filter((r) => String(r.text || '').trim().length > 0).length < 6;
    if (weakRows && (mode === 'robust' || forceVision)) {
      const boostedScale = clamp(Math.max(renderScale + 0.5, 2.6), 1.2, 3.2);
      const boostedPng = await renderPageToPngBase64(page, boostedScale);
      const azureLines = await azureAnalyzeLayoutFromPageImage(boostedPng, pageNumber, traceId, 'robust');
      if (azureLines.length > 0) {
        const azureRows = azureLines.map((line) => line.content).filter((t) => t.length > 0);
        const azureCells = synthCellsFromOcrRows(azureRows, viewport.height);
        const azureGrouped = groupCellsIntoRows(azureCells, computeYTolerance(azureCells));
        if (azureGrouped.length > rows.length) {
          cells = azureCells;
          rows = azureGrouped;
          baseVisionPng = boostedPng;
          pageOcrSource = 'azure-layout';
          console.log(
            `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} reinforced with Azure DI rows=${rows.length}`
          );
        }
      }
      if (!seededByAzure && !effectiveAzureOnlyMode) {
        const boostedRows = await visionOcrRowsFromImage(boostedPng, pageNumber, traceId, {
          mode: 'robust',
          timeoutMs: Math.max(ocrVisionTimeoutMs, 95000)
        });
        if (boostedRows.length > 0) {
          const boostedCells = synthCellsFromOcrRows(boostedRows, viewport.height);
          const boostedGrouped = groupCellsIntoRows(boostedCells, computeYTolerance(boostedCells));
          if (boostedGrouped.length > rows.length) {
            cells = boostedCells;
            rows = boostedGrouped;
            baseVisionPng = boostedPng;
            pageOcrSource = 'openai-ocr';
            console.log(
              `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} reinforced rows ${rows.length} (scale=${boostedScale})`
            );
          }
        }
      }
      if (!seededByAzure && effectiveAzureOnlyMode) {
        console.warn(
          `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} robust: Azure-only activo, sin fallback OpenAI OCR.`
        );
      }
    }
    if (!baseVisionPng && (mode === 'robust' || forceVision || rows.length === 0)) {
      baseVisionPng = await renderPageToPngBase64(page, Math.max(1.8, renderScale));
    }
    // Page classification is expensive; run only on robust/forced passes to avoid request 504 on fast mode.
    if (baseVisionPng && (mode === 'robust' || forceVision)) {
      pageClass = await classifyPageWithVision(baseVisionPng, pageNumber, traceId, {
        mode: mode === 'robust' ? 'robust' : 'fast',
        timeoutMs: Math.max(35000, Math.min(ocrVisionTimeoutMs, 90000))
      });
    }
    const pageText = rows.map((row) => row.text).join('\n');

    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      yTolerance,
      text: pageText,
      rows,
      items: cells,
      ocrSource: pageOcrSource || 'unknown',
      pageClass: pageClass.pageClass,
      pageClassConfidence: pageClass.confidence,
      pageClassReason: pageClass.reason
    });
    console.log(
      `[RAW_EXTRACT${traceId ? `][${traceId}` : ''}] page ${pageNumber}/${pdf.numPages} rows=${rows.length} cells=${cells.length} (${Date.now() - pageStartedAt}ms)`
    );
  }

  return {
    mode: 'RAW_PDF_1_1',
    sourceMimeType: 'application/pdf',
    totalPages: pdf.numPages,
    processedPages,
    fullText: pages.map((p) => `=== PAGE ${p.pageNumber} ===\n${p.text}`).join('\n\n'),
    pages
  };
}

export async function buildRawExtractAccount(base64Pdf: string, maxPages = 0): Promise<any> {
  return buildRawExtractAccountWithPage(base64Pdf, maxPages, 0, '', undefined);
}

export async function buildRawExtractAccountWithPage(
  base64Pdf: string,
  maxPages = 0,
  page = 0,
  traceId = '',
  opts?: RawExtractOptions
): Promise<any> {
  const payload = await extractRawPdfPayload(base64Pdf, maxPages, page, traceId, opts);
  const rawMetadataRows: Array<{ page: number; rowIndex: number; text: string; y: number }> = [];
  const typedRows: TypedStatementRow[] = payload.pages.flatMap((page) => buildTypedRowsFromPage(page));

  const sections = payload.pages.map((page) => ({
    category: `RAW PAGE ${page.pageNumber}`,
    items: (() => {
      const headers = detectColumnBands(page.rows);
      return page.rows.map((row) => {
        const activeHeader = findBestHeaderForRow(row, headers);
        if (!activeHeader) {
          rawMetadataRows.push({
            page: page.pageNumber,
            rowIndex: row.rowIndex,
            text: row.text,
            y: row.y
          });
          return {
            index: row.rowIndex,
            rawPage: page.pageNumber,
            description: row.text,
            quantity: 1,
            unitPrice: 0,
            total: 0,
            calculatedTotal: 0,
            hasCalculationError: false,
            rawY: row.y,
            rawCells: row.cells
          };
        }

        const split = splitRowByBands(row, activeHeader);
        const description = split.description || row.text;

        const qtyCell = pickNearestNumericCell(row.cells, activeHeader.cantLeft, activeHeader.cantLeft - 25, activeHeader.priceLeft + 8);
        const priceCell = pickNearestNumericCell(row.cells, activeHeader.priceLeft, activeHeader.priceLeft - 20, activeHeader.isaLeft - 5);
        const isaCell = pickNearestNumericCell(row.cells, activeHeader.isaLeft, activeHeader.isaLeft - 15, activeHeader.bonifLeft - 4);
        const bonifCell = pickNearestNumericCell(row.cells, activeHeader.bonifLeft, activeHeader.bonifLeft - 15, activeHeader.copagoLeft - 2);
        const copagoCell = pickNearestNumericCell(row.cells, activeHeader.copagoLeft, activeHeader.copagoLeft - 15, activeHeader.copagoLeft + 120);

        const quantity = parseQuantity(qtyCell?.text || split.quantityText) || 1;
        const unitPrice = parseMoneyFromFirstToken(priceCell?.text || split.priceText);
        const valorIsa = parseMoneyFromFirstToken(isaCell?.text || split.isaText);
        const bonificacion = parseMoneyFromFirstToken(bonifCell?.text || split.bonifText);
        const copago = parseMoneyFromFirstToken(copagoCell?.text || split.copagoText);
        const fallbackTailTotal = parseMoneyFromLastToken(row.text);
        const total = valorIsa > 0 ? valorIsa : 0;
        let resolvedTotal = total > 0 ? total : fallbackTailTotal;
        if (resolvedTotal > 0) {
          const descForCheck = split.description || row.text;
          const suspicious =
            isLikelyAdministrativeLine(descForCheck) ||
            isLikelySummaryOrCarryLine(descForCheck, row.text) ||
            resolvedTotal > MAX_REASONABLE_LINE_TOTAL;
          if (suspicious) resolvedTotal = 0;
        }
        const calculatedTotal = Math.round(quantity * unitPrice);
        const hasCalculationError =
          resolvedTotal > 0 && unitPrice > 0 && Math.abs(resolvedTotal - calculatedTotal) > Math.max(5, calculatedTotal * 0.03);

        const looksLikeDetailLine = row.cells.length >= 10 && (unitPrice > 0 || valorIsa > 0);
        const isOcrLine = row.cells.length === 1 && String(row.cells[0]?.fontName || '') === 'ocr';
        const ocrDetail = isOcrLine && isOcrCodeDetailLine(row.text);

        if ((!looksLikeDetailLine || !looksLikeBillDetailRow(row, description, unitPrice, resolvedTotal)) && !ocrDetail) {
          rawMetadataRows.push({
            page: page.pageNumber,
            rowIndex: row.rowIndex,
            text: row.text,
            y: row.y
          });
          return {
            index: row.rowIndex,
            rawPage: page.pageNumber,
            description: row.text,
            quantity: 1,
            unitPrice: 0,
            total: 0,
            calculatedTotal: 0,
            hasCalculationError: false,
            rawY: row.y,
            rawCells: row.cells
          };
        }

        return {
          index: row.rowIndex,
          rawPage: page.pageNumber,
          description: ocrDetail
            ? description.replace(/^CODIGO\s+\d{5,8}\s*/i, '').trim() || description
            : description,
          quantity,
          unitPrice,
          total: resolvedTotal,
          calculatedTotal: unitPrice > 0 ? calculatedTotal : total,
          hasCalculationError,
          valorIsa,
          bonificacion,
          copago,
          rawOcrDetail: ocrDetail,
          rawY: row.y,
          rawCells: row.cells
        };
      });
    })(),
    sectionTotal: 0,
    calculatedSectionTotal: 0,
    hasSectionError: false,
    isTaxConfusion: false,
    isUnjustifiedCharge: false
  })).map((section: any) => {
    const filteredItems = (section.items || []).filter((item: any) => isLikelyAuditableRawItem(item));
    const dedupedByKey = new Map<string, any>();
    for (const item of filteredItems) {
      const page = Number(item?.rawPage || 0);
      const total = Math.round(Number(item?.total || 0));
      const desc = String(item?.description || '');
      const key = `${page}|${canonicalDescriptionForDedup(desc)}|${total}`;
      const prev = dedupedByKey.get(key);
      if (!prev) {
        dedupedByKey.set(key, item);
        continue;
      }
      const prevLen = String(prev?.description || '').length;
      const currentLen = desc.length;
      if (currentLen > prevLen) dedupedByKey.set(key, item);
    }
    const dedupedItems = [...dedupedByKey.values()];
    const secTotal = Math.round((section.items || []).reduce((acc: number, item: any) => acc + (Number(item.total) || 0), 0));
    const secCalc = Math.round((section.items || []).reduce((acc: number, item: any) => acc + (Number(item.calculatedTotal) || 0), 0));
    return {
      ...section,
      items: dedupedItems,
      sectionTotal: secTotal,
      calculatedSectionTotal: secCalc,
      hasSectionError: Math.abs(secTotal - secCalc) > Math.max(10, secCalc * 0.03)
    };
  }).filter((section: any) => Array.isArray(section.items) && section.items.length > 0);

  // Rebuild categories in strict visual order using detected section headers.
  const sectionHeaderRows = typedRows
    .filter((r) => r.kind === 'section_header')
    .map((r) => ({ ...r, parsed: parseSectionHeader(r.text) }))
    .filter((r) => r.parsed !== null) as Array<TypedStatementRow & { parsed: { code: string; label: string } }>;

  if (sectionHeaderRows.length > 0) {
    const allItems = sections.flatMap((s: any) => s.items || []).sort((a: any, b: any) => a.rawY - b.rawY);
    const resectioned: any[] = [];
    const headersSorted = [...sectionHeaderRows].sort((a, b) => b.y - a.y);
    for (let i = 0; i < headersSorted.length; i++) {
      const current = headersSorted[i];
      const next = headersSorted[i + 1];
      const upperY = current.y;
      const lowerY = next ? next.y : -Infinity;
      const itemsForHeader = allItems.filter((it: any) => it.rawY < upperY && it.rawY > lowerY);
      if (!itemsForHeader.length) continue;
      const sectionTotal = Math.round(itemsForHeader.reduce((acc: number, it: any) => acc + (Number(it.total) || 0), 0));
      const calculatedSectionTotal = Math.round(itemsForHeader.reduce((acc: number, it: any) => acc + (Number(it.calculatedTotal) || 0), 0));
      resectioned.push({
        category: `${current.parsed.code} ${current.parsed.label}`,
        items: itemsForHeader.sort((a: any, b: any) => b.rawY - a.rawY),
        sectionTotal,
        calculatedSectionTotal,
        hasSectionError: Math.abs(sectionTotal - calculatedSectionTotal) > Math.max(10, calculatedSectionTotal * 0.03),
        isTaxConfusion: false,
        isUnjustifiedCharge: false
      });
    }
    if (resectioned.length > 0) {
      sections.length = 0;
      sections.push(...resectioned);
    }
  }

  // OCR fallback: when strict column parsing yields no bill items, rebuild from row pairs.
  if (sections.length === 0) {
    const ocrSections = buildSectionsFromOcrRows(payload);
    if (ocrSections.length > 0) {
      sections.push(...ocrSections);
    }
  }

  const totalItems = sections.reduce((acc: number, section: any) => acc + (section.items?.length || 0), 0);
  const extractedTotal = sections.reduce((acc: number, section: any) => acc + (section.sectionTotal || 0), 0);

  return {
    mode: payload.mode,
    clinicName: 'RAW_PDF_1_1',
    patientName: 'N/A',
    patientEmail: 'N/A',
    invoiceNumber: 'N/A',
    date: '',
    currency: 'CLP',
    sections,
    clinicStatedTotal: 0,
    extractedTotal,
    totalItems,
    isBalanced: true,
    discrepancy: 0,
    rawMetadataRows,
    rawTypedRows: typedRows,
    raw: payload
  };
}

export async function handleRawExtract(req: Request, res: Response) {
  const requestedTraceId = String(req.body?.traceId || '').trim();
  const traceId = requestedTraceId || `rx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  try {
    const { image, mimeType, maxPages, page, timeoutMs, mode, renderScale, force } = req.body || {};
    if (!image || !mimeType) {
      return res.status(400).json({ error: 'Missing image data or mimeType' });
    }
    if (mimeType !== 'application/pdf') {
      return res.status(400).json({ error: 'Raw extract 1:1 currently supports PDF only.' });
    }

    const parsedMaxPages = toNum(maxPages, 0);
    const parsedPage = toNum(page, 0);
    const parsedMode: 'fast' | 'robust' = String(mode || '').toLowerCase() === 'robust' ? 'robust' : 'fast';
    const parsedRenderScale = clamp(toNum(renderScale, parsedMode === 'robust' ? 2.2 : 1.8), 1.0, 3.2);
    const parsedForce = force === true || String(force || '').toLowerCase() === 'true';
    const requestTimeoutMs = resolveRequestTimeoutMs(toNum(timeoutMs, 0));
    const azureEnabled = resolveAzureLayoutEnabled();
    const azureOnly = resolveAzureOnlyMode();
    const ocrVisionTimeoutMs = clamp(
      Math.min(resolveOcrVisionTimeoutMs(parsedMode), Math.max(10000, requestTimeoutMs - 5000)),
      10000,
      180000
    );
    const approxBytes = Math.round((String(image).length * 3) / 4);
    console.log(
      `[RAW_EXTRACT][${traceId}] start page=${parsedPage || 'all'} maxPages=${parsedMaxPages || 'all'} mode=${parsedMode} scale=${parsedRenderScale} force=${parsedForce} azureEnabled=${azureEnabled} azureOnly=${azureOnly} ocrTimeoutMs=${ocrVisionTimeoutMs} bytes=${approxBytes} timeoutMs=${requestTimeoutMs}`
    );
    const data = await withTimeout(
      buildRawExtractAccountWithPage(image, parsedMaxPages, parsedPage, traceId, {
        mode: parsedMode,
        renderScale: parsedRenderScale,
        force: parsedForce,
        ocrVisionTimeoutMs
      }),
      requestTimeoutMs,
      `RAW extract trace=${traceId}`
    );
    console.log(
      `[RAW_EXTRACT][${traceId}] done sections=${Array.isArray(data?.sections) ? data.sections.length : 0} ` +
      `items=${Number(data?.totalItems || 0)} (${Date.now() - startedAt}ms)`
    );
    return res.json(data);
  } catch (error: any) {
    const message = String(error?.message || 'Raw extraction failed');
    const isTimeout = /timeout/i.test(message);
    console.error(`[RAW_EXTRACT][${traceId}] Error after ${Date.now() - startedAt}ms:`, error);
    return res.status(isTimeout ? 504 : 500).json({ error: message, traceId });
  }
}


