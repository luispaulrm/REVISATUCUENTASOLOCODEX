import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Play,
  Loader2,
  FileJson,
  Copy,
  Check,
  Database,
  RefreshCw,
  Trash2,
  Upload,
  FileText,
  Rows3,
  Type,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import PdfCalcoPage, { OverlayEntry, OverlayMode, TextClickPayload } from './PdfCalcoPage';
import { runM12Audit } from '../m12/engine';
import { buildContractCalcoFromAzureLayout, isAzureLayoutWebPayload } from '../m12/azureContractCalco';
import { buildCanonicalContractFromCalco, isM12CanonicalContract } from '../m12/calcoToCanonical';

const M12_LAST_KEY = 'm12_audit_result';
const M12_LAST_FP_KEY = 'm12_audit_last_fingerprint';
const M12_AZURE_WEB_LAST_KEY = 'm12_azure_web_result';

type SelectionState = {
  text: string;
  page: number;
  bboxPx: TextClickPayload['bboxPx'];
  mode: OverlayMode;
};

function quickHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}_${input.length}`;
}

function cacheKeyFor(stage: string, fp: string): string {
  return `m12_audit_cache_${stage}_${fp}`;
}

function looksLikeEmptyHospitalFallback(value: any): boolean {
  if (!value) return false;
  if (value?.metadata?.useful === false) return true;
  const warnings = Array.isArray(value?.warnings) ? value.warnings.map((w: any) => String(w)) : [];
  return warnings.some((w) => w.includes('No fue posible extraer la grilla hospitalaria'));
}

function isReusableM12Cache(value: any): boolean {
  return !!value && !looksLikeEmptyHospitalFallback(value);
}

function isContractCalco(value: any): boolean {
  return !!value?.source?.kind && Array.isArray(value?.pages) && !!value?.metadata?.generatedAt && !value?.analyzeResult;
}

function parseStoredJson(value: string | null): any | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isLegacyStructuredM12(value: any): boolean {
  if (!value) return false;
  if (isAzureLayoutWebPayload(value) || isContractCalco(value) || isM12CanonicalContract(value)) return false;
  return Array.isArray(value?.sections) || Array.isArray(value?.items) || !!value?.page3_sections;
}

function formatFinancialTerm(term: any): string {
  if (!term) return '-';
  if (term.state === 'SIN_TOPE') return 'Sin Tope';
  if (term.state === 'NUMERIC') return `${term.amount ?? '?'} ${term.unit ?? ''}`.trim();
  return term.literalText || term.state || '-';
}

function formatEvidenceList(values: any[], fallback = 'Sin evidencia'): string {
  const list = Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (!list.length) return fallback;
  return list.join(' | ');
}

export default function AuditorM12App() {
  const [hasContract, setHasContract] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [cacheInfo, setCacheInfo] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [pageToProcess, setPageToProcess] = useState(3);
  const [extractionMode, setExtractionMode] = useState<'single' | 'full'>('single');
  const [activePdfUrl, setActivePdfUrl] = useState('');
  const [viewerPageNumber, setViewerPageNumber] = useState(1);
  const [scale, setScale] = useState(1.5);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('rows');
  const [viewerAllPages, setViewerAllPages] = useState(false);
  const [useOpenAIFallback, setUseOpenAIFallback] = useState(false);
  const [rows, setRows] = useState<OverlayEntry[]>([]);
  const [hasTextLayer, setHasTextLayer] = useState(false);
  const [docPages, setDocPages] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);

  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const canonical = localStorage.getItem('canonical_contract_result');
    const last = parseStoredJson(localStorage.getItem(M12_LAST_KEY));
    const azureWebLast = parseStoredJson(localStorage.getItem(M12_AZURE_WEB_LAST_KEY));
    setHasContract(!!canonical || !!last || !!azureWebLast);
    if (last) {
      setResult(last);
      return;
    }
    if (azureWebLast) setResult(azureWebLast);
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const pretty = useMemo(() => (result ? JSON.stringify(result, null, 2) : ''), [result]);
  const extractionSummary = useMemo(() => {
    if (!result) return '';
    if (isAzureLayoutWebPayload(result)) {
      const model = String(result.analyzeResult.modelId || 'unknown');
      const pageCount = Array.isArray(result?.analyzeResult?.pages) ? result.analyzeResult.pages.length : 0;
      return `Pipeline: Azure Web Raw | Modelo: ${model} | Paginas: ${pageCount}`;
    }
    if (isContractCalco(result)) {
      const variant = result?.metadata?.variant || 'UNKNOWN';
      const sectionCount = Array.isArray(result?.pages) ? result.pages.length : 0;
      return `Pipeline: Contract calco | Variante: ${variant} | Secciones: ${sectionCount}`;
    }
    if (isM12CanonicalContract(result)) {
      const variant = result?.metadata?.variant || 'UNKNOWN';
      const sectionCount = Array.isArray(result?.sections) ? result.sections.length : 0;
      const reconstructibility = result?.reconstructibility?.status || 'NO_VERIFICABLE';
      const score = typeof result?.reconstructibility?.score === 'number' ? ` | Score: ${result.reconstructibility.score}` : '';
      return `Pipeline: Canonical contract | Variante: ${variant} | Secciones: ${sectionCount} | Estado: ${reconstructibility}${score}`;
    }
    const metadata = result?.metadata || {};
    if (metadata.strategy === 'AZURE_LAYOUT_FIRST') {
      const page = metadata.page ? ` | Pagina: ${metadata.page}` : '';
      const source = metadata?.sourceDetails?.pageOcrSource || metadata?.sourceDetails?.selectedPageOcrSource;
      const sourceLabel = source ? ` | Fuente: ${source}` : '';
      if (looksLikeEmptyHospitalFallback(result)) {
        return `Pipeline: Azure Layout primero sin grilla hospitalaria validada${page}${sourceLabel}`;
      }
      return `Pipeline: Azure Layout primero${page}${sourceLabel}`;
    }
    if (metadata.strategy === 'DETERMINISTIC_VISUAL_STRUCTURAL' || metadata.strategy === 'DETERMINISTIC_VISUAL_FALLBACK') {
      const page = metadata.page ? ` | Pagina: ${metadata.page}` : '';
      if (looksLikeEmptyHospitalFallback(result)) {
        return `Pipeline: Visual estructural sin grilla hospitalaria validada${page}`;
      }
      return `Pipeline: Visual estructural determinista${page}`;
    }
    if (Array.isArray(result?.sections)) return 'Pipeline: Normalizacion local desde contrato canonico';
    if (Array.isArray(result?.items)) return 'Pipeline: Auditor B estructurado';
    if (result?.page3_sections || result?.oferta_preferente || result?.libre_eleccion) return 'Pipeline: Extraccion visual estructural';
    return '';
  }, [result]);

  const extractedSourceLabel = useMemo(() => {
    if (isAzureLayoutWebPayload(result)) {
      return `azure-web:${result.analyzeResult.modelId}`;
    }
    if (isContractCalco(result)) {
      return `contract-calco:${result.source.kind}`;
    }
    if (isM12CanonicalContract(result)) {
      return `canonical-contract:${result.metadata.variant}`;
    }
    const metadata = result?.metadata || {};
    return metadata?.sourceDetails?.selectedPageOcrSource || metadata?.sourceDetails?.pageOcrSource || 'unknown';
  }, [result]);

  const viewerStatus = useMemo(() => {
    return `textLayer=${hasTextLayer ? 'yes' : 'no'} | rows=${rows.length} | pdfPages=${docPages || 0} | scope=${viewerAllPages ? 'all-pages' : `page-${viewerPageNumber}`}`;
  }, [docPages, hasTextLayer, rows.length, viewerAllPages, viewerPageNumber]);

  const canonicalSections = useMemo(() => {
    if (!isM12CanonicalContract(result)) return [];
    return result.sections || [];
  }, [result]);

  const clearCurrentObjectUrl = (): void => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  const handleOverlayTextClick = (payload: TextClickPayload): void => {
    setSelection({
      text: payload.text,
      page: payload.page,
      bboxPx: payload.bboxPx,
      mode: payload.mode
    });
  };

  const runAudit = () => {
    setIsProcessing(true);
    try {
      const current =
        result ||
        parseStoredJson(localStorage.getItem(M12_LAST_KEY)) ||
        parseStoredJson(localStorage.getItem(M12_AZURE_WEB_LAST_KEY));

      if (current && isAzureLayoutWebPayload(current)) {
        const rawStr = JSON.stringify(current);
        const fp = quickHash(rawStr);
        const ck = cacheKeyFor('contract_calco', fp);
        const cached = parseStoredJson(localStorage.getItem(ck));
        if (cached && isContractCalco(cached)) {
          setResult(cached);
          localStorage.setItem(M12_LAST_KEY, JSON.stringify(cached));
          localStorage.setItem(M12_LAST_FP_KEY, `contract_calco:${fp}`);
          setCacheInfo(`Contract calco listo (${fp})`);
          return;
        }

        const calco = buildContractCalcoFromAzureLayout(current);
        localStorage.setItem(ck, JSON.stringify(calco));
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(calco));
        localStorage.setItem(M12_LAST_FP_KEY, `contract_calco:${fp}`);
        setResult(calco);
        setCacheInfo(`Contract calco generado (${fp})`);
        return;
      }

      if (current && isContractCalco(current)) {
        const calcoStr = JSON.stringify(current);
        const fp = quickHash(calcoStr);
        const ck = cacheKeyFor('canonical_contract', fp);
        const cached = parseStoredJson(localStorage.getItem(ck));
        if (cached && isM12CanonicalContract(cached)) {
          setResult(cached);
          localStorage.setItem(M12_LAST_KEY, JSON.stringify(cached));
          localStorage.setItem(M12_LAST_FP_KEY, `canonical_contract:${fp}`);
          setCacheInfo(`Canonical contract listo (${fp})`);
          return;
        }

        const canonical = buildCanonicalContractFromCalco(current);
        localStorage.setItem(ck, JSON.stringify(canonical));
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(canonical));
        localStorage.setItem(M12_LAST_FP_KEY, `canonical_contract:${fp}`);
        setResult(canonical);
        setCacheInfo(`Canonical contract generado (${fp})`);
        return;
      }

      if (current && isM12CanonicalContract(current)) {
        setResult(current);
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(current));
        setCacheInfo('Canonical contract ya listo');
        return;
      }

      if (current && isLegacyStructuredM12(current) && isReusableM12Cache(current)) {
        setResult(current);
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(current));
        setCacheInfo('Resultado legacy reutilizado');
        return;
      }

      const canonicalStr = localStorage.getItem('canonical_contract_result');
      if (!canonicalStr) {
        alert('No hay extraccion M12 en cache ni contrato canonico en memoria.');
        return;
      }

      const fp = quickHash(canonicalStr);
      const ck = cacheKeyFor('legacy_structured', fp);
      const cached = parseStoredJson(localStorage.getItem(ck));
      if (cached) {
        const parsed = cached as any;
        if (isReusableM12Cache(parsed)) {
          parsed.metadata.cached = true;
          setResult(parsed);
          localStorage.setItem(M12_LAST_KEY, JSON.stringify(parsed));
          localStorage.setItem(M12_LAST_FP_KEY, `legacy_structured:${fp}`);
          setCacheInfo(`Cache hit (${fp})`);
          return;
        }
        localStorage.removeItem(ck);
      }

      const contract = JSON.parse(canonicalStr);
      const out = runM12Audit(contract);
      out.metadata.cached = false;

      localStorage.setItem(ck, JSON.stringify(out));
      localStorage.setItem(M12_LAST_KEY, JSON.stringify(out));
      localStorage.setItem(M12_LAST_FP_KEY, `legacy_structured:${fp}`);
      setResult(out);
      setCacheInfo(`Cache miss -> stored (${fp})`);
    } catch (e: any) {
      alert(`Error M12: ${e?.message || 'unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUploadContract = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      alert('Solo PDF en M12.');
      return;
    }

    clearCurrentObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;
    setActivePdfUrl(objectUrl);
    setSelection(null);
    setRows([]);
    setHasTextLayer(false);
    setDocPages(0);
    setViewerPageNumber(pageToProcess);

    setUploading(true);
    setFileName(file.name);
    setCacheInfo(`Extrayendo contrato desde ${file.name}...`);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const raw = String(e.target?.result || '');
          const pure = raw.includes(',') ? raw.split(',')[1] : raw;
          resolve(pure);
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
      });

      const response = await fetch('/api/m12/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64,
          mimeType: 'application/pdf',
          originalname: file.name,
          page: pageToProcess,
          mode: extractionMode,
          output: 'azure-web'
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(payload.error);

      const isAzureWebPayload = String(payload?.status || '').toLowerCase() === 'succeeded' && !!payload?.analyzeResult?.modelId;
      if (isAzureWebPayload) {
        localStorage.setItem(M12_AZURE_WEB_LAST_KEY, JSON.stringify(payload));
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(payload));
        localStorage.setItem(M12_LAST_FP_KEY, `azure-web:${quickHash(JSON.stringify(payload))}`);
        setResult(payload);
        setHasContract(true);
        setViewerPageNumber(pageToProcess);
        setCacheInfo(`Azure web layout listo (${file.name})`);
        return;
      }

      const fp = quickHash(`${file.name}|${file.size}|${extractionMode}|${extractionMode === 'single' ? pageToProcess : 'ALL'}`);
      const resultWithMeta = {
        ...payload,
        metadata: {
          ...(payload?.metadata || {}),
          cached: false
        }
      };

      localStorage.setItem(M12_LAST_KEY, JSON.stringify(resultWithMeta));
      setResult(resultWithMeta);
      setHasContract(true);
      setViewerPageNumber(Math.max(1, Number(resultWithMeta?.metadata?.page || pageToProcess || 1)));

      if (isReusableM12Cache(resultWithMeta)) {
        localStorage.setItem(cacheKeyFor('legacy_structured', fp), JSON.stringify(resultWithMeta));
        localStorage.setItem(M12_LAST_FP_KEY, `legacy_structured:${fp}`);
        setCacheInfo(`Extraccion M12 lista (${file.name}, ${extractionMode === 'single' ? `pag ${pageToProcess}` : 'completo'})`);
      } else {
        localStorage.removeItem(cacheKeyFor('legacy_structured', fp));
        localStorage.removeItem(M12_LAST_FP_KEY);
        setCacheInfo(`Extraccion M12 incompleta (${file.name}). Revisar warnings/diagnostico.`);
      }
    } catch (e: any) {
      setCacheInfo('');
      alert(`Error cargando PDF: ${e?.message || 'error desconocido'}`);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const copyJson = () => {
    if (!pretty) return;
    navigator.clipboard.writeText(pretty);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const downloadJson = () => {
    if (!pretty) return;
    const blob = new Blob([pretty], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_m12_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearM12Cache = () => {
    const keys = Object.keys(localStorage).filter(
      (k) => k.startsWith('m12_audit_cache_') || k === M12_LAST_KEY || k === M12_LAST_FP_KEY || k === M12_AZURE_WEB_LAST_KEY
    );
    keys.forEach((k) => localStorage.removeItem(k));
    setResult(null);
    setCacheInfo('Cache M12 limpiada');
    setHasContract(!!localStorage.getItem('canonical_contract_result'));
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-[#f8fafc] p-8 pb-24">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-slate-200 pb-6">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Brain className="text-indigo-600" size={20} />
                <span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Azure Web Raw</span>
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900">M12 Contrato</h1>
              <p className="text-slate-500 mt-1">
                Subir PDF guarda el JSON crudo de Azure <code>prebuilt-layout</code>. Ejecutar M12 avanza por etapas:
                {' '}<code>Azure raw -&gt; contract_calco -&gt; canonical_contract</code>.
              </p>
            </div>
          <div className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Database size={15} className={hasContract ? 'text-emerald-500' : 'text-amber-500'} />
            {hasContract ? 'Fuente lista' : 'Falta PDF/contrato'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-slate-800">
            <FileText size={18} />
            <h2 className="text-sm font-black uppercase tracking-wider">Contrato - PDF Calco</h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            <div className="lg:col-span-2 px-3 py-2 rounded-xl bg-white border border-slate-200 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">Modo</span>
              <select
                value={extractionMode}
                onChange={(e) => setExtractionMode((e.target.value as 'single' | 'full'))}
                className="text-sm font-bold text-slate-800 outline-none bg-transparent"
              >
                <option value="single">Pagina</option>
                <option value="full">Completo</option>
              </select>
            </div>

            <div className="lg:col-span-1 px-3 py-2 rounded-xl bg-white border border-slate-200 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">Pag</span>
              <input
                type="number"
                min={1}
                value={pageToProcess}
                onChange={(e) => setPageToProcess(Math.max(1, Number(e.target.value) || 1))}
                className="w-16 text-sm font-bold text-slate-800 outline-none disabled:opacity-40"
                disabled={extractionMode === 'full'}
              />
            </div>

            <div className="lg:col-span-1">
              <input
                type="number"
                min={1}
                max={Math.max(1, docPages || 1)}
                value={viewerPageNumber}
                onChange={(e) => setViewerPageNumber(Math.max(1, Number(e.target.value || 1)))}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
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
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="lg:col-span-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setOverlayMode('items')}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'items' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                <Type size={14} /> Items
              </button>
              <button
                onClick={() => setOverlayMode('rows')}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'rows' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                <Rows3 size={14} /> Rows
              </button>
              <button
                onClick={() => setViewerAllPages((v) => !v)}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 ${viewerAllPages ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700'}`}
              >
                {viewerAllPages ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Documento completo
              </button>
            </div>

            <div className="lg:col-span-4 flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={() => setUseOpenAIFallback((v) => !v)}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 ${useOpenAIFallback ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}
              >
                {useOpenAIFallback ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Fallback OpenAI
              </button>

              <label className={`px-5 py-3 rounded-xl font-bold text-sm flex items-center gap-2 border ${
                uploading ? 'bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 cursor-pointer'
              }`}>
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                {uploading ? 'Consultando Azure...' : 'Subir PDF'}
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={handleUploadContract}
                  disabled={uploading}
                />
              </label>

              <button
                onClick={runAudit}
                disabled={!hasContract || isProcessing || uploading}
                className={`px-5 py-3 rounded-xl font-bold text-sm flex items-center gap-2 ${
                  !hasContract || isProcessing || uploading ? 'bg-slate-300 text-slate-600 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-500'
                }`}
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {isProcessing ? 'Procesando...' : 'Ejecutar M12'}
              </button>

              <button
                onClick={copyJson}
                disabled={!result}
                className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? 'Copiado' : 'Copiar JSON'}
              </button>

              <button
                onClick={downloadJson}
                disabled={!result}
                className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50"
              >
                <FileJson size={15} />
                Descargar JSON
              </button>

              <button
                onClick={runAudit}
                disabled={!hasContract || isProcessing || uploading}
                className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCw size={15} />
                Recalcular / Cache
              </button>

              <button onClick={clearM12Cache} className="px-4 py-3 rounded-xl bg-white border border-rose-200 text-rose-700 font-bold text-sm flex items-center gap-2">
                <Trash2 size={15} />
                Limpiar cache M12
              </button>
            </div>
          </div>

          {cacheInfo && <div className="text-xs font-semibold text-slate-500">{cacheInfo}</div>}
          {extractionSummary && <div className="text-xs font-semibold text-indigo-600">{extractionSummary}</div>}
          {fileName && (
            <div className="text-xs font-semibold text-slate-600 flex items-center gap-2">
              <FileText size={13} />
              {fileName}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500 font-mono">{viewerStatus}</span>
            <span className="text-xs text-slate-500 font-mono">{`M12 source=${extractedSourceLabel}`}</span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${activePdfUrl ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {activePdfUrl ? 'Renderable: SI' : 'Renderable: NO'}
            </span>
            <span className={`text-xs font-bold px-2 py-1 rounded ${result ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {result ? 'JSON listo: SI' : 'JSON listo: NO'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-10 overflow-auto bg-slate-50 border border-slate-200 rounded-2xl p-4">
            {activePdfUrl ? (
              <PdfCalcoPage
                pdfUrl={activePdfUrl}
                pageNumber={viewerPageNumber}
                scale={scale}
                overlayMode={overlayMode}
                analyzeAllPages={viewerAllPages}
                useOpenAIFallback={useOpenAIFallback}
                onRowsChange={setRows}
                onTextLayerChange={setHasTextLayer}
                onDocMeta={(meta) => setDocPages(meta.numPages)}
                onTextClick={handleOverlayTextClick}
              />
            ) : (
              <div className="h-[50vh] min-h-[320px] rounded-xl border border-dashed border-slate-300 bg-white flex items-center justify-center text-slate-500 text-sm">
                Sube un contrato PDF para iniciar el calco.
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
              <div className="text-slate-800 text-sm break-words">{fileName || 'Sin archivo cargado'}</div>
            </div>
          </aside>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          {isM12CanonicalContract(result) && (
            <div className="mb-6">
              <div className="flex items-center gap-2 text-slate-800 mb-3">
                <Database size={18} />
                <h2 className="text-sm font-black uppercase tracking-wider">Evidencia Canonica</h2>
              </div>
              <div className="max-h-[480px] overflow-auto space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                {canonicalSections.map((section: any) => (
                  <div key={section.sectionKey} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="mb-3">
                      <div className="text-[11px] font-black uppercase tracking-wider text-slate-500">Seccion</div>
                      <div className="text-sm font-bold text-slate-900">{section.title}</div>
                    </div>
                    <div className="space-y-3">
                      {section.items.map((item: any) => (
                        <div key={item.itemId} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                          <div className="text-sm font-semibold text-slate-900">{item.itemLabel || '(sin label)'}</div>
                          {item.rules.length === 0 ? (
                            <div className="mt-2 text-xs font-semibold text-amber-700">Sin regla financiera reconstruida</div>
                          ) : (
                            <div className="mt-3 space-y-3">
                              {item.rules.map((rule: any) => (
                                <div key={rule.ruleId} className="rounded-lg border border-slate-200 bg-white p-3">
                                  <div className="flex flex-wrap items-center gap-2 mb-2">
                                    <span className="px-2 py-1 rounded bg-slate-900 text-white text-[10px] font-black tracking-wide">
                                      {rule.evidenceBreakdown?.mode || 'NONE'}
                                    </span>
                                    <span className={`px-2 py-1 rounded text-[10px] font-black tracking-wide ${
                                      rule.confidence === 'CONFIRMED'
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : rule.confidence === 'PARTIAL'
                                          ? 'bg-amber-100 text-amber-700'
                                          : 'bg-slate-100 text-slate-600'
                                    }`}>
                                      {rule.confidence}
                                    </span>
                                    {rule.modality && (
                                      <span className="px-2 py-1 rounded bg-indigo-100 text-indigo-700 text-[10px] font-black tracking-wide">
                                        {rule.modality}
                                      </span>
                                    )}
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs text-slate-700">
                                    <div><span className="font-bold text-slate-500">Cobertura:</span> {rule.coveragePct ?? '-'}</div>
                                    <div><span className="font-bold text-slate-500">Tope evento:</span> {formatFinancialTerm(rule.topeEvento)}</div>
                                    <div><span className="font-bold text-slate-500">Tope anual:</span> {formatFinancialTerm(rule.topeAnualBeneficiario)}</div>
                                    <div><span className="font-bold text-slate-500">Prestadores:</span> {formatEvidenceList(rule.prestadores, '-')}</div>
                                  </div>

                                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                    <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2">
                                      <div className="font-black uppercase tracking-wider text-[10px] text-emerald-700 mb-1">Directa</div>
                                      <div className="text-slate-700">{formatEvidenceList(rule.evidenceBreakdown?.directLiteralEvidence, 'Sin evidencia directa')}</div>
                                      <div className="mt-1 text-[10px] font-semibold text-emerald-700">
                                        Geometria: {rule.evidenceBreakdown?.directGeometryEvidence?.length || 0}
                                      </div>
                                    </div>
                                    <div className="rounded-lg bg-amber-50 border border-amber-100 p-2">
                                      <div className="font-black uppercase tracking-wider text-[10px] text-amber-700 mb-1">Propagada</div>
                                      <div className="text-slate-700">{formatEvidenceList(rule.evidenceBreakdown?.propagatedLiteralEvidence, 'Sin evidencia propagada')}</div>
                                      <div className="mt-1 text-[10px] font-semibold text-amber-700">
                                        Geometria: {rule.evidenceBreakdown?.propagatedGeometryEvidence?.length || 0}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-slate-800 mb-3">
            <FileJson size={18} />
            <h2 className="text-sm font-black uppercase tracking-wider">Salida JSON</h2>
          </div>
          <pre className="text-xs text-slate-800 whitespace-pre-wrap overflow-x-auto">
            {result ? pretty : 'Ejecuta M12 para generar salida estructural.'}
          </pre>
        </div>
      </div>
    </div>
  );
}
