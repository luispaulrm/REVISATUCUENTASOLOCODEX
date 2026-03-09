import React, { useEffect, useMemo, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

(pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorker;

const PDFJS_STANDARD_FONT_DATA_URL = '/pdfjs/standard_fonts/';
const PDFJS_LOADING_OPTIONS = {
  standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
  useSystemFonts: false,
  verbosity: (pdfjsLib as any).VerbosityLevel.ERRORS
} as const;

export type OverlayMode = 'items' | 'rows';

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayEntry {
  id: string;
  page: number;
  text: string;
  bbox: BoundingBox;
  source?: 'native' | 'fallback';
}

export interface TextClickPayload {
  text: string;
  bboxPx: BoundingBox;
  page: number;
  pageWidth?: number;
  pageHeight?: number;
  id: string;
  mode: OverlayMode;
}

interface PdfCalcoPageProps {
  pdfUrl: string;
  pageNumber?: number;
  scale?: number;
  overlayMode?: OverlayMode;
  analyzeAllPages?: boolean;
  useOpenAIFallback?: boolean;
  onTextClick?: (payload: TextClickPayload) => void;
  onRowsChange?: (rows: OverlayEntry[]) => void;
  onTextLayerChange?: (hasTextLayer: boolean) => void;
  onDocMeta?: (meta: { numPages: number }) => void;
}

interface FallbackOverlay {
  id: string;
  kind: 'block' | 'cell';
  bbox: BoundingBox; // normalized 0..1 from backend
  text?: string;
}

interface FallbackLayoutResponse {
  page: { w: number; h: number };
  overlays: FallbackOverlay[];
  confidence: number;
  notes: string;
}

interface PageView {
  page: number;
  width: number;
  height: number;
  imageDataUrl: string;
}

const fallbackCache = new Map<string, FallbackLayoutResponse>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeBbox(bbox: BoundingBox, width: number, height: number): BoundingBox {
  const x = clamp(bbox.x, 0, width);
  const y = clamp(bbox.y, 0, height);
  const maxW = Math.max(0, width - x);
  const maxH = Math.max(0, height - y);
  return {
    x,
    y,
    w: clamp(bbox.w, 0, maxW),
    h: clamp(bbox.h, 0, maxH)
  };
}

function mergeBbox(a: BoundingBox, b: BoundingBox): BoundingBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0
  };
}

function detectHeuristicRowsFromImageData(
  imageData: ImageData,
  width: number,
  height: number,
  page: number
): OverlayEntry[] {
  const data = imageData.data;
  const left = Math.max(0, Math.floor(width * 0.05));
  const right = Math.min(width - 1, Math.floor(width * 0.95));
  const stepX = 2;
  const density: number[] = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    let dark = 0;
    let total = 0;
    for (let x = left; x <= right; x += stepX) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a < 5) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 170) dark++;
      total++;
    }
    density[y] = total > 0 ? dark / total : 0;
  }

  const smooth: number[] = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let k = -2; k <= 2; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < height) {
        sum += density[yy];
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

  const merged: Array<{ y0: number; y1: number }> = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 <= 2) last.y1 = b.y1;
    else merged.push({ ...b });
  }

  const filtered = merged
    .filter((b) => b.y1 - b.y0 + 1 >= 3)
    .filter((b) => b.y1 - b.y0 + 1 <= Math.max(80, Math.floor(height * 0.08)));

  if (filtered.length < 6) return [];

  return filtered.slice(0, 260).map((b, idx) => ({
    id: `heur-row-${page}-${idx + 1}`,
    page,
    text: '',
    bbox: normalizeBbox(
      {
        x: left,
        y: b.y0,
        w: right - left,
        h: b.y1 - b.y0 + 1
      },
      width,
      height
    ),
    source: 'fallback'
  }));
}

