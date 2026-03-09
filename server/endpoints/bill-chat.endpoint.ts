import { Request, Response } from 'express';
import { OpenAIService } from '../services/openai.service.js';

function clipText(input: string, maxChars: number): string {
  const value = String(input || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[TRUNCATED ${value.length - maxChars} chars]`;
}

function compactJson(input: any, maxChars: number): string {
  try {
    return clipText(JSON.stringify(input), maxChars);
  } catch {
    return '';
  }
}

function parseFlexibleNumber(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return 0;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized = cleaned;
  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (hasDot) {
    // Soporta formato CLP con miles: 180.447 => 180447
    if (/^-?\d{1,3}(?:\.\d{3})+$/.test(cleaned)) {
      normalized = cleaned.replace(/\./g, '');
    } else {
      const parts = cleaned.split('.');
      normalized = parts.length > 2 ? cleaned.replace(/\./g, '') : cleaned;
    }
  } else if (hasComma) {
    const parts = cleaned.split(',');
    normalized = parts.length > 2 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value: any): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeBillPayload(billJson: any): { items: any[]; rows: any[] } {
  if (Array.isArray(billJson)) {
    // Export tipo rows-page-*.json (array de filas)
    return { items: [], rows: billJson };
  }
  const items = Array.isArray(billJson?.items) ? billJson.items : [];
  const rows = Array.isArray(billJson?.rows) ? billJson.rows : [];

  // Compatibilidad con export all-pages que viene como { pages: { "1": { rows: [...] } } }
  if (rows.length === 0 && billJson?.pages && typeof billJson.pages === 'object') {
    const flatRows: any[] = [];
    for (const [pageKey, pageObj] of Object.entries<any>(billJson.pages)) {
      const pageRows = Array.isArray(pageObj?.rows) ? pageObj.rows : [];
      for (const row of pageRows) {
        const page = Number(row?.page || pageKey);
        flatRows.push({ ...row, page: Number.isFinite(page) ? page : 0 });
      }
    }
    return { items, rows: flatRows };
  }
  return { items, rows };
}

function extractLogicalLines(billJson: any): any[] {
  return Array.isArray(billJson?.logicalLines) ? billJson.logicalLines : [];
}

function extractNumericCandidates(text: string): number[] {
  const matches = String(text || '').match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g) || [];
  return matches
    .map((token) => parseFlexibleNumber(token))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function extractPrimaryChargeFromText(text: string): number {
  const values = extractNumericCandidates(text).filter((n) => n > 0 && n < 100_000_000);
  if (values.length < 2) return 0;
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  // En layout de cuenta clínica, última suele ser bonif y penúltima valor cobrado.
  if (prev >= last) return Math.round(prev);
  return Math.round(last);
}

function estimateRowAmount(text: string): number {
  const candidates = extractNumericCandidates(text).filter((n) => n < 100_000_000);
  if (candidates.length === 0) return 0;
  // Heurística robusta para rows-only: usar el mayor monto en la línea.
  const large = candidates.filter((n) => n >= 1000);
  return Math.round((large.length > 0 ? Math.max(...large) : Math.max(...candidates)));
}

function estimateLogicalLineAmount(line: any): number {
  const fromFields = parseFlexibleNumber(line?.fields?.valor);
  if (fromFields > 0) return Math.round(fromFields);
  return estimateRowAmount(String(line?.fullText || ''));
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

function detectClinicalKeywords(question: string): string[] {
  const q = normalizeText(question);
  const buckets: Array<{ keys: string[]; terms: string[] }> = [
    { keys: ['escaner', 'scanner', 'tac', 'tomografia', 'tomograf'], terms: ['escaner', 'scanner', 'tac', 'tomografia'] },
    { keys: ['resonancia', 'rm', 'mri'], terms: ['resonancia', 'rm', 'mri'] },
    { keys: ['ecografia', 'eco doppler', 'ultrasonido'], terms: ['ecografia', 'ultrasonido', 'doppler'] },
    { keys: ['radiografia', 'rayos x', 'rx'], terms: ['radiografia', 'rayos x', 'rx'] },
    { keys: ['pabellon', 'quirofano', 'cirugia'], terms: ['pabellon', 'quirofano', 'cirugia'] }
  ];

  for (const b of buckets) {
    if (b.keys.some((k) => q.includes(k))) return b.terms;
  }
  return [];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasTerm(text: string, term: string): boolean {
  const normalizedText = normalizeText(text);
  const t = normalizeText(term);
  if (!t) return false;
  if (t.length <= 3) {
    const rx = new RegExp(`\\b${escapeRegex(t)}\\b`, 'i');
    return rx.test(normalizedText);
  }
  return normalizedText.includes(t);
}

function textHasAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => textHasTerm(text, term));
}

function extractSearchTerm(question: string): string {
  const m1 = question.match(/(?:producto|glosa|item|buscar|contiene)\s*[:\-]?\s*(.+)$/i);
  if (m1?.[1]) return m1[1].trim();
  const q = question.replace(/[?¿!]/g, ' ').trim();
  const words = q.split(/\s+/).filter(Boolean);
  return words.slice(-3).join(' ').trim();
}

function buildOpenAIBillContext(
  question: string,
  billJson: any,
  items: any[],
  rows: any[],
  askedPage: number,
  clinicalTerms: string[]
): { contextText: string; contextMode: string } {
  const normalizedQuestion = normalizeText(question);
  const hasPage = Number.isFinite(askedPage) && askedPage > 0;

  if (hasPage) {
    const pageItems = items.filter((it: any) => Number(it?.page || 0) === askedPage);
    const pageRows = rows.filter((r: any) => Number(r?.page || 0) === askedPage);
    return {
      contextMode: `page-slice:${askedPage}`,
      contextText: JSON.stringify(
        {
          page: askedPage,
          items: pageItems.slice(0, 220),
          rows: pageRows.slice(0, 420)
        },
        null,
        2
      )
    };
  }

  if (clinicalTerms.length > 0) {
    const itemMatches = items.filter((it: any) => {
      const text = normalizeText(it?.description || it?.rawText || '');
      return clinicalTerms.some((t) => text.includes(t));
    });
    const rowMatches = rows.filter((r: any) => {
      const text = normalizeText(r?.text || '');
      return clinicalTerms.some((t) => text.includes(t));
    });
    const pages = uniqueSortedNumbers([
      ...itemMatches.map((it: any) => Number(it?.page || 0)),
      ...rowMatches.map((r: any) => Number(r?.page || 0))
    ]).slice(0, 6);

    const pageSlices = pages.map((p) => ({
      page: p,
      items: items.filter((it: any) => Number(it?.page || 0) === p).slice(0, 180),
      rows: rows.filter((r: any) => Number(r?.page || 0) === p).slice(0, 320)
    }));

    return {
      contextMode: 'clinical-term-slices',
      contextText: JSON.stringify(
        {
          terms: clinicalTerms,
          matchedPages: pages,
          matchedItems: itemMatches.slice(0, 450),
          matchedRows: rowMatches.slice(0, 650),
          pageSlices
        },
        null,
        2
      )
    };
  }

  const term = extractSearchTerm(question);
  if (term) {
    const nTerm = normalizeText(term);
    const itemMatches = items.filter((it: any) => normalizeText(it?.description || it?.rawText || '').includes(nTerm));
    const rowMatches = rows.filter((r: any) => normalizeText(r?.text || '').includes(nTerm));
    if (itemMatches.length > 0 || rowMatches.length > 0) {
      const pages = uniqueSortedNumbers([
        ...itemMatches.map((it: any) => Number(it?.page || 0)),
        ...rowMatches.map((r: any) => Number(r?.page || 0))
      ]).slice(0, 8);
      return {
        contextMode: 'text-term-slices',
        contextText: JSON.stringify(
          {
            term,
            matchedPages: pages,
            matchedItems: itemMatches.slice(0, 450),
            matchedRows: rowMatches.slice(0, 650)
          },
          null,
          2
        )
      };
    }
  }

  // Fallback: enviar más contexto que antes (antes era 40k chars).
  return {
    contextMode: 'global-compact-30k',
    contextText: compactJson(billJson, 30000)
  };
}

function extractBillStats(billJson: any): {
  pageCount: number;
  itemCount: number;
  grandTotal: number;
  pageTotals: Array<{ page: number; total: number; items: number }>;
  footerDocumentTotal: number;
  footerPageTotals: Array<{ page: number; total: number }>;
} {
  const { items, rows } = normalizeBillPayload(billJson);

  const pagesFromItems = items
    .map((i: any) => Number(i?.page || 0))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  const pagesFromRows = rows
    .map((r: any) => Number(r?.page || 0))
    .filter((n: number) => Number.isFinite(n) && n > 0);

  const allPages = new Set<number>([...pagesFromItems, ...pagesFromRows]);
  const pageTotalsMap = new Map<number, { total: number; items: number }>();

  for (const item of items) {
    const page = Number(item?.page || 0);
    const total = parseFlexibleNumber(item?.total);
    if (!Number.isFinite(page) || page <= 0 || total <= 0) continue;
    const current = pageTotalsMap.get(page) || { total: 0, items: 0 };
    current.total += total;
    current.items += 1;
    pageTotalsMap.set(page, current);
  }

  const pageTotals = [...pageTotalsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, data]) => ({ page, total: Math.round(data.total), items: data.items }));

  const footerRows = rows.filter((row: any) => /^total\s+empresa\b/i.test(String(row?.text || '').trim()));
  const footerPageMap = new Map<number, number>();
  for (const row of footerRows) {
    const page = Number(row?.page || 0);
    if (!Number.isFinite(page) || page <= 0) continue;
    const total = extractPrimaryChargeFromText(String(row?.text || ''));
    if (total <= 0) continue;
    footerPageMap.set(page, total);
  }
  const footerPageTotals = [...footerPageMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, total]) => ({ page, total: Math.round(total) }));
  const footerDocumentTotal = Math.round(footerPageTotals.reduce((acc, p) => acc + p.total, 0));

  const grandTotal = Math.round(pageTotals.reduce((acc, p) => acc + p.total, 0));
  return {
    pageCount: allPages.size,
    itemCount: items.length,
    grandTotal,
    pageTotals,
    footerDocumentTotal,
    footerPageTotals
  };
}

export async function handleBillChat(req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const { question, billJson, images, preferredModel, forceOpenAI } = req.body || {};
    if (!question || typeof question !== 'string') {
      res.status(400).write('Falta la pregunta.');
      res.end();
      return;
    }

    const stats = extractBillStats(billJson);
    const { items, rows } = normalizeBillPayload(billJson);

    const normalizedQuestion = String(question || '').toLowerCase();
    const asksPages = /\bpagina|paginas|cu[aá]ntas?\s+pag/i.test(normalizedQuestion);
    const asksTotal = /\btotal|suma|sumar|subtotal|subtotales|monto\b/i.test(normalizedQuestion);
    const asksSubtotalItems = /\bitem[s]?\b.*\bsubtotal(?:es)?\b|\bsubtotal(?:es)?\b.*\bitem[s]?\b/i.test(normalizedQuestion);
    const asksBreakdown = /\bcada subtotal|por item|item pertenece|desglose|detalle\b/i.test(normalizedQuestion);
    const asksPabellon = /\bpabell[oó]n|pbellon|quir[oó]fano|quirofano\b/i.test(normalizedQuestion);
    const asksPageDetail = /\bpagina\s+\d+\b|p\s*\d+\b|detalle\s+pagina\b/i.test(normalizedQuestion);
    const asksLineByLine = /\blinea\s+por\s+linea|línea\s+por\s+línea|toda\s+la\s+cuenta|cuenta\s+completa\b/i.test(normalizedQuestion);
    const asksProduct = /\bproducto|glosa|buscar|contiene|item\b/i.test(normalizedQuestion);
    const asksVerify = /\bverifica|verificar|faltan|incomplet|consisten|cuadra|cuadran|faltan\s+items|falta[n]?\s+item/i.test(normalizedQuestion);
    const asksAllItems = /\bdime\s+los?\s+item|item[s]?\s+de\s+la\s+cuenta|todos?\s+los?\s+item|listar\s+item|lista\s+de\s+item|cuales?\s+son\s+los?\s+item/i.test(normalizedQuestion);
    const asksWhereAndAmount = /\bdonde|en\s+que\s+pagina|cuanto|monto|cobrad|valor\b/i.test(normalizedQuestion);
    const clinicalTerms = detectClinicalKeywords(question);

    const pageNumberMatch = normalizedQuestion.match(/\b(?:pagina|p)\s*(\d{1,3})\b/i);
    const askedPage = pageNumberMatch ? Number(pageNumberMatch[1]) : 0;

    const useDeterministic = !forceOpenAI;
    const logicalLines = extractLogicalLines(billJson);

    if (useDeterministic && asksVerify) {
      const pagesFromRows = uniqueSortedNumbers(rows.map((r: any) => Number(r?.page || 0)));
      const pagesFromItems = uniqueSortedNumbers(items.map((i: any) => Number(i?.page || 0)));
      const pagesWithoutItems = pagesFromRows.filter((p) => !pagesFromItems.includes(p));

      const rowKindCounts = rows.reduce((acc: Record<string, number>, row: any) => {
        const key = String(row?.rowKind || 'unknown');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      const monetaryLogicalLines = logicalLines.filter((line: any) => {
        const amount = estimateLogicalLineAmount(line);
        const text = String(line?.fullText || '').trim();
        const isHeader = /^(codigo|descripcion|rut|empresa|sucursal|nombre paciente|fecha ingreso|fecha emision|pagina|detalle|informe)/i
          .test(text);
        const isFooter = /\b(total|subtotal)\b/i.test(text);
        return amount > 0 && !isHeader && !isFooter;
      });

      const approxExpectedItems = logicalLines.length > 0
        ? monetaryLogicalLines.length
        : rows.filter((row: any) => {
          const kind = String(row?.rowKind || 'unknown');
          if (kind === 'header' || kind === 'footer') return false;
          return estimateRowAmount(String(row?.text || '')) > 0;
        }).length;

      const missingApprox = Math.max(0, approxExpectedItems - stats.itemCount);
      const topPageRows = pagesFromRows.slice(0, 40).map((p) => {
        const pageRows = rows.filter((r: any) => Number(r?.page || 0) === p).length;
        const pageItems = items.filter((i: any) => Number(i?.page || 0) === p).length;
        return `P${p}: rows=${pageRows}, items=${pageItems}`;
      });

      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push('Verificación de cobertura bill:');
      lines.push(`Páginas en rows: ${pagesFromRows.length} (${pagesFromRows.join(', ') || 'n/d'}).`);
      lines.push(`Páginas en items: ${pagesFromItems.length} (${pagesFromItems.join(', ') || 'n/d'}).`);
      lines.push(`Filas totales: ${rows.length}. Líneas lógicas: ${logicalLines.length || 0}. Ítems normalizados: ${stats.itemCount}.`);
      lines.push(`Líneas con monto detectado (estimado): ${approxExpectedItems}. Brecha estimada: ${missingApprox}.`);
      lines.push(`Total actual calculado desde items: ${stats.grandTotal.toLocaleString('es-CL')}.`);
      lines.push(`Distribución rowKind: ${Object.entries(rowKindCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'n/d'}.`);
      if (pagesWithoutItems.length > 0) {
        lines.push(`Alerta: páginas sin items normalizados: ${pagesWithoutItems.join(', ')}.`);
      }
      if (topPageRows.length > 0) {
        lines.push(`Cobertura por página: ${topPageRows.join(' | ')}.`);
      }
      if (missingApprox > 0) {
        lines.push('Sugerencia: revisar stitching/parseo de líneas con montos; hay posible subcaptura de ítems.');
      }
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksPageDetail && askedPage > 0) {
      const pageRows = rows
        .filter((r: any) => Number(r?.page || 0) === askedPage)
        .map((r: any, idx: number) => `${idx + 1}. ${String(r?.text || '').trim()}`)
        .filter((t: string) => t.length > 3);

      if (pageRows.length === 0) {
        res.write(`No disponible en bill: no encontré filas para página ${askedPage}.`);
        res.end();
        return;
      }

      res.write(`Página ${askedPage}: ${pageRows.length} líneas detectadas.\n${pageRows.join('\n')}`);
      res.end();
      return;
    }

    if (useDeterministic && asksLineByLine) {
      const rowsByPage = new Map<number, string[]>();
      for (const row of rows) {
        const p = Number(row?.page || 0);
        if (p <= 0) continue;
        const text = String(row?.text || '').trim();
        if (!text) continue;
        const list = rowsByPage.get(p) || [];
        list.push(text);
        rowsByPage.set(p, list);
      }

      const pages = [...rowsByPage.keys()].sort((a, b) => a - b);
      const lines: string[] = [];
      lines.push(`Cuenta completa detectada: ${pages.length} páginas, ${rows.length} filas, ${stats.itemCount} items.`);
      for (const p of pages) {
        const list = rowsByPage.get(p) || [];
        lines.push(`\n[Página ${p}] (${list.length} líneas)`);
        for (let i = 0; i < list.length; i += 1) {
          lines.push(`${i + 1}. ${list[i]}`);
        }
      }
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksAllItems) {
      if (items.length === 0) {
        res.write('No disponible en bill: no hay items normalizados en la cuenta.');
        res.end();
        return;
      }

      const lines: string[] = [];
      lines.push(`Modo: Determinístico`);
      lines.push(`Total de ítems en cuenta: ${items.length}.`);
      const sorted = [...items].sort((a: any, b: any) => {
        const pa = Number(a?.page || 0);
        const pb = Number(b?.page || 0);
        if (pa !== pb) return pa - pb;
        return String(a?.description || '').localeCompare(String(b?.description || ''));
      });

      for (const it of sorted.slice(0, 800)) {
        const page = Number(it?.page || 0) || '?';
        const amount = parseFlexibleNumber(it?.total);
        const desc = String(it?.description || it?.rawText || '').slice(0, 140);
        lines.push(`P${page} | ${amount.toLocaleString('es-CL')} | ${desc}`);
      }
      if (sorted.length > 800) {
        lines.push(`...(${sorted.length - 800} ítems más omitidos para no saturar salida)`);
      }

      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksWhereAndAmount && clinicalTerms.length > 0) {
      const matchesItems = items.filter((it: any) => {
        const text = String(it?.description || it?.rawText || '');
        return textHasAnyTerm(text, clinicalTerms);
      });
      const matchesRows = rows.filter((r: any) => {
        const text = String(r?.text || '');
        return textHasAnyTerm(text, clinicalTerms);
      });

      if (matchesItems.length === 0 && matchesRows.length === 0) {
        res.write(`No disponible en bill: no encontré coincidencias para ${clinicalTerms.join(', ')}.`);
        res.end();
        return;
      }

      const pages = uniqueSortedNumbers([
        ...matchesItems.map((it: any) => Number(it?.page || 0)),
        ...matchesRows.map((r: any) => Number(r?.page || 0))
      ]);
      const totalFromItems = Math.round(
        matchesItems.reduce((acc: number, it: any) => acc + parseFlexibleNumber(it?.total), 0)
      );
      const totalFromRows = Math.round(
        matchesRows.reduce((acc: number, row: any) => acc + estimateRowAmount(String(row?.text || '')), 0)
      );
      const primaryRows = matchesRows.some((row: any) => String(row?.rowKind || '') === 'item_primary')
        ? matchesRows.filter((row: any) => String(row?.rowKind || '') === 'item_primary')
        : matchesRows;
      const chargeRows = primaryRows
        .map((row: any) => ({
          page: Number(row?.page || 0),
          text: String(row?.text || ''),
          charge: extractPrimaryChargeFromText(String(row?.text || ''))
        }))
        .filter((r: any) => r.charge > 0);
      const dedup = new Map<string, { page: number; text: string; charge: number }>();
      for (const r of chargeRows) {
        const key = `${r.page}|${r.charge}|${normalizeText(r.text).slice(0, 40)}`;
        if (!dedup.has(key)) dedup.set(key, r);
      }
      const chargeRowsUnique = [...dedup.values()];
      const totalFromRowCharges = Math.round(chargeRowsUnique.reduce((acc, r) => acc + r.charge, 0));
      const useRowCharges = totalFromRowCharges > 0 && (totalFromItems === 0 || totalFromRowCharges > totalFromItems * 1.4);
      const usedRowsEstimate = (matchesItems.length === 0 || totalFromItems === 0) && !useRowCharges;
      const total = useRowCharges ? totalFromRowCharges : (usedRowsEstimate ? totalFromRows : totalFromItems);

      const out: string[] = [];
      out.push(`Términos detectados: ${clinicalTerms.join(', ')}.`);
      out.push(`Páginas con coincidencias: ${pages.length > 0 ? pages.join(', ') : 'n/d'}.`);
      out.push(`Monto total cobrado en ítems coincidentes: ${total.toLocaleString('es-CL')}.`);
      if (useRowCharges) {
        out.push('Nota: monto calculado desde columna de cobro en rows (item.total parecía bonificación).');
      }
      if (usedRowsEstimate) {
        out.push('Nota: monto estimado desde rows.text (no había items[].total).');
      }
      out.push(`Ítems coincidentes: ${matchesItems.length}, filas coincidentes: ${matchesRows.length}.`);
      const previewSource = matchesItems.length > 0 ? matchesItems : matchesRows;
      for (const entry of previewSource.slice(0, 120)) {
        const amount = matchesItems.length > 0
          ? parseFlexibleNumber(entry.total)
          : estimateRowAmount(String(entry?.text || ''));
        const label = String(entry?.description || entry?.rawText || entry?.text || '').slice(0, 120);
        out.push(`P${entry.page || '?'} | ${amount.toLocaleString('es-CL')} | ${label}`);
      }
      if (previewSource.length > 120) {
        out.push(`...(${previewSource.length - 120} ítems/filas más omitidos)`);
      }

      res.write(out.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksProduct && !(asksSubtotalItems || asksBreakdown)) {
      let term = '';
      const m1 = question.match(/(?:producto|glosa|item|buscar|contiene)\s*[:\-]?\s*(.+)$/i);
      if (m1?.[1]) term = m1[1].trim();
      if (!term) {
        const parts = question.split('?')[0].split(' ');
        term = parts.slice(-3).join(' ').trim();
      }
      term = term.replace(/[?¿!.,;:()[\]{}"]/g, ' ').replace(/\s+/g, ' ').trim();
      const nTerm = normalizeText(term);
      if (!nTerm || nTerm.length < 2 || ['item', 'items', 'cuenta', 'la cuenta', 'de la cuenta'].includes(nTerm)) {
        res.write('No disponible en bill: especifica un producto/glosa concreto para buscar.');
        res.end();
        return;
      }

      const matchesRows = rows.filter((r: any) => normalizeText(r?.text || '').includes(nTerm));
      const matchesItems = items.filter((it: any) => normalizeText(it?.description || it?.rawText || '').includes(nTerm));
      const matchedTotalItems = Math.round(matchesItems.reduce((acc: number, it: any) => acc + parseFlexibleNumber(it?.total), 0));
      const matchedTotalRows = Math.round(matchesRows.reduce((acc: number, row: any) => acc + estimateRowAmount(String(row?.text || '')), 0));
      const usedRowsEstimate = matchesItems.length === 0 || matchedTotalItems === 0;
      const matchedTotal = usedRowsEstimate ? matchedTotalRows : matchedTotalItems;

      if (matchesRows.length === 0 && matchesItems.length === 0) {
        res.write(`No disponible en bill: sin coincidencias para "${term}".`);
        res.end();
        return;
      }

      const out: string[] = [];
      out.push(`Coincidencias para "${term}": filas=${matchesRows.length}, items=${matchesItems.length}.`);
      if (matchesItems.length > 0) {
        out.push(`Total de items coincidentes: ${matchedTotal.toLocaleString('es-CL')}.`);
      } else if (matchesRows.length > 0) {
        out.push(`Total estimado de filas coincidentes: ${matchedTotal.toLocaleString('es-CL')} (estimado desde rows.text).`);
      }
      for (const row of matchesRows.slice(0, 120)) {
        out.push(`P${row.page || '?'} | ${String(row.text || '').slice(0, 180)}`);
      }
      if (matchesRows.length > 120) {
        out.push(`...(${matchesRows.length - 120} filas más omitidas)`);
      }
      res.write(out.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksPabellon) {
      const keywords = ['pabellon', 'pbellon', 'quirofano', 'cirugia', 'cirugia 3er piso'];
      const matches = items.filter((item: any) => {
        const text = normalizeText(item?.description || item?.rawText || '');
        return keywords.some((k) => text.includes(k));
      });
      const totalPabellon = Math.round(matches.reduce((acc: number, item: any) => acc + parseFlexibleNumber(item?.total), 0));

      if (matches.length === 0) {
        res.write('No disponible en bill: no encontré items de Pabellón con el criterio actual.');
        res.end();
        return;
      }

      const preview = matches
        .slice(0, 80)
        .map((item: any) => `P${item.page || '?'} | ${parseFlexibleNumber(item.total).toLocaleString('es-CL')} | ${String(item.description || item.rawText || '').slice(0, 90)}`)
        .join('\n');

      const suffix = matches.length > 80 ? `\n...(${matches.length - 80} items más omitidos para no saturar salida)` : '';
      res.write(`Total Pabellón (criterio textual): ${totalPabellon.toLocaleString('es-CL')}.\nItems considerados: ${matches.length}.\n${preview}${suffix}`);
      res.end();
      return;
    }

    if (useDeterministic && (asksSubtotalItems || asksBreakdown)) {
      const byPage = new Map<number, Array<{ description: string; total: number }>>();
      for (const item of items) {
        const page = Number(item?.page || 0);
        const total = parseFlexibleNumber(item?.total);
        if (!Number.isFinite(page) || page <= 0 || total <= 0) continue;
        const list = byPage.get(page) || [];
        list.push({ description: String(item?.description || item?.rawText || '').trim(), total });
        byPage.set(page, list);
      }

      const pages = [...byPage.keys()].sort((a, b) => a - b);
      const lines: string[] = [];
      lines.push(`Total acumulado: ${stats.grandTotal.toLocaleString('es-CL')}.`);
      lines.push(`Items considerados: ${stats.itemCount}.`);

      for (const page of pages) {
        const list = byPage.get(page) || [];
        const subtotal = Math.round(list.reduce((acc, it) => acc + it.total, 0));
        lines.push(`P${page} subtotal: ${subtotal.toLocaleString('es-CL')}`);
        for (const it of list.slice(0, 120)) {
          lines.push(`  - ${it.total.toLocaleString('es-CL')} | ${it.description.slice(0, 120)}`);
        }
        if (list.length > 120) {
          lines.push(`  - ...(${list.length - 120} items más en P${page})`);
        }
      }

      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && (asksPages || asksTotal)) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      if (asksPages) lines.push(`Páginas detectadas en bill: ${stats.pageCount}.`);
      if (asksTotal) {
        if (stats.footerDocumentTotal > 0) {
          lines.push(`Total de la cuenta (desde filas "Total Empresa" del PDF): ${stats.footerDocumentTotal.toLocaleString('es-CL')}.`);
          if (stats.footerPageTotals.length > 0) {
            const footerPerPage = stats.footerPageTotals.map((p) => `P${p.page}: ${p.total.toLocaleString('es-CL')}`).join(' | ');
            lines.push(`Totales Empresa detectados: ${footerPerPage}.`);
          }
        }
        lines.push(`Total acumulado (sumando items detectados): ${stats.grandTotal.toLocaleString('es-CL')}.`);
        if (stats.pageTotals.length > 0) {
          const perPage = stats.pageTotals.map((p) => `P${p.page}: ${p.total.toLocaleString('es-CL')}`).join(' | ');
          lines.push(`Subtotales por página: ${perPage}.`);
        }
      }
      lines.push(`Items considerados: ${stats.itemCount}.`);
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      res.write('OPENAI_API_KEY no configurada en servidor para responder pregunta abierta.');
      res.end();
      return;
    }

    let imageBase64 = '';
    let mimeType = '';
    if (Array.isArray(images) && images.length > 0 && typeof images[0] === 'string') {
      const first = images[0];
      const match = first.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        imageBase64 = match[2];
      } else if (!first.startsWith('data:')) {
        mimeType = 'image/png';
        imageBase64 = first;
      }
    }

    const modelName = typeof preferredModel === 'string' && preferredModel.trim()
      ? preferredModel.trim()
      : 'gpt-4o';

    const focused = buildOpenAIBillContext(question, billJson, items, rows, askedPage, clinicalTerms);

    const prompt = `
Eres un asistente técnico de QA para cuenta clínica.
Responde sobre este bill:
- cálculos y consistencia de montos,
- detalle por página/fila/item,
- validación de productos/glosas.

Reglas:
- No uses normativa ni jurisprudencia.
- Si falta dato, dilo explícitamente.
- Muestra pasos de cálculo cuando corresponda.
- Responde breve y auditable.

Pregunta:
${question}

Resumen calculado por sistema:
- páginas: ${stats.pageCount}
- items: ${stats.itemCount}
- total_items_detectados: ${stats.grandTotal}
- total_canonico_cuenta_total_empresa: ${stats.footerDocumentTotal || 'n/d'}
- subtotales por página: ${stats.pageTotals.map((p) => `P${p.page}=${p.total}`).join(', ') || 'n/d'}
- totales_empresa_detectados: ${stats.footerPageTotals.map((p) => `P${p.page}=${p.total}`).join(', ') || 'n/d'}
- modo de contexto: ${focused.contextMode}

Regla crítica:
- Si la pregunta es por "total de la cuenta", usa SOLO total_canonico_cuenta_total_empresa cuando exista.
- No recalcules total global desde rows/items si ya hay total canónico.

JSON bill (focalizado):
${focused.contextText}
`.trim();

    const openai = new OpenAIService(openaiKey);
    res.write('Modo: OpenAI\n');

    try {
      const stream = await openai.extractStream(imageBase64, mimeType, prompt, {
        model: modelName,
        maxTokens: 2500,
        temperature: 0.1
      });

      for await (const chunk of stream) {
        if (chunk?.text) res.write(chunk.text);
      }
    } catch (openAIError: any) {
      const msg = String(openAIError?.message || '');
      const isTpmLimit = /429|request too large|tokens per min|tpm/i.test(msg);
      if (!isTpmLimit) throw openAIError;

      // Fallback robusto: si la pregunta es resoluble en modo determinístico, responder sin reintentar OpenAI.
      if (asksWhereAndAmount && clinicalTerms.length > 0) {
        const matchesItems = items.filter((it: any) => {
          const text = String(it?.description || it?.rawText || '');
          return textHasAnyTerm(text, clinicalTerms);
        });
        const matchesRows = rows.filter((r: any) => {
          const text = String(r?.text || '');
          return textHasAnyTerm(text, clinicalTerms);
        });
        if (matchesItems.length === 0 && matchesRows.length === 0) {
          res.write(`No disponible en bill: no encontré coincidencias para ${clinicalTerms.join(', ')}.`);
          return;
        }

        const pages = uniqueSortedNumbers([
          ...matchesItems.map((it: any) => Number(it?.page || 0)),
          ...matchesRows.map((r: any) => Number(r?.page || 0))
        ]);
        const totalFromItems = Math.round(
          matchesItems.reduce((acc: number, it: any) => acc + parseFlexibleNumber(it?.total), 0)
        );
        const primaryRows = matchesRows.some((row: any) => String(row?.rowKind || '') === 'item_primary')
          ? matchesRows.filter((row: any) => String(row?.rowKind || '') === 'item_primary')
          : matchesRows;
        const chargeRows = primaryRows
          .map((row: any) => ({
            page: Number(row?.page || 0),
            text: String(row?.text || ''),
            charge: extractPrimaryChargeFromText(String(row?.text || ''))
          }))
          .filter((r: any) => r.charge > 0);
        const dedup = new Map<string, { page: number; text: string; charge: number }>();
        for (const r of chargeRows) {
          const key = `${r.page}|${r.charge}|${normalizeText(r.text).slice(0, 40)}`;
          if (!dedup.has(key)) dedup.set(key, r);
        }
        const chargeRowsUnique = [...dedup.values()];
        const totalFromRowCharges = Math.round(chargeRowsUnique.reduce((acc, r) => acc + r.charge, 0));
        const totalFromRows = Math.round(
          matchesRows.reduce((acc: number, row: any) => acc + estimateRowAmount(String(row?.text || '')), 0)
        );
        const useRowCharges = totalFromRowCharges > 0 && (totalFromItems === 0 || totalFromRowCharges > totalFromItems * 1.4);
        const usedRowsEstimate = (matchesItems.length === 0 || totalFromItems === 0) && !useRowCharges;
        const total = useRowCharges ? totalFromRowCharges : (usedRowsEstimate ? totalFromRows : totalFromItems);

        const out: string[] = [];
        out.push(`Términos detectados: ${clinicalTerms.join(', ')}.`);
        out.push(`Páginas con coincidencias: ${pages.length > 0 ? pages.join(', ') : 'n/d'}.`);
        out.push(`Monto total cobrado en ítems coincidentes: ${total.toLocaleString('es-CL')}.`);
        out.push('Nota: respuesta determinística por límite TPM de OpenAI.');
        if (useRowCharges) {
          out.push('Nota: monto calculado desde columna de cobro en rows (item.total parecía bonificación).');
        }
        out.push(`Ítems coincidentes: ${matchesItems.length}, filas coincidentes: ${matchesRows.length}.`);
        const previewSource = matchesItems.length > 0 ? matchesItems : matchesRows;
        for (const entry of previewSource.slice(0, 120)) {
          const amount = matchesItems.length > 0
            ? parseFlexibleNumber(entry.total)
            : (extractPrimaryChargeFromText(String(entry?.text || '')) || estimateRowAmount(String(entry?.text || '')));
          const label = String(entry?.description || entry?.rawText || entry?.text || '').slice(0, 120);
          out.push(`P${entry.page || '?'} | ${amount.toLocaleString('es-CL')} | ${label}`);
        }
        if (previewSource.length > 120) {
          out.push(`...(${previewSource.length - 120} ítems/filas más omitidos)`);
        }
        res.write(out.join('\n'));
        return;
      }

      if (asksPages || asksTotal) {
        const lines: string[] = [];
        lines.push('Modo: Determinístico');
        if (asksPages) lines.push(`Páginas detectadas en bill: ${stats.pageCount}.`);
        if (asksTotal) {
          if (stats.footerDocumentTotal > 0) {
            lines.push(`Total de la cuenta (desde filas "Total Empresa" del PDF): ${stats.footerDocumentTotal.toLocaleString('es-CL')}.`);
          }
          lines.push(`Total acumulado (sumando items detectados): ${stats.grandTotal.toLocaleString('es-CL')}.`);
        }
        lines.push('Nota: respuesta determinística por límite TPM de OpenAI.');
        lines.push(`Items considerados: ${stats.itemCount}.`);
        res.write(lines.join('\n'));
        return;
      }

      const lightweightContext = {
        stats: {
          pages: stats.pageCount,
          items: stats.itemCount,
          totalItemsDetectados: stats.grandTotal,
          totalCanonicoCuentaTotalEmpresa: stats.footerDocumentTotal,
          subtotals: stats.pageTotals
        },
        firstItems: items.slice(0, 120),
        firstRows: rows.slice(0, 220)
      };
      const fallbackPrompt = `
Eres un asistente técnico de QA para cuenta clínica.
Responde breve y auditable.
- No uses normativa.
- Si falta dato, dilo explícitamente.
- Si hay cálculo, muéstralo paso a paso.

Pregunta:
${question}

Contexto reducido por límite TPM:
${compactJson(lightweightContext, 14000)}
      `.trim();

      res.write('Aviso: límite TPM detectado, reintentando con contexto reducido.\n');
      const retryStream = await openai.extractStream(imageBase64, mimeType, fallbackPrompt, {
        model: modelName,
        maxTokens: 1600,
        temperature: 0.1
      });
      for await (const chunk of retryStream) {
        if (chunk?.text) res.write(chunk.text);
      }
    }
  } catch (error: any) {
    res.write(`Error en chat bill: ${error?.message || 'desconocido'}`);
  } finally {
    res.end();
  }
}
