import { Request, Response } from 'express';
import { ProjectionService } from '../services/projection.service.js';

// ✅ Railway-compatible env access
function envGet(k: string) {
    const v = process.env[k];
    return typeof v === "string" ? v : undefined;
}

// Helper to get OpenAI API keys
const getApiKeys = () => {
    const keys = [];
    if (envGet("OPENAI_API_KEY")) keys.push(envGet("OPENAI_API_KEY"));
    if (envGet("OPENAI_API_KEY_SECONDARY")) keys.push(envGet("OPENAI_API_KEY_SECONDARY"));
    if (envGet("OPENAI_API_KEY_TERTIARY")) keys.push(envGet("OPENAI_API_KEY_TERTIARY"));
    // Backward-compat fallback only if it is an OpenAI key
    if (envGet("API_KEY")?.startsWith("sk-")) keys.push(envGet("API_KEY"));
    // Deduplicate
    return [...new Set(keys)].filter(k => !!k);
};

export async function handleProjection(req: Request, res: Response) {
    console.log('[PROJECTION] New PDF-to-HTML projection request');

    // Setup streaming response
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendUpdate = (data: any) => {
        if (!res.writableEnded) {
            res.write(JSON.stringify(data) + '\n');
        }
    };

    try {
        const { image, mimeType, mode, format } = req.body;

        if (!image || !mimeType) {
            sendUpdate({ type: 'error', error: 'Missing image or mimeType' });
            return res.end();
        }


        let pageCount = 0;
        if (mimeType === 'application/pdf') {
            try {
                const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
                const data = new Uint8Array(Buffer.from(image, 'base64'));
                const loadingTask = pdfjsLib.getDocument({
                    data,
                    disableFontFace: true,
                    useSystemFonts: false
                });
                const pdf = await loadingTask.promise;
                pageCount = pdf.numPages;
                console.log(`[PROJECTION] PDF detected with ${pageCount} pages`);
            } catch (pdfError: any) {
                console.error('[PROJECTION] Error counting segments:', pdfError.message);
            }
        }

        const apiKeys = getApiKeys();
        if (apiKeys.length === 0) {
            sendUpdate({ type: 'error', error: 'API Key not configured' });
            return res.end();
        }

        // --- VALIDATION LAYER START ---
        // Dynamically determine expected type based on "mode"
        // 'BILL_ONLY' -> CUENTA
        // 'FULL' -> CONTRATO (though sometimes it could be a full cuenta, validation service handles ambiguity if needed or we default to 'CONTRATO' for full docs as per current UI flow which uses 'FULL' for contracts)
        // User flow usually is: "Analizar Cuenta" (BILL_ONLY) or "Analizar Contrato" (FULL).
        // Let's enforce strict mapping.

        let expectedType: 'CUENTA' | 'PAM' | 'CONTRATO' = 'CONTRATO';
        if (mode === 'BILL_ONLY') {
            expectedType = 'CUENTA';
        } else if (mode === 'PAM') {
            // If the UI sends PAM mode (which it might in future or if we adapt this endpoint for PAM too)
            expectedType = 'PAM';
        } else {
            // Default to CONTRATO for "FULL" mode, but we should be careful. 
            // If the user uploads a PAM in FULL mode, we should probably allow it if we accept PAMs via this endpoint.
            // But currently projection is used for Contracts (FULL) and Bills (BILL_ONLY).
            // Let's assume FULL = CONTRATO for now as per "Proyectar Contrato" usage.
            expectedType = 'CONTRATO';
        }


        const { ValidationService } = await import('../services/validation.service.js');
        const validationService = new ValidationService(apiKeys[0]); // Use first key

        sendUpdate({ type: 'log', text: `🕵️ Validando si el documento es realmente un ${expectedType}...` });

        const validation = await validationService.validateDocumentType(image, mimeType, expectedType);

        // GRACEFUL FALLBACK: If validation fails due to SERVICE ERROR (503/429), allow projection with warning
        // But if it fails due to WRONG DOCUMENT TYPE, still block
        if (!validation.isValid) {
            const isServiceError = validation.detectedType === "ERROR" ||
                validation.reason.includes('503') ||
                validation.reason.includes('429') ||
                validation.reason.includes('overloaded');

            if (isServiceError) {
                // SERVICE ERROR: Allow projection but warn user
                console.warn(`[VALIDATION] Service error, bypassing validation. Reason: ${validation.reason}`);
                sendUpdate({
                    type: 'log',
                    text: `⚠️ Validación omitida por error del servicio. Proyectando de todos modos...`
                });
            } else {
                // LEGITIMATE REJECTION: Block projection
                console.warn(`[VALIDATION] REJECTED. Detected: ${validation.detectedType}. Expected: ${expectedType}. Reason: ${validation.reason}`);
                sendUpdate({
                    type: 'error',
                    error: `VALIDACIÓN FALLIDA: Se esperaba un documento tipo ${expectedType}, pero se detectó "${validation.detectedType}". (${validation.reason})`
                });
                return res.end();
            }
        } else {
            sendUpdate({ type: 'log', text: `✅ Documento validado correctamente (${validation.detectedType}).` });
        }
        // --- VALIDATION LAYER END ---


        const projectionService = new ProjectionService(apiKeys);

        console.log('[PROJECTION] Starting projection stream...', { mode, pageCount });
        sendUpdate({ type: 'log', text: `Iniciando proyector maestro (${mode || 'FULL'}) | ${pageCount || '?'} págs...` });

        const stream = projectionService.projectPdfToHtml(image, mimeType, undefined, mode, pageCount, format);


        for await (const chunk of stream) {
            sendUpdate(chunk);
        }

        console.log('[PROJECTION] Projection complete');
        res.end();

    } catch (error: any) {
        console.error('[PROJECTION] Error in endpoint:', error);
        sendUpdate({ type: 'error', error: error.message || 'Internal Server Error' });
        res.end();
    }
}
