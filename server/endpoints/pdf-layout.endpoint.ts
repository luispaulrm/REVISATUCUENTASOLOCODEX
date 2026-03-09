import { Request, Response } from 'express';
import OpenAI from 'openai';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';

type LayoutOverlay = {
  id: string;
  kind: 'block' | 'cell';
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
  meta?: { row?: number; col?: number };
};

type LayoutResponse = {
  page: { w: number; h: number };
  overlays: LayoutOverlay[];
  confidence: number;
  notes: string;
};

let openAIClient: OpenAI | null = null;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LAYOUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: {
      type: 'object',
      additionalProperties: false,
      properties: {
        w: { type: 'number' },
        h: { type: 'number' }
      },
      required: ['w', 'h']
    },
    overlays: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['block', 'cell'] },
          bbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number', minimum: 0, maximum: 1 },
              y: { type: 'number', minimum: 0, maximum: 1 },
              w: { type: 'number', minimum: 0, maximum: 1 },
              h: { type: 'number', minimum: 0, maximum: 1 }
            },
            required: ['x', 'y', 'w', 'h']
          },
          text: { type: 'string' },
          meta: {
            type: 'object',
            additionalProperties: false,
            properties: {
              row: {
                anyOf: [
                  { type: 'number' },
                  { type: 'null' }
                ]
              },
              col: {
                anyOf: [
                  { type: 'number' },
                  { type: 'null' }
                ]
              }
            },
            required: ['row', 'col']
          }
        },
        required: ['id', 'kind', 'bbox', 'text', 'meta']
      }
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    notes: { type: 'string' }
  },
  required: ['page', 'overlays', 'confidence', 'notes']
};

function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;
  if (!openAIClient) {
    openAIClient = new OpenAI({ apiKey });
  }
  return openAIClient;
}

function getErrorStatus(error: any): number {
  if (typeof error?.status === 'number' && error.status >= 400) return error.status;
  if (typeof error?.statusCode === 'number' && error.statusCode >= 400) return error.statusCode;
  return 500;
}

