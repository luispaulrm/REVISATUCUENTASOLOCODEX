import OpenAI from 'openai';
import { DOCUMENT_CLASSIFICATION_PROMPT } from "../prompts/validation.prompt.js";

interface ValidationResult {
    isValid: boolean;
    detectedType: string;
    reason: string;
}

const VALIDATION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        classification: {
            type: 'string',
            enum: ['CUENTA', 'PAM', 'CONTRATO', 'CUENTA_PAM', 'UNKNOWN']
        },
        confidence: { type: 'number' },
        reasoning: { type: 'string' }
    },
    required: ['classification', 'confidence', 'reasoning']
};

export class ValidationService {
    private apiKeys: string[];
    private modelName: string;

    constructor(apiKeyOrKeys: string | string[]) {
        this.apiKeys = ValidationService.normalizeOpenAIKeys(apiKeyOrKeys);
        this.modelName = process.env.OPENAI_VALIDATION_MODEL || 'gpt-4o-mini';
    }

    static normalizeOpenAIKeys(apiKeyOrKeys: string | string[]): string[] {
        return [...new Set((Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys])
            .filter((k) => typeof k === 'string' && k.trim().length > 0)
            .map((k) => String(k).trim())
            .filter((k) => k.startsWith('sk-')))];
    }

    hasKeys(): boolean {
        return this.apiKeys.length > 0;
    }

    private buildContent(imageBase64: string, mimeType: string): any[] {
        const content: any[] = [{ type: 'input_text', text: DOCUMENT_CLASSIFICATION_PROMPT }];
        if ((mimeType || '').includes('pdf')) {
            content.push({
                type: 'input_file',
                filename: 'document.pdf',
                file_data: `data:application/pdf;base64,${imageBase64}`
            });
            return content;
        }

        const normalizedMime = (mimeType || '').startsWith('image/') ? mimeType : 'image/png';
        content.push({
            type: 'input_image',
            image_url: `data:${normalizedMime};base64,${imageBase64}`
        });
        return content;
    }

    /**
     * Validates if the uploaded document matches the expected type.
     */
    async validateDocumentType(
        imageBase64: string,
        mimeType: string,
        expectedType: 'CUENTA' | 'PAM' | 'CONTRATO'
    ): Promise<ValidationResult> {
        console.log(`[VALIDATION] Checking if document is "${expectedType}" with OpenAI...`);
        let lastError: any = null;

        if (this.apiKeys.length === 0) {
            return {
                isValid: false,
                detectedType: "ERROR",
                reason: 'Validation service has no valid OpenAI keys'
            };
        }

        for (const key of this.apiKeys) {
            const mask = key.substring(0, 4) + '...';
            try {
                const client = new OpenAI({ apiKey: key });
                const response = await client.responses.create({
                    model: this.modelName,
                    temperature: 0,
                    input: [
                        {
                            role: 'user',
                            content: this.buildContent(imageBase64, mimeType)
                        }
                    ],
                    text: {
                        format: {
                            type: 'json_schema',
                            name: 'document_validation',
                            strict: true,
                            schema: VALIDATION_SCHEMA
                        }
                    }
                } as any);

                const outputText = String((response as any)?.output_text || '').trim();
                console.log(`[VALIDATION] Raw AI Response: ${outputText}`);
                const jsonResponse = JSON.parse(outputText || '{}');

                const detected = String(jsonResponse?.classification || '').toUpperCase();
                const reasoning = String(jsonResponse?.reasoning || '').trim() || 'Sin razon detallada';
                const isMixedValid = detected === "CUENTA_PAM" && (expectedType === "CUENTA" || expectedType === "PAM");

                if (detected === expectedType || isMixedValid) {
                    return { isValid: true, detectedType: detected, reason: reasoning };
                }

                return {
                    isValid: false,
                    detectedType: detected || "UNKNOWN",
                    reason: `Documento identificado como ${detected || "UNKNOWN"} pero se esperaba ${expectedType}. Razon: ${reasoning}`
                };
            } catch (error: any) {
                lastError = error;
                const status = Number(error?.status || error?.statusCode || 0);
                if (status === 429 || status === 503) {
                    console.warn(`[VALIDATION] Quota/service error on key ${mask}. Rotating...`);
                    continue;
                }
                console.error(`[VALIDATION] Error on key ${mask}:`, error?.message || error);
            }
        }

        console.error("[VALIDATION] All keys failed:", lastError);
        return {
            isValid: false,
            detectedType: "ERROR",
            reason: `Validation service failed after trying ${this.apiKeys.length} keys: ${lastError?.message || 'unknown'}`
        };
    }
}
