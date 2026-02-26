import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import { AI_CONFIG, AI_MODELS, calculatePrice, getSafeMaxTokensForModel } from '../config/ai.config.js';
import { OpenAIService } from './openai.service.js';

export interface StreamChunk {
    text: string;
    usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    };
}

export interface KeyConfig {
    provider: 'google' | 'openai';
    key: string;
}

export interface GeminiServiceOptions {
    supplementEnvKeys?: boolean;
}

export class GeminiService {
    private keyConfigs: KeyConfig[] = [];
    private activeKeyIndex: number = 0;
    private client: GoogleGenerativeAI;
    private logCallback?: (msg: string) => void;

    constructor(
        apiKeyOrKeys?: string | string[] | KeyConfig[],
        logCallback?: (msg: string) => void,
        options: GeminiServiceOptions = {}
    ) {
        this.logCallback = logCallback;
        const supplementEnvKeys = options.supplementEnvKeys ?? true;

        // 1. If keys are provided, use them.
        if (apiKeyOrKeys) {
            const inputs = Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys];
            for (const input of inputs) {
                if (typeof input === 'string' && input.length > 5) {
                    this.keyConfigs.push({ provider: 'google', key: input });
                } else if (input && typeof input === 'object' && (input as any).key) {
                    this.keyConfigs.push({
                        provider: (input as any).provider || 'google',
                        key: (input as any).key
                    });
                }
            }
        }

        // 2. Supplement with environment keys if not already present
        if (supplementEnvKeys) {
            const envKeys = GeminiService.discoverKeys();
            for (const config of envKeys) {
                if (!this.keyConfigs.some(c => c.key === config.key)) {
                    this.keyConfigs.push(config);
                }
            }
        }

        if (this.keyConfigs.length === 0) {
            console.error("❌ GeminiService started with NO VALID KEYS");
        }

