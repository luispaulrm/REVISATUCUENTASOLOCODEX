import OpenAI from 'openai';
import { AI_CONFIG, calculatePrice } from '../config/ai.config.js';
import {
    PROMPT_PROYECCION_JSON,
    PROMPT_CUENTA_JSON
} from './contractConstants.js';

const BILL_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        paciente: {
            type: 'object',
            additionalProperties: false,
            properties: {
                nombre: { type: 'string' },
                rut: { type: 'string' },
                folio: { type: 'string' },
                total_cuenta: { type: 'number' }
            }
        },
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    seccion: { type: 'string' },
                    codigo: { type: 'string' },
                    descripcion: { type: 'string' },
                    cantidad: { type: 'number' },
                    precioUnitario: { type: 'number' },
                    total: { type: 'number' },
                    index: { type: 'number' }
                },
                required: ['descripcion', 'total']
            }
        }
    },
    required: ['items']
};

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpenAIModel(modelName: string): boolean {
    return /^gpt-/i.test(String(modelName || '').trim());
}

function getModelCandidates(requestedModel: string): string[] {
    const configuredFallbacks = Array.isArray(AI_CONFIG.FALLBACK_MODELS) ? AI_CONFIG.FALLBACK_MODELS : [];
    const defaults = ['gpt-4o', 'gpt-4o-mini'];
    const raw = [requestedModel, AI_CONFIG.ACTIVE_MODEL, ...configuredFallbacks, ...defaults]
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim());

    const openAIOnly = raw.filter(isOpenAIModel);
    return [...new Set(openAIOnly)];
}

function buildContent(prompt: string, image: string, mimeType: string): any[] {
    const content: any[] = [{ type: 'input_text', text: prompt }];
    const safeMime = String(mimeType || '').toLowerCase();

    if (safeMime.includes('pdf')) {
        content.push({
            type: 'input_file',
            filename: 'projection-document.pdf',
            file_data: `data:application/pdf;base64,${image}`
        });
        return content;
    }

    if (safeMime.startsWith('image/')) {
        content.push({
            type: 'input_image',
            image_url: `data:${safeMime};base64,${image}`
        });
    }

    return content;
}

export interface ProjectionChunk {
    type: 'chunk' | 'usage' | 'error' | 'log';
    text?: string;
    usage?: {
        promptTokens: number;
        candidatesTokens: number;
        totalTokens: number;
        estimatedCost: number;
        estimatedCostCLP: number;
    };
    error?: string;
}

export class ProjectionService {
    private keys: string[];

