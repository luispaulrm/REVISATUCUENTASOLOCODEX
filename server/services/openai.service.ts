import OpenAI from 'openai';

/**
 * Servicio especializado para OpenAI API con soporte completo:
 * - Vision API (GPT-4o para imágenes)
 * - Streaming con metadata correcta
 * - JSON mode nativo
 * - Manejo de errores específicos
 * - Normalización de respuestas
 */

export interface OpenAIStreamChunk {
    text: string;
    usageMetadata?: {
        promptTokenCount: number;
        completionTokenCount: number;
        totalTokenCount: number;
    };
}

export class OpenAIService {
    private client: OpenAI;
    private logCallback?: (msg: string) => void;

    // Configuración de tokens máximos por modelo
    private readonly MAX_TOKENS_BY_MODEL = {
        'gpt-4o': 16384,
        'gpt-4-turbo': 8192,
        'gpt-4o-mini': 4096,
        'gpt-4-vision-preview': 8192
    };

    // Límites realistas para uso interno (dejar margen)
    private readonly SAFE_MAX_TOKENS_BY_MODEL = {
        'gpt-4o': 8000,
        'gpt-4-turbo': 4000,
        'gpt-4o-mini': 2000,
        'gpt-4-vision-preview': 4000
    };

    constructor(apiKey: string, logCallback?: (msg: string) => void) {
        if (!apiKey || apiKey.length < 5) {
            throw new Error('❌ OpenAI API key invalid or missing');
        }
        this.client = new OpenAI({ apiKey });
        this.logCallback = logCallback;
        this.log(`✅ OpenAI Service initialized`);
    }

    private log(msg: string) {
        const logMsg = `[OpenAIService] ${msg}`;
        if (this.logCallback) this.logCallback(logMsg);
        console.log(logMsg);
    }

    /**
     * Obtiene el máximo de tokens permitido para un modelo
     */
    private getSafeMaxTokens(modelName: string): number {
        const safe = this.SAFE_MAX_TOKENS_BY_MODEL[modelName as keyof typeof this.SAFE_MAX_TOKENS_BY_MODEL];
        return safe || 4000;
    }

    /**
     * Convierte una imagen base64 a formato correcto para OpenAI Vision API
     */
    private formatImageForVision(imageBase64: string, mimeType: string): string {
        // Validar que sea base64 puro (sin data: prefix)
        const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
        
        // Mapear MIME type a formato OpenAI
        let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/png';
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
            mediaType = 'image/jpeg';
        } else if (mimeType.includes('png')) {
            mediaType = 'image/png';
        } else if (mimeType.includes('gif')) {
            mediaType = 'image/gif';
        } else if (mimeType.includes('webp')) {
            mediaType = 'image/webp';
        }

