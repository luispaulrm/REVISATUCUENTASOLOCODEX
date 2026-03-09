import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { performForensicAudit } from './services/auditEngine.service.js';
import { classifyBillingModel } from './services/billingModelClassifier.service.js';
import { ParserService } from "./services/parser.service.js";
import { OpenAIService } from './services/openai.service.js';
import { AI_CONFIG, GENERATION_CONFIG, getSafeMaxTokensForModel } from "./config/ai.config.js";
import { handlePamExtraction, handlePamValidation } from './endpoints/pam.endpoint.js';
import { handleContractExtraction } from './endpoints/contract.endpoint.js';
// No unnecessary imports
import { handleProjection } from './endpoints/projection.endpoint.js';
import { handleAskAuditor } from './endpoints/ask.endpoint.js';
import { handleBillChat } from './endpoints/bill-chat.endpoint.js';
import { handlePamChat } from './endpoints/pam-chat.endpoint.js';
import { handlePreCheck } from './endpoints/precheck.endpoint.js';
import { handleGeneratePdf } from './endpoints/generate-pdf.endpoint.js';
import { handleCanonicalExtraction } from './endpoints/canonical.endpoint.js';
import { handleM12VisualExtraction } from './endpoints/m12.endpoint.js';
import { handlePdfLayoutGet, handlePdfLayoutPost } from './endpoints/pdf-layout.endpoint.js';
import { handleRawExtract } from './endpoints/raw-extract.endpoint.js';
import { LearnContractEndpoint } from './endpoints/learn-contract.endpoint.js';
import { learnFromContract } from './services/contractLearning.service.js';
// REMOVED: TaxonomyPhase1Service, TaxonomyPhase1_5Service, SkeletonService, preProcessEventos
// These were eliminated to lighten the bill extraction pipeline (no longer used by M11 engine)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// âš ï¸ CRITICAL: Only load dotenv in development
// Railway injects env vars natively, dotenv.config() interferes
if (process.env.NODE_ENV !== 'production') {
    const rootEnvPath = path.join(process.cwd(), '.env');
    const rootEnvLocalPath = path.join(process.cwd(), '.env.local');
    const serverEnvPath = path.join(__dirname, '.env');
    if (fs.existsSync(rootEnvPath)) {
        dotenv.config({ path: rootEnvPath, override: false });
        console.log('Loaded root environment from ' + rootEnvPath);
    }
    if (fs.existsSync(rootEnvLocalPath)) {
        dotenv.config({ path: rootEnvLocalPath, override: true });
        console.log('Loaded root local environment from ' + rootEnvLocalPath);
    }
    if (fs.existsSync(serverEnvPath)) {
        dotenv.config({ path: serverEnvPath, override: true });
        console.log('Loaded server environment from ' + serverEnvPath);
    }
    if (!fs.existsSync(rootEnvPath) && !fs.existsSync(rootEnvLocalPath) && !fs.existsSync(serverEnvPath)) {
        dotenv.config(); // Fallback to default
        console.log('No .env files found in root/server, using default dotenv fallback');
    }
}
// âœ… Railway-compatible env access (Object.keys can fail in some runtimes)
function envGet(k: string) {
    const v = process.env[k];
    return typeof v === "string" ? v : undefined;
}

// Environment Check
console.log("\n" + "=".repeat(50));
console.log("ðŸš€ AUDIT SERVER BOOTSTRAP");
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
    console.error("âŒ GEMINI_API_KEY NOT FOUND (checked GEMINI_API_KEY + API_KEY)");
} else {
    console.log(`âœ… GEMINI_API_KEY LOADED`);
    console.log(`   Key preview: ${GEMINI_API_KEY.substring(0, 8)}...${GEMINI_API_KEY.slice(-4)}`);
}

