#!/usr/bin/env node
/**
 * Script de prueba de APIs
 * Verifica que ambas APIs (Gemini y OpenAI) funcionen correctamente
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { OpenAIService } from './services/openai.service.js';
import { GeminiService } from './services/gemini.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cargar .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

function envGet(k: string) {
    return process.env[k];
}

async function testOpenAI() {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 TEST: OpenAI Service');
    console.log('='.repeat(60));

    const apiKey = envGet('OPENAI_API_KEY');
    if (!apiKey) {
        console.log('❌ OPENAI_API_KEY no configurada');
        return false;
    }

    try {
        const service = new OpenAIService(apiKey, (msg) => console.log(`  [OpenAI] ${msg}`));
        
        console.log('\n📝 Prueba 1: Extracción simple (sin imagen)');
        const result = await service.extractText(
            'Responde con un JSON válido:\n{"status": "working", "model": "gpt-4o"}',
            {
                model: 'gpt-4o',
                maxTokens: 500,
                temperature: 0.1
            }
        );
        console.log(`   ✅ Resultado: ${result.substring(0, 100)}...`);

        console.log('\n✅ OpenAI Service: FUNCIONAL');
        return true;
    } catch (err: any) {
        console.log(`❌ Error en OpenAI: ${err.message}`);
        return false;
    }
}

async function testGemini() {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 TEST: Gemini Service');
    console.log('='.repeat(60));

    const apiKey = envGet('GEMINI_API_KEY');
    if (!apiKey) {
        console.log('❌ GEMINI_API_KEY no configurada');
        return false;
    }

    try {
        const service = new GeminiService(apiKey, (msg) => console.log(`  [Gemini] ${msg}`));
        
        console.log('\n📝 Prueba 1: Extracción simple (sin imagen)');
        const result = await service.extractText(
            'Responde con un JSON válido:\n{"status": "working", "model": "gemini"}',
            {
                maxTokens: 500,
                temperature: 0.1
            }
        );
        console.log(`   ✅ Resultado: ${result.substring(0, 100)}...`);

        console.log('\n✅ Gemini Service: FUNCIONAL');
        return true;
    } catch (err: any) {
        console.log(`❌ Error en Gemini: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log('\n');
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║' + ' VALIDADOR DE SERVICIOS DE IA '.padStart(34).padEnd(59) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');

    const results = {
        openai: false,
        gemini: false
    };

    // Test OpenAI
    try {
        results.openai = await testOpenAI();
    } catch (err: any) {
        console.log(`❌ Excepción en OpenAI test: ${err.message}`);
    }

    // Test Gemini
    try {
        results.gemini = await testGemini();
    } catch (err: any) {
        console.log(`❌ Excepción en Gemini test: ${err.message}`);
    }

    // Resumen
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESUMEN');
    console.log('='.repeat(60));
    
    console.log(`OpenAI:  ${results.openai ? '✅ FUNCIONAL' : '❌ FALLA'}`);
    console.log(`Gemini:  ${results.gemini ? '✅ FUNCIONAL' : '❌ FALLA'}`);

    const allWorking = results.openai && results.gemini;
    console.log('\n' + (allWorking ? '✅ ¡LISTO PARA PRODUCCIÓN!' : '❌ Revisar configuración'));
    console.log('');

    process.exit(allWorking ? 0 : 1);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