function buildItemOverlays(textItems: any[], viewport: any, page: number): OverlayEntry[] {
  const viewScale = Number(viewport?.scale || 1);
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);

  return textItems
    .filter((item: any) => typeof item?.str === 'string' && item.str.trim().length > 0)
    .map((item: any, idx: number) => {
      const transform = (pdfjsLib as any).Util.transform(viewport.transform, item.transform);
      const itemWidth = Math.max(1, Number(item.width || 0) * viewScale);
      const fontHeight = Math.max(
        1,
        Math.hypot(Number(transform[2] || 0), Number(transform[3] || 0)) || Math.abs(Number(item.height || 0) * viewScale) || 8
      );

      const bbox = normalizeBbox(
        {
          x: Number(transform[4] || 0),
          y: Number(transform[5] || 0) - fontHeight,
          w: itemWidth,
          h: fontHeight
        },
        width,
        height
      );

      return {
        id: `item-${page}-${idx + 1}`,
        page,
        text: String(item.str || '').trim(),
        bbox,
        source: 'native' as const
      } as OverlayEntry;
    })
    .filter((item) => item.bbox.w > 0 && item.bbox.h > 0);
}

export function buildRowsFromItems(items: OverlayEntry[], page: number, yTolerancePx = 4): OverlayEntry[] {
  type Bucket = {
    yCenter: number;
    items: OverlayEntry[];
  };

  const sortedByY = [...items].sort((a, b) => a.bbox.y - b.bbox.y);
  const buckets: Bucket[] = [];

  for (const item of sortedByY) {
    const centerY = item.bbox.y + item.bbox.h / 2;
    let bucket = buckets.find((candidate) => Math.abs(candidate.yCenter - centerY) <= yTolerancePx);

    if (!bucket) {
      bucket = { yCenter: centerY, items: [] };
      buckets.push(bucket);
    }

    bucket.items.push(item);
    const centers = bucket.items.map((entry) => entry.bbox.y + entry.bbox.h / 2);
    bucket.yCenter = centers.reduce((acc, y) => acc + y, 0) / Math.max(1, centers.length);
  }

  return buckets
    .map((bucket, idx) => {
      const ordered = [...bucket.items].sort((a, b) => a.bbox.x - b.bbox.x);
      const text = ordered.map((entry) => entry.text).join(' ').replace(/\s+/g, ' ').trim();
      const bbox = ordered.reduce((acc, entry) => mergeBbox(acc, entry.bbox), ordered[0].bbox);

      return {
        id: `row-${page}-${idx + 1}`,
        page,
        text,
        bbox,
        source: ordered.some((it) => it.source === 'fallback') ? 'fallback' : 'native'
      } as OverlayEntry;
    })
    .sort((a, b) => a.bbox.y - b.bbox.y);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const marker = 'base64,';
      const idx = value.indexOf(marker);
      if (idx < 0) {
        reject(new Error('No se pudo convertir Blob a base64.'));
        return;
      }
      resolve(value.slice(idx + marker.length));
    };
    reader.onerror = () => reject(reader.error || new Error('Error leyendo Blob.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchFallbackLayout(
  pdfUrl: string,
  pageNumber: number,
  scale: number
): Promise<{ layout: FallbackLayoutResponse | null; error?: string }> {
  const cacheKey = `${pdfUrl}|${pageNumber}|${scale}|layout-v3`;
  const cached = fallbackCache.get(cacheKey);
  if (cached) return { layout: cached };

  const isHttp = pdfUrl.startsWith('http://') || pdfUrl.startsWith('https://');
  const isBlob = pdfUrl.startsWith('blob:');
  const isDataPdf = pdfUrl.startsWith('data:application/pdf;base64,');

  const controller = new AbortController();
  const timeoutMs = 240000;
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  if (isHttp) {
    try {
      response = await fetch(`/api/pdf-layout?pdfUrl=${encodeURIComponent(pdfUrl)}&page=${pageNumber}`, {
        signal: controller.signal
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { layout: null, error: `Fallback timeout (${Math.round(timeoutMs / 1000)}s).` };
      }
      return { layout: null, error: `Error de red en fallback: ${error?.message || 'desconocido'}` };
    } finally {
      window.clearTimeout(timeoutId);
    }
  } else if (isBlob || isDataPdf) {
    let pdfBase64 = '';
    if (isDataPdf) {
      pdfBase64 = pdfUrl.split('base64,')[1] || '';
    } else {
      const blobResponse = await fetch(pdfUrl);
      if (!blobResponse.ok) {
        return { layout: null, error: `No se pudo leer blob local (${blobResponse.status}).` };
      }
      const blob = await blobResponse.blob();
      pdfBase64 = await blobToBase64(blob);
    }

    if (!pdfBase64) return { layout: null, error: 'Blob local vacio al convertir a base64.' };
    try {
      response = await fetch('/api/pdf-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64, page: pageNumber }),
        signal: controller.signal
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { layout: null, error: `Fallback timeout (${Math.round(timeoutMs / 1000)}s).` };
      }
      return { layout: null, error: `Error de red en fallback: ${error?.message || 'desconocido'}` };
    } finally {
      window.clearTimeout(timeoutId);
    }
  } else {
    window.clearTimeout(timeoutId);
    return { layout: null, error: 'Fuente PDF no soportada para fallback.' };
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      if (body?.error) detail = String(body.error);
    } catch {
      // no-op
    }
    return {
      layout: null,
      error: `Fallback HTTP ${response.status}${detail ? `: ${detail}` : ''}`
    };
  }

  const data = (await response.json()) as FallbackLayoutResponse;
  const overlayCount = Array.isArray(data?.overlays) ? data.overlays.length : 0;
  if (overlayCount <= 0) {
    return { layout: data, error: 'Fallback devolvio 0 overlays; se omitio cache para permitir reintentos.' };
  }
  fallbackCache.set(cacheKey, data);
  return { layout: data };
}

function fallbackToEntries(
  layout: FallbackLayoutResponse,
  canvasWidth: number,
  canvasHeight: number,
  pageNumber: number,
  overlayMode: OverlayMode
): OverlayEntry[] {
  const overlays = Array.isArray(layout?.overlays) ? layout.overlays : [];
  const relevant = (() => {
    if (overlayMode !== 'rows') return overlays;
    const blocks = overlays.filter((o) => o.kind === 'block');
    const cells = overlays.filter((o) => o.kind === 'cell');
    // For line-by-line audit we prefer whichever family yields more granular rows.
    if (cells.length >= blocks.length && cells.length > 0) return cells;
    if (blocks.length > 0) return blocks;
    return overlays;
  })();

  return relevant
    .map((overlay, idx) => {
      const bbox = normalizeBbox(
        {
          x: Number(overlay?.bbox?.x || 0) * canvasWidth,
          y: Number(overlay?.bbox?.y || 0) * canvasHeight,
          w: Number(overlay?.bbox?.w || 0) * canvasWidth,
          h: Number(overlay?.bbox?.h || 0) * canvasHeight
        },
        canvasWidth,
        canvasHeight
      );

      return {
        id: overlay?.id || `fb-${pageNumber}-${idx + 1}`,
        page: pageNumber,
        text: String(overlay?.text || ''),
        bbox,
        source: 'fallback' as const
      } as OverlayEntry;
    })
    .filter((entry) => entry.bbox.w > 0 && entry.bbox.h > 0);
}

const PdfCalcoPage: React.FC<PdfCalcoPageProps> = ({
  pdfUrl,
  pageNumber = 1,
  scale = 1.5,
  overlayMode = 'rows',
  analyzeAllPages = false,
  useOpenAIFallback = false,
  onTextClick,
  onRowsChange,
  onTextLayerChange,
  onDocMeta
}) => {
  const [pageViews, setPageViews] = useState<PageView[]>([]);
  const [items, setItems] = useState<OverlayEntry[]>([]);
  const [rows, setRows] = useState<OverlayEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfUrl) {
      setPageViews([]);
      setItems([]);
      setRows([]);
      setSelectedId(null);
      setError(null);
      setIsLoading(false);
      onRowsChange?.([]);
      onTextLayerChange?.(false);
      onDocMeta?.({ numPages: 0 });
      return;
    }

    let cancelled = false;

    async function renderPdf(): Promise<void> {
      setIsLoading(true);
      setError(null);
      setSelectedId(null);

      try {
        const loadingTask = (pdfjsLib as any).getDocument({
          url: pdfUrl,
          ...PDFJS_LOADING_OPTIONS
        });
        const pdf = await loadingTask.promise;
        onDocMeta?.({ numPages: Number(pdf?.numPages || 0) });
        const safePageNumber = Math.min(Math.max(1, pageNumber), pdf.numPages);
        const pagesToProcess = analyzeAllPages
          ? Array.from({ length: pdf.numPages }, (_, idx) => idx + 1)
          : [safePageNumber];

        const pageResults: PageView[] = [];
        const collectedItems: OverlayEntry[] = [];
        const collectedRows: OverlayEntry[] = [];
        let hasTextLayer = false;

        for (const targetPage of pagesToProcess) {
          const page = await pdf.getPage(targetPage);
          const viewport = page.getViewport({ scale });

          const renderCanvas = document.createElement('canvas');
          const renderCtx = renderCanvas.getContext('2d');
          if (!renderCtx) throw new Error('No se pudo obtener contexto 2D para renderizado PDF.');

          renderCanvas.width = Math.ceil(viewport.width);
          renderCanvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: renderCtx, viewport } as any).promise;

          pageResults.push({
            page: targetPage,
            width: viewport.width,
            height: viewport.height,
            imageDataUrl: renderCanvas.toDataURL('image/png')
          });

          const textContent = await page.getTextContent();
          const textItems = (textContent.items || []).filter((item: any) => typeof item?.str === 'string' && item.str.trim().length > 0);
          if (textItems.length > 0) hasTextLayer = true;

          const pageItems = buildItemOverlays(textItems, viewport, targetPage);
          const pageRows = buildRowsFromItems(pageItems, targetPage, 4);
          collectedItems.push(...pageItems);
          if (pageRows.length > 0) {
            collectedRows.push(...pageRows);
          } else if (overlayMode === 'rows') {
            // Local visual fallback so scanned PDFs become auditable immediately,
            // even when OpenAI fallback is disabled.
            const pixelData = renderCtx.getImageData(0, 0, renderCanvas.width, renderCanvas.height);
            const heuristicRows = detectHeuristicRowsFromImageData(pixelData, renderCanvas.width, renderCanvas.height, targetPage);
            collectedRows.push(...heuristicRows);
          }
        }

        if (cancelled) return;
        // Render inmediato del PDF (y cualquier text-layer nativo) sin esperar fallback remoto.
        setPageViews(pageResults);
        setItems(collectedItems);
        setRows(collectedRows);
        onRowsChange?.(collectedRows);
        onTextLayerChange?.(hasTextLayer);
        setIsLoading(false);

        // OpenAI fallback is single-page only to avoid multi-page API cost.
        if (!hasTextLayer && useOpenAIFallback && !analyzeAllPages) {
          const metricByPage = new Map<number, { width: number; height: number }>();
          pageResults.forEach((p) => metricByPage.set(p.page, { width: p.width, height: p.height }));

          const fallbackPages = [safePageNumber];

          for (const targetPage of fallbackPages) {
            const fallbackResult = await fetchFallbackLayout(pdfUrl, targetPage, scale);
            if (fallbackResult.error) {
              setError(fallbackResult.error);
              continue;
            }
            if (!fallbackResult.layout) continue;

            const metric = metricByPage.get(targetPage);
            if (!metric) continue;

            const fallbackEntries = fallbackToEntries(
              fallbackResult.layout,
              metric.width,
              metric.height,
              targetPage,
              overlayMode
            );

            if (overlayMode === 'rows') {
              collectedRows.push(...fallbackEntries);
            } else {
              collectedItems.push(...fallbackEntries);
            }
          }

          if (cancelled) return;
          setItems(collectedItems);
          setRows(collectedRows);
          onRowsChange?.(collectedRows);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Error renderizando PDF.');
          setPageViews([]);
          setItems([]);
          setRows([]);
          onRowsChange?.([]);
          onTextLayerChange?.(false);
          onDocMeta?.({ numPages: 0 });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
    };
  }, [pdfUrl, pageNumber, scale, overlayMode, analyzeAllPages, useOpenAIFallback, onRowsChange, onTextLayerChange, onDocMeta]);

  const overlaysByPage = useMemo(() => {
    const source = overlayMode === 'rows' ? rows : items;
    const map = new Map<number, OverlayEntry[]>();
    for (const entry of source) {
      const list = map.get(entry.page) || [];
      list.push(entry);
      map.set(entry.page, list);
    }
    return map;
  }, [overlayMode, rows, items]);

  const handleClick = (entry: OverlayEntry): void => {
    setSelectedId(entry.id);
    const view = pageViews.find((p) => p.page === entry.page);

    const payload: TextClickPayload = {
      text: entry.text,
      bboxPx: entry.bbox,
      page: entry.page,
      pageWidth: view?.width,
      pageHeight: view?.height,
      id: entry.id,
      mode: overlayMode
    };

    if (payload.text) {
      console.log({ text: payload.text, bboxPx: payload.bboxPx, page: payload.page });
    }
    onTextClick?.(payload);
  };

  return (
    <div className="space-y-3">
      {pageViews.map((view) => {
        const pageOverlays = overlaysByPage.get(view.page) || [];
        return (
          <div
            key={`page-${view.page}`}
            className="relative inline-block border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm"
            style={{ width: view.width }}
          >
            <img
              src={view.imageDataUrl}
              alt={`PDF page ${view.page}`}
              className="block select-none"
              style={{ width: view.width, height: view.height }}
            />

            <div className="absolute inset-0">
              {pageOverlays.map((entry) => {
                const selected = selectedId === entry.id;
                const baseClass = overlayMode === 'rows'
                  ? 'bg-emerald-300/10 border-emerald-500/40 hover:bg-emerald-300/20 hover:border-emerald-600/70'
                  : 'bg-cyan-300/10 border-cyan-500/40 hover:bg-cyan-300/20 hover:border-cyan-600/70';
                const selectedClass = 'bg-indigo-300/25 border-indigo-600';

                return (
                  <div
                    key={entry.id}
                    className={`absolute border rounded-[3px] transition-colors cursor-pointer ${selected ? selectedClass : baseClass}`}
                    style={{
                      left: entry.bbox.x,
                      top: entry.bbox.y,
                      width: entry.bbox.w,
                      height: entry.bbox.h
                    }}
                    title={entry.text || entry.id}
                    onClick={() => handleClick(entry)}
                  />
                );
              })}
            </div>

            <div className="absolute top-2 right-2 px-2 py-0.5 text-[10px] font-bold bg-white/90 border border-slate-200 rounded">
              Pag {view.page}
            </div>
          </div>
        );
      })}

      <div className="text-[11px] text-slate-500 font-mono flex flex-wrap gap-4">
        <span>{isLoading ? 'rendering...' : `pages=${pageViews.length}`}</span>
        <span>{`mode=${overlayMode}`}</span>
        <span>{`items=${items.length}`}</span>
        <span>{`rows=${rows.length}`}</span>
        {error && <span className="text-rose-600">{`error=${error}`}</span>}
      </div>
    </div>
  );
};

export default PdfCalcoPage;