        return `data:${mediaType};base64,${cleanBase64}`;
    }

    /**
     * Extrae texto e imágenes con soporte Vision completo
     * SIN streaming (para respuestas estructuradas)
     */
    async extract(
        imageBase64: string,
        mimeType: string,
        prompt: string,
        options: {
            model?: string;
            maxTokens?: number;
            temperature?: number;
            jsonMode?: boolean;
        } = {}
    ): Promise<string> {
        const model = options.model || 'gpt-4o';
        const safeMaxTokens = this.getSafeMaxTokens(model);
        const maxTokens = Math.min(options.maxTokens || safeMaxTokens, safeMaxTokens);
        const temperature = options.temperature ?? 0.1;

        try {
            this.log(`🚀 Extracting with ${model} (maxTokens: ${maxTokens})`);

            const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt }
                    ]
                }
            ];

            // Agregar imagen si está disponible
            if (imageBase64 && mimeType) {
                const imageUrl = this.formatImageForVision(imageBase64, mimeType);
                (messages[0].content as any[]).push({
                    type: 'image_url',
                    image_url: {
                        url: imageUrl,
                        detail: 'high' // Máxima calidad para OCR
                    }
                });
                this.log(`📸 Imagen agregada (${mimeType})`);
            }

            const requestConfig: OpenAI.Chat.ChatCompletionCreateParams = {
                model,
                messages,
                max_completion_tokens: maxTokens,
                temperature,
                top_p: 0.95
            };

            // Agregar JSON mode si está solicitado
            if (options.jsonMode) {
                requestConfig.response_format = { type: 'json_object' };
                this.log(`📋 JSON mode activado`);
            }

            const response = await this.client.chat.completions.create(requestConfig);

            const text = response.choices[0]?.message?.content || '';
            const usage = response.usage;

            this.log(`✅ Extraction successful (${text.length} chars)`);
            if (usage) {
                this.log(`📊 Tokens - Input: ${usage.prompt_tokens}, Output: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
            }

            return text;
        } catch (err: any) {
            this.handleOpenAIError(err, model);
            throw err;
        }
    }

    /**
     * Streaming de respuestas con acumulación de metadata
     */
    async extractStream(
        imageBase64: string,
        mimeType: string,
        prompt: string,
        options: {
            model?: string;
            maxTokens?: number;
            temperature?: number;
            jsonMode?: boolean;
        } = {}
    ): Promise<AsyncIterable<OpenAIStreamChunk>> {
        const model = options.model || 'gpt-4o';
        const safeMaxTokens = this.getSafeMaxTokens(model);
        const maxTokens = Math.min(options.maxTokens || safeMaxTokens, safeMaxTokens);
        const temperature = options.temperature ?? 0.1;

        try {
            this.log(`🚀 Streaming with ${model} (maxTokens: ${maxTokens})`);

            const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt }
                    ]
                }
            ];

            // Agregar imagen si está disponible
            if (imageBase64 && mimeType) {
                const imageUrl = this.formatImageForVision(imageBase64, mimeType);
                (messages[0].content as any[]).push({
                    type: 'image_url',
                    image_url: {
                        url: imageUrl,
                        detail: 'high'
                    }
                });
                this.log(`📸 Imagen agregada para streaming`);
            }

            const requestConfig: OpenAI.Chat.ChatCompletionCreateParams = {
                model,
                messages,
                max_completion_tokens: maxTokens,
                temperature,
                top_p: 0.95,
                stream: true
            };

            if (options.jsonMode) {
                requestConfig.response_format = { type: 'json_object' };
            }

            const stream = await this.client.chat.completions.create(requestConfig);
            return this.processStream(stream);
        } catch (err: any) {
            this.handleOpenAIError(err, model);
            throw err;
        }
    }

    /**
     * Procesa el stream y normaliza metadata
     */
    private async *processStream(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): AsyncIterable<OpenAIStreamChunk> {
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let chunkCount = 0;

        for await (const chunk of stream) {
            chunkCount++;
            
            // Extraer texto del delta
            const text = chunk.choices[0]?.delta?.content || '';
            
            // Acumular tokens si están disponibles (típicamente en el último chunk)
            if (chunk.usage) {
                totalPromptTokens = chunk.usage.prompt_tokens || 0;
                totalCompletionTokens = chunk.usage.completion_tokens || 0;
            }

            // Normalizar metadata
            const usageMetadata = (totalPromptTokens > 0 || totalCompletionTokens > 0) ? {
                promptTokenCount: totalPromptTokens,
                completionTokenCount: totalCompletionTokens,
                totalTokenCount: totalPromptTokens + totalCompletionTokens
            } : undefined;

            yield {
                text,
                usageMetadata
            };
        }

        if (chunkCount === 0) {
            this.log(`⚠️ Stream returned 0 chunks`);
        }
    }

    /**
     * Chat simple sin imágenes
     */
    async chat(
        messages: OpenAI.Chat.ChatCompletionMessageParam[],
        options: {
            model?: string;
            maxTokens?: number;
            temperature?: number;
        } = {}
    ): Promise<string> {
        const model = options.model || 'gpt-4o';
        const safeMaxTokens = this.getSafeMaxTokens(model);
        const maxTokens = Math.min(options.maxTokens || safeMaxTokens, safeMaxTokens);

        try {
            const response = await this.client.chat.completions.create({
                model,
                messages,
                max_completion_tokens: maxTokens,
                temperature: options.temperature ?? 0.7,
                top_p: 0.95
            });

            return response.choices[0]?.message?.content || '';
        } catch (err: any) {
            this.handleOpenAIError(err, model);
            throw err;
        }
    }

    /**
     * Extracción de solo texto (sin imágenes)
     */
    async extractText(
        prompt: string,
        options: {
            model?: string;
            maxTokens?: number;
            temperature?: number;
        } = {}
    ): Promise<string> {
        return this.extract('', '', prompt, {
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            jsonMode: false
        });
    }

    /**
     * Manejo centralizado de errores específicos de OpenAI
     */
    private handleOpenAIError(err: any, modelName: string): void {
        const status = err.status || err.statusCode;
        const message = err.message || err.toString();

        if (status === 400) {
            this.log(`❌ Bad Request (400): ${message}`);
            this.log(`   ℹ️ Verificar: max_completion_tokens, modelo disponible, formato correcto`);
        } else if (status === 401) {
            this.log(`❌ Unauthorized (401): API key inválida o expirada`);
        } else if (status === 403) {
            this.log(`❌ Forbidden (403): Acceso denegado`);
        } else if (status === 429) {
            this.log(`❌ Rate Limit (429): Cuota excedida. Esperar 60+ segundos`);
        } else if (status === 500) {
            this.log(`❌ Server Error (500): OpenAI no disponible`);
        } else if (status === 503) {
            this.log(`❌ Service Unavailable (503): OpenAI saturado`);
        } else if (message.includes('timeout') || message.includes('Timeout')) {
            this.log(`❌ Timeout: El modelo tardó demasiado (>120s)`);
        } else {
            this.log(`❌ Unexpected error: ${message}`);
        }
    }

    /**
     * Validar que la API key sea válida
     */
    static validateApiKey(apiKey: string): boolean {
        return apiKey && apiKey.length > 20 && apiKey.startsWith('sk-');
    }

    /**
     * Obtener información del modelo
     */
    static getModelInfo(modelName: string): {
        name: string;
        vision: boolean;
        maxTokens: number;
        contextWindow: number;
    } {
        const models: Record<string, any> = {
            'gpt-4o': {
                name: 'GPT-4 Optimized',
                vision: true,
                maxTokens: 16384,
                contextWindow: 128000
            },
            'gpt-4o-mini': {
                name: 'GPT-4 Mini',
                vision: true,
                maxTokens: 4096,
                contextWindow: 128000
            },
            'gpt-4-turbo': {
                name: 'GPT-4 Turbo',
                vision: true,
                maxTokens: 8192,
                contextWindow: 128000
            },
            'gpt-4-vision-preview': {
                name: 'GPT-4 Vision Preview',
                vision: true,
                maxTokens: 8192,
                contextWindow: 128000
            }
        };

        return models[modelName] || {
            name: modelName,
            vision: modelName.includes('vision'),
            maxTokens: 4096,
            contextWindow: 8192
        };
    }
}