        // Initialize default client
        const firstGoogleKey = this.keyConfigs.find(c => c.provider === 'google')?.key || "DUMMY_KEY";
        this.client = new GoogleGenerativeAI(firstGoogleKey);
    }

    static discoverKeys(): KeyConfig[] {
        const getEnv = (k: string) => typeof process !== 'undefined' && process.env ? process.env[k] : undefined;
        const keys: KeyConfig[] = [];

        const googleKeys = [
            getEnv("GEMINI_API_KEY"),
            getEnv("API_KEY"),
            getEnv("GEMINI_API_KEY_SECONDARY"),
            getEnv("GEMINI_API_KEY_TERTIARY"),
            getEnv("GEMINI_API_KEY_QUATERNARY"),
            getEnv("GEMINI_API_KEY_QUINARY")
        ];

        for (const k of googleKeys) {
            if (k && k.length > 5 && !keys.some(c => c.key === k)) {
                keys.push({ provider: 'google', key: k });
            }
        }

        const openAIKey = getEnv("OPENAI_API_KEY");
        if (openAIKey && openAIKey.length > 5 && !keys.some(c => c.key === openAIKey)) {
            keys.push({ provider: 'openai', key: openAIKey });
        }

        return keys;
    }

    private isModelOpenAI(modelName: string): boolean {
        return modelName.toLowerCase().startsWith('gpt') || modelName.toLowerCase().includes('gpt');
    }

    private log(msg: string) {
        if (this.logCallback) this.logCallback(msg);
        console.log(`[GeminiService] ${msg}`);
    }

    private getModelsToTry(): string[] {
        const baseModels = [
            AI_CONFIG.ACTIVE_MODEL,
            ...AI_CONFIG.FALLBACK_MODELS
        ].filter((m): m is string => Boolean(m));

        const models = [...baseModels];
        const hasGoogleKey = this.keyConfigs.some(c => c.provider === 'google');
        const hasOpenAIKey = this.keyConfigs.some(c => c.provider === 'openai');

        const hasGoogleModel = models.some(m => !this.isModelOpenAI(m));
        const hasOpenAIModel = models.some(m => this.isModelOpenAI(m));

        if (hasGoogleKey && !hasGoogleModel) {
            models.push('gemini-3-flash-preview', 'gemini-3.1-pro-preview');
        }

        if (hasOpenAIKey && !hasOpenAIModel) {
            models.push(AI_MODELS.openai_primary, AI_MODELS.openai_mini);
        }

        return Array.from(new Set(models));
    }

    async extract(
        image: string,
        mimeType: string,
        prompt: string,
        config: {
            maxTokens?: number;
            responseMimeType?: string;
            responseSchema?: any;
            temperature?: number;
            topP?: number;
            topK?: number;
        } = {}
    ): Promise<string> {
        let lastError: any;
        const modelsToTry = this.getModelsToTry();

        for (const modelName of modelsToTry) {
            if (!modelName) continue;
            const isModelOpenAI = this.isModelOpenAI(modelName);
            this.log(`🛡️ Estrategia: Intentando extracción con modelo ${modelName} (${isModelOpenAI ? 'OpenAI' : 'Google'})`);

            // Find valid keys for this model
            const validKeys = this.keyConfigs.filter(c =>
                (isModelOpenAI && c.provider === 'openai') ||
                (!isModelOpenAI && c.provider === 'google')
            );

            if (validKeys.length === 0) {
                this.log(`⚠️ No keys found for ${isModelOpenAI ? 'OpenAI' : 'Google'}. skipping.`);
                continue;
            }

            for (let i = 0; i < validKeys.length; i++) {
                const keyIdx = (this.activeKeyIndex + i) % validKeys.length;
                const { provider, key: currentKey } = validKeys[keyIdx];
                const mask = currentKey ? (currentKey.substring(0, 4) + '...') : '???';

                try {
                    if (provider === 'openai' && mimeType === 'application/pdf') {
                        this.log(`ℹ️ OpenAI Vision no soporta PDF directo. Saltando a proveedor Google para este archivo.`);
                        continue;
                    }

                    if (provider === 'openai') {
                        // ✅ NUEVO: Usar OpenAIService para manejo correcto
                        const openaiSvc = new OpenAIService(currentKey, (msg) => this.log(msg));
                        const safeMaxTokens = getSafeMaxTokensForModel(modelName);
                        const maxTokens = Math.min(config.maxTokens || safeMaxTokens, safeMaxTokens);
                        
                        const text = await openaiSvc.extract(image, mimeType, prompt, {
                            model: modelName,
                            maxTokens: maxTokens,
                            temperature: config.temperature || 0.1,
                            jsonMode: config.responseMimeType === 'application/json'
                        });
                        
                        this.log(`✅ Éxito con OpenAI ${modelName} (${text.length} chars)`);
                        this.activeKeyIndex = keyIdx;
                        return text;
                    } else {
                        this.client = new GoogleGenerativeAI(currentKey);
                        const model = this.client.getGenerativeModel({
                            model: modelName,
                            generationConfig: {
                                maxOutputTokens: Math.min(config.maxTokens || 8000, 8000),
                                responseMimeType: config.responseMimeType,
                                responseSchema: config.responseSchema,
                                temperature: config.temperature,
                                topP: config.topP,
                                topK: config.topK
                            }
                        });

                        this.log(`🚀 Enviando solicitud a ${modelName}... (Llave ${mask})`);

                        const timeoutMs = 90000;
                        const extractionPromise = model.generateContent([{ text: prompt }, ...(image && mimeType ? [{
                            inlineData: { data: image, mimeType: mimeType }
                        }] : [])]);

                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error(`Timeout: Gemini ${modelName} did not respond in ${timeoutMs / 1000}s`)), timeoutMs);
                        });

                        const result = await Promise.race([extractionPromise, timeoutPromise]) as any;
                        const text = result.response.text();
                        this.log(`✅ Éxito con Llave ${mask} en ${modelName} (${text.length} chars)`);
                        this.activeKeyIndex = keyIdx;
                        return text;
                    }
                } catch (err: any) {
                    lastError = err;
                    const errStr = (err?.toString() || "") + (err?.message || "");
                    const isQuota = errStr.includes('429') || errStr.includes('Too Many Requests') || err?.status === 429 || err?.status === 503;
                    const isTimeout = errStr.includes('Timeout') || errStr.includes('deadline');
                    const isInvalid = errStr.includes('404') || errStr.includes('not found') || errStr.includes('400');

                    if (isQuota) {
                        this.log(`⚠️ Error de cuota en Llave ${mask}. Probando siguiente...`);
                        continue;
                    } else if (isTimeout) {
                        this.log(`⏱️ Tiempo excedido en Llave ${mask} con ${modelName}. Probando siguiente...`);
                        continue;
                    } else if (isInvalid) {
                        this.log(`❌ Modelo ${modelName} no disponible (${err.message}). Saltando al siguiente modelo...`);
                        break;
                    } else {
                        this.log(`❌ Error en Llave ${mask}: ${err.message}`);
                        continue;
                    }
                }
            }
        }
        throw lastError || new Error("All API keys and models failed for extraction.");
    }

    async extractText(
        prompt: string,
        config: {
            maxTokens?: number;
            responseMimeType?: string;
            responseSchema?: any;
            temperature?: number;
            topP?: number;
            topK?: number;
        } = {}
    ): Promise<string> {
        return this.extract('', '', prompt, config);
    }

    async extractWithStream(
        image: string,
        mimeType: string,
        prompt: string,
        config: {
            maxTokens?: number;
            responseMimeType?: string;
            responseSchema?: any;
            temperature?: number;
            topP?: number;
            topK?: number;
        } = {}
    ): Promise<AsyncIterable<StreamChunk>> {
        let lastError: any;
        let startingKeyIdx = this.activeKeyIndex;
        const modelsToTry = this.getModelsToTry();

        for (const modelName of modelsToTry) {
            if (!modelName) continue;
            const isModelOpenAI = this.isModelOpenAI(modelName);
            this.log(`🛡️ Estrategia: Probando streaming con ${modelName} (${isModelOpenAI ? 'OpenAI' : 'Google'})`);

            const validKeys = this.keyConfigs.filter(c =>
                (isModelOpenAI && c.provider === 'openai') ||
                (!isModelOpenAI && c.provider === 'google')
            );

            if (validKeys.length === 0) continue;

            for (let i = 0; i < validKeys.length; i++) {
                const keyIdx = (this.activeKeyIndex + i) % validKeys.length;
                const { provider, key: currentKey } = validKeys[keyIdx];
                const mask = currentKey ? (currentKey.substring(0, 4) + '...') : '???';

                try {
                    if (provider === 'openai' && mimeType === 'application/pdf') {
                        this.log(`ℹ️ OpenAI Vision no soporta PDF directo. Saltando a proveedor Google para este archivo.`);
                        continue;
                    }

                    if (provider === 'openai') {
                        // ✅ NUEVO: Usar OpenAIService para streaming correcto
                        const openaiSvc = new OpenAIService(currentKey, (msg) => this.log(msg));
                        const safeMaxTokens = getSafeMaxTokensForModel(modelName);
                        const maxTokens = Math.min(config.maxTokens || safeMaxTokens, safeMaxTokens);
                        
                        const stream = await openaiSvc.extractStream(image, mimeType, prompt, {
                            model: modelName,
                            maxTokens: maxTokens,
                            temperature: config.temperature || 0.1,
                            jsonMode: config.responseMimeType === 'application/json'
                        });
                        
                        this.log(`✅ Éxito (Stream) con OpenAI ${modelName}`);
                        this.activeKeyIndex = keyIdx;
                        return this.normalizeStreamFromOpenAI(stream);
                    } else {
                        this.client = new GoogleGenerativeAI(currentKey);
                        const model = this.client.getGenerativeModel({
                            model: modelName,
                            generationConfig: {
                                maxOutputTokens: Math.min(config.maxTokens || 8000, 8000),
                                responseMimeType: config.responseMimeType,
                                responseSchema: config.responseSchema,
                                temperature: config.temperature,
                                topP: config.topP,
                                topK: config.topK
                            }
                        });

                        const resultStream = await model.generateContentStream([
                            { text: prompt },
                            ...(image && mimeType ? [{
                                inlineData: { data: image, mimeType: mimeType }
                            }] : [])
                        ]);

                        this.log(`✅ Éxito (Stream) con Llave ${mask} en ${modelName}`);
                        this.activeKeyIndex = keyIdx;
                        return this.processStream(resultStream);
                    }
                } catch (err: any) {
                    lastError = err;
                    this.log(`❌ Error con ${modelName} en llave ${mask}: ${err.message}`);
                }
            }
        }
        throw lastError || new Error("All API keys failed for stream extraction.");
    }

    private async * normalizeStreamFromOpenAI(openaiStream: AsyncIterable<any>): AsyncIterable<StreamChunk> {
        for await (const chunk of openaiStream) {
            yield {
                text: chunk.text,
                usageMetadata: chunk.usageMetadata ? {
                    promptTokenCount: chunk.usageMetadata.promptTokenCount || 0,
                    candidatesTokenCount: chunk.usageMetadata.completionTokenCount || 0,
                    totalTokenCount: chunk.usageMetadata.totalTokenCount || 0
                } : undefined
            };
        }
    }

    private async * processStream(resultStream: any): AsyncIterable<StreamChunk> {
        for await (const chunk of resultStream.stream) {
            const chunkText = chunk.text();
            const usage = chunk.usageMetadata;
            yield {
                text: chunkText,
                usageMetadata: usage ? {
                    promptTokenCount: usage.promptTokenCount || 0,
                    candidatesTokenCount: usage.candidatesTokenCount || 0,
                    totalTokenCount: usage.totalTokenCount || 0
                } : undefined
            };
        }
    }

    private async * processOpenAIStream(resultStream: any): AsyncIterable<StreamChunk> {
        for await (const chunk of resultStream) {
            const chunkText = chunk.choices[0]?.delta?.content || "";
            const usage = (chunk as any).usage;
            yield {
                text: chunkText,
                usageMetadata: usage ? {
                    promptTokenCount: usage.prompt_tokens || 0,
                    candidatesTokenCount: usage.completion_tokens || 0,
                    totalTokenCount: usage.total_tokens || 0
                } : undefined
            };
        }
    }

    static calculateCost(modelName: string, promptTokens: number, candidatesTokens: number) {
        const { costUSD, costCLP } = calculatePrice(promptTokens, candidatesTokens, modelName);
        return {
            promptTokens,
            candidatesTokens,
            totalTokens: promptTokens + candidatesTokens,
            estimatedCost: costUSD,
            estimatedCostCLP: costCLP
        };
    }

    static async generateChatResponse(
        systemPrompt: string,
        userMessage: string,
        history: { role: string, parts: { text: string }[] }[],
        modelName: string
    ): Promise<string> {
        const keys = GeminiService.discoverKeys();
        const firstGoogleKey = keys.find(c => c.provider === 'google')?.key;
        if (!firstGoogleKey) throw new Error("No Google API Key found for Chat");
        const genAI = new GoogleGenerativeAI(firstGoogleKey);
        const model = genAI.getGenerativeModel({ model: modelName });
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                { role: "model", parts: [{ text: "Entendido." }] },
                ...history
            ]
        });
        const result = await chat.sendMessage(userMessage);
        return result.response.text();
    }
}
