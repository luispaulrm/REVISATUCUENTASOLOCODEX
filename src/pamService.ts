export interface PAMItem {
    codigoGC: string;
    descripcion: string;
    cantidad: string;
    valorTotal: string;
    bonificacion: string;
    copago: string;
    _audit?: string;
}

export interface PrestadorDesglose {
    nombrePrestador: string;
    items: PAMItem[];
    _totals?: {
        valor: number;
        bonif: number;
        copago: number;
    };
}

export interface PAMResumen {
    totalCopago: string;
    totalCopagoCalculado?: number;
    totalCopagoDeclarado: string;
    totalValorDeclarado?: number;
    totalBonificacionDeclarada?: number;
    revisionCobrosDuplicados: string;
    fuenteTotalDeclarado?: string;
    discrepancia?: number;
    auditoriaStatus?: string;
    cuadra?: boolean;
}

export interface FolioPAM {
    folioPAM: string;
    bonosAsociados?: string[];
    prestadorPrincipal: string;
    periodoCobro: string;
    desglosePorPrestador: PrestadorDesglose[];
    resumen: PAMResumen;
}

export interface PamDocument {
    folios: FolioPAM[];
    global: {
        totalValor: number;
        totalBonif: number;
        totalCopago: number;
        totalCopagoDeclarado: number;
        cuadra: boolean;
        discrepancia: number;
        auditoriaStatus: string;
        totalItems?: number;
    };
}

export interface UsageMetrics {
    promptTokens: number;
    candidatesTokens: number;
    totalTokens: number;
    estimatedCost: number;
    estimatedCostCLP: number;
}

export interface PamExtractionResult {
    data: PamDocument;
    usage?: UsageMetrics;
    traceId?: string;
}

export type PamWorkflowOptions = {
    analyzeAllPages?: boolean;
    pageNumber?: number;
    requireAzure?: boolean;
};

const pamInFlightRequests = new Map<string, Promise<PamExtractionResult>>();
const pamRecentResults = new Map<string, { result: PamExtractionResult; completedAt: number }>();

function buildPamRequestKey(imageData: string, mimeType: string, options: PamWorkflowOptions): string {
    const analyzeAllPages = options.analyzeAllPages !== false;
    const pageNumber = Math.max(1, Number(options.pageNumber || 1));
    const prefix = String(imageData || '').slice(0, 64);
    const suffix = String(imageData || '').slice(-64);
    return [
        mimeType,
        analyzeAllPages ? 'all-pages' : `page-${pageNumber}`,
        String(imageData || '').length,
        prefix,
        suffix
    ].join('|');
}