const GEMINI_SEC = envGet("GEMINI_API_KEY_SECONDARY");
if (GEMINI_SEC) {
    console.log(`âœ… GEMINI_API_KEY_SECONDARY LOADED: ${GEMINI_SEC.substring(0, 8)}...`);
}
const GEMINI_TER = envGet("GEMINI_API_KEY_TERTIARY");
if (GEMINI_TER) {
    console.log(`âœ… GEMINI_API_KEY_TERTIARY LOADED: ${GEMINI_TER.substring(0, 8)}...`);
}
const GEMINI_QUA = envGet("GEMINI_API_KEY_QUATERNARY");
if (GEMINI_QUA) {
    console.log(`âœ… GEMINI_API_KEY_QUATERNARY LOADED: ${GEMINI_QUA.substring(0, 8)}...`);
}
const GEMINI_QUI = envGet("GEMINI_API_KEY_QUINARY");
if (GEMINI_QUI) {
    console.log(`âœ… GEMINI_API_KEY_QUINARY LOADED: ${GEMINI_QUI.substring(0, 8)}...`);
}
const OPENAI_API_KEY = envGet("OPENAI_API_KEY");
if (OPENAI_API_KEY) {
    console.log(`âœ… OPENAI_API_KEY LOADED: ${OPENAI_API_KEY.substring(0, 8)}...`);
}
const AZURE_DI_ENDPOINT = envGet("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
const AZURE_DI_KEY = envGet("AZURE_DOCUMENT_INTELLIGENCE_KEY");
const AZURE_DI_KEY_SECONDARY = envGet("AZURE_DOCUMENT_INTELLIGENCE_KEY_SECONDARY") || envGet("AZURE_DOCUMENT_INTELLIGENCE_KEY2");
if (AZURE_DI_ENDPOINT && (AZURE_DI_KEY || AZURE_DI_KEY_SECONDARY)) {
    const keyMode = AZURE_DI_KEY && AZURE_DI_KEY_SECONDARY ? 'primary+secondary' : (AZURE_DI_KEY ? 'primary' : 'secondary');
    console.log(`AZURE_DOCUMENT_INTELLIGENCE configured: ${AZURE_DI_ENDPOINT} (${keyMode})`);
} else {
    console.log('AZURE_DOCUMENT_INTELLIGENCE not configured (endpoint/key missing)');
}
console.log("=".repeat(50) + "\n");

// ðŸ›¡ï¸ GLOBAL CRASH GUARD
// Evita que el servidor se reinicie por errores "flaky" de librerÃ­as externas (ej: Google AI stream)
process.on('unhandledRejection', (reason, promise) => {
    console.error('ðŸš¨ [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    // No salimos (process.exit) para mantener el servidor vivo ante fallos transitorios
});

process.on('uncaughtException', (err) => {
    console.error('?? [CRITICAL] Uncaught Exception:', err);
    const code = (err as any)?.code;
    // Irrecoverable server startup errors: exit so tsx watch can restart cleanly.
    if (code === 'EADDRINUSE' || code === 'EACCES') {
        console.error(`[CRITICAL] Fatal startup error (${code}). Exiting process for clean restart.`);
        process.exit(1);
    }
});

const app = express();
// âœ… Railway requires listening to process.env.PORT
const PORT = Number(envGet("PORT") || 5000);

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use((err: any, _req: any, res: any, next: any) => {
    if (!err) return next();
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({
            error: 'Payload demasiado grande. Intenta un PDF mas liviano o menos paginas.'
        });
    }
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            error: 'JSON invalido en la solicitud.'
        });
    }
    return next(err);
});

const upload = multer({ storage: multer.memoryStorage() });

// Helper para obtener la API Key
const getApiKey = () => GEMINI_API_KEY;

function extractLinesFromPdfTextItems(items: any[]): string[] {
    const yTol = 3.2;
    const groups: Array<{ y: number; items: any[] }> = [];

    for (const it of items || []) {
        if (!it?.transform || it.transform.length < 6) continue;
        const y = Number(it.transform[5] || 0);
        const g = groups.find((x) => Math.abs(x.y - y) <= yTol);
        if (g) g.items.push(it);
        else groups.push({ y, items: [it] });
    }

    return groups
        .map((g) => {
            const row = g.items.sort(
                (a: any, b: any) => Number(a.transform?.[4] || 0) - Number(b.transform?.[4] || 0)
            );
            const y = g.y;
            const text = row.map((i: any) => String(i.str || '')).join(' ').replace(/\s+/g, ' ').trim();
            return { y, text };
        })
        .filter((l) => l.text.length > 0)
        .sort((a, b) => b.y - a.y)
        .map((l) => l.text);
}

