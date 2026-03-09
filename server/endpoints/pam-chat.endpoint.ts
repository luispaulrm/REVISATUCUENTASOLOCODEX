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

function normalizeText(value: any): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseMoney(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const cleaned = String(value ?? '').replace(/[^\d-]/g, '');
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function uniqueSorted<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function flattenPamItems(pamJson: any): Array<{
  folioPAM: string;
  prestador: string;
  codigoGC: string;
  descripcion: string;
  cantidad: string;
  valorTotal: number;
  bonificacion: number;
  copago: number;
}> {
  const folios = Array.isArray(pamJson?.folios) ? pamJson.folios : [];
  const items: Array<any> = [];

  for (const folio of folios) {
    for (const prestador of Array.isArray(folio?.desglosePorPrestador) ? folio.desglosePorPrestador : []) {
      for (const item of Array.isArray(prestador?.items) ? prestador.items : []) {
        items.push({
          folioPAM: String(folio?.folioPAM || ''),
          prestador: String(prestador?.nombrePrestador || ''),
          codigoGC: String(item?.codigoGC || ''),
          descripcion: String(item?.descripcion || ''),
          cantidad: String(item?.cantidad || ''),
          valorTotal: parseMoney(item?.valorTotal),
          bonificacion: parseMoney(item?.bonificacion),
          copago: parseMoney(item?.copago)
        });
      }
    }
  }

  return items;
}

function extractPamStats(pamJson: any) {
  const folios = Array.isArray(pamJson?.folios) ? pamJson.folios : [];
  const items = flattenPamItems(pamJson);
  const providers = uniqueSorted(
    items.map((item) => item.prestador).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b, 'es'));

  return {
    folios,
    items,
    providers,
    totals: {
      totalValor: parseMoney(pamJson?.global?.totalValor),
      totalBonif: parseMoney(pamJson?.global?.totalBonif),
      totalCopago: parseMoney(pamJson?.global?.totalCopago),
      totalCopagoDeclarado: parseMoney(pamJson?.global?.totalCopagoDeclarado),
      discrepancia: parseMoney(pamJson?.global?.discrepancia),
      cuadra: Boolean(pamJson?.global?.cuadra),
      totalItems: Number(pamJson?.global?.totalItems || items.length || 0)
    }
  };
}

