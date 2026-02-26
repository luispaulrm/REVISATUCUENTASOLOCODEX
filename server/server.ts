import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import { GeminiService } from './services/gemini.service.js';
import { performForensicAudit } from './services/auditEngine.service.js';
import { classifyBillingModel } from './services/billingModelClassifier.service.js';
import { ParserService } from "./services/parser.service.js";
import { OpenAIService } from './services/openai.service.js';
import { AI_CONFIG, AI_MODELS, GENERATION_CONFIG, getSafeMaxTokensForModel } from "./config/ai.config.js";
import { handlePamExtraction } from './endpoints/pam.endpoint.js';
import { handleContractExtraction } from './endpoints/contract.endpoint.js';
// No unnecessary imports
import { handleProjection } from './endpoints/projection.endpoint.js';
import { handleAskAuditor } from './endpoints/ask.endpoint.js';
import { handlePreCheck } from './endpoints/precheck.endpoint.js';
import { handleGeneratePdf } from './endpoints/generate-pdf.endpoint.js';
import { handleCanonicalExtraction } from './endpoints/canonical.endpoint.js';
import { handleM12VisualExtraction } from './endpoints/m12.endpoint.js';
import { LearnContractEndpoint } from './endpoints/learn-contract.endpoint.js';
import { learnFromContract } from './services/contractLearning.service.js';
import { BILL_PROMPT } from './prompts/bill.prompt.js';
// REMOVED: TaxonomyPhase1Service, TaxonomyPhase1_5Service, SkeletonService, preProcessEventos
// These were eliminated to lighten the bill extraction pipeline (no longer used by M11 engine)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⚠️ CRITICAL: Only load dotenv in development
// Railway injects env vars natively, dotenv.config() interferes
if (process.env.NODE_ENV !== 'production') {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        console.log(`✅ Loaded environment from ${envPath}`);
    } else {
        dotenv.config(); // Fallback to default
        console.log(`⚠️ .env not found at ${envPath}, using default`);
    }
}

// ✅ Railway-compatible env access (Object.keys can fail in some runtimes)
function envGet(k: string) {
    const v = process.env[k];
    return typeof v === "string" ? v : undefined;
}

// Environment Check
console.log("\n" + "=".repeat(50));
console.log("🚀 AUDIT SERVER BOOTSTRAP");
console.log("\n=== RAILWAY CONTEXT ===");
console.log("SERVICE:", envGet("RAILWAY_SERVICE_NAME") || "N/A");
console.log("ENV:", envGet("RAILWAY_ENVIRONMENT_NAME") || "N/A");
console.log("PROJECT:", envGet("RAILWAY_PROJECT_NAME") || "N/A");
console.log("=======================\n");

const ENV_KEYS = Object.getOwnPropertyNames(process.env);
console.log("[ENV_CHECK] Total Vars:", ENV_KEYS.length);
console.log("[ENV_CHECK] Keys sample:", ENV_KEYS.slice(0, 30));
console.log("[ENV_CHECK] NODE_ENV:", envGet("NODE_ENV") || "development");
console.log("[ENV_CHECK] has PORT:", Boolean(envGet("PORT")));
console.log("[ENV_CHECK] has RAILWAY_PROJECT_ID:", Boolean(envGet("RAILWAY_PROJECT_ID")));

// Read API key with Railway-compatible method
const GEMINI_API_KEY = envGet("GEMINI_API_KEY") || envGet("API_KEY") || '';
console.log("[ENV_CHECK] GEMINI KEY PRESENT:", Boolean(GEMINI_API_KEY));

if (!GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY NOT FOUND (checked GEMINI_API_KEY + API_KEY)");
} else {
    console.log(`✅ GEMINI_API_KEY LOADED`);
    console.log(`   Key preview: ${GEMINI_API_KEY.substring(0, 8)}...${GEMINI_API_KEY.slice(-4)}`);
}

const GEMINI_SEC = envGet("GEMINI_API_KEY_SECONDARY");
if (GEMINI_SEC) {
    console.log(`✅ GEMINI_API_KEY_SECONDARY LOADED: ${GEMINI_SEC.substring(0, 8)}...`);
}
const GEMINI_TER = envGet("GEMINI_API_KEY_TERTIARY");
if (GEMINI_TER) {
    console.log(`✅ GEMINI_API_KEY_TERTIARY LOADED: ${GEMINI_TER.substring(0, 8)}...`);
}
const GEMINI_QUA = envGet("GEMINI_API_KEY_QUATERNARY");
if (GEMINI_QUA) {
    console.log(`✅ GEMINI_API_KEY_QUATERNARY LOADED: ${GEMINI_QUA.substring(0, 8)}...`);
}
const GEMINI_QUI = envGet("GEMINI_API_KEY_QUINARY");
if (GEMINI_QUI) {
    console.log(`✅ GEMINI_API_KEY_QUINARY LOADED: ${GEMINI_QUI.substring(0, 8)}...`);
}
const OPENAI_API_KEY = envGet("OPENAI_API_KEY");
if (OPENAI_API_KEY) {
    console.log(`✅ OPENAI_API_KEY LOADED: ${OPENAI_API_KEY.substring(0, 8)}...`);
}
console.log("=".repeat(50) + "\n");

