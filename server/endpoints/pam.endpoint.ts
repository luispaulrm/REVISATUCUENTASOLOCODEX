import { Request, Response } from 'express';
import { PAM_PROMPT } from '../prompts/pam.prompt.js';
import { calculatePrice } from '../config/ai.config.js';
import { OpenAIService } from '../services/openai.service.js';

function envGet(key: string): string | undefined {
    const value = process.env[key];
    return typeof value === 'string' ? value : undefined;
}

const getOpenAIExtractionKeys = (): string[] => {
    const keys = [];
    if (envGet('OPENAI_API_KEY')) keys.push(envGet('OPENAI_API_KEY'));
    if (envGet('OPENAI_API_KEY_SECONDARY')) keys.push(envGet('OPENAI_API_KEY_SECONDARY'));
    if (envGet('OPENAI_API_KEY_TERTIARY')) keys.push(envGet('OPENAI_API_KEY_TERTIARY'));
    if (envGet('API_KEY')?.startsWith('sk-')) keys.push(envGet('API_KEY'));
    return [...new Set(keys)].filter((key): key is string => Boolean(key));
};

const getOpenAIValidationKeys = (): string[] => {
    const keys = [];
    if (envGet('OPENAI_API_KEY')) keys.push(envGet('OPENAI_API_KEY'));
    if (envGet('OPENAI_API_KEY_SECONDARY')) keys.push(envGet('OPENAI_API_KEY_SECONDARY'));
    if (envGet('OPENAI_API_KEY_TERTIARY')) keys.push(envGet('OPENAI_API_KEY_TERTIARY'));
    if (envGet('API_KEY')?.startsWith('sk-')) keys.push(envGet('API_KEY'));
    return [...new Set(keys)].filter((key): key is string => Boolean(key));
};

const resolveAzureLayoutKeys = (): string[] => {
    const primary = String(envGet('AZURE_DOCUMENT_INTELLIGENCE_KEY') || '').trim();
    const secondary = String(envGet('AZURE_DOCUMENT_INTELLIGENCE_KEY_SECONDARY') || envGet('AZURE_DOCUMENT_INTELLIGENCE_KEY2') || '').trim();
    return [...new Set([primary, secondary].filter((key) => key.length > 0))];
};

const resolveAzureLayoutEnabled = (): boolean => {
    const endpoint = String(envGet('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT') || '').trim();
    const keys = resolveAzureLayoutKeys();
    return endpoint.length > 0 && keys.length > 0;
};

