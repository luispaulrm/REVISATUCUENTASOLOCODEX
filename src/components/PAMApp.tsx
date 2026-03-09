import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Download, FileText, Link2, Rows3, ToggleLeft, ToggleRight, Trash2, Type, Upload } from 'lucide-react';
import PdfCalcoPage, { OverlayMode, OverlayEntry, TextClickPayload } from './PdfCalcoPage';
import { extractPamData, PamDocument, UsageMetrics } from '../pamService';
import { PAMResults } from './PAMResults';
import PAMAuditChat from './PAMAuditChat';

type ViewStatus = 'idle' | 'loading' | 'processing' | 'ready' | 'error';

type SelectionState = {
  text: string;
  page: number;
  bboxPx: TextClickPayload['bboxPx'];
  mode: OverlayMode;
};

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

function inferPamMimeType(blob: Blob, name: string): string {
  const explicit = String(blob.type || '').trim().toLowerCase();
  const lowerName = String(name || '').trim().toLowerCase();

  if (explicit === 'application/pdf') return 'application/pdf';
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (explicit) return explicit;
  return 'application/pdf';
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function PAMApp() {
  const [urlInput, setUrlInput] = useState('');
  const [activePdfUrl, setActivePdfUrl] = useState('');
  const [status, setStatus] = useState<ViewStatus>('idle');
  const [error, setError] = useState('');
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('rows');
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.5);
  const [analyzeAllPages, setAnalyzeAllPages] = useState(true);
  const [useOpenAIFallback, setUseOpenAIFallback] = useState(false);
  const [rows, setRows] = useState<OverlayEntry[]>([]);
  const [hasTextLayer, setHasTextLayer] = useState(false);
  const [docPages, setDocPages] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [pamResult, setPamResult] = useState<PamDocument | null>(null);
  const [usage, setUsage] = useState<UsageMetrics | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRunKeyRef = useRef<string | null>(null);
  const lastRunRef = useRef<{ key: string; finishedAt: number } | null>(null);

  const statusBadge = useMemo(() => {
    if (status === 'error') return { label: 'Error', className: 'bg-rose-50 text-rose-700 border border-rose-200' };
    if (status === 'processing') return { label: 'Procesando PAM', className: 'bg-amber-50 text-amber-700 border border-amber-200' };
    if (status === 'loading') return { label: 'Cargando PDF', className: 'bg-slate-100 text-slate-700 border border-slate-200' };
    if (status === 'ready') return { label: 'PAM listo', className: 'bg-emerald-50 text-emerald-700 border border-emerald-200' };
    return { label: 'Sin documento', className: 'bg-slate-100 text-slate-500 border border-slate-200' };
  }, [status]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  const addLog = (message: string): void => {
    console.log(`[PAM] ${message}`);
    setLogs((prev) => [...prev.slice(-11), message]);
  };

  const clearCurrentObjectUrl = (): void => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  const clearPamState = (): void => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeRunKeyRef.current = null;
    lastRunRef.current = null;
    clearCurrentObjectUrl();
    setActivePdfUrl('');
    setPamResult(null);
    setUsage(null);
    setProgress(0);
    setRows([]);
    setHasTextLayer(false);
    setDocPages(0);
    setPageNumber(1);
    setScale(1.5);
    setSelection(null);
    setLogs([]);
    setError('');
    setSourceLabel('');
    setStatus('idle');
    localStorage.removeItem('pam_audit_result');
    localStorage.removeItem('pam_audit_file_fingerprint');
    localStorage.removeItem('pam_audit_raw_result');
  };

  const runPamExtraction = async (base64Payload: string, mimeType: string, fileName: string, fileSize: number): Promise<void> => {
    const runKey = [
      fileName,
      fileSize,
      mimeType,
      analyzeAllPages ? 'all-pages' : `page-${pageNumber}`
    ].join('|');

    if (activeRunKeyRef.current === runKey) {
      addLog('[PAM] Doble disparo detectado. Se ignora corrida duplicada en curso.');
      return;
    }

    const lastRun = lastRunRef.current;
    if (lastRun && lastRun.key === runKey && Date.now() - lastRun.finishedAt < 4000) {
      addLog('[PAM] Doble disparo detectado. Se ignora corrida duplicada reciente.');
      return;
    }

    activeRunKeyRef.current = runKey;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setStatus('processing');
    setError('');
    setProgress(5);
    setPamResult(null);
    setUsage(null);
    setLogs([]);
    addLog('[PAM] Iniciando extraccion...');

    try {
      const result = await extractPamData(
        base64Payload,
        mimeType,
        (msg) => addLog(msg),
        (nextUsage) => setUsage(nextUsage),
        (nextProgress) => setProgress(Math.round(nextProgress)),
        controller.signal,
        {
          analyzeAllPages,
          pageNumber
        }
      );

      setPamResult(result.data);
      setStatus('ready');
      setProgress(100);
      localStorage.setItem('pam_audit_result', JSON.stringify(result.data));
      localStorage.setItem('pam_audit_file_fingerprint', JSON.stringify({ name: fileName, size: fileSize }));
      if (result.traceId) {
        addLog(`[PAM] Trace final: ${result.traceId}`);
      }
      addLog('[PAM] Extraccion completada.');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        addLog('[PAM] Proceso cancelado.');
        setStatus('idle');
        return;
      }
      const message = err?.message || 'Error procesando PAM.';
      setError(message);
      setStatus('error');
      addLog(`[PAM] ${message}`);
    } finally {
      abortControllerRef.current = null;
      if (activeRunKeyRef.current === runKey) {
        activeRunKeyRef.current = null;
      }
      lastRunRef.current = { key: runKey, finishedAt: Date.now() };
    }
  };

  const loadBlobAsPam = async (blob: Blob, name: string): Promise<void> => {
    clearCurrentObjectUrl();
    setStatus('loading');
    setError('');
    setSelection(null);
    setRows([]);
    setProgress(0);
    setPageNumber(1);
    setSourceLabel(name);

    const objectUrl = URL.createObjectURL(blob);
    objectUrlRef.current = objectUrl;
    setActivePdfUrl(objectUrl);

    const dataUrl = await fileToDataUrl(blob);
    const base64Payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const mimeType = inferPamMimeType(blob, name);

    await runPamExtraction(base64Payload, mimeType, name, blob.size);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await loadBlobAsPam(file, file.name);
  };

  const handleLoadUrl = async (): Promise<void> => {
    const target = urlInput.trim();
    if (!target) return;

    try {
      setStatus('loading');
      setError('');
      setLogs([]);
      addLog(`[PAM] Descargando PDF desde URL...`);
      const response = await fetch(target);
      if (!response.ok) {
        throw new Error(`No se pudo cargar la URL (${response.status}).`);
      }
      const blob = await response.blob();
      const name = target.split('/').pop() || 'documento-pam.pdf';
      await loadBlobAsPam(new File([blob], name, { type: blob.type || 'application/pdf' }), name);
    } catch (err: any) {
      const message = err?.message || 'Error cargando URL.';
      setError(message);
      setStatus('error');
      addLog(`[PAM] ${message}`);
    }
  };

  const handleClearCache = (): void => {
    clearPamState();
  };

  const handleExportPamJson = (): void => {
    if (!pamResult) return;
    downloadTextFile(`pam_result_${Date.now()}.json`, JSON.stringify(pamResult, null, 2), 'application/json');
  };

  const handleTextClick = (payload: TextClickPayload): void => {
    setSelection({
      text: payload.text,
      page: payload.page,
      bboxPx: payload.bboxPx,
      mode: payload.mode
    });
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <div className="p-4 xl:p-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-slate-800">
            <FileText size={18} />
            <h2 className="text-sm font-black uppercase tracking-wider">PAM - PDF Calco</h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            <div className="lg:col-span-6 flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://.../documento-pam.pdf"
                className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
              />
              <button onClick={() => void handleLoadUrl()} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold inline-flex items-center gap-2">
                <Link2 size={14} /> Cargar URL
              </button>
            </div>

            <div className="lg:col-span-2">
              <label className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-bold inline-flex items-center justify-center gap-2 cursor-pointer bg-white">
                <Upload size={14} /> Cargar Archivo
                <input ref={fileInputRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>

            <div className="lg:col-span-1">
              <input
                type="number"
                min={1}
                max={Math.max(1, docPages || 1)}
                value={pageNumber}
                onChange={(e) => setPageNumber(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
              />
            </div>

            <div className="lg:col-span-1">
              <input
                type="number"
                step={0.1}
                min={0.5}
                max={3}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value || 1.5))}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
              />
            </div>

            <div className="lg:col-span-2 flex items-center justify-end gap-2">
              <button
                onClick={() => setAnalyzeAllPages((v) => !v)}
                className={`px-3 py-2 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${analyzeAllPages ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700'}`}
              >
                {analyzeAllPages ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Documento completo
              </button>
              <button
                onClick={() => setUseOpenAIFallback((v) => !v)}
                className={`px-3 py-2 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${useOpenAIFallback ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}
              >
                {useOpenAIFallback ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Fallback OpenAI
              </button>
              <button onClick={handleClearCache} className="px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold inline-flex items-center gap-2">
                <Trash2 size={14} /> Borrar caché
              </button>
              <button disabled={!pamResult} className={`px-3 py-2 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${pamResult ? 'bg-violet-300 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
                <Database size={14} /> PAM listo
              </button>
              <button onClick={handleExportPamJson} disabled={!pamResult} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                <Download size={14} /> Export PAM JSON
              </button>
            </div>
          </div>

          {sourceLabel && <div className="text-xs font-semibold text-slate-600">Archivo en sesion: {sourceLabel}</div>}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-500">Modo:</span>
            <button onClick={() => setOverlayMode('items')} className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'items' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>
                <Type size={14} /> Items
            </button>
            <button onClick={() => setOverlayMode('rows')} className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'rows' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>
                <Rows3 size={14} /> Rows
            </button>
            <span className="ml-3 text-xs text-slate-500 font-mono">
              {`textLayer=${hasTextLayer ? 'yes' : 'no'} | rows=${rows.length} | fallback=${useOpenAIFallback ? 'on' : 'off'} | pdfPages=${docPages || 0}`}
            </span>
            <span className="text-xs text-slate-500 font-mono">{`scope=${analyzeAllPages ? 'all-pages' : 'single-page'}`}</span>
            <span className="text-xs text-slate-500 font-mono">{`source[p${pageNumber}]=${sourceLabel || 'unknown'}`}</span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${activePdfUrl ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {activePdfUrl ? 'Renderable: SI' : 'Renderable: NO'}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${pamResult ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {pamResult ? 'Reconciliado: SI' : 'Reconciliado: NO'}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${pamResult && progress === 100 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {pamResult && progress === 100 ? 'Completo: SI' : 'Completo: NO'}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${status === 'ready' ? 'bg-emerald-100 text-emerald-700' : status === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
              {`Gate: ${status === 'ready' ? 'PASS' : status === 'error' ? 'FAIL' : 'WAIT'}`}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${statusBadge.className}`}>
              {statusBadge.label}
            </span>
          </div>

          {error ? (
            <div className="text-xs px-3 py-2 rounded border bg-rose-50 border-rose-200 text-rose-700">{error}</div>
          ) : logs.length > 0 ? (
            <div className={`text-xs px-3 py-2 rounded border ${pamResult ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
              {logs[logs.length - 1]}
            </div>
          ) : (
            <div className="text-xs px-3 py-2 rounded border bg-amber-50 border-amber-200 text-amber-700">
              Carga una URL o archivo PDF para iniciar el calco PAM.
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-10 overflow-auto bg-slate-50 border border-slate-200 rounded-2xl p-4">
            {activePdfUrl ? (
              <div>
                <PdfCalcoPage
                  pdfUrl={activePdfUrl}
                  pageNumber={pageNumber}
                  scale={scale}
                  overlayMode={overlayMode}
                  analyzeAllPages={analyzeAllPages}
                  useOpenAIFallback={useOpenAIFallback}
                  onRowsChange={setRows}
                  onTextLayerChange={setHasTextLayer}
                  onDocMeta={(meta) => setDocPages(meta.numPages)}
                  onTextClick={handleTextClick}
                />
                {pamResult ? <PAMAuditChat pamContext={pamResult} /> : null}
              </div>
            ) : (
              <div className="h-[50vh] min-h-[320px] rounded-xl border border-dashed border-slate-300 bg-white flex items-center justify-center text-slate-500 text-sm">
                Carga una URL o archivo PDF para iniciar el calco.
              </div>
            )}
          </div>

          <aside className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl p-3">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700 mb-3">Seleccion Actual</h3>
            {selection ? (
              <div className="space-y-3 text-[12px]">
                <div className="p-2 rounded bg-slate-50 border border-slate-100">
                  <p className="text-[10px] uppercase font-bold text-slate-500 mb-1">Texto</p>
                  <p className="text-slate-800 whitespace-pre-wrap break-words">{selection.text || '(vacio)'}</p>
                </div>
                <div className="p-2 rounded bg-slate-50 border border-slate-100 font-mono text-[11px] text-slate-700">
                  {`page: ${selection.page}`}<br />
                  {`mode: ${selection.mode}`}<br />
                  {`x: ${selection.bboxPx.x.toFixed(1)}`}<br />
                  {`y: ${selection.bboxPx.y.toFixed(1)}`}<br />
                  {`w: ${selection.bboxPx.w.toFixed(1)}`}<br />
                  {`h: ${selection.bboxPx.h.toFixed(1)}`}
                </div>
              </div>
            ) : (
              <p className="text-slate-400 text-sm">Haz click en un overlay para ver detalle.</p>
            )}

            <div className="mt-4 pt-4 border-t border-slate-200">
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Documento</div>
              <div className="text-slate-800 text-sm break-words">{sourceLabel || 'Sin archivo cargado'}</div>
              {usage && (
                <div className="mt-4 p-2 rounded bg-slate-50 border border-slate-100 text-[11px] text-slate-700 space-y-1">
                  <div>Input: {usage.promptTokens}</div>
                  <div>Output: {usage.candidatesTokens}</div>
                  <div>Total: {usage.totalTokens}</div>
                  <div>Costo: ${usage.estimatedCostCLP} CLP</div>
                </div>
              )}
            </div>
          </aside>
        </div>

        {pamResult && <div className="mt-6"><PAMResults data={pamResult} /></div>}
      </div>
    </div>
  );
}
