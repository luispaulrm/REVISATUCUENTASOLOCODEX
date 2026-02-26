import { Request, Response } from 'express';
import { analyzeSingleContract } from '../services/contractEngine.service.js';
import { transformToCanonical } from '../services/canonicalTransform.service.ts';
import { registerProcessedContract, getContractCount } from '../services/contractLearning.service.ts';
import { ContractLayoutExtractorA } from '../services/contractLayoutExtractorA.service.js';
import { ContractAuditorB } from '../services/contractAuditorB.service.js';
import { GeminiService } from '../services/gemini.service.js';
import { AuditorBResult } from '../services/contractTypes.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { calculatePrice } from '../config/ai.config.js';

function envGet(k: string) {
    const v = process.env[k];
    return typeof v === "string" ? v : undefined;
}

const MAX_PAGES_HIGH_FIDELITY = 15; // Safe limit for high-fidelity extraction
const PDF_RENDER_SCALE = 2.0;

type PageInput = { image: string; mimeType: string };

function parseTokenCount(raw: string): number {
    return Number(String(raw || '').replace(/[^\d]/g, '')) || 0;
}

async function renderPdfPagesToPng(
    buffer: Buffer,
    totalPages: number
): Promise<PageInput[]> {
    const { createCanvas } = await import('@napi-rs/canvas');
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(buffer),
        disableFontFace: true,
        useSystemFonts: true,
        disableWorker: true,
        verbosity: 0,
    } as any);
    const pdf = await loadingTask.promise;
    const pagesToRender = Math.min(pdf.numPages, totalPages);
    const rendered: PageInput[] = [];

    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');

        await page.render({
            canvasContext: context as any,
            viewport
        } as any).promise;

        const dataUrl = canvas.toDataURL('image/png');
        rendered.push({
            image: dataUrl.split(',')[1],
            mimeType: 'image/png'
        });
    }

    return rendered;
}

