export const AI_MODELS = {
    primary: 'gpt-4o',
    fallback: 'gpt-4o-mini',
    extractor: 'gpt-4o',
    reasoner: 'gpt-4o',
    openai_primary: 'gpt-4o',
    openai_mini: 'gpt-4o-mini'
};

export const AI_CONFIG = {
    ACTIVE_MODEL: AI_MODELS.primary,           // ✅ OpenAI GPT-4o como primario
    FALLBACK_MODELS: [
        AI_MODELS.fallback,                    // Fallback a gpt-4o-mini (OpenAI)
        AI_MODELS.openai_mini                  // Otro fallback OpenAI
    ],
    MAX_TOKENS: 35000,
    TEMPERATURE: 0.1,
    PRICING: {
        'gemini-3.1-pro-preview': { input: 1.25, output: 5.0 },
        'gemini-3-flash-preview': { input: 0.1, output: 0.4 },
        'gpt-4o': { input: 2.5, output: 10.0 },
        'gpt-4o-mini': { input: 0.15, output: 0.6 }
    }
};

export const GENERATION_CONFIG = {
    maxOutputTokens: 8000,  // CORREGIDO: máximo seguro para OpenAI gpt-4o
    temperature: 0.1,
    topP: 0.95,
    topK: 40
};

export function calculatePrice(promptTokens: number, candidateTokens: number, modelName: string = AI_CONFIG.ACTIVE_MODEL) {
    const pricing = AI_CONFIG.PRICING[modelName as keyof typeof AI_CONFIG.PRICING] || AI_CONFIG.PRICING['gemini-3-flash-preview'];
    const costUSD = (promptTokens / 1_000_000) * pricing.input + (candidateTokens / 1_000_000) * pricing.output;
    const costCLP = costUSD * 1000; // Simplified conversion
    return { costUSD, costCLP };
}

/**
 * Obtiene el máximo de tokens seguro para un modelo específico
 * (deja margen para evitar errores 400)
 */
export function getSafeMaxTokensForModel(modelName: string): number {
    const modelMaxTokens: Record<string, number> = {
        'gemini-3-flash-preview': 8000,
        'gemini-3.1-pro-preview': 8000,
        'gpt-4o': 8000,
        'gpt-4o-mini': 2000,
        'gpt-4-turbo': 4000
    };
    
    return modelMaxTokens[modelName] || 8000;
}