    constructor(apiKeyOrKeys: string | string[]) {
        this.keys = (Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys])
            .filter((k) => typeof k === 'string' && k.trim().length > 0);
    }

    async *projectPdfToHtml(
        image: string,
        mimeType: string,
        modelName: string = 'gpt-4o',
        mode: 'FULL' | 'BILL_ONLY' = 'FULL',
        pageCount: number = 0,
        format: 'html' | 'json' = 'html'
    ): AsyncIterable<ProjectionChunk> {
        let fullContent = '';
        let isFinalized = false;
        let pass = 0;
        const maxPasses = format === 'json' ? 1 : 30;

        while (!isFinalized && pass < maxPasses) {
            pass++;
            yield { type: 'log', text: `[IA] Iniciando Pase ${pass}/${maxPasses} con OpenAI...` };

            const isBillOnly = mode === 'BILL_ONLY';
            const prompt = pass === 1
                ? (format === 'json'
                    ? (isBillOnly ? PROMPT_CUENTA_JSON : PROMPT_PROYECCION_JSON)
                    : `
                ACT AS A HIGH-FIDELITY DOCUMENT PROJECTOR (OCR CALCO MODE).
                TOTAL PAGES IN DOCUMENT: ${pageCount || 'Unknown'}
                ${isBillOnly ? 'TARGET: Project ONLY the clinical bill/account content.' : 'PROCESS EVERY PAGE from beginning to end.'}
                Return ONLY HTML content. Do not add explanations.
                `)
                : `
                CONTINUE PROJECTING THE DOCUMENT EXACTLY FROM THE LAST POINT.
                DO NOT REPEAT CONTENT.
                If there is no remaining content, output "<!-- END_OF_DOCUMENT -->".
                LAST PROJECTED CONTENT (CONTEXT):
                "...${fullContent.slice(-4000)}"
                `;

            const modelsToTry = getModelCandidates(modelName);
            let passSuccess = false;
            let passError: any = null;

            for (const currentModel of modelsToTry) {
                if (passSuccess) break;
                for (let keyIdx = 0; keyIdx < this.keys.length; keyIdx++) {
                    if (passSuccess) break;
                    const currentKey = this.keys[keyIdx];
                    const keyMask = `${currentKey.substring(0, 4)}...`;

                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            if (attempt > 1 || keyIdx > 0 || currentModel !== modelName) {
                                yield {
                                    type: 'log',
                                    text: `[IA] Estrategia OpenAI: Modelo ${currentModel} | Key ${keyIdx + 1}/${this.keys.length} (${keyMask}) | Intento ${attempt}/3`
                                };
                            }

                            const client = new OpenAI({ apiKey: currentKey });
                            const request: any = {
                                model: currentModel,
                                temperature: 0,
                                max_output_tokens: format === 'json' ? 12000 : 16000,
                                input: [
                                    {
                                        role: 'user',
                                        content: buildContent(prompt, image, mimeType)
                                    }
                                ]
                            };

                            if (format === 'json') {
                                if (isBillOnly) {
                                    request.text = {
                                        format: {
                                            type: 'json_schema',
                                            name: 'clinical_bill_projection',
                                            strict: false,
                                            schema: BILL_JSON_SCHEMA
                                        }
                                    };
                                } else {
                                    request.text = { format: { type: 'json_object' } };
                                }
                            }

                            const response = await client.responses.create(request);
                            const outputText = String((response as any)?.output_text || '').trim();
                            if (!outputText) {
                                throw new Error('OpenAI devolvio salida vacia');
                            }

                            const cleanChunk = outputText.replace('<!-- END_OF_DOCUMENT -->', '').trim();
                            fullContent += cleanChunk;

                            if (cleanChunk) {
                                yield { type: 'chunk', text: cleanChunk };
                            }

                            const usage = (response as any)?.usage || {};
                            const promptTokens = Number(usage?.input_tokens || 0);
                            const candidatesTokens = Number(usage?.output_tokens || 0);
                            const totalTokens = Number(usage?.total_tokens || (promptTokens + candidatesTokens));
                            const { costUSD, costCLP } = calculatePrice(promptTokens, candidatesTokens, currentModel);
                            yield {
                                type: 'usage',
                                usage: {
                                    promptTokens,
                                    candidatesTokens,
                                    totalTokens,
                                    estimatedCost: costUSD,
                                    estimatedCostCLP: costCLP
                                }
                            };

                            if (format === 'json' || outputText.includes('<!-- END_OF_DOCUMENT -->')) {
                                isFinalized = true;
                                yield { type: 'log', text: `[IA] Proyeccion finalizada en pase ${pass}.` };
                            } else if (cleanChunk.length < 20) {
                                isFinalized = true;
                                yield { type: 'log', text: '[IA] Finalizacion por salida marginal (sin contenido nuevo util).' };
                            } else {
                                yield { type: 'log', text: `[IA] Pase ${pass} completado. Solicitando continuacion...` };
                            }

                            passSuccess = true;
                            break;
                        } catch (err: any) {
                            passError = err;
                            const status = Number(err?.status || err?.statusCode || 0);
                            const msg = String(err?.message || err || '');
                            const isRetryable = status === 429 || status === 503 || /timeout/i.test(msg);
                            if (isRetryable) {
                                yield { type: 'log', text: `[IA] OpenAI ${status || 'timeout'} en ${currentModel}. Rotando key/modelo...` };
                                break;
                            }
                            if (attempt < 3) {
                                await delay(1200 * attempt);
                                continue;
                            }
                        }
                    }
                }
            }

            if (!passSuccess) {
                const errMsg = passError?.message || 'Error projecting PDF with OpenAI';
                yield { type: 'error', error: errMsg };
                break;
            }
        }
    }
}