export async function handleCanonicalExtraction(req: Request, res: Response) {
    console.log('[CANONICAL] New Extraction Request');

    // Setup streaming for logs (reusing existing UI logic)
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendUpdate = (data: any) => {
        res.write(JSON.stringify(data) + '\n');
    };

    try {
        const { image, mimeType, originalname, strategy } = req.body;
        if (!image || !mimeType) {
            return res.status(400).json({ error: 'Missing image/pdf data' });
        }

        const apiKey = envGet("GEMINI_API_KEY") || envGet("API_KEY") || '';
        if (!apiKey) return res.status(500).json({ error: 'API Key not configured' });

        const buffer = Buffer.from(image, 'base64');
        const file = { buffer, mimetype: mimeType, originalname: originalname || 'contrato.pdf' };
        let pagesToProcess: PageInput[] = [{ image, mimeType }];
        let detectedPdfPages = 1;

        if (mimeType === 'application/pdf') {
            try {
                const loadingTask = pdfjsLib.getDocument({
                    data: new Uint8Array(buffer),
                    disableFontFace: true,
                    useSystemFonts: true,
                    disableWorker: true,
                    verbosity: 0,
                } as any);
                const pdf = await loadingTask.promise;
                detectedPdfPages = Math.min(pdf.numPages, MAX_PAGES_HIGH_FIDELITY);
                console.log(`[CANONICAL] PDF detected with ${pdf.numPages} pages. Processing ${detectedPdfPages} pages.`);

                if (detectedPdfPages > 1) {
                    pagesToProcess = [];
                    for (let i = 1; i <= detectedPdfPages; i++) {
                        pagesToProcess.push({ image, mimeType });
                    }
                }
            } catch (err) {
                console.error('[CANONICAL] Error reading PDF page count:', err);
            }
        }

        if (strategy === 'GRID_GEOMETRY') {
            sendUpdate({ type: 'chunk', text: `🚀 ACTIVANDO TECNOLOGÍA A (Geometría Determinista) - ${pagesToProcess.length} páginas detectadas...` });

            if (mimeType === 'application/pdf') {
                try {
                    sendUpdate({ type: 'chunk', text: `[SISTEMA] PDF detectado. Convirtiendo ${detectedPdfPages} página(s) a PNG para OpenAI Vision...` });
                    pagesToProcess = await renderPdfPagesToPng(buffer, detectedPdfPages);
                    sendUpdate({ type: 'chunk', text: `[SISTEMA] Conversión PDF→PNG completada. ${pagesToProcess.length} imagen(es) listas para extracción.` });
                } catch (renderErr: any) {
                    console.error('[CANONICAL] PDF render error:', renderErr);
                    throw new Error(`No se pudo convertir PDF a imágenes para OpenAI: ${renderErr?.message || 'error desconocido'}`);
                }
            }

            // Standardized key discovery
            const apiKeys = GeminiService.discoverKeys();

            if (apiKeys.length === 0) {
                throw new Error(
                    'No hay API keys disponibles para procesar la extracción canónica.'
                );
            }

            let activeModel = 'gpt-4o';
            const gridUsage = {
                input: 0,
                output: 0,
                costUSD: 0,
                costCLP: 0
            };

            const streamLog = (msg: string, prefix = '') => {
                const text = `${prefix}${msg}`;
                sendUpdate({ type: 'chunk', text });

                const modelMatch = text.match(/modelo\s+([a-zA-Z0-9._-]+)/i);
                if (modelMatch?.[1]) {
                    activeModel = modelMatch[1];
                }

                const tokenMatch = text.match(/Tokens\s*-\s*Input:\s*([^,]+)\s*,\s*Output:\s*([^,]+)\s*,/i);
                if (tokenMatch) {
                    const input = parseTokenCount(tokenMatch[1]);
                    const output = parseTokenCount(tokenMatch[2]);
                    const pricing = calculatePrice(input, output, activeModel);

                    gridUsage.input += input;
                    gridUsage.output += output;
                    gridUsage.costUSD += pricing.costUSD;
                    gridUsage.costCLP += pricing.costCLP;

                    sendUpdate({
                        type: 'metrics',
                        metrics: {
                            input,
                            output,
                            cost: Math.round(pricing.costCLP),
                            costUSD: pricing.costUSD,
                            model: activeModel
                        }
                    });
                }
            };

            const gemini = new GeminiService(
                apiKeys,
                (msg) => streamLog(msg),
                { supplementEnvKeys: false }
            );
            const extractorA = new ContractLayoutExtractorA(gemini, (msg) => streamLog(msg, '[PASO 1] '));
            const auditorB = new ContractAuditorB(gemini, (msg) => streamLog(msg, '[PASO 2] '));

            sendUpdate({ type: 'chunk', text: '[PASO 1] Iniciando Extracción de Geometría...' });
            const layoutDoc = await extractorA.extractDocLayout(
                pagesToProcess,
                'DOC_' + Date.now(),
                file.originalname
            );

            sendUpdate({ type: 'chunk', text: '[PASO 2] Ejecutando Auditor Semántico...' });
            const result = await auditorB.auditLayout(layoutDoc);

            // Transform AuditorBResult to the canonical format (simplified for now)
            // or just return the AuditorBResult directly if the UI understands it.
            // For now, let's keep the AuditorBResult as the "final" data.
            const gridMetrics = {
                strategy: 'GRID_GEOMETRY',
                tokenUsage: {
                    input: gridUsage.input,
                    output: gridUsage.output,
                    total: gridUsage.input + gridUsage.output,
                    costClp: Math.round(gridUsage.costCLP),
                    costUsd: Number(gridUsage.costUSD.toFixed(6)),
                    totalPages: pagesToProcess.length,
                    phaseSuccess: {
                        EXTRACTOR_A: true,
                        AUDITOR_B: true
                    }
                },
                extractionBreakdown: {
                    totalItems: Array.isArray((result as any)?.items) ? (result as any).items.length : 0
                }
            };

            sendUpdate({
                type: 'final',
                data: result,
                metrics: gridMetrics,
                totalCount: await registerProcessedContract(`${file.originalname}|${file.buffer.length}`)
            });

        } else {
            // 1. Run full fidelity extraction (Legacy V2)
            const result = await analyzeSingleContract(
                file,
                apiKey,
                (logMsg) => {
                    if (logMsg.startsWith('@@METRICS@@')) {
                        try {
                            const metrics = JSON.parse(logMsg.replace('@@METRICS@@', ''));
                            sendUpdate({ type: 'metrics', metrics });
                        } catch (e) {
                            console.error('[CANONICAL] Failed to parse metrics:', e);
                        }
                    } else {
                        sendUpdate({ type: 'chunk', text: logMsg });
                    }
                }
            );

            // 2. Transform to Canonical JSON
            const canonicalResult = transformToCanonical(result);

            // 3. Register as processed unique contract (fingerprint: name|size)
            const fingerprint = `${file.originalname}|${file.buffer.length}`;
            const totalCount = await registerProcessedContract(fingerprint);

            // 4. Send final canonical data
            sendUpdate({
                type: 'final',
                data: canonicalResult,
                metrics: result.metrics,
                totalCount
            });
        }

        res.end();

    } catch (error: any) {
        console.error('[CANONICAL] Error:', error);
        sendUpdate({ type: 'error', message: error.message });
        res.end();
    }
}