async function azureExtractPamHintsFromPdf(pdfBase64: string): Promise<string[]> {
    if (!resolveAzureLayoutEnabled()) return [];

    const endpoint = String(envGet('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT') || '').trim().replace(/\/+$/, '');
    const keys = resolveAzureLayoutKeys();
    const apiVersion = String(envGet('AZURE_DOCUMENT_INTELLIGENCE_API_VERSION') || '2024-11-30');
    const url = `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${apiVersion}&outputContentFormat=text`;

    let lastError: any = null;
    for (const key of keys) {
        try {
            const submitResponse = await fetch(url, {
                method: 'POST',
                headers: {
                    'Ocp-Apim-Subscription-Key': key,
                    'Content-Type': 'application/pdf'
                },
                body: Buffer.from(pdfBase64, 'base64')
            });

            if (!submitResponse.ok) {
                const body = await submitResponse.text().catch(() => '');
                throw new Error(`Azure submit HTTP ${submitResponse.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
            }

            const operationLocation = submitResponse.headers.get('operation-location');
            if (!operationLocation) throw new Error('Azure missing operation-location');

            const startedAt = Date.now();
            while (Date.now() - startedAt < 120000) {
                await new Promise((resolve) => setTimeout(resolve, 2500));
                const pollResponse = await fetch(operationLocation, {
                    headers: { 'Ocp-Apim-Subscription-Key': key }
                });
                const pollPayload = await pollResponse.json().catch(() => ({}));
                if (!pollResponse.ok) throw new Error(`Azure poll HTTP ${pollResponse.status}`);

                const status = String(pollPayload?.status || '').toLowerCase();
                if (status === 'succeeded') {
                    const pages = Array.isArray(pollPayload?.analyzeResult?.pages) ? pollPayload.analyzeResult.pages : [];
                    const lines: string[] = [];
                    for (const page of pages.slice(0, 20)) {
                        const pageNo = Number(page?.pageNumber || 0);
                        const pageLines = Array.isArray(page?.lines) ? page.lines : [];
                        for (const line of pageLines.slice(0, 160)) {
                            const content = String(line?.content || '').replace(/\s+/g, ' ').trim();
                            if (content) lines.push(`[P${pageNo || '?'}] ${content}`);
                        }
                    }
                    return lines.slice(0, 1200);
                }

                if (status === 'failed') throw new Error(`Azure status=${status}`);
            }

            throw new Error('Azure timeout');
        } catch (error: any) {
            lastError = error;
        }
    }

    if (lastError) throw lastError;
    return [];
}

function cleanMoney(value: string): number {
    if (!value) return 0;
    return parseInt(value.replace(/[^\d-]/g, ''), 10) || 0;
}

function parseMoney(value: any): number {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseInt(value.replace(/[^\d]/g, ''), 10) || 0;
    return 0;
}

function repairCommonMojibake(value: string): string {
    const input = String(value || '').trim();
    if (!input) return '';
    let patched = input
        .replace(/\*\*\s*/g, '')
        .replace(/I(?:Ã3|�3|ï¿½3)N/gi, 'IÓN')
        .replace(/MEDICI(?:Ã3|�3|ï¿½3)N/gi, 'MEDICIÓN')
        .replace(/M(?:ÃO|�O|ï¿½O)TODO/gi, 'MÉTODO')
        .replace(/T(?:Ã‰|�‰|ï¿½‰)CNICAS/gi, 'TÉCNICAS');
    if (!/[ÃÂ�ï¿½]/.test(patched)) return patched;
    try {
        const repaired = Buffer.from(patched, 'latin1').toString('utf8').trim();
        return repaired || patched;
    } catch {
        return patched;
    }
}

function repairUppercaseAccentArtifacts(value: string): string {
    return String(value || '')
        .replace(/([A-ZÁÉÍÓÚÜÑ])á(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Á')
        .replace(/([A-ZÁÉÍÓÚÜÑ])é(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1É')
        .replace(/([A-ZÁÉÍÓÚÜÑ])í(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Í')
        .replace(/([A-ZÁÉÍÓÚÜÑ])ó(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Ó')
        .replace(/([A-ZÁÉÍÓÚÜÑ])ú(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Ú')
        .replace(/([A-ZÁÉÍÓÚÜÑ])ü(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Ü')
        .replace(/([A-ZÁÉÍÓÚÜÑ])ñ(?=[A-ZÁÉÍÓÚÜÑ])/g, '$1Ñ');
}

function normalizePamDisplayText(value: string): string {
    const repaired = repairUppercaseAccentArtifacts(repairCommonMojibake(String(value || '')));
    return repaired
        .replace(/\*\*\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizePamProviderName(value: string): string {
    let text = normalizePamDisplayText(value);
    if (!text) return '';

    if (/^SERV\.?\s*INTEG\.?\s*DE\s*SALUD\s*LTDA\./i.test(text)) {
        return /LIBRE/i.test(text)
            ? 'SERV. INTEG. DE SALUD LTDA. (LIBRE ELECCION)'
            : 'SERV. INTEG. DE SALUD LTDA.';
    }

    if (/^CLINICA INDISA/i.test(text)) {
        return /LIBRE/i.test(text)
            ? 'CLINICA INDISA (LIBRE ELECCION)'
            : 'CLINICA INDISA';
    }

    text = text
        .replace(/\(LIBRE(?:\s+ELECCION(?:\s+[A-Z.]+)?)?.*$/i, '(LIBRE ELECCION)')
        .replace(/\(LIBRE ELECCION$/i, '(LIBRE ELECCION)');

    return text;
}

function sanitizePamDescriptionText(value: string): string {
    let text = normalizePamDisplayText(value);
    if (!text) return '';

    text = text
        .replace(/^(?:SANTA MARIA\s+\d+\s+)?G\/C C[ÓO]DIGO IA DESCRIPCI[ÓO]N PRESTACI[ÓO]N N[º°O]? VALOR BONIFICA\.?\s*COB\.?\s*SEG\.?\s*BES\s*PLAN\s*COPAGO\s*/i, '')
        .replace(/^C[ÓO]DIGO PRESTACI[ÓO]N CANTIDAD VALOR BONIFICACI[ÓO]N CONVENIO COPAGO\s*/i, '')
        .replace(/^AGENCIA\s*:\s*CASA MATRIZ\s+VALORIZACI[ÓO]N\s*:\s*COPAGO EN CL[IÍ]NICA\s*/i, '')
        .replace(/\s+NO CONVENIO\s*:.*$/i, '')
        .replace(/\s+PAGADO\s+FIRMA BENEFICIARIO.*$/i, '')
        .replace(/\s+FIRMA BENEFICIARIO.*$/i, '')
        .replace(/\s+nueva\s+\d{2}\/\d{2}\/\d{4}.*$/i, '')
        .replace(/\s+OA?\s*masvida.*$/i, '')
        .replace(/\s+-IN\s+\S+$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    return text;
}

function normalizePamDeclaredTotals(
    totalValorDeclarado: number,
    totalBonificacionDeclarada: number,
    totalCopagoDeclarado: number,
    fallbackValor: number,
    fallbackBonificacion: number,
    fallbackCopago: number
): {
    totalValorDeclarado: number;
    totalBonificacionDeclarada: number;
    totalCopagoDeclarado: number;
} {
    let valor = parseMoney(totalValorDeclarado) || parseMoney(fallbackValor);
    const bonificacion = parseMoney(totalBonificacionDeclarada) || parseMoney(fallbackBonificacion);
    const copago = parseMoney(totalCopagoDeclarado) || parseMoney(fallbackCopago);

    if ((valor <= 0 || valor === bonificacion) && bonificacion > 0 && copago > 0) {
        valor = bonificacion + copago;
    }

    return {
        totalValorDeclarado: valor,
        totalBonificacionDeclarada: bonificacion,
        totalCopagoDeclarado: copago
    };
}

function extractPamProgramContextByFolio(rawText: string, folioPAM: string): {
    periodoCobro?: string;
    totalValorDeclarado?: number;
    totalBonificacionDeclarada?: number;
    totalCopagoDeclarado?: number;
    sourceLine?: string;
} {
    const targetFolio = String(folioPAM || '').replace(/[^\d]/g, '');
    if (!targetFolio) return {};

    const lines = String(rawText || '')
        .split('\n')
        .map((line) => normalizePamDisplayText(line))
        .filter(Boolean);

    let currentFolio = '';
    let periodoCobro = '';
    const subtotalLines: string[] = [];
    const copagoLines: string[] = [];
    const seenSubtotalLines = new Set<string>();
    const seenCopagoLines = new Set<string>();
    let totalValorDeclarado = 0;
    let totalBonificacionDeclarada = 0;
    let totalCopagoDeclarado = 0;

    for (const line of lines) {
        const folioMatch = line.match(/(?:Folio\s+P(?:\.A\.M\.?)?|Folio\s+PAM|Documento asociado:\s*PAM\s*N[º°]?|Correlativo\s+P\.A\.M\.)\s*:?\s*([0-9]+)/i);
        if (folioMatch) currentFolio = String(folioMatch[1] || '').replace(/[^\d]/g, '');
        if (currentFolio !== targetFolio) continue;

        const periodMatch = line.match(/Per[ií]odo\s+de\s+Cobro\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})\s*-\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
        if (periodMatch) periodoCobro = `${periodMatch[1]} - ${periodMatch[2]}`;

        const subtotalMatch = line.match(/Sub\s+total\s+por\s+prestador\s*:.*?Valores\s*\(\$\)\s*:?\s*([\d.]+)\s+([\d.]+)/i);
        if (subtotalMatch) {
            if (!seenSubtotalLines.has(line)) {
                seenSubtotalLines.add(line);
                totalValorDeclarado += parseMoney(subtotalMatch[1]);
                totalBonificacionDeclarada += parseMoney(subtotalMatch[2]);
                subtotalLines.push(line);
            }
            continue;
        }

        const copagoMatch = line.match(/Copago\s+en\s+Cl[ií]nica\s*:?\s*([\d.]+)/i);
        if (copagoMatch) {
            if (!seenCopagoLines.has(line)) {
                seenCopagoLines.add(line);
                totalCopagoDeclarado += parseMoney(copagoMatch[1]);
                copagoLines.push(line);
            }
        }
    }

    const sourceLines = [...subtotalLines, ...copagoLines];
    if (!periodoCobro && sourceLines.length === 0) return {};

    return {
        periodoCobro: periodoCobro || undefined,
        totalValorDeclarado: totalValorDeclarado || undefined,
        totalBonificacionDeclarada: totalBonificacionDeclarada || undefined,
        totalCopagoDeclarado: totalCopagoDeclarado || undefined,
        sourceLine: sourceLines.length
            ? (sourceLines.length === 1
                ? sourceLines[0]
                : `Suma de ${sourceLines.length} lineas PROGRAMA detectadas para folio ${targetFolio}. ${sourceLines.slice(0, 4).join(' | ')}${sourceLines.length > 4 ? ' | ...' : ''}`)
            : undefined
    };
}

const PAM_CODE_DESCRIPTION_OVERRIDES: Record<string, string> = {
    '302046': 'GASES Y EQUILIBRIO ACIDO BASE EN SANGRE (INCLUYE: PH, O2, CO2, EXCESO DE BASE Y BICARBONATO), TODOS O CADA UNO DE LOS PARAMETROS',
    '302081': 'CALCIO IÓNICO. INCLUYE MEDICIÓN DE PH MÉTODO IÓN SELECTIVO. NO INCLUYE POINT OF CARE TESTING POCT',
    '702203': 'PRUEBA DE COMPATIBILIDAD POR UNIDAD DE GLÓBULOS ROJOS ESTUDIADA (PROC. AUT.)'
};

const PAM_CODE_DESCRIPTION_CANONICAL: Record<string, string> = {
    ...PAM_CODE_DESCRIPTION_OVERRIDES,
    '0101031': 'CONSULTA DE URGENCIA INSTITUCIONAL HORARIO INHABIL',
    '0201101': 'DIA CAMA DE HOSPITALIZACION INTEGRAL CUIDADOS MEDIOS (SALA 1 CAMA)',
    '0301034': 'CLASIFICACION SANGUINEA ABO Y RHD',
    '0301045': 'HEMOGRAMA (INCLUYE RECUENTOS DE LEUCOCITOS, ERITROCITOS, PLAQUETAS, HEMOGLOBINA, HEMATOCRITO, FORMULA LEUCOCITARIA, CARACTERISTICAS DE LOS ELEMENTOS FIGURADOS Y VELOCIDAD DE ERITROSEDIMENTACION)',
    '0301085': 'TROMBOPLASTINA, TIEMPO PARCIAL DE (TTPA, TTPK O SIMILARES)',
    '0302004': 'LACTATO EN SANGRE',
    '0302008': 'AMILASA, EN SANGRE',
    '0302023': 'CREATININA EN SANGRE',
    '0302032': 'ELECTROLITOS PLASMATICOS (SODIO, POTASIO, CLORO) C/U',
    '0302034': 'PERFIL LIPIDICO (INCLUYE MEDICIONES DE COLESTEROL TOTAL, HDL-COLESTEROL Y TRIGLICERIDOS CON ESTIMACIONES POR FORMULA DE LDL-COLESTEROL, VLDL-COLESTEROL Y COLESTEROL NO-HDL)',
    '0302047': 'GLUCOSA EN SANGRE',
    '0302053': 'LIPASA EN SANGRE',
    '0302057': 'NITROGENO UREICO Y/O UREA, EN SANGRE',
    '0302076': 'PERFIL HEPATICO (INCLUYE TIEMPO DE PROTROMBINA, BILIRRUBINA TOTAL Y CONJUGADA, FOSFATASAS ALCALINAS TOTALES, GGT, TRANSAMINASAS GOT/AST Y GPT/ALT)',
    '0305031': 'PROTEINA C REACTIVA POR TECNICAS AUTOMATIZADAS',
    '0306011': 'UROCULTIVO, RECUENTO DE COLONIAS Y ANTIBIOGRAMA (CUALQUIER TECNICA) (INCLUYE TOMA DE ORINA ASEPTICA Y FRASCO RECOLECTOR)',
    '0307011': 'TOMA DE MUESTRAS DE SANGRE VENOSA EN ADULTOS',
    '0309022': 'ORINA COMPLETA, (INCLUYE COD. 03-09-023 Y 03-09-024)',
    '0403020': 'TOMOGRAFIA COMPUTARIZADA DE ABDOMEN Y PELVIS',
    '0601103': 'ATENCION KINESIOLOGICA INTEGRAL EN PACIENTES HOSPITALIZADOS',
    '0702207': 'DETECCION DE ANTICUERPOS IRREGULARES ERITROCITARIOS',
    '0801005': 'ESTUDIO HISTOPATOLOGICO CON TECNICAS HISTOQUIMICAS, NIVELES, DECALCIFICACION (POR CADA LAMINA)',
    '0801008': 'ESTUDIO HISTOPATOLOGICO DE BIOPSIA DIFERIDA (POR CADA MUESTRA Y/O TEJIDO) (INCLUYE HASTA 3 LAMINAS)',
    '1802053': 'APENDICECTOMIA Y/O DREN. ABSCESO APENDICULAR (PROC. AUT.)',
    '3101001': 'MEDICAMENTOS CLINICOS EN HOSPITALIZACION',
    '3101002': 'MATERIALES CLINICOS EN HOSPITALIZACION',
    '3201001': 'GASTOS NO CUBIERTOS POR EL PLAN',
    '3201002': 'PRESTACION NO CONTEMPLADA EN EL ARANCEL'
};

function resolvePamCanonicalDescription(codigoGC: string, descripcion: string): string {
    const normalizedCode = normalizePamDisplayText(String(codigoGC || '').trim());
    const cleanedDescription = sanitizePamDescriptionText(descripcion);
    const override = normalizePamDisplayText(PAM_CODE_DESCRIPTION_CANONICAL[normalizedCode] || '');
    if (!override) return cleanedDescription;

    const comparable = normalizePamComparable(cleanedDescription);
    const overrideComparable = normalizePamComparable(override);
    const isNoisy = /G\/C C[Ã"O]DIGO IA|^C[Ã"O]DIGO PRESTACI[Ã"O]N|PAGADO|FIRMA BENEFICIARIO|NÊN MAIN|MATYYE|BES PLAN COPAGO/i.test(cleanedDescription);
    const hasLeadingModifier = /^\d{2}\s+/.test(cleanedDescription);
    const looksTruncated = cleanedDescription.length < Math.max(24, Math.floor(override.length * 0.75))
        || /(?:\b(?:PR|BI|ERI|MED|HOSP|HISTOQUIM|AUT|LAMINAS?|CARACTERISTICAS?)|\()$/i.test(cleanedDescription);
    const looksEquivalent = comparable.length > 0 && (overrideComparable.startsWith(comparable) || comparable.startsWith(overrideComparable));

    if (!cleanedDescription || isNoisy || hasLeadingModifier || looksTruncated || looksEquivalent) {
        return override;
    }

    return cleanedDescription;
}

function normalizePamMimeType(imageBase64: string, mimeType: string): string {
    const normalized = String(mimeType || '').trim().toLowerCase();
    if (normalized === 'application/pdf') return 'application/pdf';
    if (normalized === 'application/octet-stream' || !normalized) {
        const head = String(imageBase64 || '').slice(0, 24);
        try {
            const signature = Buffer.from(head, 'base64').toString('latin1');
            if (signature.startsWith('%PDF')) return 'application/pdf';
        } catch {
            // no-op
        }
    }
    return normalized || 'application/pdf';
}

function buildPamRawText(rawPayload: any): string {
    const pages = getPamRawPages(rawPayload);
    const lines: string[] = [];

    for (const page of pages) {
        const pageNumber = Number(page?.pageNumber || 0);
        const rows = Array.isArray(page?.rows) ? page.rows : [];
        for (const row of rows) {
            const text = String(row?.text || '').replace(/\s+/g, ' ').trim();
            if (text) lines.push(`[P${pageNumber || '?'}] ${text}`);
        }
    }

    return lines.join('\n').trim();
}

function getPamRawPages(rawPayload: any): any[] {
    if (Array.isArray(rawPayload?.raw?.pages)) return rawPayload.raw.pages;
    if (Array.isArray(rawPayload?.pages)) return rawPayload.pages;
    return [];
}

function withPamRawPages(rawPayload: any, pages: any[]): any {
    if (Array.isArray(rawPayload?.raw?.pages)) {
        return {
            ...rawPayload,
            raw: {
                ...(rawPayload?.raw || {}),
                pages
            }
        };
    }

    if (Array.isArray(rawPayload?.pages)) {
        return {
            ...rawPayload,
            pages,
            processedPages: pages.length
        };
    }

    return rawPayload;
}

function buildPamPageText(page: any): string {
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    return rows
        .map((row: any) => String(row?.text || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function classifyPamRawPage(page: any): {
    pageNumber: number;
    isPam: boolean;
    itemBearing: boolean;
    family: 'modern-bono' | 'programa' | 'liquidacion' | 'duplicados' | 'unknown';
    score: number;
} {
    const pageNumber = Number(page?.pageNumber || 0);
    const text = normalizePamComparable(buildPamPageText(page)).toLowerCase();
    if (!text) {
        return { pageNumber, isPam: false, itemBearing: false, family: 'unknown', score: 0 };
    }

    const hasModernFolio = text.includes('folio p.a.m') || text.includes('folio pam');
    const hasPrograma = text.includes('programa de atencion medica');
    const hasLiquidacion = text.includes('liquidacion detalle de atenciones de salud') || text.includes('documento asociado: pam');
    const hasDuplicados = text.includes('detalle de cobros duplicados de acuerdo a norma');
    const hasModernTable = text.includes('codigo prestacion cantidad valor bonificacion convenio copago');
    const hasClassicTable = text.includes('g/c codigo ia descripcion prestacion n valor bonifica');

    let family: 'modern-bono' | 'programa' | 'liquidacion' | 'duplicados' | 'unknown' = 'unknown';
    let score = 0;

    if (hasPrograma) {
        family = 'programa';
        score += 6;
    }
    if (hasLiquidacion) {
        family = 'liquidacion';
        score += 6;
    }
    if (hasDuplicados) {
        family = 'duplicados';
        score += 5;
    }
    if (hasModernFolio && hasModernTable) {
        family = 'modern-bono';
        score += 8;
    } else if (hasModernFolio) {
        score += 3;
    }
    if (hasClassicTable) score += 4;

    const isPam = score >= 5;
    const itemBearing = family === 'modern-bono' || family === 'programa' || family === 'liquidacion';
    return { pageNumber, isPam, itemBearing, family, score };
}

function extractPamFolioFromPageText(page: any): string {
    const text = buildPamPageText(page);
    const match = text.match(/(?:Folio\s+P(?:\.A\.M\.?)?|Folio\s+PAM|Documento asociado:\s*PAM\s*N[º°])\s*:?\s*([0-9]+)/i);
    return String(match?.[1] || '').trim();
}

function selectPamRelevantRawPayload(rawPayload: any): {
    filteredPayload: any;
    selectedPageNumbers: number[];
    itemPageNumbers: number[];
    familiesByPage: Array<{ pageNumber: number; family: string; itemBearing: boolean }>;
} {
    const pages = getPamRawPages(rawPayload);
    const classified = pages.map((page) => ({ page, meta: classifyPamRawPage(page) }));
    const selected = classified.filter((entry) => entry.meta.isPam);
    if (!selected.length) {
        return {
            filteredPayload: rawPayload,
            selectedPageNumbers: [],
            itemPageNumbers: [],
            familiesByPage: []
        };
    }

    const filteredPayload = withPamRawPages(rawPayload, selected.map((entry) => entry.page));

    return {
        filteredPayload,
        selectedPageNumbers: selected.map((entry) => entry.meta.pageNumber),
        itemPageNumbers: selected.filter((entry) => entry.meta.itemBearing).map((entry) => entry.meta.pageNumber),
        familiesByPage: selected.map((entry) => ({
            pageNumber: entry.meta.pageNumber,
            family: entry.meta.family,
            itemBearing: entry.meta.itemBearing
        }))
    };
}

function selectPamDeterministicPages(rawPayload: any): any[] {
    const pages = getPamRawPages(rawPayload);
    const classified = pages
        .map((page) => ({
            page,
            meta: classifyPamRawPage(page),
            folio: extractPamFolioFromPageText(page),
            candidateCount: countPamItemCandidates(page),
            rowCount: Array.isArray(page?.rows) ? page.rows.length : 0
        }))
        .filter((entry) => entry.meta.itemBearing);

    if (!classified.length) return pages;

    const groups = new Map<string, typeof classified>();
    for (const entry of classified) {
        const key = entry.folio || `page-${entry.meta.pageNumber}`;
        const bucket = groups.get(key) || [];
        bucket.push(entry);
        groups.set(key, bucket);
    }

    const selected: any[] = [];
    for (const entries of groups.values()) {
        const modern = entries.filter((entry) => entry.meta.family === 'modern-bono');
        const programa = entries.filter((entry) => entry.meta.family === 'programa');
        const liquidacion = entries.filter((entry) => entry.meta.family === 'liquidacion');
        const modernRich = modern.filter((entry) => entry.candidateCount >= 3);
        const modernStrong = modern.filter((entry) => entry.candidateCount >= 5 || (entry.candidateCount >= 1 && entry.rowCount >= 35));
        let chosen = entries;
        if (modernStrong.length > 0) {
            chosen = modernStrong;
        } else if (programa.length > 0) {
            chosen = programa;
        } else if (modernRich.length > 0) {
            chosen = modernRich;
        } else if (modern.length > 0) {
            chosen = modern;
        } else if (liquidacion.length > 0) {
            chosen = liquidacion;
        }
        selected.push(...chosen.map((entry) => entry.page));
    }

    return selected;
}

type PamValidationOutcome = {
    isValid: boolean;
    detectedType: string;
    reason: string;
};

function isPamCompatibleDetectedType(value: string): boolean {
    const normalized = String(value || '').trim().toUpperCase();
    return normalized === 'PAM' || normalized === 'CUENTA_PAM';
}

async function validatePamBeforeProcessing(image: string, mimeType: string): Promise<PamValidationOutcome> {
    const { ValidationService } = await import('../services/validation.service.js');
    const validationService = new ValidationService(getOpenAIValidationKeys());

    if (!validationService.hasKeys()) {
        return {
            isValid: true,
            detectedType: 'UNKNOWN',
            reason: 'OPENAI_API_KEY no disponible; validacion omitida'
        };
    }

    const validation = await validationService.validateDocumentType(image, mimeType, 'PAM');
    if (validation.isValid) {
        return {
            isValid: true,
            detectedType: validation.detectedType,
            reason: validation.reason
        };
    }

    const isServiceError = validation.detectedType === 'ERROR'
        || validation.reason.includes('401')
        || validation.reason.includes('429')
        || validation.reason.includes('503')
        || validation.reason.toLowerCase().includes('api key');

    if (isServiceError) {
        return {
            isValid: true,
            detectedType: validation.detectedType,
            reason: `Validacion omitida por error de servicio: ${validation.reason}`
        };
    }

    return {
        isValid: false,
        detectedType: validation.detectedType,
        reason: validation.reason
    };
}

export async function handlePamValidation(req: Request, res: Response) {
    try {
        const { image, mimeType, traceId } = req.body || {};
        const traceLabel = String(traceId || '').trim();
        if (!image || !mimeType) {
            return res.status(400).json({ error: 'Missing image or mimeType' });
        }

        const effectiveMimeType = normalizePamMimeType(image, mimeType);
        console.log(`[PAM${traceLabel ? `][${traceLabel}` : ''}] validate start mime=${effectiveMimeType}`);
        const validation = await validatePamBeforeProcessing(image, effectiveMimeType);

        if (!validation.isValid) {
            console.log(`[PAM${traceLabel ? `][${traceLabel}` : ''}] validate reject detected=${validation.detectedType} reason=${validation.reason}`);
            return res.status(422).json({
                ok: false,
                expectedType: 'PAM',
                detectedType: validation.detectedType,
                reason: validation.reason,
                traceId: traceLabel || undefined
            });
        }

        console.log(`[PAM${traceLabel ? `][${traceLabel}` : ''}] validate ok detected=${validation.detectedType}`);
        return res.json({
            ok: true,
            expectedType: 'PAM',
            detectedType: validation.detectedType,
            reason: validation.reason,
            traceId: traceLabel || undefined
        });
    } catch (error: any) {
        const traceLabel = String(req.body?.traceId || '').trim();
        console.error(`[PAM${traceLabel ? `][${traceLabel}` : ''}] validate error:`, error);
        return res.status(500).json({ error: error?.message || 'Validation failed', traceId: traceLabel || undefined });
    }
}

function parsePamTextToDocument(fullText: string) {
    const lines = fullText.split('\n').map((line) => line.trim()).filter(Boolean);
    const mapFolios = new Map<string, any>();
    let currentFolio = 'UNKNOWN';
    let currentFolioObj: any = null;
    let currentProviderObj: any = null;
    const seenItems = new Set<string>();

    for (const line of lines) {
        if (line.startsWith('FOLIO:')) {
            currentFolio = line.replace('FOLIO:', '').trim();
            currentProviderObj = null;

            if (!mapFolios.has(currentFolio)) {
                currentFolioObj = {
                    folioPAM: currentFolio,
                    prestadorPrincipal: 'PENDING',
                    periodoCobro: 'PENDING',
                    desglosePorPrestador: [],
                    resumen: {
                        totalCopagoDeclarado: 0,
                        copago: 0,
                        revisionCobrosDuplicados: ''
                    }
                };
                mapFolios.set(currentFolio, currentFolioObj);
            } else {
                currentFolioObj = mapFolios.get(currentFolio);
            }
            continue;
        }

        if (line.startsWith('DATE_START:')) {
            if (currentFolioObj) {
                const start = line.replace('DATE_START:', '').trim();
                const currentPeriod = String(currentFolioObj.periodoCobro || 'PENDING');
                const end = currentPeriod.includes(' - ') ? currentPeriod.split(' - ')[1] : '';
                currentFolioObj.periodoCobro = end ? `${start} - ${end}` : start;
            }
            continue;
        }

        if (line.startsWith('DATE_END:')) {
            if (currentFolioObj) {
                const end = line.replace('DATE_END:', '').trim();
                const currentPeriod = String(currentFolioObj.periodoCobro || 'PENDING');
                const start = currentPeriod.includes(' - ') ? currentPeriod.split(' - ')[0] : (currentPeriod === 'PENDING' ? '' : currentPeriod);
                currentFolioObj.periodoCobro = start ? `${start} - ${end}` : end;
            }
            continue;
        }

        if (line.startsWith('PROVIDER:')) {
            const providerName = line.replace('PROVIDER:', '').trim();
            if (!currentFolioObj) {
                currentFolio = 'DEFAULT_PAM';
                currentFolioObj = {
                    folioPAM: currentFolio,
                    prestadorPrincipal: 'PENDING',
                    periodoCobro: 'PENDING',
                    desglosePorPrestador: [],
                    resumen: { revisionCobrosDuplicados: '' }
                };
                mapFolios.set(currentFolio, currentFolioObj);
            }

            currentProviderObj = currentFolioObj.desglosePorPrestador.find((provider: any) => provider.nombrePrestador === providerName);
            if (!currentProviderObj) {
                currentProviderObj = {
                    nombrePrestador: providerName,
                    items: []
                };
                currentFolioObj.desglosePorPrestador.push(currentProviderObj);
                if (currentFolioObj.prestadorPrincipal === 'PENDING') {
                    currentFolioObj.prestadorPrincipal = providerName;
                }
            }
            continue;
        }

        if (line.startsWith('TOTAL_COPAGO_DECLARADO:')) {
            if (currentFolioObj) {
                currentFolioObj.resumen.totalCopagoDeclarado = cleanMoney(line.replace('TOTAL_COPAGO_DECLARADO:', ''));
            }
            continue;
        }

        if (line.startsWith('DUPLICATE_REVIEW:')) {
            if (currentFolioObj) {
                const note = line.replace('DUPLICATE_REVIEW:', '').trim();
                const previous = String(currentFolioObj.resumen.revisionCobrosDuplicados || '').trim();
                currentFolioObj.resumen.revisionCobrosDuplicados = previous ? `${previous} | ${note}` : note;
            }
            continue;
        }

        if (!line.includes('|')) continue;
        const parts = line.split('|').map((part) => part.trim());
        if (parts.length < 6 || !currentFolioObj) continue;

        const [code, description, quantity, total, bonif, copago] = parts;
        if (description.includes('Descripcion') || description.includes('Descripción') || description.includes('---')) continue;

        if (!currentProviderObj) {
            currentProviderObj = {
                nombrePrestador: 'PRESTADOR_GENERAL',
                items: []
            };
            currentFolioObj.desglosePorPrestador.push(currentProviderObj);
        }

        const newItem = {
            codigoGC: code,
            descripcion: description,
            cantidad: quantity,
            valorTotal: cleanMoney(total),
            bonificacion: cleanMoney(bonif),
            copago: cleanMoney(copago)
        };

        const dedupeKey = [
            currentFolio,
            currentProviderObj.nombrePrestador,
            newItem.codigoGC,
            newItem.descripcion,
            newItem.cantidad,
            newItem.valorTotal,
            newItem.bonificacion,
            newItem.copago
        ].join('|').toUpperCase();

        if (!seenItems.has(dedupeKey)) {
            seenItems.add(dedupeKey);
            currentProviderObj.items.push(newItem);
        }
    }

    const folios = Array.from(mapFolios.values());
    let globalValor = 0;
    let globalBonif = 0;
    let globalCopago = 0;
    let globalDeclarado = 0;
    let globalItems = 0;

    for (const folio of folios) {
        const providers = folio.desglosePorPrestador || [];
        let folioCopago = 0;

        for (const provider of providers) {
            const items = provider.items || [];
            for (const item of items) {
                const valor = parseMoney(item.valorTotal);
                const bonif = parseMoney(item.bonificacion);
                const copago = parseMoney(item.copago);

                globalValor += valor;
                globalBonif += bonif;
                globalCopago += copago;
                globalItems++;
                folioCopago += copago;
            }
        }

        if (!folio.resumen) folio.resumen = {};
        if (!folio.resumen.revisionCobrosDuplicados) folio.resumen.revisionCobrosDuplicados = '';

        const totalDeclarado = parseMoney(folio.resumen.totalCopagoDeclarado || folio.resumen.totalCopago || 0);
        if (!folio.resumen.totalCopagoCalculado) folio.resumen.totalCopagoCalculado = folioCopago;
        if (!folio.resumen.totalCopago) folio.resumen.totalCopago = folioCopago;
        if (!folio.resumen.auditoriaStatus) {
            folio.resumen.auditoriaStatus = Math.abs(folioCopago - totalDeclarado) <= 500 ? 'OK' : 'DISCREPANCY';
        }
        folio.resumen.cuadra = Math.abs(folioCopago - totalDeclarado) <= 500;
        folio.resumen.discrepancia = folioCopago - totalDeclarado;
        globalDeclarado += totalDeclarado;
    }

    return {
        folios,
        global: {
            totalValor: globalValor,
            totalBonif: globalBonif,
            totalCopago: globalCopago,
            totalCopagoDeclarado: globalDeclarado,
            cuadra: Math.abs(globalCopago - globalDeclarado) <= 500,
            discrepancia: globalCopago - globalDeclarado,
            auditoriaStatus: 'COMPLETED',
            totalItems: globalItems
        }
    };
}

function extractMoneyCandidates(text: string): number[] {
    const matches = String(text || '').match(/\d{1,3}(?:\.\d{3})+|\d+/g) || [];
    return matches
        .map((token) => parseMoney(token))
        .filter((value) => Number.isFinite(value) && value > 0);
}

function extractDeclaredTotalsFromRawText(rawText: string): {
    totalValorDeclarado?: number;
    totalBonificacionDeclarada?: number;
    totalCopagoDeclarado?: number;
    sourceLine?: string;
} {
    const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const tally = new Map<string, { count: number; data: any }>();

    for (const line of lines) {
        const normalized = line.toLowerCase();
        const hasTotalSignal = normalized.includes('totales')
            || normalized.includes('total pam')
            || normalized.includes('total general')
            || normalized.includes('total bonos')
            || normalized.includes('total bono')
            || normalized.includes('valor prestación')
            || normalized.includes('copago en clinica')
            || normalized.includes('copago prestador');
        if (!hasTotalSignal) continue;

        const numbers = extractMoneyCandidates(line);
        if (numbers.length === 0) continue;

        const record: any = { sourceLine: normalizePamDisplayText(line) };
        if (numbers.length >= 3 && (normalized.includes('totales') || normalized.includes('total pam') || normalized.includes('total general'))) {
            const trio = numbers.slice(-3);
            record.totalValorDeclarado = trio[0];
            record.totalBonificacionDeclarada = trio[1];
            record.totalCopagoDeclarado = trio[2];
        } else {
            record.totalCopagoDeclarado = numbers[numbers.length - 1];
        }

        const key = JSON.stringify(record);
        const prev = tally.get(key);
        tally.set(key, { count: (prev?.count || 0) + 1, data: record });
    }

    const winner = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    return winner?.data || {};
}

function choosePrincipalProviderName(
    providers: any[],
    headerProvider?: string
): string {
    const cleanedHeader = normalizePamProviderName(String(headerProvider || '').trim());
    if (cleanedHeader) return cleanedHeader;

    const ranked = (providers || [])
        .map((provider: any) => {
            const items = Array.isArray(provider?.items) ? provider.items : [];
            const totalValor = items.reduce((acc: number, item: any) => acc + parseMoney(item?.valorTotal), 0);
            return {
                name: normalizePamProviderName(String(provider?.nombrePrestador || '').trim()),
                totalValor
            };
        })
        .filter((provider: any) => provider.name);

    ranked.sort((a: any, b: any) => b.totalValor - a.totalValor);
    return ranked[0]?.name || 'PENDING';
}

function buildDeclaredTotalSourceLine(
    declaredTotals: { sourceLine?: string },
    totalCopagoDeclarado: number,
    totalCopagoCalculado: number
): string {
    const explicitSource = normalizePamDisplayText(String(declaredTotals?.sourceLine || '').trim());
    if (explicitSource) return explicitSource;
    if (totalCopagoDeclarado === totalCopagoCalculado) {
        return 'Inferido desde suma de items; no se detecto linea literal de total en RAW_EXTRACT.';
    }
    return 'Total declarado sin linea literal capturada; revisar RAW_EXTRACT.';
}

function buildLiteralDeclaredTotalsFromFolios(sourceFolios: any[]): {
    totalValorDeclarado?: number;
    totalBonificacionDeclarada?: number;
    totalCopagoDeclarado?: number;
    sourceLine?: string;
} | null {
    const foliosWithLiteralTotals = (sourceFolios || []).filter((folio: any) => {
        const source = normalizePamDisplayText(String(folio?.resumen?.fuenteTotalDeclarado || ''));
        return /(?:^\[P\d+\]\s*)?TOTAL(?:ES)?\b/i.test(source) || /\bTOTAL(?:ES)?\b/i.test(source);
    });

    if (!foliosWithLiteralTotals.length) return null;

    const sources = [...new Set(foliosWithLiteralTotals
        .map((folio: any) => normalizePamDisplayText(String(folio?.resumen?.fuenteTotalDeclarado || '')))
        .filter(Boolean))];

    const totalValorDeclarado = foliosWithLiteralTotals.reduce((acc: number, folio: any) => acc + parseMoney(folio?.resumen?.totalValorDeclarado), 0);
    const totalBonificacionDeclarada = foliosWithLiteralTotals.reduce((acc: number, folio: any) => acc + parseMoney(folio?.resumen?.totalBonificacionDeclarada), 0);
    const totalCopagoDeclarado = foliosWithLiteralTotals.reduce((acc: number, folio: any) => acc + parseMoney(folio?.resumen?.totalCopagoDeclarado), 0);

    if (sources.length === 1) {
        return {
            totalValorDeclarado,
            totalBonificacionDeclarada,
            totalCopagoDeclarado,
            sourceLine: sources[0]
        };
    }

    const preview = sources.slice(0, 3).join(' | ');
    return {
        totalValorDeclarado,
        totalBonificacionDeclarada,
        totalCopagoDeclarado,
        sourceLine: `Suma de ${sources.length} lineas literales de Total detectadas en bonos asociados RAW_EXTRACT. ${preview}${sources.length > 3 ? ' | ...' : ''}`
    };
}

function parseRetryAfterMs(error: any): number | null {
    const message = String(error?.message || error?.toString?.() || '');
    const secondsMatch = message.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (secondsMatch) {
        const seconds = Number(secondsMatch[1]);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.max(1000, Math.ceil(seconds * 1000) + 250);
        }
    }
    return null;
}

function extractMasterPamContext(rawText: string): {
    masterPamFolio: string;
    issueDate: string;
    dueDate: string;
    prestadorPrincipal: string;
    correlativosDocumento: string[];
} {
    const text = String(rawText || '');
    const pamMatches = [...text.matchAll(/Correlativo\s+P\.A\.M\.\s*:\s*([0-9]+)/gi)].map((match) => String(match[1] || '').trim());
    const correlativoMatches = [...text.matchAll(/Correlativo\s*:\s*(?:\d+-)?([0-9]{6,})/gi)].map((match) => String(match[1] || '').trim());
    const issueMatch = text.match(/Fecha\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
    const dueMatch = text.match(/Vencimiento\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
    const providerMatch = text.match(/Entidad Profesional\s*:\s*([^\n\r]+?)(?:\s+R\.U\.T|\s*$)/i);

    const countMostCommon = (values: string[]): string => {
        const tally = new Map<string, number>();
        for (const value of values) {
            if (!value) continue;
            tally.set(value, (tally.get(value) || 0) + 1);
        }
        return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    };

    return {
        masterPamFolio: countMostCommon(pamMatches),
        issueDate: String(issueMatch?.[1] || '').trim(),
        dueDate: String(dueMatch?.[1] || '').trim(),
        prestadorPrincipal: String(providerMatch?.[1] || '').trim(),
        correlativosDocumento: [...new Set(correlativoMatches.filter(Boolean))]
    };
}

function normalizePamLineText(value: string): string {
    return normalizePamDisplayText(String(value || '').replace(/\s+/g, ' ').trim());
}

function isPamStructuralRow(text: string): boolean {
    const normalized = normalizePamLineText(text).toLowerCase();
    if (!normalized) return true;
    return normalized.startsWith('documento ')
        || normalized.startsWith('documento:')
        || normalized.startsWith('isapre ')
        || normalized.startsWith('sucursal emisión')
        || normalized.startsWith('correlativo ')
        || normalized.startsWith('beneficiario ')
        || normalized.startsWith('cotizante ')
        || normalized.startsWith('plan ')
        || normalized.startsWith('entidad profesional ')
        || normalized.startsWith('otras coberturas')
        || normalized.startsWith('forma de pago ')
        || normalized.startsWith('importante:')
        || normalized.startsWith('código de verificación')
        || normalized.startsWith('bono atención nominativo')
        || normalized.startsWith('solo por la bonificación')
        || normalized.startsWith('prestador a pagar ')
        || normalized.startsWith('valor a pagar ')
        || normalized.startsWith('a pagar por el afiliado ')
        || normalized.startsWith('código nombre valor bonificación copago')
        || normalized.startsWith('prestación prestación cantidad prestación isapre afiliado')
        || normalized === 'b'
        || normalized === 'banmédica'
        || normalized === 'banmedica'
        || /^total\b/i.test(normalized);
}

function isPamStructuralRowV2(text: string): boolean {
    const normalized = normalizePamComparable(text).toLowerCase();
    if (!normalized) return true;
    return normalized.startsWith('documento ')
        || normalized.startsWith('documento:')
        || normalized.startsWith('isapre ')
        || normalized.startsWith('sucursal emision')
        || normalized.startsWith('correlativo ')
        || normalized.startsWith('beneficiario ')
        || normalized.startsWith('cotizante ')
        || normalized.startsWith('plan ')
        || normalized.startsWith('entidad profesional ')
        || normalized.startsWith('otras coberturas')
        || normalized.startsWith('forma de pago ')
        || normalized.startsWith('importante:')
        || normalized.startsWith('codigo de verificacion')
        || normalized.startsWith('bono atencion nominativo')
        || normalized.startsWith('solo por la bonificacion')
        || normalized.startsWith('prestador a pagar ')
        || normalized.startsWith('valor a pagar ')
        || normalized.startsWith('a pagar por el afiliado ')
        || normalized.startsWith('codigo nombre valor bonificacion copago')
        || normalized.startsWith('prestacion prestacion cantidad prestacion isapre afiliado')
        || normalized.startsWith('este bono se emite')
        || normalized.startsWith('afiliado la diferencia no bonificada')
        || normalized.startsWith('vigencia del bono')
        || normalized.startsWith('intransferible')
        || normalized.startsWith('plan:')
        || normalized.startsWith('prestador ')
        || normalized.startsWith('direccion ')
        || normalized.startsWith('emisor:')
        || normalized.startsWith('profesional medico:')
        || normalized.startsWith('medico tratante:')
        || normalized.startsWith('documento valido')
        || normalized.startsWith('pagado')
        || normalized.startsWith('firma beneficiario')
        || normalized.startsWith('oficina')
        || normalized.includes('prestadores pueden verificar la validez de este bono')
        || normalized === 'b'
        || normalized === 'banmedica'
        || /^total\b/i.test(normalized);
}

function extractPamMoneyTriplet(text: string): { valor: number; bonificacion: number; copago: number } | null {
    const moneyMatches = [...String(text || '').matchAll(/\$\s*([\d.]+)/g)].map((match) => parseMoney(match[1]));
    if (moneyMatches.length < 3) return null;
    const lastThree = moneyMatches.slice(-3);
    return {
        valor: lastThree[0],
        bonificacion: lastThree[1],
        copago: lastThree[2]
    };
}

function isPamQuantityToken(value: string): boolean {
    return /^\d+(?:[.,]\d+)?$/.test(String(value || '').trim());
}

function isPamAmountToken(value: string): boolean {
    return /^\$?\s*\d{1,3}(?:\.\d{3})*(?:,\d+)?$/.test(String(value || '').trim());
}

function inferPamCopagoFromTail(valor: number, bonificacion: number, tailAmounts: number[]): number {
    const inferred = Math.max(valor - bonificacion, 0);
    if (tailAmounts.length >= 4) {
        const explicitCopago = tailAmounts[3];
        return explicitCopago > 0 ? explicitCopago : inferred;
    }
    if (tailAmounts.length >= 3) {
        const explicitThird = tailAmounts[2];
        return explicitThird > 0 ? explicitThird : inferred;
    }
    return inferred;
}

function extractPamSplitItemHead(row: any): {
    codigoGC: string;
    descripcionInline: string;
} | null {
    const text = normalizePamLineText(String(row?.text || ''));
    if (!text || isPamStructuralRowV2(text)) return null;

    const cells = Array.isArray(row?.cells)
        ? row.cells.map((cell: any) => normalizePamLineText(String(cell?.text || ''))).filter(Boolean)
        : [];
    if (cells.length >= 2 && /^\d{6,8}$/.test(cells[0])) {
        const rest = cells.slice(1);
        if (!rest.some((token) => isPamQuantityToken(token) || isPamAmountToken(token))) {
            return {
                codigoGC: cells[0],
                descripcionInline: normalizePamLineText(rest.join(' ').replace(/^\*+\s*/, ''))
            };
        }
    }

    const match = text.match(/^\*{0,2}\s*(\d{6,8})\s+(.+)$/);
    if (!match) return null;

    const description = normalizePamLineText(String(match[2] || '').replace(/^\*+\s*/, ''));
    if (!description) return null;
    if (isPamQuantityToken(description) || /(?:\$\s*[\d.]+|^\d+(?:[.,]\d+)?(?:\s+[\d.]+){2,4}$)/.test(description)) return null;

    return {
        codigoGC: match[1],
        descripcionInline: description
    };
}

function extractPamSplitItemTail(row: any): {
    cantidad: string;
    valorTotal: number;
    bonificacion: number;
    copago: number;
} | null {
    const text = normalizePamLineText(String(row?.text || ''));
    if (!text || isPamStructuralRowV2(text)) return null;
    if (/^\*{0,2}\s*\d{6,8}\b/.test(text)) return null;

    const cells = Array.isArray(row?.cells)
        ? row.cells.map((cell: any) => normalizePamLineText(String(cell?.text || ''))).filter(Boolean)
        : [];
    const tokens = cells.length > 0 ? cells : text.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) return null;
    if (!isPamQuantityToken(tokens[0])) return null;

    const tail = tokens.slice(1);
    if (tail.length < 2 || tail.length > 4) return null;
    if (!tail.every((token) => isPamAmountToken(token))) return null;

    const amounts = tail.map((token) => parseMoney(token));
    const valorTotal = amounts[0];
    const bonificacion = amounts[1];

    return {
        cantidad: String(tokens[0]).replace(',', '.'),
        valorTotal,
        bonificacion,
        copago: inferPamCopagoFromTail(valorTotal, bonificacion, amounts)
    };
}

function extractPamItemCoreFromCells(cells: string[]): {
    codigoGC: string;
    descripcionInline: string;
    cantidad: string;
    valorTotal: number;
    bonificacion: number;
    copago: number;
} | null {
    if (!Array.isArray(cells) || cells.length < 4) return null;
    if (!/^\d{6,8}$/.test(cells[0])) return null;

    for (let qtyIndex = 1; qtyIndex <= cells.length - 3; qtyIndex += 1) {
        if (!isPamQuantityToken(cells[qtyIndex])) continue;
        const tail = cells.slice(qtyIndex + 1);
        if (tail.length < 2 || tail.length > 4) continue;
        if (!tail.every((token) => isPamAmountToken(token))) continue;

        const amounts = tail.map((token) => parseMoney(token));
        const valorTotal = amounts[0];
        const bonificacion = amounts[1];
        const descripcionInline = normalizePamLineText(cells.slice(1, qtyIndex).join(' ').replace(/^\*+\s*/, ''));
        if (!descripcionInline) continue;

        return {
            codigoGC: cells[0],
            descripcionInline,
            cantidad: cells[qtyIndex].replace(',', '.'),
            valorTotal,
            bonificacion,
            copago: inferPamCopagoFromTail(valorTotal, bonificacion, amounts)
        };
    }

    return null;
}

function extractPamItemCore(row: any): {
    codigoGC: string;
    descripcionInline: string;
    cantidad: string;
    valorTotal: number;
    bonificacion: number;
    copago: number;
} | null {
    const text = normalizePamLineText(String(row?.text || ''));
    if (!text || /^total\b/i.test(text)) return null;

    const cells = Array.isArray(row?.cells) ? row.cells.map((cell: any) => normalizePamLineText(String(cell?.text || ''))).filter(Boolean) : [];
    const cellsBased = extractPamItemCoreFromCells(cells);
    if (cellsBased) return cellsBased;

    const triplet = extractPamMoneyTriplet(text);
    if (!triplet) return null;

    let codigoGC = '';
    let cantidad = '1';
    let descripcionInline = '';

    if (cells.length >= 5 && /^\d{6,8}$/.test(cells[0])) {
        codigoGC = cells[0];
        const quantityIndex = cells.length - 4;
        if (quantityIndex > 0 && /^\d+(?:[.,]\d+)?$/.test(cells[quantityIndex])) {
            cantidad = cells[quantityIndex].replace(',', '.');
            descripcionInline = cells.slice(1, quantityIndex).join(' ');
        } else {
            descripcionInline = cells.slice(1, -3).join(' ');
        }
    } else {
        const codeMatch = text.match(/^\*{0,2}\s*(\d{6,8})\b/);
        if (!codeMatch) return null;
        codigoGC = codeMatch[1];
        const beforeMoney = text.split(/\$\s*[\d.]+/)[0].replace(/^\*{0,2}\s*\d{6,8}\s*/, '').trim();
        const qtyMatch = beforeMoney.match(/^(.*?)(\d+(?:[.,]\d+)?)$/);
        if (qtyMatch) {
            descripcionInline = qtyMatch[1].trim();
            cantidad = qtyMatch[2].replace(',', '.');
        } else {
            descripcionInline = beforeMoney;
        }
    }

    if (!codigoGC) return null;
    return {
        codigoGC,
        descripcionInline: normalizePamLineText(descripcionInline.replace(/^\*+\s*/, '')),
        cantidad,
        valorTotal: triplet.valor,
        bonificacion: triplet.bonificacion,
        copago: triplet.copago
    };
}

function countPamItemCandidates(page: any): number {
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    return rows.reduce((acc: number, row: any) => acc + (extractPamItemCore(row) ? 1 : 0), 0);
}

function isPamDescriptionContinuationRow(row: any): boolean {
    const text = normalizePamLineText(String(row?.text || ''));
    if (!text) return false;
    if (isPamStructuralRowV2(text)) return false;
    if (/^\d{8,}$/.test(text)) return false;
    if (/^\*{0,2}\s*\d{6,8}\b/.test(text)) return false;
    if (/\$\s*[\d.]+/.test(text)) return false;
    return true;
}

function normalizePamComparable(value: string): string {
    return normalizePamLineText(value)
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getPamLastWord(value: string): string {
    const tokens = normalizePamComparable(value).split(' ').filter(Boolean);
    return tokens[tokens.length - 1] || '';
}

function pamDescriptionContinuationScore(value: string): number {
    const text = normalizePamLineText(value);
    if (!text) return 0;

    let score = 0;
    if (/[,:;(]$/.test(text)) score += 4;
    if (!/[).]$/.test(text)) score += 2;

    const lastWord = getPamLastWord(text);
    const continuationWords = new Set([
        'DE', 'DEL', 'LA', 'LAS', 'LOS', 'POR', 'PARA', 'EN', 'CON', 'SIN', 'CADA',
        'UNIDAD', 'ELEMENTOS', 'METODO', 'METODOS', 'ION', 'IONES', 'GLOBULOS', 'ROJOS',
        'MUESTRA', 'MUESTRAS', 'ANTICUERPO', 'ANTICUERPOS', 'TRATAMIENTO', 'O2', 'PH',
        'TECNICAS', 'BASE'
    ]);
    if (continuationWords.has(lastWord)) score += 4;
    return score;
}

function looksLikeFreshPamDescriptionStart(value: string): boolean {
    const text = normalizePamLineText(value);
    const comparable = normalizePamComparable(text);
    if (!comparable) return false;
    if (text.startsWith('(')) return false;

    const firstWord = comparable.split(' ')[0] || '';
    if (firstWord === 'SELECTIVO' || firstWord === 'ESTUDIADA' || firstWord === 'FIGURADOS' || firstWord === 'TRATAMIENTO') {
        return false;
    }

    const freshWords = new Set([
        'HEMOGRAMA', 'GASES', 'PRUEBA', 'CLASIFICACION', 'DETECCION', 'DIA', 'ESTUDIO',
        'ATENCION', 'TOMOGRAFIA', 'APOYO', 'MATERIALES', 'MEDICAMENTOS', 'PRESTACIONES',
        'ELECTROLITOS', 'VISITA', 'DE', 'INMUNOHISTOQUIMICA'
    ]);

    if (freshWords.has(firstWord)) return true;
    if (text.startsWith('** ')) return true;
    return comparable.split(' ').length >= 4;
}

function looksLikeFreshPamDescriptionStartV2(value: string): boolean {
    const text = normalizePamLineText(value);
    const comparable = normalizePamComparable(text);
    if (!comparable) return false;
    if (text.startsWith('(')) return false;

    const firstWord = (comparable.split(' ')[0] || '').replace(/[^\w]/g, '');
    if (firstWord === 'SELECTIVO' || firstWord === 'ESTUDIADA' || firstWord === 'FIGURADOS' || firstWord === 'TRATAMIENTO') {
        return false;
    }

    const freshWords = new Set([
        'HEMOGRAMA', 'GASES', 'PRUEBA', 'CLASIFICACION', 'DETECCION', 'DIA', 'ESTUDIO',
        'ATENCION', 'TOMOGRAFIA', 'APOYO', 'MATERIALES', 'MEDICAMENTOS', 'PRESTACIONES',
        'ELECTROLITOS', 'VISITA', 'DE', 'INMUNOHISTOQUIMICA'
    ]);

    if (freshWords.has(firstWord)) return true;
    if (text.startsWith('** ')) return true;
    return comparable.split(' ').length >= 4;
}

function pushPamDescriptionPart(parts: string[], text: string): void {
    const normalized = normalizePamLineText(text);
    if (!normalized) return;
    if (parts[parts.length - 1] === normalized) return;
    parts.push(normalized);
}

function trimPamRowsToFirstDocumentCopy(rows: any[]): any[] {
    const markerIndex = rows.findIndex((row: any) => {
        const comparable = normalizePamComparable(String(row?.text || ''));
        return comparable.includes('COPIA PRESTADOR') || comparable.includes('COPIA AFILIADO');
    });
    return markerIndex >= 0 ? rows.slice(0, markerIndex) : rows;
}

function repairPamKnownItemSequence(items: any[]): any[] {
    if (!Array.isArray(items) || items.length === 0) return [];

    const repaired = items.map((item: any) => ({
        ...item,
        descripcion: resolvePamCanonicalDescription(String(item?.codigoGC || '').trim(), String(item?.descripcion || '')) || `CODIGO ${String(item?.codigoGC || '').trim()}`
    }));

    for (let index = 0; index <= repaired.length - 3; index += 1) {
        const first = repaired[index];
        const second = repaired[index + 1];
        const third = repaired[index + 2];
        if (!first || !second || !third) continue;

        if (first.codigoGC !== '302046' || second.codigoGC !== '302081' || third.codigoGC !== '702203') continue;

        const firstComparable = normalizePamComparable(first.descripcion);
        const secondComparable = normalizePamComparable(second.descripcion);
        const thirdComparable = normalizePamComparable(third.descripcion);
        const secondLooksLikeTail = secondComparable.startsWith('SELECTIVO')
            || secondComparable.startsWith('ESTUDIADA')
            || secondComparable.includes('POINT OF CARE TESTING');
        const thirdLooksLikeCompatibility = thirdComparable.startsWith('PRUEBA DE COMPATIBILIDAD')
            || thirdComparable.includes('GLOBULOS ROJOS');

        const shouldRepairKnownTrio = secondLooksLikeTail
            || secondComparable.startsWith('PRUEBA DE COMPATIBILIDAD')
            || thirdLooksLikeCompatibility
            || /^CODIGO\s+702203$/i.test(third.descripcion);

        if (shouldRepairKnownTrio) {
            first.descripcion = normalizePamDisplayText(PAM_CODE_DESCRIPTION_CANONICAL['302046']);
            second.descripcion = normalizePamDisplayText(PAM_CODE_DESCRIPTION_CANONICAL['302081']);
            third.descripcion = normalizePamDisplayText(PAM_CODE_DESCRIPTION_CANONICAL['702203']);
        }
    }

    return repaired;
}

function resolvePamContinuationTarget(
    text: string,
    openItems: Array<{ descParts: string[]; inlineDesc: string; rowIndex: number }>
): number | null {
    if (!openItems.length) return null;

    const freshStart = looksLikeFreshPamDescriptionStartV2(text);
    const startsWithParen = normalizePamLineText(text).startsWith('(');
    const lastItem = openItems[openItems.length - 1];
    const previousItem = openItems.length >= 2 ? openItems[openItems.length - 2] : null;
    const lastDesc = lastItem?.descParts?.join(' ').trim() || '';
    const previousDesc = previousItem?.descParts?.join(' ').trim() || '';

    if (startsWithParen) {
        return openItems.length - 1;
    }
    if (!lastDesc && previousItem) {
        if (!freshStart) {
            return openItems.length - 2;
        }
        return openItems.length - 1;
    }

    let bestIndex: number | null = null;
    let bestScore = -Infinity;

    for (let offset = 0; offset < Math.min(4, openItems.length); offset += 1) {
        const itemIndex = openItems.length - 1 - offset;
        const item = openItems[itemIndex];
        const currentDesc = item.descParts.join(' ').trim();
        let score = Math.max(0, 4 - offset);

        if (!currentDesc) {
            score += freshStart ? 5 : 1;
        } else {
            score += pamDescriptionContinuationScore(currentDesc);
            score += freshStart ? -2 : 2;
        }

        if (!freshStart && previousItem && itemIndex === openItems.length - 2 && pamDescriptionContinuationScore(previousDesc) >= 4 && !lastDesc) {
            score += 4;
        }
        if (!freshStart && itemIndex === openItems.length - 1 && !lastDesc && previousItem && pamDescriptionContinuationScore(previousDesc) >= 4) {
            score -= 3;
        }
        if (startsWithParen && itemIndex === openItems.length - 1 && !currentDesc) {
            score += 4;
        }

        if (item.inlineDesc && freshStart && pamDescriptionContinuationScore(currentDesc) <= 2) {
            score -= 1;
        }

        if (score > bestScore) {
            bestScore = score;
            bestIndex = itemIndex;
        }
    }

    return bestScore >= 6 ? bestIndex : null;
}

function parsePamPageDeterministic(page: any) {
    const rows = Array.isArray(page?.rows)
        ? trimPamRowsToFirstDocumentCopy([...page.rows].sort((a, b) => Number(a?.rowIndex || 0) - Number(b?.rowIndex || 0)))
        : [];
    const itemStates: any[] = [];
    const pendingPrefixRows: string[] = [];

    let correlativoDocumento = '';
    let folioPamMaster = '';
    let issueDate = '';
    let dueDate = '';
    let entidadProfesional = '';
    let prestadorPagar = '';
    let declaredTotalValor = 0;
    let declaredTotalBonificacion = 0;
    let declaredTotalCopago = 0;
    let declaredTotalSource = '';

    for (let index = 0; index < rows.length; index += 1) {
        const text = normalizePamLineText(String(rows[index]?.text || ''));
        if (!text) continue;

        const correlativoMatch = text.match(/Correlativo\s*:\s*(?:\d+-)?(\d{6,})/i);
        if (correlativoMatch) correlativoDocumento = correlativoMatch[1];
        const pamMatch = text.match(/(?:Correlativo\s+P\.A\.M\.|Folio\s+P(?:\.A\.M\.?)?|Folio\s+PAM|Documento asociado:\s*PAM\s*N[º°])\s*:?\s*([0-9]+)/i);
        if (pamMatch) folioPamMaster = pamMatch[1];
        const issueMatch = text.match(/Fecha\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
        if (issueMatch) issueDate = issueMatch[1];
        const attentionMatch = text.match(/Fecha\s+Atenci[oó]n\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
        if (attentionMatch) issueDate = attentionMatch[1];
        const dueMatch = text.match(/Vencimiento\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
        if (dueMatch) dueDate = dueMatch[1];
        const periodMatch = text.match(/Per[ií]odo\s+de\s+Cobro\s*:\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})\s*-\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
        if (periodMatch) {
            issueDate = issueDate || periodMatch[1];
            dueDate = dueDate || periodMatch[2];
        }
        const entityMatch = text.match(/Entidad Profesional\s*:\s*([^\n\r]+?)(?:\s+R\.U\.T|\s*$)/i);
        if (entityMatch) entidadProfesional = normalizePamLineText(entityMatch[1]);
        const providerMatch = text.match(/Prestador a pagar\s*:\s*([^\n\r]+?)(?:\s*,\s*RUT|\s*$)/i);
        if (providerMatch) prestadorPagar = normalizePamLineText(providerMatch[1]);
        const providerClassicMatch = text.match(/^Prestador(?:\s*\/\s*Instituci[oó]n|\s*:?)\s*[: ]\s*(?:\[[^\]]+\]\s*)?(?:\d[\d.-]*\s+)?([^\n\r]+?)(?:\s+No Convenio|\s+Sociedad|\s*,\s*RUT|\s*$)/i);
        if (providerClassicMatch) prestadorPagar = normalizePamLineText(providerClassicMatch[1]);

        if (/^total\b/i.test(text)) {
            const triplet = extractPamMoneyTriplet(text);
            if (triplet) {
                declaredTotalValor = triplet.valor;
                declaredTotalBonificacion = triplet.bonificacion;
                declaredTotalCopago = triplet.copago;
                declaredTotalSource = text;
            }
        }

        const inlineTotalsMatch = text.match(/Totales?\s*:?\s*(\d+(?:[.,]\d+)?)\s+([\d.]+)\s+([\d.]+)(?:\s+[\d.]+)?(?:\s+([\d.]+))?/i);
        if (inlineTotalsMatch) {
            declaredTotalValor = parseMoney(inlineTotalsMatch[2]);
            declaredTotalBonificacion = parseMoney(inlineTotalsMatch[3]);
            if (inlineTotalsMatch[4]) {
                declaredTotalCopago = parseMoney(inlineTotalsMatch[4]);
            }
            declaredTotalSource = text;
        }

        const copagoLineMatch = text.match(/Copago\s+en\s+(?:Prestad(?:or|o)|Cl[ií]nica)\s*:?\s*([\d.]+)/i);
        if (copagoLineMatch) {
            declaredTotalCopago = parseMoney(copagoLineMatch[1]);
            if (!declaredTotalSource) declaredTotalSource = text;
        }
    }

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const core = extractPamItemCore(row);
        if (core) {
            const itemState = {
                codigoGC: core.codigoGC,
                cantidad: core.cantidad,
                valorTotal: core.valorTotal,
                bonificacion: core.bonificacion,
                copago: core.copago,
                inlineDesc: core.descripcionInline,
                rowIndex: Number(row?.rowIndex || 0),
                descParts: [] as string[]
            };
            if (pendingPrefixRows.length > 0) {
                for (const pending of pendingPrefixRows) pushPamDescriptionPart(itemState.descParts, pending);
                pendingPrefixRows.length = 0;
            }
            if (core.descripcionInline) pushPamDescriptionPart(itemState.descParts, core.descripcionInline);
            itemStates.push(itemState);
            continue;
        }

        const splitHead = extractPamSplitItemHead(row);
        const splitTail = splitHead && index + 1 < rows.length ? extractPamSplitItemTail(rows[index + 1]) : null;
        if (splitHead && splitTail) {
            const itemState = {
                codigoGC: splitHead.codigoGC,
                cantidad: splitTail.cantidad,
                valorTotal: splitTail.valorTotal,
                bonificacion: splitTail.bonificacion,
                copago: splitTail.copago,
                inlineDesc: splitHead.descripcionInline,
                rowIndex: Number(row?.rowIndex || 0),
                descParts: [] as string[]
            };
            if (pendingPrefixRows.length > 0) {
                for (const pending of pendingPrefixRows) pushPamDescriptionPart(itemState.descParts, pending);
                pendingPrefixRows.length = 0;
            }
            pushPamDescriptionPart(itemState.descParts, splitHead.descripcionInline);
            itemStates.push(itemState);
            index += 1;
            continue;
        }

        if (!isPamDescriptionContinuationRow(row)) {
            pendingPrefixRows.length = 0;
            continue;
        }

        const continuationText = normalizePamLineText(String(row?.text || ''));
        const targetIndex = resolvePamContinuationTarget(continuationText, itemStates);
        if (targetIndex !== null) {
            pushPamDescriptionPart(itemStates[targetIndex].descParts, continuationText);
        } else {
            pendingPrefixRows.push(continuationText);
        }
    }

    const items = itemStates.map((item) => ({
        codigoGC: item.codigoGC,
        descripcion: normalizePamLineText(item.descParts.join(' ')) || item.inlineDesc || `CODIGO ${item.codigoGC}`,
        cantidad: item.cantidad,
        valorTotal: item.valorTotal,
        bonificacion: item.bonificacion,
        copago: item.copago,
        _audit: `page=${Number(page?.pageNumber || 0)} row=${Number(item.rowIndex || 0)} source=raw-deterministic`
    }));

    if (!items.length) return null;

    const providerName = prestadorPagar || entidadProfesional || 'PRESTADOR_GENERAL';
    const totalValorCalculado = items.reduce((acc, item) => acc + parseMoney(item.valorTotal), 0);
    const totalBonificacionCalculada = items.reduce((acc, item) => acc + parseMoney(item.bonificacion), 0);
    const totalCopagoCalculado = items.reduce((acc, item) => acc + parseMoney(item.copago), 0);

    return {
        folioPAM: correlativoDocumento || folioPamMaster || `PAGE-${Number(page?.pageNumber || 0)}`,
        masterPamFolio: folioPamMaster,
        correlativoDocumento: correlativoDocumento || '',
        prestadorPrincipal: providerName,
        periodoCobro: issueDate && dueDate ? `${issueDate} - ${dueDate}` : (issueDate || dueDate || 'PENDING'),
        desglosePorPrestador: [
            {
                nombrePrestador: providerName,
                items
            }
        ],
        resumen: {
            totalValorDeclarado: declaredTotalValor || totalValorCalculado,
            totalBonificacionDeclarada: declaredTotalBonificacion || totalBonificacionCalculada,
            totalCopagoDeclarado: declaredTotalCopago || totalCopagoCalculado,
            totalCopagoCalculado,
            totalCopago: totalCopagoCalculado,
            revisionCobrosDuplicados: '',
            fuenteTotalDeclarado: declaredTotalSource ? `[P${Number(page?.pageNumber || 0)}] ${declaredTotalSource}` : '',
            auditoriaStatus: Math.abs(totalCopagoCalculado - (declaredTotalCopago || totalCopagoCalculado)) <= 500 ? 'OK' : 'DISCREPANCY',
            cuadra: Math.abs(totalCopagoCalculado - (declaredTotalCopago || totalCopagoCalculado)) <= 500,
            discrepancia: totalCopagoCalculado - (declaredTotalCopago || totalCopagoCalculado)
        }
    };
}

export function buildPamDeterministicFromRawPayload(rawPayload: any): any | null {
    const scoped = selectPamRelevantRawPayload(rawPayload);
    const pages = selectPamDeterministicPages(scoped.filteredPayload);
    if (!pages.length) return null;

    const rawText = buildPamRawText(scoped.filteredPayload);
    const parsedPages = pages
        .map((page: any) => parsePamPageDeterministic(page))
        .filter(Boolean);

    if (!parsedPages.length) return null;

    const pageFingerprints = new Set<string>();
    const dedupedPages = parsedPages.filter((folio: any) => {
        const providerNames = (folio?.desglosePorPrestador || []).map((provider: any) => provider?.nombrePrestador || '').join('|');
        const items = (folio?.desglosePorPrestador || []).flatMap((provider: any) => provider?.items || []);
        const fingerprint = [
            folio?.folioPAM || '',
            providerNames,
            Number(folio?.resumen?.totalCopagoDeclarado || 0),
            items.length
        ].join('|');
        if (pageFingerprints.has(fingerprint)) return false;
        pageFingerprints.add(fingerprint);
        return true;
    });

    const modelLike = {
        folios: dedupedPages.map((folio: any) => ({
            folioPAM: folio.correlativoDocumento || folio.folioPAM,
            masterPamFolio: folio.masterPamFolio || '',
            correlativoDocumento: folio.correlativoDocumento || '',
            prestadorPrincipal: folio.prestadorPrincipal,
            periodoCobro: folio.periodoCobro,
            desglosePorPrestador: folio.desglosePorPrestador,
            resumen: {
                totalValorDeclarado: folio.resumen.totalValorDeclarado,
                totalBonificacionDeclarada: folio.resumen.totalBonificacionDeclarada,
                totalCopagoDeclarado: folio.resumen.totalCopagoDeclarado,
                fuenteTotalDeclarado: folio.resumen.fuenteTotalDeclarado,
                revisionCobrosDuplicados: folio.resumen.revisionCobrosDuplicados || ''
            }
        }))
    };

    const normalized = normalizePamJsonPayload(modelLike, rawText);
    if (!Array.isArray(normalized?.folios) || normalized.folios.length === 0) return null;
    if (Number(normalized?.global?.totalItems || 0) <= 0) return null;
    return normalized;
}

function normalizePamJsonPayload(modelPayload: any, rawText: string) {
    const sourceFolios = Array.isArray(modelPayload)
        ? modelPayload
        : (Array.isArray(modelPayload?.folios) ? modelPayload.folios : []);

    const declaredTotals = buildLiteralDeclaredTotalsFromFolios(sourceFolios) || extractDeclaredTotalsFromRawText(rawText);
    const masterContext = extractMasterPamContext(rawText);
    const canUseDocumentDeclaredTotalsPerFolio = sourceFolios.length <= 1;
    const folios = sourceFolios.map((folio: any, folioIndex: number) => {
        const providersRaw = Array.isArray(folio?.desglosePorPrestador) ? folio.desglosePorPrestador : [];
        const providers = providersRaw.map((provider: any, providerIndex: number) => {
            const seen = new Set<string>();
            const itemsRaw = Array.isArray(provider?.items) ? provider.items : [];
            const items = itemsRaw.flatMap((item: any) => {
                const itemAudit = String(item?._audit || '').trim();
                const normalizedItem = {
                    codigoGC: normalizePamDisplayText(String(item?.codigoGC || item?.codigo || '').trim()),
                    descripcion: resolvePamCanonicalDescription(
                        normalizePamDisplayText(String(item?.codigoGC || item?.codigo || '').trim()),
                        String(item?.descripcion || '').trim()
                    ),
                    cantidad: String(item?.cantidad || '1').trim() || '1',
                    valorTotal: parseMoney(item?.valorTotal),
                    bonificacion: parseMoney(item?.bonificacion),
                    copago: parseMoney(item?.copago)
                };
                if (!normalizedItem.descripcion) return [];
                const dedupeKey = [
                    folioIndex,
                    providerIndex,
                    itemAudit,
                    normalizedItem.codigoGC,
                    normalizedItem.descripcion,
                    normalizedItem.cantidad,
                    normalizedItem.valorTotal,
                    normalizedItem.bonificacion,
                    normalizedItem.copago
                ].join('|').toUpperCase();
                if (seen.has(dedupeKey)) return [];
                seen.add(dedupeKey);
                return [normalizedItem];
            });
            const repairedItems = repairPamKnownItemSequence(items);

            return {
                nombrePrestador: normalizePamProviderName(String(provider?.nombrePrestador || folio?.prestadorPrincipal || 'PRESTADOR_GENERAL').trim()),
                items: repairedItems
            };
        }).filter((provider: any) => provider.items.length > 0);

        const itemTotals = providers.flatMap((provider: any) => provider.items);
        const totalValor = itemTotals.reduce((acc: number, item: any) => acc + parseMoney(item.valorTotal), 0);
        const totalBonificacion = itemTotals.reduce((acc: number, item: any) => acc + parseMoney(item.bonificacion), 0);
        const totalCopago = itemTotals.reduce((acc: number, item: any) => acc + parseMoney(item.copago), 0);
        const folioDeclaredTotals = buildLiteralDeclaredTotalsFromFolios([folio]) || {
            totalValorDeclarado: parseMoney(folio?.resumen?.totalValorDeclarado),
            totalBonificacionDeclarada: parseMoney(folio?.resumen?.totalBonificacionDeclarada),
            totalCopagoDeclarado: parseMoney(folio?.resumen?.totalCopagoDeclarado),
            sourceLine: normalizePamDisplayText(String(folio?.resumen?.fuenteTotalDeclarado || ''))
        };
        const fallbackDeclaredTotals = canUseDocumentDeclaredTotalsPerFolio ? declaredTotals : {};
        const normalizedDeclaredTotals = normalizePamDeclaredTotals(
            folioDeclaredTotals.totalValorDeclarado || fallbackDeclaredTotals.totalValorDeclarado || totalValor,
            folioDeclaredTotals.totalBonificacionDeclarada || fallbackDeclaredTotals.totalBonificacionDeclarada || totalBonificacion,
            folioDeclaredTotals.totalCopagoDeclarado || fallbackDeclaredTotals.totalCopagoDeclarado || totalCopago,
            totalValor,
            totalBonificacion,
            totalCopago
        );
        const totalValorDeclarado = normalizedDeclaredTotals.totalValorDeclarado;
        const totalBonificacionDeclarada = normalizedDeclaredTotals.totalBonificacionDeclarada;
        const totalCopagoDeclarado = normalizedDeclaredTotals.totalCopagoDeclarado;

        return {
            folioPAM: String(folio?.folioPAM || folio?.folio || '').replace(/[^\d-]/g, '') || 'UNKNOWN',
            masterPamFolio: String(folio?.masterPamFolio || '').replace(/[^\d-]/g, '') || '',
            correlativoDocumento: String(folio?.correlativoDocumento || folio?.folioPAM || folio?.folio || '').replace(/[^\d-]/g, '') || 'UNKNOWN',
            prestadorPrincipal: choosePrincipalProviderName(providers, folio?.prestadorPrincipal),
            periodoCobro: String(folio?.periodoCobro || '').trim() || 'PENDING',
            desglosePorPrestador: providers,
            resumen: {
                totalValorDeclarado,
                totalBonificacionDeclarada,
                totalCopagoDeclarado,
                totalCopagoCalculado: totalCopago,
                totalCopago,
                revisionCobrosDuplicados: normalizePamDisplayText(String(folio?.resumen?.revisionCobrosDuplicados || '').trim()),
                fuenteTotalDeclarado: buildDeclaredTotalSourceLine(
                    (folioDeclaredTotals.sourceLine || canUseDocumentDeclaredTotalsPerFolio) ? {
                        ...fallbackDeclaredTotals,
                        ...folioDeclaredTotals
                    } : folioDeclaredTotals,
                    totalCopagoDeclarado,
                    totalCopago
                ),
                auditoriaStatus: Math.abs(totalCopago - totalCopagoDeclarado) <= 500 ? 'OK' : 'DISCREPANCY',
                cuadra: Math.abs(totalCopago - totalCopagoDeclarado) <= 500,
                discrepancia: totalCopago - totalCopagoDeclarado
            }
        };
    });
    const foliosByGroup = new Map<string, any[]>();
    for (const folio of folios) {
        const groupKey = String(folio.masterPamFolio || folio.folioPAM || folio.correlativoDocumento || '').trim() || 'UNKNOWN';
        const bucket = foliosByGroup.get(groupKey) || [];
        bucket.push(folio);
        foliosByGroup.set(groupKey, bucket);
    }

    const normalizedFolios = [...foliosByGroup.entries()].map(([groupKey, groupFolios]) => {
        const programContext = extractPamProgramContextByFolio(rawText, groupKey);
        if (groupFolios.length === 1) {
            const folio = groupFolios[0];
            const singleDeclaredTotals = normalizePamDeclaredTotals(
                programContext.totalValorDeclarado || folio.resumen.totalValorDeclarado,
                programContext.totalBonificacionDeclarada || folio.resumen.totalBonificacionDeclarada,
                programContext.totalCopagoDeclarado || folio.resumen.totalCopagoDeclarado,
                folio.resumen.totalCopagoCalculado + (parseMoney(folio.resumen.totalBonificacionDeclarada) || 0),
                folio.resumen.totalBonificacionDeclarada,
                folio.resumen.totalCopagoCalculado
            );
            return {
                ...folio,
                periodoCobro: programContext.periodoCobro || folio.periodoCobro,
                resumen: {
                    ...folio.resumen,
                    totalValorDeclarado: singleDeclaredTotals.totalValorDeclarado,
                    totalBonificacionDeclarada: singleDeclaredTotals.totalBonificacionDeclarada,
                    totalCopagoDeclarado: singleDeclaredTotals.totalCopagoDeclarado,
                    fuenteTotalDeclarado: buildDeclaredTotalSourceLine(
                        programContext.sourceLine ? programContext : { sourceLine: folio.resumen.fuenteTotalDeclarado },
                        singleDeclaredTotals.totalCopagoDeclarado,
                        folio.resumen.totalCopagoCalculado
                    )
                },
                bonosAsociados: groupFolios
                    .map((entry: any) => String(entry.correlativoDocumento || '').trim())
                    .filter((value: string) => value && value !== groupKey)
            };
        }

        const providerMap = new Map<string, any>();
        const correlativos = new Set<string>();

        for (const folio of groupFolios) {
            correlativos.add(String(folio.correlativoDocumento || '').trim());
            for (const provider of folio.desglosePorPrestador || []) {
                const key = String(provider.nombrePrestador || 'PRESTADOR_GENERAL').trim();
                const current = providerMap.get(key) || { nombrePrestador: key, items: [] };
                current.items.push(...(provider.items || []));
                providerMap.set(key, current);
            }
        }

        const mergedProviders = [...providerMap.values()];
        const mergedItems = mergedProviders.flatMap((provider: any) => provider.items || []);
        const totalValor = mergedItems.reduce((acc: number, item: any) => acc + parseMoney(item.valorTotal), 0);
        const totalBonificacion = mergedItems.reduce((acc: number, item: any) => acc + parseMoney(item.bonificacion), 0);
        const totalCopago = mergedItems.reduce((acc: number, item: any) => acc + parseMoney(item.copago), 0);
        const groupDeclaredTotals = buildLiteralDeclaredTotalsFromFolios(groupFolios) || declaredTotals;
        const normalizedGroupDeclaredTotals = normalizePamDeclaredTotals(
            programContext.totalValorDeclarado || groupDeclaredTotals.totalValorDeclarado || totalValor,
            programContext.totalBonificacionDeclarada || groupDeclaredTotals.totalBonificacionDeclarada || totalBonificacion,
            programContext.totalCopagoDeclarado || groupDeclaredTotals.totalCopagoDeclarado || totalCopago,
            totalValor,
            totalBonificacion,
            totalCopago
        );
        const totalCopagoDeclarado = normalizedGroupDeclaredTotals.totalCopagoDeclarado;
        const firstFolio = groupFolios[0];
        const groupMasterContext = groupKey === masterContext.masterPamFolio ? masterContext : { masterPamFolio: groupKey };
        const periodoCobro = groupFolios
            .map((folio: any) => String(folio?.periodoCobro || '').trim())
            .find((period: string) => period && period !== 'PENDING')
            || programContext.periodoCobro
            || firstFolio?.periodoCobro
            || 'PENDING';

        return {
            folioPAM: groupKey,
            bonosAsociados: [...correlativos].filter((value) => value && value !== groupKey),
            prestadorPrincipal: choosePrincipalProviderName(mergedProviders, groupMasterContext.prestadorPrincipal || firstFolio?.prestadorPrincipal),
            periodoCobro,
            desglosePorPrestador: mergedProviders,
            resumen: {
                totalValorDeclarado: normalizedGroupDeclaredTotals.totalValorDeclarado,
                totalBonificacionDeclarada: normalizedGroupDeclaredTotals.totalBonificacionDeclarada,
                totalCopagoDeclarado,
                totalCopagoCalculado: totalCopago,
                totalCopago,
                revisionCobrosDuplicados: '',
                fuenteTotalDeclarado: buildDeclaredTotalSourceLine(
                    programContext.sourceLine ? programContext : groupDeclaredTotals,
                    totalCopagoDeclarado,
                    totalCopago
                ),
                auditoriaStatus: Math.abs(totalCopago - totalCopagoDeclarado) <= 500 ? 'OK' : 'DISCREPANCY',
                cuadra: Math.abs(totalCopago - totalCopagoDeclarado) <= 500,
                discrepancia: totalCopago - totalCopagoDeclarado
            }
        };
    });

    const allItems = normalizedFolios.flatMap((folio: any) => folio.desglosePorPrestador.flatMap((provider: any) => provider.items));
    const totalValor = allItems.reduce((acc: number, item: any) => acc + parseMoney(item.valorTotal), 0);
    const totalBonif = allItems.reduce((acc: number, item: any) => acc + parseMoney(item.bonificacion), 0);
    const totalCopago = allItems.reduce((acc: number, item: any) => acc + parseMoney(item.copago), 0);
    const totalCopagoDeclarado = normalizedFolios.reduce((acc: number, folio: any) => acc + parseMoney(folio.resumen.totalCopagoDeclarado), 0);

    return {
        folios: normalizedFolios,
        global: {
            totalValor,
            totalBonif,
            totalCopago,
            totalCopagoDeclarado,
            cuadra: Math.abs(totalCopago - totalCopagoDeclarado) <= 500,
            discrepancia: totalCopago - totalCopagoDeclarado,
            auditoriaStatus: 'COMPLETED',
            totalItems: allItems.length
        }
    };
}

export async function handlePamExtraction(req: Request, res: Response) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    const traceId = String(req.body?.traceId || '').trim();
    const traceLabel = traceId ? `[${traceId}]` : '';
    console.log(`[PAM]${traceLabel} New PAM extraction request (deterministic-first)`);

    const sendUpdate = (data: any) => {
        if (!res.writableEnded) res.write(JSON.stringify(data) + '\n');
    };

    try {
        const { image, mimeType, rawPayload, preValidation } = req.body || {};
        if (!image || !mimeType) {
            sendUpdate({ type: 'error', message: 'Missing image or mimeType' });
            return res.end();
        }

        const effectiveMimeType = normalizePamMimeType(image, mimeType);
        sendUpdate({ type: 'log', message: `Trace PAM: ${traceId || 'sin-trace'}` });
        sendUpdate({ type: 'log', message: `PAM MIME efectivo: ${effectiveMimeType}` });
        const scopedRawSelection = selectPamRelevantRawPayload(rawPayload);
        const effectiveRawPayload = scopedRawSelection.selectedPageNumbers.length > 0 ? scopedRawSelection.filteredPayload : rawPayload;
        if (scopedRawSelection.selectedPageNumbers.length > 0) {
            sendUpdate({
                type: 'log',
                message: `Paginas PAM detectadas: ${scopedRawSelection.selectedPageNumbers.join(', ')}`
            });
        }
        const itemBearingPages = scopedRawSelection.itemPageNumbers;
        if (itemBearingPages.length > 0) {
            sendUpdate({
                type: 'log',
                message: `Paginas PAM con items: ${itemBearingPages.join(', ')}`
            });
        }
        const rawText = buildPamRawText(effectiveRawPayload);
        const hasRawWorkflow = rawText.length > 0;
        if (hasRawWorkflow) {
            sendUpdate({ type: 'log', message: `Workflow PAM: RAW OCR Bill-like activo (${rawText.split('\n').length} lineas)` });
        }

        const hasPrevalidatedPam = preValidation?.ok === true && isPamCompatibleDetectedType(preValidation?.detectedType);
        if (hasPrevalidatedPam) {
            sendUpdate({ type: 'log', message: `Documento validado previamente: ${preValidation.detectedType}` });
            console.log(`[PAM]${traceLabel} prevalidated detected=${preValidation.detectedType}`);
        } else {
            sendUpdate({ type: 'log', message: 'Validando documento PAM...' });
            const validation = await validatePamBeforeProcessing(image, effectiveMimeType);
            if (!validation.isValid) {
                sendUpdate({
                    type: 'error',
                    message: `VALIDACION FALLIDA: Se esperaba un "PAM" (bono/liquidacion) pero se detecto: "${validation.detectedType}". (${validation.reason})`
                });
                return res.end();
            }
            sendUpdate({ type: 'log', message: `Documento validado: ${validation.detectedType}` });
            console.log(`[PAM]${traceLabel} validated detected=${validation.detectedType}`);
        }

        if (hasRawWorkflow) {
            sendUpdate({ type: 'log', message: 'Intentando parser PAM deterministico desde RAW OCR...' });
            sendUpdate({ type: 'progress', progress: 35 });
            const deterministicPam = buildPamDeterministicFromRawPayload(effectiveRawPayload);
            if (deterministicPam) {
                sendUpdate({ type: 'log', message: 'Parser PAM deterministico OK. OpenAI omitido.' });
                sendUpdate({ type: 'progress', progress: 100 });
                sendUpdate({ type: 'final', data: deterministicPam });
                console.log(
                    `[PAM]${traceLabel} deterministic done folios=${Array.isArray(deterministicPam?.folios) ? deterministicPam.folios.length : 0} ` +
                    `items=${Number(deterministicPam?.global?.totalItems || 0)}`
                );
                return res.end();
            }
            sendUpdate({ type: 'log', message: 'Parser deterministico insuficiente. Activando fallback OpenAI...' });
        }

        const extractionKeys = getOpenAIExtractionKeys();
        if (extractionKeys.length === 0) {
            sendUpdate({ type: 'error', message: 'OPENAI_API_KEY no configurada para fallback PAM' });
            return res.end();
        }

        sendUpdate({ type: 'log', message: 'Iniciando extraccion de datos PAM...' });
        sendUpdate({ type: 'progress', progress: hasRawWorkflow ? 45 : 10 });

        let promptText = PAM_PROMPT;
        let azureHints: string[] = [];

        if (hasRawWorkflow) {
            promptText = `${PAM_PROMPT}\n\nRAW_EXTRACT_HINTS_BEGIN\n${rawText}\nRAW_EXTRACT_HINTS_END`;
        } else if (effectiveMimeType === 'application/pdf') {
            if (!resolveAzureLayoutEnabled()) {
                sendUpdate({
                    type: 'error',
                    message: 'PAM en PDF requiere Azure Document Intelligence habilitado antes de OpenAI.'
                });
                return res.end();
            }

            try {
                sendUpdate({ type: 'log', message: 'Azure DI: preextrayendo layout PAM...' });
                azureHints = await azureExtractPamHintsFromPdf(image);
                if (azureHints.length > 0) {
                    promptText = `${PAM_PROMPT}\n\nAZURE_LAYOUT_HINTS_BEGIN\n${azureHints.join('\n')}\nAZURE_LAYOUT_HINTS_END`;
                    sendUpdate({ type: 'log', message: `Azure DI: ${azureHints.length} lineas de apoyo incorporadas al prompt.` });
                } else {
                    sendUpdate({ type: 'error', message: 'Azure DI no devolvio lineas utiles para este PDF PAM.' });
                    return res.end();
                }
            } catch (azureError: any) {
                sendUpdate({ type: 'error', message: `Azure DI fallo: ${azureError?.message || 'error desconocido'}` });
                return res.end();
            }
        }

        const activeModel = String(envGet('OPENAI_PAM_MODEL') || envGet('OPENAI_VISION_MODEL') || 'gpt-4o');
        sendUpdate({ type: 'log', message: `Conectando con OpenAI (${activeModel})...` });
        console.log(`[PAM]${traceLabel} extracting model=${activeModel} raw=${hasRawWorkflow}`);
        sendUpdate({ type: 'progress', progress: 30 });

        const jsonPrompt = `
Extrae el PAM y responde SOLO con un JSON valido.

Formato requerido:
{
  "folios": [
    {
      "folioPAM": "string",
      "prestadorPrincipal": "string",
      "periodoCobro": "string",
      "desglosePorPrestador": [
        {
          "nombrePrestador": "string",
          "items": [
            {
              "codigoGC": "string",
              "descripcion": "string",
              "cantidad": "string",
              "valorTotal": 0,
              "bonificacion": 0,
              "copago": 0
            }
          ]
        }
      ],
      "resumen": {
        "totalCopagoDeclarado": 0,
        "revisionCobrosDuplicados": "string"
      }
    }
  ]
}

Reglas criticas:
- Lee el documento como PAM literal, no como cuenta clinica.
- No inventes items.
- No dupliques "copia prestador/afiliado".
- Usa los totales impresos del PAM en resumen.
- Si hay linea de Totales con Valor/Bonificacion/Copago, respeta ese total declarado.
- No uses el copago del ultimo item como total del folio salvo que el documento realmente lo indique.

Contexto fuente:
${promptText}
        `.trim();

        let extractionText = '';
        let usagePayload: any = null;
        let lastError: any = null;

        for (const key of extractionKeys) {
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                try {
                    const openai = new OpenAIService(key);
                    const extraction = await openai.extractWithUsage(
                        (effectiveMimeType === 'application/pdf' || hasRawWorkflow) ? '' : image,
                        (effectiveMimeType === 'application/pdf' || hasRawWorkflow) ? '' : effectiveMimeType,
                        jsonPrompt,
                        {
                            model: activeModel,
                            maxTokens: 8000,
                            temperature: 0.1,
                            jsonMode: true
                        }
                    );
                    extractionText = extraction.text;
                    usagePayload = extraction.usage;
                    break;
                } catch (error: any) {
                    lastError = error;
                    const errMsg = error?.message || 'desconocido';
                    const retryAfterMs = parseRetryAfterMs(error);
                    const is429 = errMsg.includes('429') || error?.status === 429;
                    sendUpdate({ type: 'log', message: `[DEBUG] OpenAI error: ${errMsg}` });

                    if (is429 && retryAfterMs && attempt < 2) {
                        sendUpdate({
                            type: 'log',
                            message: `OpenAI 429 en ${activeModel}. Reintentando en ${(retryAfterMs / 1000).toFixed(1)}s...`
                        });
                        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
                        continue;
                    }
                }
                break;
            }
            if (extractionText) break;
        }

        if (!extractionText) {
            const errStr = `${lastError?.toString?.() || ''}${lastError?.message || ''}`;
            const has429 = errStr.includes('429') || errStr.includes('Too Many Requests') || lastError?.status === 429;
            sendUpdate({
                type: 'error',
                message: has429 ? 'OpenAI saturado (429). Intente nuevamente en 1 minuto.' : `Error critico OpenAI: ${lastError?.message || 'sin detalle'}`
            });
            return res.end();
        }

        console.log(`[PAM]${traceLabel} extraction chars=${extractionText.length}`);

        if (usagePayload) {
            const promptTokens = usagePayload.promptTokenCount || 0;
            const candidatesTokens = usagePayload.completionTokenCount || 0;
            const totalTokens = usagePayload.totalTokenCount || 0;
            const { costUSD, costCLP } = calculatePrice(promptTokens, candidatesTokens, activeModel);
            sendUpdate({
                type: 'usage',
                usage: {
                    promptTokens,
                    candidatesTokens,
                    totalTokens,
                    estimatedCost: costUSD,
                    estimatedCostCLP: costCLP
                }
            });
        }

        sendUpdate({ type: 'progress', progress: 80 });
        sendUpdate({ type: 'log', message: 'Procesando respuesta...' });

        let modelPayload: any = null;
        try {
            modelPayload = JSON.parse(extractionText);
        } catch {
            const fallback = parsePamTextToDocument(extractionText);
            sendUpdate({ type: 'log', message: 'OpenAI devolvio texto no JSON; usando parser de respaldo.' });
            sendUpdate({ type: 'progress', progress: 100 });
            sendUpdate({ type: 'final', data: fallback });
            return res.end();
        }

        const pamData = normalizePamJsonPayload(modelPayload, rawText);

        sendUpdate({ type: 'progress', progress: 100 });
        sendUpdate({ type: 'final', data: pamData });
        console.log(
            `[PAM]${traceLabel} done folios=${Array.isArray(pamData?.folios) ? pamData.folios.length : 0} ` +
            `items=${Number(pamData?.global?.totalItems || 0)}`
        );
        res.end();
    } catch (error: any) {
        console.error(`[PAM]${traceLabel} Unexpected error in endpoint:`, error);
        sendUpdate({ type: 'error', message: error?.message || 'Internal Server Error' });
        res.end();
    }
}
