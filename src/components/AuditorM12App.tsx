import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Play, Loader2, FileJson, Copy, Check, Database, RefreshCw, Trash2, Upload, FileText } from 'lucide-react';
import { runM12Audit } from '../m12/engine';

const M12_LAST_KEY = 'm12_audit_result';
const M12_LAST_FP_KEY = 'm12_audit_last_fingerprint';

function quickHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}_${input.length}`;
}

function cacheKeyFor(fp: string): string {
  return `m12_audit_cache_${fp}`;
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

  useEffect(() => {
    const canonical = localStorage.getItem('canonical_contract_result');
    const last = localStorage.getItem(M12_LAST_KEY);
    setHasContract(!!canonical || !!last);
    if (last) {
      try {
        setResult(JSON.parse(last));
      } catch {
        // ignore malformed cache
      }
    }
  }, []);

  const pretty = useMemo(() => (result ? JSON.stringify(result, null, 2) : ''), [result]);

  const runAudit = () => {
    setIsProcessing(true);
    try {
      const lastFp = localStorage.getItem(M12_LAST_FP_KEY);
      if (lastFp) {
        const localCached = localStorage.getItem(cacheKeyFor(lastFp));
        if (localCached) {
          const parsed = JSON.parse(localCached) as any;
          if (parsed?.metadata) parsed.metadata.cached = true;
          setResult(parsed);
          localStorage.setItem(M12_LAST_KEY, JSON.stringify(parsed));
          setCacheInfo(`Cache hit (${lastFp})`);
          return;
        }
      }

      const canonicalStr = localStorage.getItem('canonical_contract_result');
      if (!canonicalStr) {
        alert('No hay extracción M12 en cache ni contrato canónico en memoria.');
        return;
      }

      const fp = quickHash(canonicalStr);
      const ck = cacheKeyFor(fp);
      const cached = localStorage.getItem(ck);
      if (cached) {
        const parsed = JSON.parse(cached) as any;
        parsed.metadata.cached = true;
        setResult(parsed);
        localStorage.setItem(M12_LAST_KEY, JSON.stringify(parsed));
        localStorage.setItem(M12_LAST_FP_KEY, fp);
        setCacheInfo(`Cache hit (${fp})`);
        return;
      }

      const contract = JSON.parse(canonicalStr);
      const out = runM12Audit(contract);
      out.metadata.cached = false;

      localStorage.setItem(ck, JSON.stringify(out));
      localStorage.setItem(M12_LAST_KEY, JSON.stringify(out));
      localStorage.setItem(M12_LAST_FP_KEY, fp);
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

    setUploading(true);
    setFileName(file.name);
    setCacheInfo(`Subiendo ${file.name}...`);
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
          mode: extractionMode
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(payload.error);

      const fp = quickHash(`${file.name}|${file.size}|${extractionMode}|${extractionMode === 'single' ? pageToProcess : 'ALL'}`);
      const resultWithMeta = {
        ...payload,
        metadata: {
          ...(payload?.metadata || {}),
          cached: false
        }
      };
      localStorage.setItem(cacheKeyFor(fp), JSON.stringify(resultWithMeta));
      localStorage.setItem(M12_LAST_KEY, JSON.stringify(resultWithMeta));
      localStorage.setItem(M12_LAST_FP_KEY, fp);
      setResult(resultWithMeta);
      setHasContract(true);
      setCacheInfo(`Extracción M12 lista (${file.name}, ${extractionMode === 'single' ? `pág ${pageToProcess}` : 'completo'})`);
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
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('m12_audit_cache_') || k === M12_LAST_KEY || k === M12_LAST_FP_KEY);
    keys.forEach((k) => localStorage.removeItem(k));
    setResult(null);
    setCacheInfo('Cache M12 limpiada');
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-[#f8fafc] p-8 pb-24">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-slate-200 pb-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Brain className="text-indigo-600" size={20} />
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Visual Structural</span>
            </div>
            <h1 className="text-3xl font-extrabold text-slate-900">M12 Auditor</h1>
            <p className="text-slate-500 mt-1">Extracción estructural tipo grilla con salida JSON y caché local.</p>
          </div>
          <div className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Database size={15} className={hasContract ? 'text-emerald-500' : 'text-amber-500'} />
            {hasContract ? 'Fuente lista' : 'Falta PDF/contrato'}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="px-3 py-2 rounded-xl bg-white border border-slate-200 flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">Modo</span>
            <select
              value={extractionMode}
              onChange={(e) => setExtractionMode((e.target.value as 'single' | 'full'))}
              className="text-sm font-bold text-slate-800 outline-none bg-transparent"
            >
              <option value="single">Página</option>
              <option value="full">Completo</option>
            </select>
          </div>

          <div className="px-3 py-2 rounded-xl bg-white border border-slate-200 flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">Pág</span>
            <input
              type="number"
              min={1}
              value={pageToProcess}
              onChange={(e) => setPageToProcess(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 text-sm font-bold text-slate-800 outline-none disabled:opacity-40"
              disabled={extractionMode === 'full'}
            />
          </div>

          <label className={`px-5 py-3 rounded-xl font-bold text-sm flex items-center gap-2 border ${
            uploading ? 'bg-slate-200 text-slate-500 border-slate-300 cursor-not-allowed' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 cursor-pointer'
          }`}>
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {uploading ? 'Canonizando PDF...' : 'Subir PDF'}
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

          <button onClick={copyJson} disabled={!result} className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50">
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'Copiado' : 'Copiar JSON'}
          </button>

          <button onClick={downloadJson} disabled={!result} className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50">
            <FileJson size={15} />
            Descargar JSON
          </button>

          <button onClick={runAudit} disabled={!hasContract || isProcessing || uploading} className="px-4 py-3 rounded-xl bg-white border border-slate-200 text-slate-700 font-bold text-sm flex items-center gap-2 disabled:opacity-50">
            <RefreshCw size={15} />
            Recalcular / Cache
          </button>

          <button onClick={clearM12Cache} className="px-4 py-3 rounded-xl bg-white border border-rose-200 text-rose-700 font-bold text-sm flex items-center gap-2">
            <Trash2 size={15} />
            Limpiar cache M12
          </button>
        </div>

        {cacheInfo && (
          <div className="text-xs font-semibold text-slate-500">{cacheInfo}</div>
        )}
        {fileName && (
          <div className="text-xs font-semibold text-slate-600 flex items-center gap-2">
            <FileText size={13} />
            {fileName}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <pre className="text-xs text-slate-800 whitespace-pre-wrap overflow-x-auto">
            {result ? pretty : 'Ejecuta M12 para generar salida estructural.'}
          </pre>
        </div>
      </div>
    </div>
  );
}