function isRateLimitError(error: any): boolean {
  const status = getErrorStatus(error);
  if (status === 429) return true;
  const message = String(error?.message || '');
  return /rate\s*limit/i.test(message);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeLayout(raw: any, pageNumber: number, totalPages: number): LayoutResponse {
  const overlaysRaw = Array.isArray(raw?.overlays) ? raw.overlays : [];
  const overlays: LayoutOverlay[] = overlaysRaw
    .map((ov: any, index: number) => {
      const x = clamp01(Number(ov?.bbox?.x || 0));
      const y = clamp01(Number(ov?.bbox?.y || 0));
      const w = clamp01(Number(ov?.bbox?.w || 0));
      const h = clamp01(Number(ov?.bbox?.h || 0));
      const safeW = Math.min(w, 1 - x);
      const safeH = Math.min(h, 1 - y);

      return {
        id: String(ov?.id || `ov-${index + 1}`),
        kind: ov?.kind === 'cell' ? 'cell' : 'block',
        bbox: { x, y, w: safeW, h: safeH },
        text: typeof ov?.text === 'string' ? ov.text : '',
        meta: (() => {
          const row = typeof ov?.meta?.row === 'number' && Number.isFinite(ov.meta.row) ? ov.meta.row : undefined;
          const col = typeof ov?.meta?.col === 'number' && Number.isFinite(ov.meta.col) ? ov.meta.col : undefined;
          return row !== undefined || col !== undefined ? { row, col } : undefined;
        })()
      };
    })
    .filter((ov: LayoutOverlay) => ov.bbox.w > 0 && ov.bbox.h > 0);

  const confidence = Number.isFinite(Number(raw?.confidence)) ? clamp01(Number(raw.confidence)) : 0.5;
  const notesBase = typeof raw?.notes === 'string' ? raw.notes : '';

  return {
    page: { w: 1, h: 1 },
    overlays,
    confidence,
    notes: notesBase || `page=${pageNumber}/${totalPages}`
  };
}

function parseLayoutOutput(outputText: string, pageNumber: number, totalPages: number): LayoutResponse | null {
  if (!outputText) return null;
  try {
    const parsed = JSON.parse(stripCodeFences(outputText));
    return normalizeLayout(parsed, pageNumber, totalPages);
  } catch {
    return null;
  }
}

function layoutTextStats(layout: LayoutResponse): { nonEmptyCount: number; avgLen: number } {
  const texts = layout.overlays
    .map((ov) => String(ov?.text || '').trim())
    .filter((t) => t.length > 0);
  const totalLen = texts.reduce((acc, t) => acc + t.length, 0);
  return {
    nonEmptyCount: texts.length,
    avgLen: texts.length > 0 ? totalLen / texts.length : 0
  };
}

function shouldTryImageFallback(layout: LayoutResponse): boolean {
  const stats = layoutTextStats(layout);
  if (layout.confidence < 0.35) return true;
  if (stats.nonEmptyCount < 4) return true;
  if (stats.avgLen < 6) return true;
  return false;
}

function scoreLayout(layout: LayoutResponse): number {
  const stats = layoutTextStats(layout);
  const cellCount = layout.overlays.filter((ov) => ov.kind === 'cell').length;
  return stats.nonEmptyCount * 2 + stats.avgLen * 0.1 + cellCount * 0.05 + layout.confidence;
}

function isWeakLineLayout(layout: LayoutResponse | null): boolean {
  if (!layout) return true;
  const cells = layout.overlays.filter((ov) => ov.kind === 'cell');
  if (cells.length < 20) return true;
  const avgH = cells.reduce((acc, ov) => acc + ov.bbox.h, 0) / Math.max(1, cells.length);
  if (avgH > 0.06) return true;
  return false;
}

function stripCodeFences(text: string): string {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchPdfBuffer(pdfUrl: string): Promise<Buffer> {
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`No se pudo descargar PDF (${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function toPureBase64(input: string): string {
  const marker = 'base64,';
  const idx = input.indexOf(marker);
  if (idx >= 0) return input.slice(idx + marker.length);
  return input;
}

async function getPdfMetrics(pdfBuffer: Buffer, requestedPage: number): Promise<{ page: number; totalPages: number }> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any);

  const pdf = await loadingTask.promise;
  const safePage = Math.min(Math.max(1, requestedPage), pdf.numPages);

  return {
    page: safePage,
    totalPages: pdf.numPages
  };
}

async function extractNativeLayoutFromPdfBuffer(pdfBuffer: Buffer, requestedPage: number): Promise<LayoutResponse | null> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any);

  const pdf = await loadingTask.promise;
  const safePage = Math.min(Math.max(1, requestedPage), pdf.numPages);
  const page = await pdf.getPage(safePage);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const rawItems = Array.isArray((tc as any)?.items) ? (tc as any).items : [];

  type NativeRow = { y: number; x0: number; y0: number; x1: number; y1: number; texts: string[] };
  const yTol = 4;
  const rows: NativeRow[] = [];

  for (const item of rawItems) {
    const text = String(item?.str || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tr = Array.isArray(item?.transform) ? item.transform : [];
    if (tr.length < 6) continue;
    const x = Number(tr[4] || 0);
    const y = Number(tr[5] || 0);
    const w = Math.max(1, Number(item?.width || 8));
    const h = Math.max(1, Number(item?.height || 8));
    const top = viewport.height - y - h;
    const bottom = top + h;
    const centerY = (top + bottom) / 2;

    let row = rows.find((r) => Math.abs(r.y - centerY) <= yTol);
    if (!row) {
      row = { y: centerY, x0: x, y0: top, x1: x + w, y1: bottom, texts: [] };
      rows.push(row);
    } else {
      row.x0 = Math.min(row.x0, x);
      row.y0 = Math.min(row.y0, top);
      row.x1 = Math.max(row.x1, x + w);
      row.y1 = Math.max(row.y1, bottom);
    }
    row.texts.push(text);
  }

  if (rows.length === 0) return null;

  const sortedRows = rows.sort((a, b) => a.y0 - b.y0);
  const overlays: LayoutOverlay[] = sortedRows.map((row, idx) => {
    const text = row.texts.join(' ').replace(/\s+/g, ' ').trim();
    const x = clamp01(row.x0 / Math.max(1, viewport.width));
    const y = clamp01(row.y0 / Math.max(1, viewport.height));
    const x1 = clamp01(row.x1 / Math.max(1, viewport.width));
    const y1 = clamp01(row.y1 / Math.max(1, viewport.height));
    return {
      id: `native-row-${idx + 1}`,
      kind: 'cell',
      bbox: {
        x,
        y,
        w: Math.max(0, x1 - x),
        h: Math.max(0, y1 - y)
      },
      text,
      meta: { row: idx, col: 0 }
    };
  }).filter((ov) => ov.text && ov.bbox.w > 0 && ov.bbox.h > 0);

  if (overlays.length === 0) return null;

  return {
    page: { w: 1, h: 1 },
    overlays,
    confidence: overlays.length >= 12 ? 0.85 : 0.7,
    notes: `native_pdf_text_rows=${overlays.length}`
  };
}

async function renderPdfPageToPngBase64(
  pdfBuffer: Buffer,
  requestedPage: number
): Promise<{ page: number; totalPages: number; imageBase64: string }> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: true,
    disableWorker: true,
    verbosity: 0
  } as any);

  const pdf = await loadingTask.promise;
  const safePage = Math.min(Math.max(1, requestedPage), pdf.numPages);
  const page = await pdf.getPage(safePage);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');

  await page.render({
    canvasContext: context as any,
    viewport
  } as any).promise;

  const dataUrl = canvas.toDataURL('image/png');
  const imageBase64 = dataUrl.split(',')[1] || '';

  return {
    page: safePage,
    totalPages: pdf.numPages,
    imageBase64
  };
}

async function cropPngBase64ByYWindow(
  imageBase64: string,
  yTopNorm: number,
  yBottomNorm: number
): Promise<{ imageBase64: string; yTopNorm: number; yHeightNorm: number }> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const src = await loadImage(Buffer.from(imageBase64, 'base64'));
  const w = src.width;
  const h = src.height;
  const top = Math.max(0, Math.min(h - 1, Math.floor(h * yTopNorm)));
  const bottom = Math.max(top + 1, Math.min(h, Math.floor(h * yBottomNorm)));
  const ch = bottom - top;
  const canvas = createCanvas(w, ch);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src as any, 0, top, w, ch, 0, 0, w, ch);
  const dataUrl = canvas.toDataURL('image/png');
  const croppedBase64 = dataUrl.split(',')[1] || '';
  return { imageBase64: croppedBase64, yTopNorm: top / h, yHeightNorm: ch / h };
}

async function detectHeuristicRowLayoutFromImage(
  imageBase64: string,
  pageNumber: number,
  totalPages: number
): Promise<LayoutResponse | null> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(Buffer.from(imageBase64, 'base64'));
  const width = img.width;
  const height = img.height;
  if (!width || !height) return null;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img as any, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const left = Math.max(0, Math.floor(width * 0.05));
  const right = Math.min(width - 1, Math.floor(width * 0.95));
  const stepX = 2;
  const densities: number[] = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    let dark = 0;
    let total = 0;
    for (let x = left; x <= right; x += stepX) {
      const idx = (y * width + x) * 4;
      const a = pixels[idx + 3];
      if (a < 5) continue;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 170) dark++;
      total++;
    }
    densities[y] = total > 0 ? dark / total : 0;
  }

  const smooth: number[] = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let k = -2; k <= 2; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < height) {
        sum += densities[yy];
        count++;
      }
    }
    smooth[y] = count > 0 ? sum / count : 0;
  }

  const mean = smooth.reduce((acc, v) => acc + v, 0) / Math.max(1, smooth.length);
  const variance = smooth.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / Math.max(1, smooth.length);
  const std = Math.sqrt(variance);
  const threshold = Math.max(mean + std * 0.85, 0.012);

  const bands: Array<{ y0: number; y1: number }> = [];
  let start = -1;
  for (let y = 0; y < height; y++) {
    const active = smooth[y] >= threshold;
    if (active && start < 0) start = y;
    if (!active && start >= 0) {
      bands.push({ y0: start, y1: y - 1 });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: height - 1 });

  if (bands.length === 0) return null;

  const merged: Array<{ y0: number; y1: number }> = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 <= 2) {
      last.y1 = b.y1;
    } else {
      merged.push({ ...b });
    }
  }

  const filtered = merged
    .filter((b) => b.y1 - b.y0 + 1 >= 3)
    .filter((b) => b.y1 - b.y0 + 1 <= Math.max(80, Math.floor(height * 0.08)));

  if (filtered.length < 6) return null;

  const overlays: LayoutOverlay[] = filtered.slice(0, 260).map((b, idx) => ({
    id: `heur-row-${idx + 1}`,
    kind: 'cell',
    bbox: {
      x: clamp01(left / width),
      y: clamp01(b.y0 / height),
      w: clamp01((right - left) / width),
      h: clamp01((b.y1 - b.y0 + 1) / height)
    },
    text: '',
    meta: { row: idx, col: 0 }
  }));

  return {
    page: { w: 1, h: 1 },
    overlays,
    confidence: 0.45,
    notes: `heuristic_rows=${overlays.length}; page=${pageNumber}/${totalPages}`
  };
}

function remapLayoutFromYCrop(
  cropped: LayoutResponse,
  yTopNorm: number,
  yHeightNorm: number,
  pageNumber: number,
  totalPages: number
): LayoutResponse {
  const overlays = cropped.overlays.map((ov, idx) => {
    const y = clamp01(yTopNorm + ov.bbox.y * yHeightNorm);
    const h = clamp01(ov.bbox.h * yHeightNorm);
    const safeH = Math.min(h, 1 - y);
    return {
      ...ov,
      id: `${ov.id || `crop-${idx + 1}`}-remap`,
      bbox: { ...ov.bbox, y, h: safeH }
    };
  }).filter((ov) => ov.bbox.w > 0 && ov.bbox.h > 0);

  return {
    page: { w: 1, h: 1 },
    overlays,
    confidence: clamp01(cropped.confidence),
    notes: cropped.notes || `crop_remap_page=${pageNumber}/${totalPages}`
  };
}

async function callOpenAIWithFile(
  client: OpenAI,
  model: string,
  prompt: string,
  pdfBuffer: Buffer,
  maxOutputTokens: number = 8000
): Promise<string> {
  const response = await retryWithBackoff(
    async () => client.responses.create({
      model,
      temperature: 0,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt
            },
            {
              type: 'input_file',
              filename: 'clinical-bill.pdf',
              file_data: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'pdf_layout',
          strict: true,
          schema: LAYOUT_JSON_SCHEMA
        }
      }
    } as any),
    {
      maxRetries: 1,
      initialDelay: 2500,
      maxDelay: 5000
    }
  );

  return String((response as any)?.output_text || '').trim();
}

async function callOpenAIWithImage(
  client: OpenAI,
  model: string,
  prompt: string,
  imageBase64: string,
  maxOutputTokens: number = 8000
): Promise<string> {
  const response = await retryWithBackoff(
    async () => client.responses.create({
      model,
      temperature: 0,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `${prompt} The PDF was rasterized to image for this call.`
            },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${imageBase64}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'pdf_layout',
          strict: true,
          schema: LAYOUT_JSON_SCHEMA
        }
      }
    } as any),
    {
      maxRetries: 1,
      initialDelay: 2500,
      maxDelay: 5000
    }
  );

  return String((response as any)?.output_text || '').trim();
}

async function inferLayoutFromPdfBuffer(pdfBuffer: Buffer, requestedPage: number): Promise<LayoutResponse> {
  const metrics = await getPdfMetrics(pdfBuffer, requestedPage);
  const nativeLayout = await extractNativeLayoutFromPdfBuffer(pdfBuffer, metrics.page);
  if (nativeLayout && nativeLayout.overlays.length > 0) {
    return nativeLayout;
  }

  const client = getOpenAIClient();
  if (!client) {
    throw new HttpError(503, 'OPENAI_API_KEY no configurada.');
  }
  const model = process.env.OPENAI_LAYOUT_MODEL || 'gpt-4o-mini';

  const enableFileFallback = process.env.OPENAI_LAYOUT_ENABLE_FILE_FALLBACK === 'true';
  const prompt = [
    `Analyze ONLY page ${metrics.page} of this clinical bill PDF.`,
    'Return strict JSON with normalized bboxes (0..1).',
    'Do not invent text. If unreadable, set text="" and lower confidence.',
    'Detect visual billing blocks and optional table-like cells for audit overlays.',
    'Meta row/col is optional and only when clearly inferable.'
  ].join(' ');
  const imagePrompt = [
    `Analyze ONLY page ${metrics.page} of this clinical bill image.`,
    'Return strict JSON with normalized bboxes (0..1).',
    'Prioritize OCR: include text exactly as seen in the image.',
    'Create many cell overlays for visible row-like text (avoid only giant generic blocks).',
    'Do not return only metadata/header rows. Include billing detail rows from the table body.',
    'If unreadable keep text="" and reduce confidence.'
  ].join(' ');
  const lineAuditPrompt = [
    `Extract line-by-line overlays for page ${metrics.page} of this clinical bill image.`,
    'Focus on the billing table rows (Codigo/Descripcion/Fecha/Cant/V.Unit/Total).',
    'Return one overlay per visible row in the table body.',
    'Include as many rows as possible so the result is auditable per line.',
    'Avoid giant blocks and prefer narrow horizontal row boxes.',
    'Return strict JSON with normalized bboxes (0..1).'
  ].join(' ');

  // For scanned PDFs (no native text), image-first is usually faster and more useful than file-level OCR.
  let imageError: any = null;
  let bestImageLayout: LayoutResponse | null = null;
  let rasterizedForHeuristic: { page: number; totalPages: number; imageBase64: string } | null = null;
  try {
    const rasterized = await renderPdfPageToPngBase64(pdfBuffer, metrics.page);
    rasterizedForHeuristic = rasterized;
    const imageOutputText = await callOpenAIWithImage(client, model, imagePrompt, rasterized.imageBase64, 4000);
    let imageLayout = parseLayoutOutput(imageOutputText, metrics.page, metrics.totalPages);
    if (imageLayout && imageLayout.overlays.length > 0) {
      bestImageLayout = imageLayout;
    }
    if (isWeakLineLayout(imageLayout)) {
      const cropped = await cropPngBase64ByYWindow(rasterized.imageBase64, 0.34, 0.98);
      const secondPassOutput = await callOpenAIWithImage(client, model, lineAuditPrompt, cropped.imageBase64, 6000);
      const secondPassLayoutCropped = parseLayoutOutput(secondPassOutput, metrics.page, metrics.totalPages);
      const secondPassLayout = secondPassLayoutCropped
        ? remapLayoutFromYCrop(secondPassLayoutCropped, cropped.yTopNorm, cropped.yHeightNorm, metrics.page, metrics.totalPages)
        : null;
      if (secondPassLayout && secondPassLayout.overlays.length > 0) {
        bestImageLayout = secondPassLayout;
      }
      if (secondPassLayout && scoreLayout(secondPassLayout) >= scoreLayout(imageLayout || secondPassLayout)) {
        imageLayout = secondPassLayout;
      }
    }
    if (imageLayout && imageLayout.overlays.length > 0 && !isWeakLineLayout(imageLayout)) {
      return imageLayout;
    }
    imageError = new Error('image_layout_weak');
  } catch (err: any) {
    imageError = err;
  }

  let fileOutputText = '';
  let fileError: any = null;
  let fileLayout: LayoutResponse | null = null;
  // File fallback can be expensive in TPM; keep it opt-in.
  if (enableFileFallback && !isRateLimitError(imageError)) {
    try {
      fileOutputText = await callOpenAIWithFile(client, model, prompt, pdfBuffer, 6000);
      fileLayout = parseLayoutOutput(fileOutputText, metrics.page, metrics.totalPages);
    } catch (err: any) {
      fileError = err;
    }
  }

  if (fileLayout && fileLayout.overlays.length > 0) {
    return fileLayout;
  }

  let heuristicLayout: LayoutResponse | null = null;
  if (rasterizedForHeuristic) {
    try {
      heuristicLayout = await detectHeuristicRowLayoutFromImage(
        rasterizedForHeuristic.imageBase64,
        metrics.page,
        metrics.totalPages
      );
    } catch {
      // no-op: preserve original OpenAI errors below
    }
  }

  if (heuristicLayout && heuristicLayout.overlays.length > 0 && bestImageLayout && bestImageLayout.overlays.length > 0) {
    return heuristicLayout.overlays.length >= bestImageLayout.overlays.length ? heuristicLayout : bestImageLayout;
  }
  if (heuristicLayout && heuristicLayout.overlays.length > 0) {
    return heuristicLayout;
  }
  if (bestImageLayout && bestImageLayout.overlays.length > 0) {
    return bestImageLayout;
  }

  if (!fileOutputText && enableFileFallback) {
    const fileMsg = fileError?.message ? `file_call=${fileError.message}` : 'file_call=skipped_or_unknown';
    const imageMsg = imageError?.message ? `image_call=${imageError.message}` : 'image_call=unknown_error';
    const status = Math.max(getErrorStatus(fileError), getErrorStatus(imageError));
    throw new HttpError(status >= 400 ? status : 500, `No se pudo obtener layout OpenAI (${fileMsg}; ${imageMsg}).`);
  }

  return {
    page: { w: 1, h: 1 },
    overlays: [],
    confidence: 0,
    notes: 'No se pudo parsear JSON de layout OpenAI.'
  };
}

export async function handlePdfLayoutGet(req: Request, res: Response) {
  try {
    const pdfUrl = String(req.query.pdfUrl || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));

    if (!pdfUrl || !isHttpUrl(pdfUrl)) {
      res.status(400).json({
        error: 'Parametro pdfUrl invalido. Debe ser URL http/https alcanzable por backend.'
      });
      return;
    }

    const pdfBuffer = await fetchPdfBuffer(pdfUrl);
    const layout = await inferLayoutFromPdfBuffer(pdfBuffer, page);
    res.json(layout);
  } catch (error: any) {
    console.error('[pdf-layout:get] Error:', error);
    res.status(getErrorStatus(error)).json({ error: error?.message || 'Internal Server Error' });
  }
}

export async function handlePdfLayoutPost(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.body?.page || 1));
    const pdfBase64 = String(req.body?.pdfBase64 || '').trim();

    if (!pdfBase64) {
      res.status(400).json({ error: 'Parametro pdfBase64 requerido.' });
      return;
    }

    const pureBase64 = toPureBase64(pdfBase64);
    const pdfBuffer = Buffer.from(pureBase64, 'base64');
    const layout = await inferLayoutFromPdfBuffer(pdfBuffer, page);
    res.json(layout);
  } catch (error: any) {
    console.error('[pdf-layout:post] Error:', error);
    res.status(getErrorStatus(error)).json({ error: error?.message || 'Internal Server Error' });
  }
}
