#!/usr/bin/env node
/**
 * Verificador de configuración de APIs
 * Comprueba que OpenAI y Gemini estén correctamente configuradas
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cargar .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`✅ Loaded .env from: ${envPath}\n`);
} else {
    console.log(`⚠️  No .env found at: ${envPath}\n`);
}

function envGet(k: string) {
    return process.env[k];
}

function validateOpenAIKey(key?: string): { valid: boolean; message: string } {
    if (!key) {
        return { valid: false, message: '❌ OPENAI_API_KEY no configurada' };
    }
    if (key.length < 20) {
        return { valid: false, message: `❌ OPENAI_API_KEY muy corta (${key.length} chars, mín 20)` };
    }
    if (!key.startsWith('sk-')) {
        return { valid: false, message: '❌ OPENAI_API_KEY no comienza con "sk-"' };
    }
    return { valid: true, message: `✅ OPENAI_API_KEY válida (${key.substring(0, 8)}...)` };
}

function validateGeminiKey(key?: string): { valid: boolean; message: string } {
    if (!key) {
        return { valid: false, message: '❌ GEMINI_API_KEY no configurada' };
    }
    if (key.length < 20) {
        return { valid: false, message: `❌ GEMINI_API_KEY muy corta (${key.length} chars, mín 20)` };
    }
    return { valid: true, message: `✅ GEMINI_API_KEY válida (${key.substring(0, 8)}...)` };
}

console.log('='.repeat(60));
console.log('🔍 VERIFICACIÓN DE CONFIGURACIÓN - APIs de IA');
console.log('='.repeat(60) + '\n');

// OpenAI
console.log('📍 OPENAI:');
const openaiKey = envGet('OPENAI_API_KEY');
const openaiValidation = validateOpenAIKey(openaiKey);
console.log(`   ${openaiValidation.message}`);

// Gemini
console.log('\n📍 GOOGLE GEMINI:');
const geminiKey = envGet('GEMINI_API_KEY');
const geminiValidation = validateGeminiKey(geminiKey);
console.log(`   ${geminiValidation.message}`);

const geminiSec = envGet('GEMINI_API_KEY_SECONDARY');
if (geminiSec && geminiSec.length > 5) {
    console.log(`   ✅ GEMINI_API_KEY_SECONDARY configurada`);
}

const geminiTer = envGet('GEMINI_API_KEY_TERTIARY');
if (geminiTer && geminiTer.length > 5) {
    console.log(`   ✅ GEMINI_API_KEY_TERTIARY configurada`);
}

// Resumen
console.log('\n' + '='.repeat(60));
console.log('📊 RESUMEN:');
console.log('='.repeat(60));

const allValid = openaiValidation.valid && geminiValidation.valid;

if (allValid) {
    console.log('✅ ¡Configuración lista! Ambas APIs están disponibles\n');
    console.log('🎯 Sistema funcionará con:');
    console.log('   • OpenAI GPT-4o: Para auditoría M11 (vision)');
    console.log('   • Google Gemini: Como fallback principal');
    console.log('');
    process.exit(0);
} else {
    console.log('❌ Configuración incompleta. Revisa:\n');
    if (!openaiValidation.valid) {
        console.log('   1. Obtén una API key de https://platform.openai.com/api-keys');
        console.log('   2. Copia el valor sk-... en OPENAI_API_KEY del .env');
        console.log('');
    }
    if (!geminiValidation.valid) {
        console.log('   1. Obtén una API key de https://aistudio.google.com/app/apikey');
        console.log('   2. Copia el valor en GEMINI_API_KEY del .env');
        console.log('');
    }
    process.exit(1);
}