// 🛡️ GLOBAL CRASH GUARD
// Evita que el servidor se reinicie por errores "flaky" de librerías externas (ej: Google AI stream)
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    // No salimos (process.exit) para mantener el servidor vivo ante fallos transitorios
});

process.on('uncaughtException', (err) => {
    console.error('🚨 [CRITICAL] Uncaught Exception:', err);
    // En producción idealmente se reinicia, pero en este dev-server preferimos aguantar
    // a menos que sea algo irrecuperable.
});

const app = express();
// ✅ Railway requires listening to process.env.PORT
const PORT = Number(envGet("PORT") || 5000);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Helper para obtener la API Key
const getApiKey = () => GEMINI_API_KEY;

const billingSchema = {
    type: "object",
    properties: {
        clinicName: { type: "string" },
        patientName: { type: "string" },
        patientEmail: { type: "string" },
        invoiceNumber: { type: "string" },
        date: { type: "string" },
        currency: { type: "string", description: "Currency symbol or code, e.g., CLP" },
        sections: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    category: { type: "string", description: "Categoría (Ej: Pabellón, Insumos, Farmacia)" },
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                index: { type: "number", description: "Número correlativo del ítem" },
                                description: { type: "string" },
                                quantity: { type: "number" },
                                unitPrice: { type: "number", description: "Precio unitario (preferiblemente bruto/ISA)" },
                                total: { type: "number", description: "Valor Total del ítem incluyendo IVA/Impuestos (Valor ISA)" }
                            },
                            required: ["index", "description", "total"]
                        }
                    },
                    sectionTotal: { type: "number", description: "Total declarado por la clínica para la sección" }
                },
                required: ["category", "items", "sectionTotal"]
            }
        },
        clinicStatedTotal: { type: "number", description: "El Gran Total final de la cuenta" }
    },
    required: ["clinicName", "sections", "clinicStatedTotal"]
};

// Redundant EXTRACTION_PROMPT removed. Now using BILL_PROMPT from ./prompts/bill.prompt.js

// Helper to get all API keys with provider context (Moved to GeminiService.discoverKeys)
const getApiKeys = () => GeminiService.discoverKeys();

app.post('/api/audit/ask', handleAskAuditor);
app.post('/api/audit/pre-check', handlePreCheck);
app.post('/api/generate-pdf', handleGeneratePdf);
app.post('/api/extract-canonical', handleCanonicalExtraction);
app.post('/api/m12/extract', handleM12VisualExtraction);
app.post('/api/learn-contract', LearnContractEndpoint);
import { handleChat } from './endpoints/chat.endpoint.js';
app.post('/api/audit/chat', handleChat);

// import { handleTaxonomyClassification } from './endpoints/taxonomy.endpoint.js';
// app.post('/api/audit/taxonomy', handleTaxonomyClassification);