async function extractPdfTextContext(
    base64Pdf: string,
    maxPages: number = 30
): Promise<{ text: string; pages: number; pageTexts: string[] }> {
    const data = new Uint8Array(Buffer.from(base64Pdf, 'base64'));
    const loadingTask = pdfjsLib.getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: true,
        disableWorker: true,
        verbosity: 0,
    } as any);

    const pdf = await loadingTask.promise;
    const pagesToRead = Math.min(pdf.numPages, maxPages);
    const chunks: string[] = [];
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const tc = await page.getTextContent();
        const lines = extractLinesFromPdfTextItems((tc as any).items || []);
        const pageText = lines.join('\n');
        pageTexts.push(pageText);
        chunks.push(`=== PAGE ${pageNumber} ===\n${pageText}`);
    }

    return {
        text: chunks.join('\n\n'),
        pages: pagesToRead,
        pageTexts
    };
}

function parseFlexibleNumeric(value: string, isQuantity: boolean = false): number {
    if (!value) return 0;
    let cleaned = value.trim();
    if (!cleaned) return 0;

    let negative = false;
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
        negative = true;
        cleaned = cleaned.slice(1, -1);
    }

    cleaned = cleaned.replace(/[^\d.,-]/g, '');
    if (!cleaned || cleaned === '-') return 0;
    if (cleaned.startsWith('-')) {
        negative = true;
        cleaned = cleaned.slice(1);
    }
    if (!/[0-9]/.test(cleaned)) return 0;

    const dotCount = (cleaned.match(/\./g) || []).length;
    const commaCount = (cleaned.match(/,/g) || []).length;
    let normalized = cleaned;

    if (dotCount > 0 && commaCount > 0) {
        const lastDot = cleaned.lastIndexOf('.');
        const lastComma = cleaned.lastIndexOf(',');
        // 1.234,56 => decimal comma; 1,234.56 => decimal dot
        if (lastComma > lastDot) {
            normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
        } else {
            normalized = cleaned.replace(/,/g, '');
        }
    } else if (commaCount > 0) {
        if (commaCount > 1) {
            normalized = cleaned.replace(/,/g, '');
        } else {
            const [left, right = ''] = cleaned.split(',');
            if (!isQuantity && right.length === 3 && left.length >= 1) {
                // 8,764 -> 8764
                normalized = `${left}${right}`;
            } else if (isQuantity && right.length === 3 && left.length <= 2) {
                // 1,000 qty -> 1.000
                normalized = `${left}.${right}`;
            } else {
                normalized = `${left}.${right}`;
            }
        }
    } else if (dotCount > 0) {
        if (dotCount > 1) {
            // 1.234.567 -> 1234567
            normalized = cleaned.replace(/\./g, '');
        } else {
            const [left, right = ''] = cleaned.split('.');
            if (!isQuantity && right.length === 3 && left.length >= 1) {
                // 8.764 -> 8764 for currency
                normalized = `${left}${right}`;
            } else {
                normalized = `${left}.${right}`;
            }
        }
    }

    let n = Number(normalized);
    if (!Number.isFinite(n)) n = 0;
    if (negative) n = -n;
    return n;
}

function parseChileanNumericToken(value: string): number {
    return parseFlexibleNumeric(value, false);
}

function detectPdfGrandTotalFromText(pdfText: string | null): { total: number; source: string } {
    if (!pdfText) return { total: 0, source: 'none' };

    const lines = pdfText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const tokenRegex = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g;

    // Pattern used in this bill family: multiple "Total Empresa" lines, one per provider.
    // The payable total is typically the max amount in each "Total Empresa" line.
    const totalEmpresaLines = lines.filter(l => /total\s+empresa/i.test(l));
    if (totalEmpresaLines.length > 0) {
        const perLineTotals: number[] = [];
        for (const line of totalEmpresaLines) {
            const matches = line.match(tokenRegex) || [];
            const values = matches
                .map(parseChileanNumericToken)
                .filter(v => v > 0);
            if (values.length === 0) continue;
            const candidate = Math.max(...values);
            if (candidate > 1000) perLineTotals.push(Math.round(candidate));
        }
        if (perLineTotals.length > 0) {
            const total = perLineTotals.reduce((acc, n) => acc + n, 0);
            return { total, source: 'total_empresa_sum' };
        }
    }

    // Generic fallback for documents that expose a single global total line.
    const globalTotalLines = lines.filter(l =>
        /(grand[_\s]?total|total\s+cuenta|monto\s+total|total\s+final|saldo\s+cuenta)/i.test(l)
    );
    if (globalTotalLines.length > 0) {
        let best = 0;
        for (const line of globalTotalLines) {
            const matches = line.match(tokenRegex) || [];
            const values = matches
                .map(parseChileanNumericToken)
                .filter(v => v > 0);
            if (values.length === 0) continue;
            best = Math.max(best, Math.max(...values));
        }
        if (best > 0) {
            return { total: Math.round(best), source: 'global_line_max' };
        }
    }

    return { total: 0, source: 'none' };
}