function buildPamTraceId(): string {
    return `pam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getPamRawPages(rawPayload: any): any[] {
    if (Array.isArray(rawPayload?.raw?.pages)) return rawPayload.raw.pages;
    if (Array.isArray(rawPayload?.pages)) return rawPayload.pages;
    return [];
}

function summarizeOcrSources(rawPayload: any): Record<string, number> {
    const pages = getPamRawPages(rawPayload);
    const summary: Record<string, number> = {};
    for (const page of pages) {
        const source = String(page?.ocrSource || 'unknown').trim().toLowerCase() || 'unknown';
        summary[source] = (summary[source] || 0) + 1;
    }
    return summary;
}

function hasAzureSource(rawPayload: any): boolean {
    const pages = getPamRawPages(rawPayload);
    return pages.some((page) => String(page?.ocrSource || '').toLowerCase() === 'azure-layout');
}

function listAzurePages(rawPayload: any): number[] {
    const pages = getPamRawPages(rawPayload);
    return pages
        .filter((page) => String(page?.ocrSource || '').toLowerCase() === 'azure-layout')
        .map((page) => Number(page?.pageNumber || 0))
        .filter((page) => Number.isFinite(page) && page > 0);
}

async function fetchPamRawPayload(
    imageData: string,
    signal: AbortSignal | undefined,
    options: PamWorkflowOptions,
    traceId: string,
    onLog?: (msg: string) => void,
    onProgress?: (progress: number) => void
): Promise<any> {
    const analyzeAllPages = options.analyzeAllPages !== false;
    const pageNumber = Math.max(1, Number(options.pageNumber || 1));
    const requireAzure = options.requireAzure !== false;

    onLog?.(`[SYSTEM] Workflow Bill/PAM: OCR RAW previo (${analyzeAllPages ? 'documento completo' : `pagina ${pageNumber}`})...`);
    onProgress?.(15);

    const response = await fetch('/api/extract-raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image: imageData,
            mimeType: 'application/pdf',
            maxPages: analyzeAllPages ? 0 : 1,
            page: analyzeAllPages ? 0 : pageNumber,
            mode: 'fast',
            renderScale: 1.4,
            traceId: `${traceId}:raw`
        }),
        signal
    });

    if (!response.ok) {
        let detail = '';
        try {
            const body = await response.json();
            detail = body?.error ? String(body.error) : '';
        } catch {
            // noop
        }
        throw new Error(`RAW OCR PAM fallo (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const payload = await response.json();
    const processedPages = Number(payload?.raw?.processedPages || payload?.processedPages || getPamRawPages(payload).length || 0);
    onLog?.(`[SYSTEM] OCR RAW listo: ${processedPages} pagina(s) procesadas.`);
    const sourceSummary = summarizeOcrSources(payload);
    onLog?.(`[SYSTEM] OCR source: ${JSON.stringify(sourceSummary)}`);
    const azurePages = listAzurePages(payload);
    if (azurePages.length > 0) {
        onLog?.(`[AZURE] Azure layout activo en paginas: ${azurePages.join(', ')}`);
    } else {
        onLog?.('[AZURE] Azure layout no detectado en RAW OCR.');
    }
    if (requireAzure && !hasAzureSource(payload)) {
        throw new Error(
            'PAM requiere Azure, pero RAW OCR no devolvio paginas con ocrSource=azure-layout. ' +
            'Revisa AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/KEY en backend.'
        );
    }
    onProgress?.(25);
    return payload;
}

async function validatePamDocumentFirst(
    imageData: string,
    mimeType: string,
    traceId: string,
    signal: AbortSignal | undefined,
    onLog?: (msg: string) => void
): Promise<{ ok: true; detectedType: string; reason: string }> {
    onLog?.(`[SYSTEM] Trace PAM: ${traceId}`);
    onLog?.('[SYSTEM] Validando si el documento corresponde a PAM (antes de Azure)...');
    const response = await fetch('/api/validate-pam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image: imageData,
            mimeType,
            traceId
        }),
        signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
        const detectedType = String(payload?.detectedType || 'UNKNOWN');
        const reason = String(payload?.reason || payload?.error || 'Validation rejected');
        throw new Error(`VALIDACION FALLIDA PRE-AZURE: detectado=${detectedType}. ${reason}`);
    }

    const detected = String(payload?.detectedType || 'PAM');
    onLog?.(`[SYSTEM] Documento validado como ${detected}. Continua workflow Azure.`);
    return {
        ok: true,
        detectedType: detected,
        reason: String(payload?.reason || '')
    };
}