app.get('/api/contract-count', async (req, res) => {
    try {
        const { ContractCacheService } = await import('./services/contractCache.service.js');
        const count = await ContractCacheService.getCount();
        res.json({ count });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mental-model', async (req, res) => {
    try {
        const mentalModelPath = path.resolve('./mental_model.json');
        if (fs.existsSync(mentalModelPath)) {
            const data = fs.readFileSync(mentalModelPath, 'utf-8');
            res.json(JSON.parse(data));
        } else {
            res.status(404).json({ error: 'Mental model not generated yet' });
        }
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/contracts/clear-cache', async (req, res) => {
    console.log('[CACHE] Clearing contract cache...');
    try {
        const { ContractCacheService } = await import('./services/contractCache.service.js');
        const { resetLearningMemory } = await import('./services/contractLearning.service.js'); // New Import logic

        const count = await ContractCacheService.clearAll();
        resetLearningMemory(); // Reset counter

        res.json({ success: true, deletedCount: count });
    } catch (err: any) {
        console.error('[CACHE] Error clearing cache:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/extract', async (req, res) => {
    console.log(`[REQUEST] New extraction request (Streaming)`);

    // Configurar cabeceras para streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendUpdate = (data: any) => {
        if (!res.writableEnded) {
            res.write(JSON.stringify(data) + '\n');
        }
    };

    const forensicLog = (msg: string) => {
        console.log(`[FORENSIC] ${msg}`);
        sendUpdate({ type: 'chunk', text: `[FORENSIC] ${msg}` });
    };

    forensicLog("Iniciando análisis forense de la cuenta clínica.");

    try {
        const { image, mimeType } = req.body;
        console.log(`[REQUEST] Processing image style: ${mimeType}`);

        const apiKeys = getApiKeys();
        console.log(`[AUTH] Found ${apiKeys.length} API Keys.`);

        if (!image || !mimeType) {
            console.error(`[ERROR] Missing payload: image=${!!image}, mimeType=${mimeType}`);
            return res.status(400).json({ error: 'Missing image data or mimeType' });
        }

        if (apiKeys.length === 0) {
            console.error(`[CRITICAL] Cannot proceed without API Key`);
            return res.status(500).json({ error: 'Server configuration error: Gemini API Key not found' });
        }

        const CSV_PROMPT = BILL_PROMPT;

        // --- CSV STREAMING EXTRACTION (original, proven approach) ---
        // Note: JSON output mode (responseMimeType) caused streaming to freeze on large bills.
        // We keep the CSV approach which streams reliably, and parse line by line.

        let resultStream: any;
        let lastError: any;
        let activeApiKey: string | undefined;
        let activeProvider: 'google' | 'openai' = 'google';

        const modelsToTry = [
            AI_CONFIG.ACTIVE_MODEL,
            ...AI_CONFIG.FALLBACK_MODELS,
            AI_MODELS.openai_primary,
            AI_MODELS.openai_mini
        ].filter(Boolean);

        for (const modelName of modelsToTry) {
            if (!modelName) continue;
            console.log(`[AUTH] 🛡️ Attempting extraction with model: ${modelName}`);

            const isModelOpenAI = modelName.startsWith('gpt') || modelName.includes('gpt');

            for (const keyConfig of apiKeys) {
                const { provider, key: apiKey } = keyConfig;

                // Skip if provider doesn't match model type
                if (isModelOpenAI && provider !== 'openai') continue;
                if (!isModelOpenAI && provider !== 'google') continue;

                const keyMask = apiKey ? (apiKey.substring(0, 4) + '...') : '???';
                console.log(`[AUTH] Trying with API Key: ${keyMask} (Provider: ${provider}, Model: ${modelName})`);

                try {
                    forensicLog(`Intentando extracción con modelo ${modelName}...`);

                    const waitingInterval = setInterval(() => {
                        forensicLog(`⏳ Esperando respuesta de ${modelName}... (Procesando)`);
                    }, 10000);

                    const timeoutMs = 180000;

                    let streamPromise;
                    if (provider === 'google') {
                        const genAI = new GoogleGenerativeAI(apiKey);
                        const model = genAI.getGenerativeModel({
                            model: modelName,
                            generationConfig: {
                                maxOutputTokens: GENERATION_CONFIG.maxOutputTokens,
                                temperature: GENERATION_CONFIG.temperature,
                                topP: GENERATION_CONFIG.topP,
                                topK: GENERATION_CONFIG.topK
                            }
                        });
                        streamPromise = model.generateContentStream([
                            { text: CSV_PROMPT },
                            {
                                inlineData: {
                                    data: image,
                                    mimeType: mimeType
                                }
                            }
                        ]);
                    } else {
                        // ✅ CORREGIDO: Usar OpenAIService para mejor manejo
                        const openaiSvc = new OpenAIService(apiKey, forensicLog);
                        const safeMaxTokens = getSafeMaxTokensForModel(modelName);
                        streamPromise = openaiSvc.extractStream(image, mimeType, CSV_PROMPT, {
                            model: modelName,
                            maxTokens: safeMaxTokens,
                            temperature: GENERATION_CONFIG.temperature
                        });
                    }

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => {
                            reject(new Error(`Timeout: El modelo ${modelName} no respondió en ${timeoutMs / 1000} segundos`));
                        }, timeoutMs);
                    });

                    try {
                        resultStream = await Promise.race([streamPromise, timeoutPromise]) as any;
                    } finally {
                        clearInterval(waitingInterval);
                    }

                    if (resultStream) {
                        activeApiKey = apiKey;
                        activeProvider = provider;
                        break;
                    }

                } catch (attemptError: any) {
                    const errStr = (attemptError?.toString() || "") + (attemptError?.message || "");
                    const isTimeout = errStr.includes('Timeout');
                    const is429 = errStr.includes('429') || errStr.includes('Too Many Requests') || (attemptError?.status === 429);
                    const is400 = errStr.includes('400') || attemptError?.status === 400;
                    const is401 = errStr.includes('401') || attemptError?.status === 401;
                    const is403 = errStr.includes('403') || attemptError?.status === 403;

                    if (isTimeout) {
                        forensicLog(`⏱️ Timeout: El modelo ${modelName} no respondió en 180 segundos. Intentando con la siguiente clave...`);
                        lastError = attemptError;
                        continue;
                    }

                    if (is429) {
                        const backoffMs = 30000 + Math.random() * 30000;
                        forensicLog(`⚠️ Quota 429 en ${keyMask}. Esperando ${Math.round(backoffMs / 1000)}s antes de intentar otra clave...`);
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                        lastError = attemptError;
                        continue;
                    }

                    if (is400) {
                        forensicLog(`❌ Error 400 - Verificar max_completion_tokens o modelo disponible: ${attemptError.message}`);
                        lastError = attemptError;
                        continue;
                    }

                    if (is401 || is403) {
                        forensicLog(`❌ Error ${attemptError.status} - API key inválida o acceso denegado`);
                        lastError = attemptError;
                        continue;
                    }

                    console.warn(`[AUTH] Failed with Key: ${keyMask} on ${modelName}:`, attemptError.message);
                    lastError = attemptError;
                }
            }
            if (activeApiKey) break;
            console.warn(`[AUTH] ⚠️ All keys failed for model ${modelName}. Switching to next model...`);
        }

        if (!resultStream) {
            console.error("❌ All API Keys failed.");
            const errStr = (lastError?.toString() || "") + (lastError?.message || "");
            const has429 = errStr.includes('429') || errStr.includes('Too Many Requests') || lastError?.status === 429;

            if (has429) {
                sendUpdate({
                    type: 'error',
                    message: '⏳ Todas las claves de API están saturadas (Quota Exceeded). Por favor espera 1-2 minutos.'
                });
                return res.end();
            }
            throw lastError || new Error("All API attempts failed");
        }

        // Stream chunks and aggregate text
        let fullText = "";
        let previousLength = 0;
        let stuckCount = 0;
        let maxIterations = 10000;
        let iteration = 0;

        // ✅ CORREGIDO: Ambos streams usan el mismo formato ahora
        const streamToIterate = activeProvider === 'google' ? resultStream.stream : resultStream;

        for await (const chunk of streamToIterate) {
            iteration++;
            if (iteration > maxIterations) {
                console.error(`[CRITICAL] Stream exceeded ${maxIterations} iterations. Breaking.`);
                break;
            }

            // ✅ Normalizado: ambos providers devuelven .text como propiedad
            const chunkText = activeProvider === 'google' ? chunk.text() : (chunk.text || "");
            fullText += chunkText;

            if (fullText.length === previousLength) {
                stuckCount++;
                if (stuckCount > 3) {
                    console.log(`[WARN] Stream stuck at ${fullText.length} chars. Breaking.`);
                    break;
                }
            } else {
                stuckCount = 0;
            }
            previousLength = fullText.length;

            console.log(`[CHUNK] +${chunkText.length} chars (Total: ${fullText.length})`);
            sendUpdate({ type: 'chunk', text: chunkText });

            // ✅ CORREGIDO: Normalizar metadata de ambos providers
            const usageMetadata = activeProvider === 'google' 
                ? (chunk as any).usageMetadata 
                : (chunk as any).usageMetadata;
            
            if (usageMetadata) {
                const promptTokens = usageMetadata.promptTokenCount || 0;
                const completionTokens = usageMetadata.completionTokenCount || 0;
                const totalTokens = usageMetadata.totalTokenCount || 0;
                const { estimatedCost, estimatedCostCLP } = GeminiService.calculateCost(AI_CONFIG.ACTIVE_MODEL, promptTokens, completionTokens);
                sendUpdate({
                    type: 'usage',
                    usage: { promptTokens, candidatesTokens: completionTokens, totalTokens, estimatedCost, estimatedCostCLP }
                });
            } else {
                sendUpdate({ type: 'progress', length: fullText.length });
            }
        }

        console.log(`\n[DEBUG] Extracción finalizada. Longitud total: ${fullText.length} chars.`);

        // --- CSV PARSER ---
        // Strip Markdown bold (**...**) and heading markers (#) that the LLM sometimes adds
        // despite being instructed not to. Without this, `**SECTION: foo**` fails `startsWith('SECTION:')`.
        const lines = fullText.split('\n')
            .map(l => l.trim().replace(/\*\*/g, '').replace(/^#+\s*/, ''))
            .filter(l => l);
        const sectionsMap = new Map<string, any>();
        const sectionPageTracking = new Map<string, Set<number>>();
        let currentSectionName = "SECCION_DESCONOCIDA";
        let currentPage = 1;
        let globalIndex = 1;

        let clinicGrandTotalField = 0;
        let clinicName = "CLINICA";
        let patientName = "PACIENTE";
        let patientEmail = "N/A";
        let invoiceNumber = "000000";
        let billingDate = new Date().toLocaleDateString('es-CL');

        const cleanCLP = (value: string, isQuantity: boolean = false): number => {
            if (!value) return 0;
            let cleaned = value.trim();
            if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
                cleaned = '-' + cleaned.substring(1, cleaned.length - 1);
            }
            cleaned = cleaned.replace(/[^\d.,-]/g, '');
            if (cleaned === '' || cleaned === '-') return 0;
            const firstNumeric = cleaned.search(/[0-9-]/);
            if (firstNumeric > 0) cleaned = cleaned.substring(firstNumeric);
            if (cleaned.includes(',')) {
                return parseFloat(cleaned.replace(/\./g, '').replace(/,/g, '.')) || 0;
            }
            const dots = (cleaned.match(/\./g) || []).length;
            if (dots === 1) {
                const parts = cleaned.split('.');
                if (!isQuantity) return parseFloat(cleaned.replace(/\./g, '')) || 0;
                if (parts[1] === "000") {
                    return parts[0].length <= 2 ? (parseFloat(cleaned) || 0) : (parseFloat(cleaned.replace(/\./g, '')) || 0);
                }
                if (parts[1].length !== 3) return parseFloat(cleaned) || 0;
                return parseFloat(cleaned.replace(/\./g, '')) || 0;
            } else if (dots > 1) {
                return parseFloat(cleaned.replace(/\./g, '')) || 0;
            }
            return parseFloat(cleaned.replace(/[^\d.eE-]/g, '')) || 0;
        };

        const robustSplit = (line: string): string[] => {
            let trimmed = line.trim();
            if (trimmed.startsWith('|')) trimmed = trimmed.substring(1);
            if (trimmed.endsWith('|')) trimmed = trimmed.substring(0, trimmed.length - 1);
            return trimmed.split('|').map(c => c.trim());
        };

        for (const line of lines) {
            if (line.startsWith('GRAND_TOTAL:') || line.startsWith('GRAND_TOTAL_BRUTO:')) {
                const rawVal = line.replace(/^GRAND_TOTAL[^:]*:/, '').trim();
                clinicGrandTotalField = Math.round(cleanCLP(rawVal, false));
                continue;
            }
            if (line.startsWith('CLINIC:')) { clinicName = line.replace('CLINIC:', '').trim(); continue; }
            if (line.startsWith('PATIENT:')) { patientName = line.replace('PATIENT:', '').trim(); continue; }
            if (line.startsWith('EMAIL:')) { patientEmail = line.replace('EMAIL:', '').trim(); continue; }
            if (line.startsWith('INVOICE:')) { invoiceNumber = line.replace('INVOICE:', '').trim(); continue; }
            if (line.startsWith('DATE:')) { billingDate = line.replace('DATE:', '').trim(); continue; }
            if (line.startsWith('PAGE:')) {
                const p = parseInt(line.replace('PAGE:', '').trim());
                if (!isNaN(p)) currentPage = p;
                forensicLog(`Procesando Página ${currentPage}...`);
                continue;
            }
            if (line.startsWith('SECTION:')) {
                currentSectionName = line.replace('SECTION:', '').trim();
                if (!sectionsMap.has(currentSectionName)) {
                    sectionsMap.set(currentSectionName, { category: currentSectionName, items: [], sectionTotal: 0 });
                }
                if (!sectionPageTracking.has(currentSectionName)) {
                    sectionPageTracking.set(currentSectionName, new Set<number>());
                }
                continue;
            }
            if (line.startsWith('SECTION_TOTAL:')) {
                const rawVal = line.replace('SECTION_TOTAL:', '').trim();
                const secTotal = Math.round(cleanCLP(rawVal, false));
                if (sectionsMap.has(currentSectionName)) {
                    sectionsMap.get(currentSectionName).sectionTotal = secTotal;
                }
                continue;
            }
            if (!line.includes('|')) continue;

            if (sectionPageTracking.has(currentSectionName)) {
                sectionPageTracking.get(currentSectionName)!.add(currentPage);
            }

            const cols = robustSplit(line);
            if (cols.length < 3) continue;

            let code = "", desc = "", qtyStr = "1", unitPriceStr = "0", totalStr = "0";
            let valorIsaStr = "", bonifStr = "", copagoStr = "";

            if (cols.length === 3) {
                desc = cols[1]; totalStr = cols[2]; unitPriceStr = totalStr;
            } else {
                code = cols[1]; desc = cols[2]; qtyStr = cols[3]; unitPriceStr = cols[4];
                if (cols.length >= 10) {
                    valorIsaStr = cols[6]; bonifStr = cols[7]; copagoStr = cols[8]; totalStr = cols[9];
                } else if (cols.length >= 7) {
                    totalStr = cols[6];
                } else {
                    totalStr = cols.length >= 6 ? cols[5] : cols[3];
                }
            }

            const isClinicTotalLine = desc?.toUpperCase().includes("TOTAL SECCIÓN") || desc?.toUpperCase().includes("SUBTOTAL");
            const total = Math.round(cleanCLP(totalStr || "0", false));
            const quantity = cleanCLP(qtyStr || "1", true);
            const unitPrice = Math.round(cleanCLP(unitPriceStr || "0", false));
            const valorIsa = Math.round(cleanCLP(valorIsaStr || "0", false));
            const bonificacion = Math.round(cleanCLP(bonifStr || "0", false));
            const copago = Math.round(cleanCLP(copagoStr || "0", false));
            const fullDescription = code ? `${desc} ${code}` : desc;

            let sectionObj = sectionsMap.get(currentSectionName);
            if (!sectionObj) {
                sectionsMap.set("SECCIONES_GENERALES", { category: "SECCIONES_GENERALES", items: [], sectionTotal: 0 });
                sectionObj = sectionsMap.get("SECCIONES_GENERALES");
            }

            const calcTotal = Math.round(unitPrice * quantity);
            let finalQuantity = quantity, finalUnitPrice = unitPrice, finalTotal = total, finalCalcTotal = calcTotal;

            // Smart magnitude coherence check
            const factors = [10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000, 10000000000, 100000000000, 1000000000000];
            let foundFix = false;
            if (Math.abs(calcTotal - total) > 5) {
                for (const f of factors) {
                    if (unitPrice > 0) {
                        const testQty = quantity / f;
                        const testCalc = Math.round(unitPrice * testQty);
                        if (Math.abs(testCalc - total) <= 10) { finalQuantity = testQty; finalCalcTotal = testCalc; foundFix = true; break; }
                    }
                    if (quantity > 0) {
                        const testPrice = unitPrice / f;
                        const testCalc = Math.round(testPrice * quantity);
                        if (Math.abs(testCalc - total) <= 10) { finalUnitPrice = testPrice; finalCalcTotal = testCalc; foundFix = true; break; }
                    }
                }
            }

            const simpleError = Math.abs(finalTotal - finalCalcTotal) > 10;
            const ivaError = Math.abs(finalTotal - Math.round(finalCalcTotal * 1.19)) > 10;
            let hasError = !foundFix && simpleError && ivaError;
            const isIVAApplied = simpleError && !ivaError;

            if (finalQuantity > 10000 && finalTotal < 1000000 && finalUnitPrice > 0 && finalUnitPrice < finalTotal) {
                const correctedQty = Math.round((finalTotal / finalUnitPrice) * 100) / 100;
                if (correctedQty < 1000 && correctedQty > 0) {
                    finalQuantity = correctedQty;
                    finalCalcTotal = Math.round(finalQuantity * finalUnitPrice);
                    hasError = Math.abs(finalTotal - finalCalcTotal) > 10;
                }
            }

            if (isClinicTotalLine) {
                sectionObj.sectionTotal = finalTotal;
            } else {
                const isHeaderArtifact = fullDescription.toLowerCase().includes("descripción") ||
                    fullDescription.toLowerCase().includes("código") ||
                    fullDescription.includes("---");

                if (!isHeaderArtifact && finalTotal > 0) {
                    const classification = classifyBillingModel({
                        quantity: finalQuantity,
                        unitPrice: finalUnitPrice,
                        total: finalTotal,
                        valorIsa: valorIsa,
                        description: fullDescription
                    });

                    const finalAuthoritativeTotal = classification.authoritativeTotal;
                    if (valorIsa > 0) finalTotal = finalAuthoritativeTotal;

                    if (classification.model === 'MULTIPLICATIVE_EXACT') {
                        finalCalcTotal = Math.round(finalQuantity * finalUnitPrice);
                        const tolerance = classification.toleranceApplied || 10;
                        hasError = Math.abs(finalTotal - finalCalcTotal) > tolerance;
                    } else {
                        finalCalcTotal = finalAuthoritativeTotal;
                        hasError = false;
                    }

                    sectionObj.items.push({
                        index: globalIndex++,
                        description: fullDescription,
                        quantity: finalQuantity,
                        unitPrice: finalUnitPrice,
                        total: finalTotal,
                        calculatedTotal: finalCalcTotal,
                        hasCalculationError: hasError,
                        isIVAApplied: isIVAApplied,
                        valorIsa: valorIsa,
                        bonificacion: bonificacion,
                        copago: copago,
                        billingModel: classification.model,
                        authoritativeTotal: finalAuthoritativeTotal,
                        unitPriceTrust: classification.unitPriceTrust,
                        qtyIsProration: classification.qtyIsProration,
                        suspectedColumnShift: classification.suspectedColumnShift,
                        toleranceApplied: classification.toleranceApplied
                    });
                }
            }
        }



        // ... After parsing lines Loop ...

        // --- MATH AUDIT (no LLM repair) ---
        forensicLog(`Iniciando Auditoría Matemática de ${sectionsMap.size} secciones.`);
        const sectionsArray = Array.from(sectionsMap.values());

        for (const sec of sectionsArray) {
            const sumItems = sec.items.reduce((acc: number, item: any) => acc + item.total, 0);

            if (sec.sectionTotal === 0 && sec.items.length > 0) {
                sec.sectionTotal = sumItems;
                continue;
            }

            const diff = sec.sectionTotal - sumItems;
            if (Math.abs(diff) > 10) {
                forensicLog(`⚠️ DESCUADRE en "${sec.category}": Declarado $${sec.sectionTotal} vs Suma $${sumItems} (Dif: $${diff}).`);
            }
        }

        // REMOVED REDUNDANT CONSISTENCY CHECK (Found Root Cause in Parser)

        // Re-calculate section totals before Discrepancy Hunter avoids confusion
        for (const sec of sectionsMap.values()) {
            sec.sectionTotal = sec.items.reduce((acc: number, item: any) => acc + item.total, 0);
        }

        // --- DISCREPANCY HUNTER ---
        // Final attempt to fix global discrepancies by identifying suspect items
        // Specifically targets "Honorarios" duplicates where AI forces Qty 1 on assistants.
        const currentExtractedTotal = Array.from(sectionsMap.values()).reduce((acc: number, sec: any) => acc + sec.sectionTotal, 0);
        const globalDiscrepancy = currentExtractedTotal - clinicGrandTotalField; // Positive means we over-extracted

        if (Math.abs(globalDiscrepancy) > 1000) {
            forensicLog(`🔍 DISCREPANCY HUNTER: Analizando sobrante de $${globalDiscrepancy}...`);

            let fixedGlobal = false;
            for (const sec of Array.from(sectionsMap.values())) {
                // look for items that might be inflated
                for (const item of sec.items) {
                    // Scenario: Item Total is suspiciously close to Discrepancy + X (where X is the real value)
                    // Or simply: If we reduce this item's Qty, does it fix the discrepancy?

                    if (item.unitPrice > 0) {
                        const targetTotal = item.total - globalDiscrepancy;
                        if (targetTotal > 0) {
                            const impliedQty = targetTotal / item.unitPrice;

                            // Check if impliedQty is a "clean" decimal (e.g. 0.08, 0.25, 0.33)
                            // or if the item is a duplicate Price of another item in the same section
                            const candidates = sec.items.filter((i: any) => i.unitPrice === item.unitPrice);
                            const isDuplicatePrice = candidates.length > 1;
                            const isFirstOccurrence = candidates[0] === item;
                            const isProtected = (isDuplicatePrice && isFirstOccurrence && item.unitPrice > 100000);

                            if ((isDuplicatePrice || impliedQty < 0.3) && impliedQty < 1 && impliedQty > 0 && !isProtected) {
                                // Double check if this new quantity makes sense
                                // e.g. 0.07999 -> 0.08
                                const potentialQty = Math.round(impliedQty * 100) / 100;

                                // STRICT CHECK: Only allow common medical fractions
                                // We don't want to change a quantity to 0.96 (or 0.07!) just because it fits the math.
                                const commonFractions = [0.1, 0.125, 0.2, 0.25, 0.3, 0.33, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9];
                                const isCommon = commonFractions.some(f => Math.abs(potentialQty - f) < 0.02);

                                if (!isCommon) {
                                    // DEAD STOP. No more loopholes for small values.
                                    // If isn't a standard surgery split (assistant, etc), don't invent it.
                                    continue;
                                }

                                const verificationTotal = Math.round(potentialQty * item.unitPrice);
                                const residual = Math.abs(verificationTotal - targetTotal);

                                if (residual < 5000) { // Tolerance
                                    forensicLog(`🎯 CAZADO: "${item.description}" parece estar inflado. Qty ${item.quantity} -> ${potentialQty}. Ajustando Total de $${item.total} a $${verificationTotal}.`);

                                    // Apply fix
                                    item.quantity = potentialQty;
                                    item.total = verificationTotal;
                                    item.calculatedTotal = verificationTotal;
                                    item.isUnjustifiedCharge = true; // Mark as suspiciously fixed

                                    // Update section total
                                    sec.sectionTotal -= (item.total - verificationTotal); // This won't work directly if sectionTotal is separate, but helps logic
                                    // Actually we should just update the item and let the final sum happen later, 
                                    // but sectionObj.sectionTotal is what creates the JSON.
                                    sec.sectionTotal = sec.items.reduce((sum: number, i: any) => sum + i.total, 0);

                                    // Break after fixing one major discrepancy per run to avoid cascading errors
                                    item.hasCalculationError = false;
                                    fixedGlobal = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if (fixedGlobal) break;
            }
        }


        const sumOfSections = Array.from(sectionsMap.values()).reduce((acc: number, s: any) => acc + s.sectionTotal, 0);

        // --- MAGNITUDE SANITY CHECK ---
        // Scenario: Gemini reads "452.075,00" as 45207500 (x100 inflation) for items.
        // But reads "Total: 6.912.876" correctly or differently.
        // If Sum is ~100x Stated Total, we should SCALE DOWN the items, not scale up the total.
        if (clinicGrandTotalField > 0 && sumOfSections > 0) {
            const ratio = sumOfSections / clinicGrandTotalField;
            if (ratio > 80 && ratio < 120) {
                console.warn(`[AUDIT] Detected likely magnitude error (Items Sum is 100x Stated Total). Sum: ${sumOfSections}, Stated: ${clinicGrandTotalField}. Scaling down ALL items by 100.`);

                // Fix every item in every section
                for (const section of sectionsMap.values()) {
                    section.items.forEach((item: any) => {
                        item.unitPrice = item.unitPrice / 100;
                        item.total = item.total / 100;
                        item.calculatedTotal = item.calculatedTotal / 100;
                    });
                    // Recalculate section total
                    section.sectionTotal = section.sectionTotal / 100;
                }

                // Update the Sum variable for the audit report
                // (Note: We don't update clinicGrandTotalField, we assume it was correct)
            }
        }

        // Re-calculate sum after potential fix
        // EXCLUDE informative sections (PAM) that should not be counted in total

        const finalSumOfSections = Array.from(sectionsMap.values())
            .filter((s: any) => {
                const cat = s.category.toUpperCase();
                const isInformative = cat.includes('PROGRAMA DE ATENCION MEDICA')
                    || cat.includes('PAM')
                    || cat.includes('DETALLE DE COBROS DUPLICADOS');
                if (isInformative) {
                    console.log(`[AUDIT] Excluding informative section from total: "${s.category}"`);
                }
                return !isInformative;
            })
            .reduce((acc: number, s: any) => acc + s.sectionTotal, 0);


        // --- MANITUDE FIX 2.0 (Heuristic Validation) ---
        // If final sum is massive (> 100M) and we have standard medical items in the >10M range, 
        // it's extremely likely we have a 100x inflation (comma read as dot).
        // Rizotomia is typically 2M, not 205M.
        let detectedInflation = false;
        if (finalSumOfSections > 100000000) { // > 100 Million
            // Check average item price
            let highValCount = 0;
            let totalCount = 0;
            for (const sec of sectionsMap.values()) {
                for (const item of sec.items) {
                    totalCount++;
                    if (item.unitPrice > 10000000) { // > 10 Million
                        highValCount++;
                    }
                }
            }

            if (totalCount > 0 && (highValCount / totalCount) > 0.1) {
                detectedInflation = true;
                console.warn(`[AUDIT] 🚨 DETECTED 100x INFLATION. Correcting values...`);

                for (const sec of sectionsMap.values()) {
                    for (const item of sec.items) {
                        item.unitPrice = Math.round(item.unitPrice / 100);
                        item.total = Math.round(item.total / 100);
                        item.calculatedTotal = Math.round(item.calculatedTotal / 100);
                        item.valorIsa = Math.round((item.valorIsa || 0) / 100);
                        item.bonificacion = Math.round((item.bonificacion || 0) / 100);
                        item.copago = Math.round((item.copago || 0) / 100);
                        item.authoritativeTotal = Math.round((item.authoritativeTotal || 0) / 100);
                    }
                    sec.sectionTotal = Math.round(sec.sectionTotal / 100);
                    sec.calculatedSectionTotal = Math.round(sec.calculatedSectionTotal / 100);
                }
            }
        }


        // --- NEW: CANONICAL AC2 INFERENCE (STRICT NORM) ---
        // Rule: AC2 = Bonification / Factor
        // Anchor: Rizotomia (1103057) -> Factor 1.2
        let inferredAC2: string | undefined = undefined;
        try {
            for (const sec of sectionsMap.values()) {
                for (const item of sec.items) {
                    const desc = (item.description || "").toUpperCase();
                    const code = (item.code || "").toUpperCase();

                    // Check for RIZOTOMIA (1103057)
                    if ((code === '1103057' || desc.includes('1103057') || desc.includes('RIZOTO')) && item.bonificacion > 0) {
                        const factor = 1.2; // Canonical Factor for Rizotomia (per User Rule)
                        const rawAC2 = item.bonificacion / factor;

                        // Validation range (AC2 typical values ~20k - 300k)
                        if (rawAC2 > 20000 && rawAC2 < 500000) {
                            // No rounding to "pretty" numbers. Use Math.round to get closest integer peso.
                            const ac2Value = Math.round(rawAC2);
                            inferredAC2 = `$${ac2Value.toLocaleString('es-CL')}`;
                            console.log(`[AUDIT] 🧮 DEDUCCIÓN AC2 (HECHO MATEMÁTICO):`);
                            console.log(`[AUDIT]   Ancla: ${desc} (${code})`);
                            console.log(`[AUDIT]   Análisis: Despeje desde aplicación observada del contrato.`);
                            console.log(`[AUDIT]   Formula: Bonificación $${item.bonificacion.toLocaleString('es-CL')} / Factor ${factor}`);
                            console.log(`[AUDIT]   Resultado: ${rawAC2.toFixed(4)} => ${inferredAC2}`);
                        }
                        break;
                    }
                }
                if (inferredAC2) break;
            }
        } catch (e) {
            console.error('[AUDIT] Error inferring AC2:', e);
        }

        // --- SKELETON + TAXONOMY PHASES REMOVED ---
        // Previously generated skeleton, Taxonomy Phase 1, and MEP/Etiology Phase 1.5 here.
        // Removed to lighten the extraction pipeline: 2-3 LLM calls eliminated.
        // The M11 engine operates directly on CanonicalBillItem[] and CanonicalPamLine[].
        console.log(`[SUCCESS] Audit data prepared.`);

        const auditData = {
            clinicName: clinicName,
            patientName: patientName,
            patientEmail: patientEmail,
            invoiceNumber: invoiceNumber,
            date: billingDate,
            currency: "CLP",
            sections: Array.from(sectionsMap.values()),
            clinicStatedTotal: detectedInflation ? Math.round((clinicGrandTotalField || finalSumOfSections) / 100) : (clinicGrandTotalField || finalSumOfSections),
            // INJECT INFERRED AC2 (CANONICAL)
            valorUnidadReferencia: inferredAC2,
            // PHASE MARKER FOR FRONTEND
            phase: "2.0"
        };


        console.log(`[SUCCESS] Audit data prepared. Sections: ${sectionsMap.size}. Total: ${auditData.clinicStatedTotal}`);

        // Enviar resultado final
        sendUpdate({
            type: 'final',
            data: auditData
        });
        console.log(`[RESPONSE] Final update sent.`);

        res.end();

    } catch (error: any) {
        console.error('Error in streaming extraction:', error);
        sendUpdate({ type: 'error', message: error.message || 'Internal Server Error' });
        res.end();
    }
});

// ========== PAM ENDPOINT (NEW) ==========
import { handleTaxonomyPhase1 } from './endpoints/taxonomy.endpoint.js';
import { handleAuditOrchestration } from './endpoints/audit.endpoint.js';

app.post('/api/cuenta/taxonomy-phase1', handleTaxonomyPhase1);
app.post('/api/audit/run', handleAuditOrchestration);

import { handleAuditAnalysis } from './endpoints/audit.endpoint.js';
app.post('/api/extract-pam', handlePamExtraction);
app.post('/api/extract-contract', handleContractExtraction);
app.post('/api/audit/analyze', handleAuditAnalysis);
app.post('/api/project', handleProjection);

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../dist')));

// Manejar cualquier otra ruta con el index.html del frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server running on port ${PORT}`);
});
// Port conflict resolution trigger
server.timeout = 600000; // 10 minutes