async function renderPdfPagesToPng(
    base64Pdf: string,
    maxPages: number = 30,
    scale: number = 2.0
): Promise<Array<{ image: string; mimeType: string }>> {
    const { createCanvas } = await import('@napi-rs/canvas');
    const data = new Uint8Array(Buffer.from(base64Pdf, 'base64'));
    const loadingTask = pdfjsLib.getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: true,
        disableWorker: true,
        verbosity: 0,
    } as any);
    const pdf = await loadingTask.promise;
    const pagesToRender = Math.min(pdf.numPages, maxPages);
    const rendered: Array<{ image: string; mimeType: string }> = [];

    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
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
                    category: { type: "string", description: "CategorÃ­a (Ej: PabellÃ³n, Insumos, Farmacia)" },
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                index: { type: "number", description: "NÃºmero correlativo del Ã­tem" },
                                description: { type: "string" },
                                quantity: { type: "number" },
                                unitPrice: { type: "number", description: "Precio unitario (preferiblemente bruto/ISA)" },
                                total: { type: "number", description: "Valor Total del Ã­tem incluyendo IVA/Impuestos (Valor ISA)" }
                            },
                            required: ["index", "description", "total"]
                        }
                    },
                    sectionTotal: { type: "number", description: "Total declarado por la clÃ­nica para la secciÃ³n" }
                },
                required: ["category", "items", "sectionTotal"]
            }
        },
        clinicStatedTotal: { type: "number", description: "El Gran Total final de la cuenta" }
    },
    required: ["clinicName", "sections", "clinicStatedTotal"]
};

// Motor de Cuenta Clinica deshabilitado.

app.post('/api/audit/ask', handleAskAuditor);
app.post('/api/bill/chat', handleBillChat);
app.post('/api/pam/chat', handlePamChat);
app.post('/api/audit/pre-check', handlePreCheck);
app.post('/api/generate-pdf', handleGeneratePdf);
app.post('/api/extract-canonical', handleCanonicalExtraction);
app.post('/api/m12/extract', handleM12VisualExtraction);
app.get('/api/pdf-layout', handlePdfLayoutGet);
app.post('/api/pdf-layout', handlePdfLayoutPost);
app.post('/api/extract-raw', handleRawExtract);
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
        console.warn('[contract-count] fallback count=0:', err?.message || err);
        res.json({ count: 0 });
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

app.post('/api/extract', (_req, res) => {
    res.status(410).json({
        error: 'Modulo Cuenta Clinica deshabilitado. Se reiniciara desde cero.'
    });
});

// ========== PAM ENDPOINT (NEW) ==========
import { handleTaxonomyPhase1 } from './endpoints/taxonomy.endpoint.js';
import { handleAuditOrchestration } from './endpoints/audit.endpoint.js';

app.post('/api/cuenta/taxonomy-phase1', handleTaxonomyPhase1);
app.post('/api/audit/run', handleAuditOrchestration);

import { handleAuditAnalysis } from './endpoints/audit.endpoint.js';
app.post('/api/extract-pam', handlePamExtraction);
app.post('/api/validate-pam', handlePamValidation);
app.post('/api/extract-contract', handleContractExtraction);
app.post('/api/audit/analyze', handleAuditAnalysis);
app.post('/api/project', handleProjection);

// Servir archivos estÃ¡ticos del frontend
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