export async function extractPamData(
    imageData: string,
    mimeType: string,
    onLog?: (msg: string) => void,
    onUsageUpdate?: (usage: UsageMetrics) => void,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
    options: PamWorkflowOptions = {}
): Promise<PamExtractionResult> {
    const requestKey = buildPamRequestKey(imageData, mimeType, options);
    const cachedResult = pamRecentResults.get(requestKey);
    if (cachedResult && Date.now() - cachedResult.completedAt < 4000) {
        onLog?.('[SYSTEM] Reutilizando resultado PAM reciente para evitar doble corrida.');
        onProgress?.(100);
        if (cachedResult.result.usage) {
            onUsageUpdate?.(cachedResult.result.usage);
        }
        return cachedResult.result;
    }

    const inFlightRequest = pamInFlightRequests.get(requestKey);
    if (inFlightRequest) {
        onLog?.('[SYSTEM] Corrida PAM duplicada detectada. Reutilizando proceso en curso.');
        return inFlightRequest;
    }

    const runPromise = (async (): Promise<PamExtractionResult> => {
        onLog?.('[SYSTEM] Iniciando analisis de Coberturas PAM...');
        onProgress?.(5);
        onLog?.('[SYSTEM] Aplicando esquema de bonificacion Isapre/Aseguradora...');
        onProgress?.(10);
        const traceId = buildPamTraceId();
        onLog?.(`[SYSTEM] Trace PAM asignado: ${traceId}`);

        const effectiveMimeType = String(mimeType || '').trim().toLowerCase() || 'application/pdf';
        const preValidation = await validatePamDocumentFirst(imageData, effectiveMimeType, traceId, signal, onLog);
        const rawPayload = effectiveMimeType === 'application/pdf'
            ? await fetchPamRawPayload(imageData, signal, options, traceId, onLog, onProgress)
            : null;

        if (rawPayload) {
            try {
                localStorage.setItem('pam_audit_raw_result', JSON.stringify(rawPayload));
            } catch {
                // ignore storage quota or serialization issues
            }
        }

        const response = await fetch('/api/extract-pam', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageData,
                mimeType: effectiveMimeType,
                rawPayload,
                preValidation,
                traceId
            }),
            signal
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Error en servidor PAM');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No se pudo establecer stream');

        const decoder = new TextDecoder();
        let resultData: PamDocument | null = null;
        let partialBuffer = '';
        let latestUsage: UsageMetrics | null = null;

        let watchdogTimer: number | null = null;
        let lastActivity = Date.now();

        const checkHealth = () => {
            if (Date.now() - lastActivity > 20000) {
                onLog?.('[SYSTEM] Esperando respuesta del modelo...');
            }
        };

        watchdogTimer = window.setInterval(checkHealth, 5000);

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                partialBuffer += decoder.decode(value, { stream: true });
                lastActivity = Date.now();
                const lines = partialBuffer.split('\n');
                partialBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const update = JSON.parse(line);

                        switch (update.type) {
                            case 'usage':
                                latestUsage = update.usage;
                                onUsageUpdate?.(update.usage);
                                onLog?.(`[API] Tokens: ${update.usage.totalTokens} | Costo: $${update.usage.estimatedCostCLP} CLP`);
                                break;
                            case 'log':
                                onLog?.(update.message);
                                break;
                            case 'progress':
                                if (update.progress !== undefined) onProgress?.(update.progress);
                                break;
                            case 'chunk':
                                if (update.text) onLog?.(update.text);
                                break;
                            case 'final':
                                onProgress?.(95);
                                resultData = update.data;
                                break;
                            case 'error':
                                throw new Error(update.message);
                        }
                    } catch (error: any) {
                        console.error('Error parsing NDJSON:', error);
                        if (error.message && !error.message.includes('JSON')) throw error;
                    }
                }
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                onLog?.('[SYSTEM] Proceso cancelado por el usuario.');
                throw error;
            }
            throw error;
        } finally {
            if (watchdogTimer) clearInterval(watchdogTimer);
            reader.releaseLock();
        }

        if (!resultData) throw new Error('No se recibio resultado PAM estructurado');

        onLog?.('[SYSTEM] Analisis PAM completado con exito');
        onLog?.(`[SYSTEM] Folios encontrados: ${resultData.folios.length}`);

        return {
            data: resultData,
            usage: latestUsage || undefined,
            traceId
        };
    })();

    pamInFlightRequests.set(requestKey, runPromise);

    try {
        const result = await runPromise;
        pamRecentResults.set(requestKey, { result, completedAt: Date.now() });
        return result;
    } finally {
        if (pamInFlightRequests.get(requestKey) === runPromise) {
            pamInFlightRequests.delete(requestKey);
        }
    }
}