function findRequestedFolio(question: string, folios: any[]): any | null {
  const match = question.match(/\bfolio\s*[:#-]?\s*([a-z0-9-]+)/i);
  if (match?.[1]) {
    const requested = normalizeText(match[1]);
    return folios.find((folio: any) => normalizeText(folio?.folioPAM).includes(requested)) || null;
  }
  return null;
}

function extractSearchTerm(question: string): string {
  const direct = question.match(/(?:codigo|código|glosa|descripcion|descripción|item|buscar|prestador)\s*[:\-]?\s*(.+)$/i);
  if (direct?.[1]) return direct[1].trim();
  const clean = question.replace(/[?¿!]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return words.slice(-3).join(' ').trim();
}

function buildOpenAIPamContext(question: string, pamJson: any, stats: ReturnType<typeof extractPamStats>) {
  const normalizedQuestion = normalizeText(question);
  const folio = findRequestedFolio(question, stats.folios);

  if (folio) {
    return {
      contextMode: `folio-slice:${folio.folioPAM}`,
      contextText: JSON.stringify(folio, null, 2)
    };
  }

  const searchTerm = extractSearchTerm(question);
  if (searchTerm) {
    const normalizedTerm = normalizeText(searchTerm);
    const itemMatches = stats.items.filter((item) =>
      normalizeText(`${item.codigoGC} ${item.descripcion} ${item.prestador} ${item.folioPAM}`).includes(normalizedTerm)
    );
    if (itemMatches.length > 0) {
      return {
        contextMode: 'item-slice',
        contextText: JSON.stringify(
          {
            term: searchTerm,
            matchedItems: itemMatches.slice(0, 250)
          },
          null,
          2
        )
      };
    }
  }

  if (/\bprestador|proveedor\b/i.test(normalizedQuestion)) {
    return {
      contextMode: 'provider-summary',
      contextText: JSON.stringify(
        stats.folios.map((folio: any) => ({
          folioPAM: folio?.folioPAM,
          prestadorPrincipal: folio?.prestadorPrincipal,
          prestadores: (folio?.desglosePorPrestador || []).map((prestador: any) => ({
            nombrePrestador: prestador?.nombrePrestador,
            items: Array.isArray(prestador?.items) ? prestador.items.length : 0
          }))
        })),
        null,
        2
      )
    };
  }

  return {
    contextMode: 'global-compact-20k',
    contextText: compactJson(pamJson, 20000)
  };
}

export async function handlePamChat(req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const { question, pamJson, images, preferredModel, forceOpenAI } = req.body || {};
    if (!question || typeof question !== 'string') {
      res.status(400).write('Falta la pregunta.');
      res.end();
      return;
    }

    const stats = extractPamStats(pamJson);
    const normalizedQuestion = normalizeText(question);
    const askedFolio = findRequestedFolio(question, stats.folios);

    const asksTotals = /\btotal|totales|monto|valor|bonif|bonificacion|bonificación|copago\b/i.test(normalizedQuestion);
    const asksFolios = /\bfolios?|cuantos folios|cuántos folios|listar folios|lista de folios\b/i.test(normalizedQuestion);
    const asksProviders = /\bprestador|prestadores|proveedor|proveedores\b/i.test(normalizedQuestion);
    const asksVerify = /\bcuadra|cuadran|discrepancia|revisar|verifica|verificar|consisten|auditoria|auditoría\b/i.test(normalizedQuestion);
    const asksItems = /\bitem|items|glosa|glosas|codigo|código|descripcion|descripción|buscar|contiene|detalle\b/i.test(normalizedQuestion);
    const asksAllItems = /\btodos los items|todos los ítems|listar items|lista de items|lista de ítems\b/i.test(normalizedQuestion);

    const useDeterministic = !forceOpenAI;

    if (useDeterministic && asksFolios && !askedFolio) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Folios detectados: ${stats.folios.length}.`);
      for (const folio of stats.folios) {
        const providers = Array.isArray(folio?.desglosePorPrestador) ? folio.desglosePorPrestador.length : 0;
        const declared = parseMoney(folio?.resumen?.totalCopagoDeclarado);
        lines.push(
          `Folio ${folio?.folioPAM || 'n/d'} | prestador principal: ${folio?.prestadorPrincipal || 'n/d'} | prestadores: ${providers} | copago declarado: ${declared.toLocaleString('es-CL')}`
        );
      }
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && askedFolio && (asksTotals || asksItems || asksVerify || asksProviders)) {
      const items = flattenPamItems({ folios: [askedFolio] });
      const totalValor = items.reduce((acc, item) => acc + item.valorTotal, 0);
      const totalBonif = items.reduce((acc, item) => acc + item.bonificacion, 0);
      const totalCopago = items.reduce((acc, item) => acc + item.copago, 0);
      const declared = parseMoney(askedFolio?.resumen?.totalCopagoDeclarado);
      const providers = uniqueSorted(items.map((item) => item.prestador).filter(Boolean));

      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Detalle folio ${askedFolio?.folioPAM || 'n/d'}:`);
      lines.push(`Prestador principal: ${askedFolio?.prestadorPrincipal || 'n/d'}.`);
      lines.push(`Prestadores: ${providers.join(', ') || 'n/d'}.`);
      lines.push(`Items: ${items.length}.`);
      lines.push(`Valor total: ${totalValor.toLocaleString('es-CL')}.`);
      lines.push(`Bonificación total: ${totalBonif.toLocaleString('es-CL')}.`);
      lines.push(`Copago calculado: ${totalCopago.toLocaleString('es-CL')}.`);
      lines.push(`Copago declarado: ${declared.toLocaleString('es-CL')}.`);
      lines.push(`Discrepancia: ${(totalCopago - declared).toLocaleString('es-CL')}.`);
      lines.push(`Cuadra: ${Math.abs(totalCopago - declared) <= 500 ? 'sí' : 'no'}.`);

      if (asksItems) {
        for (const item of items.slice(0, 120)) {
          lines.push(
            `${item.codigoGC || 's/c'} | ${item.descripcion} | cant=${item.cantidad || 'n/d'} | valor=${item.valorTotal.toLocaleString('es-CL')} | bonif=${item.bonificacion.toLocaleString('es-CL')} | copago=${item.copago.toLocaleString('es-CL')} | prestador=${item.prestador || 'n/d'}`
          );
        }
        if (items.length > 120) {
          lines.push(`...(${items.length - 120} ítems más omitidos)`);
        }
      }

      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksProviders) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Prestadores detectados: ${stats.providers.length}.`);
      for (const provider of stats.providers) {
        const providerItems = stats.items.filter((item) => item.prestador === provider);
        const totalValor = providerItems.reduce((acc, item) => acc + item.valorTotal, 0);
        const totalBonif = providerItems.reduce((acc, item) => acc + item.bonificacion, 0);
        const totalCopago = providerItems.reduce((acc, item) => acc + item.copago, 0);
        const providerFolios = uniqueSorted(providerItems.map((item) => item.folioPAM).filter(Boolean));
        lines.push(
          `${provider} | folios=${providerFolios.join(', ') || 'n/d'} | items=${providerItems.length} | valor=${totalValor.toLocaleString('es-CL')} | bonif=${totalBonif.toLocaleString('es-CL')} | copago=${totalCopago.toLocaleString('es-CL')}`
        );
      }
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksVerify) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push('Verificación de consistencia PAM:');
      lines.push(`Folios: ${stats.folios.length}. Prestadores: ${stats.providers.length}. Items: ${stats.totals.totalItems}.`);
      lines.push(`Valor total: ${stats.totals.totalValor.toLocaleString('es-CL')}.`);
      lines.push(`Bonificación total: ${stats.totals.totalBonif.toLocaleString('es-CL')}.`);
      lines.push(`Copago calculado global: ${stats.totals.totalCopago.toLocaleString('es-CL')}.`);
      lines.push(`Copago declarado global: ${stats.totals.totalCopagoDeclarado.toLocaleString('es-CL')}.`);
      lines.push(`Discrepancia global: ${stats.totals.discrepancia.toLocaleString('es-CL')}.`);
      lines.push(`Cuadra global: ${stats.totals.cuadra ? 'sí' : 'no'}.`);

      const inconsistentFolios = stats.folios
        .map((folio: any) => {
          const items = flattenPamItems({ folios: [folio] });
          const calculated = items.reduce((acc, item) => acc + item.copago, 0);
          const declared = parseMoney(folio?.resumen?.totalCopagoDeclarado);
          const diff = calculated - declared;
          return {
            folio: String(folio?.folioPAM || 'n/d'),
            calculated,
            declared,
            diff,
            cuadra: Math.abs(diff) <= 500
          };
        })
        .filter((folio) => !folio.cuadra);

      if (inconsistentFolios.length === 0) {
        lines.push('No detecté folios con descalce superior a 500.');
      } else {
        lines.push('Folios con descalce:');
        for (const folio of inconsistentFolios) {
          lines.push(
            `${folio.folio} | copago_calculado=${folio.calculated.toLocaleString('es-CL')} | copago_declarado=${folio.declared.toLocaleString('es-CL')} | diferencia=${folio.diff.toLocaleString('es-CL')}`
          );
        }
      }

      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksAllItems) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Items detectados en PAM: ${stats.items.length}.`);
      for (const item of stats.items.slice(0, 400)) {
        lines.push(
          `Folio ${item.folioPAM || 'n/d'} | ${item.prestador || 'n/d'} | ${item.codigoGC || 's/c'} | ${item.descripcion} | valor=${item.valorTotal.toLocaleString('es-CL')} | bonif=${item.bonificacion.toLocaleString('es-CL')} | copago=${item.copago.toLocaleString('es-CL')}`
        );
      }
      if (stats.items.length > 400) {
        lines.push(`...(${stats.items.length - 400} ítems más omitidos)`);
      }
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksItems) {
      const term = extractSearchTerm(question);
      const normalizedTerm = normalizeText(term);
      if (!normalizedTerm || normalizedTerm.length < 2) {
        res.write('No disponible en PAM: especifica un código, glosa, folio o prestador concreto.');
        res.end();
        return;
      }

      const matches = stats.items.filter((item) =>
        normalizeText(`${item.codigoGC} ${item.descripcion} ${item.prestador} ${item.folioPAM}`).includes(normalizedTerm)
      );

      if (matches.length === 0) {
        res.write(`No disponible en PAM: sin coincidencias para "${term}".`);
        res.end();
        return;
      }

      const totalValor = matches.reduce((acc, item) => acc + item.valorTotal, 0);
      const totalBonif = matches.reduce((acc, item) => acc + item.bonificacion, 0);
      const totalCopago = matches.reduce((acc, item) => acc + item.copago, 0);
      const folios = uniqueSorted(matches.map((item) => item.folioPAM).filter(Boolean));

      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Coincidencias para "${term}": ${matches.length}.`);
      lines.push(`Folios: ${folios.join(', ') || 'n/d'}.`);
      lines.push(`Valor total coincidente: ${totalValor.toLocaleString('es-CL')}.`);
      lines.push(`Bonificación coincidente: ${totalBonif.toLocaleString('es-CL')}.`);
      lines.push(`Copago coincidente: ${totalCopago.toLocaleString('es-CL')}.`);
      for (const item of matches.slice(0, 120)) {
        lines.push(
          `Folio ${item.folioPAM || 'n/d'} | ${item.prestador || 'n/d'} | ${item.codigoGC || 's/c'} | ${item.descripcion} | valor=${item.valorTotal.toLocaleString('es-CL')} | bonif=${item.bonificacion.toLocaleString('es-CL')} | copago=${item.copago.toLocaleString('es-CL')}`
        );
      }
      if (matches.length > 120) {
        lines.push(`...(${matches.length - 120} coincidencias más omitidas)`);
      }

      res.write(lines.join('\n'));
      res.end();
      return;
    }

    if (useDeterministic && asksTotals) {
      const lines: string[] = [];
      lines.push('Modo: Determinístico');
      lines.push(`Folios detectados: ${stats.folios.length}.`);
      lines.push(`Prestadores detectados: ${stats.providers.length}.`);
      lines.push(`Items detectados: ${stats.totals.totalItems}.`);
      lines.push(`Valor total PAM: ${stats.totals.totalValor.toLocaleString('es-CL')}.`);
      lines.push(`Bonificación total: ${stats.totals.totalBonif.toLocaleString('es-CL')}.`);
      lines.push(`Copago calculado: ${stats.totals.totalCopago.toLocaleString('es-CL')}.`);
      lines.push(`Copago declarado: ${stats.totals.totalCopagoDeclarado.toLocaleString('es-CL')}.`);
      lines.push(`Discrepancia global: ${stats.totals.discrepancia.toLocaleString('es-CL')}.`);
      res.write(lines.join('\n'));
      res.end();
      return;
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      res.write('OPENAI_API_KEY no configurada en servidor para responder pregunta abierta de PAM.');
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

    const focused = buildOpenAIPamContext(question, pamJson, stats);
    const prompt = `
Eres un asistente técnico de QA para PAM (Programa de Atención Médica o liquidación/cobertura de Isapre).
Responde sobre este PAM:
- totales de valor, bonificación y copago,
- detalle por folio, prestador e item,
- validación de cuadre y discrepancias.

Reglas:
- No uses normativa ni jurisprudencia.
- Si falta dato, dilo explícitamente.
- Muestra pasos de cálculo cuando corresponda.
- Responde breve y auditable.

Pregunta:
${question}

Resumen calculado por sistema:
- folios: ${stats.folios.length}
- prestadores: ${stats.providers.length}
- items: ${stats.totals.totalItems}
- total_valor: ${stats.totals.totalValor}
- total_bonificacion: ${stats.totals.totalBonif}
- total_copago: ${stats.totals.totalCopago}
- total_copago_declarado: ${stats.totals.totalCopagoDeclarado}
- discrepancia: ${stats.totals.discrepancia}
- cuadra: ${stats.totals.cuadra ? 'si' : 'no'}
- modo de contexto: ${focused.contextMode}

JSON PAM (focalizado):
${focused.contextText}
    `.trim();

    const openai = new OpenAIService(openaiKey);
    res.write('Modo: OpenAI\n');

    try {
      const stream = await openai.extractStream(imageBase64, mimeType, prompt, {
        model: modelName,
        maxTokens: 2200,
        temperature: 0.1
      });

      for await (const chunk of stream) {
        if (chunk?.text) res.write(chunk.text);
      }
    } catch (openAIError: any) {
      const lightweightPrompt = `
Eres un asistente técnico de QA para PAM.
Responde breve y auditable.
- No uses normativa.
- Si falta dato, dilo explícitamente.
- Si hay cálculo, muéstralo paso a paso.

Pregunta:
${question}

Contexto reducido por fallback:
${compactJson({
  totals: stats.totals,
  providers: stats.providers.slice(0, 40),
  firstFolios: stats.folios.slice(0, 8),
  firstItems: stats.items.slice(0, 120)
}, 12000)}
      `.trim();

      res.write(`Aviso: fallback OpenAI por error primario (${openAIError?.message || 'desconocido'}).\n`);
      const retryStream = await openai.extractStream(imageBase64, mimeType, lightweightPrompt, {
        model: modelName,
        maxTokens: 1600,
        temperature: 0.1
      });
      for await (const chunk of retryStream) {
        if (chunk?.text) res.write(chunk.text);
      }
    }
  } catch (error: any) {
    res.write(`Error en chat PAM: ${error?.message || 'desconocido'}`);
  } finally {
    res.end();
  }
}
