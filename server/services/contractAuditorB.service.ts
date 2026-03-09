import { GeminiService } from './gemini.service.js';
import { LayoutGridDoc, AuditorBResult } from './contractTypes.js';
import { jsonrepair } from 'jsonrepair';

export class ContractAuditorB {
  private gemini: GeminiService;
  private logCallback?: (msg: string) => void;

  constructor(gemini: GeminiService, logCallback?: (msg: string) => void) {
    this.gemini = gemini;
    this.logCallback = logCallback;
  }

  private log(msg: string) {
    console.log(`[AuditorB] ${msg}`);
    if (this.logCallback) this.logCallback(msg);
  }

  private normalizeForMatch(input: string): string {
    return String(input || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9%.\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isLikelyFinancialCellText(text: string): boolean {
    const t = this.normalizeForMatch(text);
    if (!t) return false;
    return /\b\d+(?:[.,]\d+)?\b\s*(uf|va|vam)\b|%|sin\s+tope|tope|copago|bonificaci|veces?\s+arancel/.test(t);
  }

  private isLikelyServiceCellText(text: string): boolean {
    const t = this.normalizeForMatch(text);
    if (!t) return false;
    return /(urgenc|hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|examen|protesis|ambulator)/.test(t);
  }

  private parseCellId(cellId: string): { row: number; col: number } | null {
    const raw = String(cellId || '');
    let match = /_c_(\d+)_(\d+)$/.exec(raw);
    if (!match) match = /_(\d+)_(\d+)$/.exec(raw);
    if (!match) return null;
    return { row: Number(match[1]), col: Number(match[2]) };
  }

  private getCellPosition(cell: any): { row: number; col: number } | null {
    if (Number.isFinite(cell?.row) && Number.isFinite(cell?.col)) {
      return { row: Number(cell.row), col: Number(cell.col) };
    }
    return this.parseCellId(String(cell?.cellId || ''));
  }

  private chooseTopCellInColumn(page: any, targetCol: number): string | null {
    const candidates = (page.cells || [])
      .map((cell: any) => ({ cell, idx: this.getCellPosition(cell) }))
      .filter((x: any) => x.idx && x.idx.col === targetCol);

    if (candidates.length === 0) return null;

    const headerRegex = /(prestacion|item|beneficio|cobertura|servicio|descripcion)/i;
    const headerCandidate = candidates
      .filter((x: any) => headerRegex.test(this.normalizeForMatch(String(x.cell.text || '').trim())))
      .sort((a: any, b: any) => {
        if (a.idx.row !== b.idx.row) return a.idx.row - b.idx.row;
        const ay = a.cell.bbox?.y0 ?? 999999;
        const by = b.cell.bbox?.y0 ?? 999999;
        return ay - by;
      })[0];
    if (headerCandidate?.cell?.cellId) return headerCandidate.cell.cellId;

    const nonFinancial = candidates
      .filter((x: any) => {
        const txt = String(x.cell.text || '').trim();
        return txt.length > 0 && !this.isLikelyFinancialCellText(txt);
      })
      .sort((a: any, b: any) => {
        if (a.idx.row !== b.idx.row) return a.idx.row - b.idx.row;
        const ay = a.cell.bbox?.y0 ?? 999999;
        const by = b.cell.bbox?.y0 ?? 999999;
        return ay - by;
      })[0];
    if (nonFinancial?.cell?.cellId) return nonFinancial.cell.cellId;

    const nonEmpty = candidates
      .filter((x: any) => String(x.cell.text || '').trim().length > 0)
      .sort((a: any, b: any) => {
        if (a.idx.row !== b.idx.row) return a.idx.row - b.idx.row;
        const ay = a.cell.bbox?.y0 ?? 999999;
        const by = b.cell.bbox?.y0 ?? 999999;
        return ay - by;
      })[0];
    if (nonEmpty?.cell?.cellId) return nonEmpty.cell.cellId;

    return candidates
      .sort((a: any, b: any) => a.idx.row - b.idx.row)[0]
      ?.cell?.cellId || null;
  }

  private inferItemColumnDeterministic(page: any, schema: any, suggestedSchema: any): string | null {
    const pageCells = page.cells || [];
    if (pageCells.length === 0) return null;

    const direct = schema?.item_col || schema?.prestacion_col;
    if (direct && pageCells.some((c: any) => c.cellId === direct)) {
      const directCell = pageCells.find((c: any) => c.cellId === direct);
      const hasCollision = [
        schema?.preferente_pct_col,
        schema?.preferente_tope_evento_col,
        schema?.preferente_tope_anual_col,
        schema?.libre_pct_col,
        schema?.libre_tope_evento_col,
        schema?.libre_tope_anual_col
      ].some((x: any) => x && x === direct);
      const directText = String(directCell?.text || '');
      const directLooksFinancial = this.isLikelyFinancialCellText(directText);
      const directLooksService = this.isLikelyServiceCellText(directText);
      if (!hasCollision && (!directLooksFinancial || directLooksService)) {
        return direct;
      }
    }

    const suggested = suggestedSchema?.item_col || suggestedSchema?.prestacion_col;
    if (suggested) {
      const idx = this.parseCellId(suggested);
      if (idx) {
        const projected = this.chooseTopCellInColumn(page, idx.col);
        if (projected) return projected;
      }
    }

    const headerRegex = /(prestacion|item|beneficio|cobertura|servicio|descripcion)/i;
    const headerCell = pageCells
      .filter((c: any) => headerRegex.test(this.normalizeForMatch(String(c.text || '').trim())))
      .sort((a: any, b: any) => {
        const ai = this.getCellPosition(a);
        const bi = this.getCellPosition(b);
        const ar = ai?.row ?? 999999;
        const br = bi?.row ?? 999999;
        if (ar !== br) return ar - br;
        const ay = a.bbox?.y0 ?? 999999;
        const by = b.bbox?.y0 ?? 999999;
        return ay - by;
      })[0];

    if (headerCell?.cellId) return headerCell.cellId;

    const byCol: Record<number, any[]> = {};
    for (const cell of pageCells) {
      const idx = this.getCellPosition(cell);
      if (!idx) continue;
      if (!byCol[idx.col]) byCol[idx.col] = [];
      byCol[idx.col].push(cell);
    }

    let bestCol: number | null = null;
    let bestScore = -Infinity;

    for (const colKey of Object.keys(byCol)) {
      const col = Number(colKey);
      const cells = byCol[col];
      const texts = cells.map((c: any) => String(c.text || '').trim()).filter(Boolean);
      if (texts.length === 0) continue;

      const joined = this.normalizeForMatch(texts.join(' '));
      const letters = (joined.match(/[a-z]/g) || []).length;
      const digits = (joined.match(/[0-9]/g) || []).length;
      const alphaRatio = letters / Math.max(1, letters + digits);
      const avgLen = texts.reduce((acc: number, t: string) => acc + t.length, 0) / texts.length;
      const numericSignals = (joined.match(/(%|uf|va|\b\d+[.,]?\d*)/g) || []).length;
      const serviceSignals = (joined.match(/urgenc|hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|examen|protesis|ambulator/g) || []).length;
      const financialSignals = (joined.match(/sin\s+tope|copago|tope|\buf\b|\bva\b|%/g) || []).length;
      const leftBias = -col * 2;

      const score = (alphaRatio * 100) + avgLen + (serviceSignals * 24) + leftBias - (numericSignals * 0.5) - (financialSignals * 10);
      if (score > bestScore) {
        bestScore = score;
        bestCol = col;
      }
    }

    if (bestCol === null) return null;
    return this.chooseTopCellInColumn(page, bestCol);
  }

  private buildRowLines(page: any): Array<{ row: number; text: string; cells: Array<{ cellId: string; text: string }> }> {
    const grouped: Record<number, Array<{ col: number; cellId: string; text: string }>> = {};
    const cells = page.cells || [];

    for (const cell of cells) {
      const idx = this.getCellPosition(cell);
      if (!idx) continue;
      if (!grouped[idx.row]) grouped[idx.row] = [];
      grouped[idx.row].push({
        col: idx.col,
        cellId: String(cell.cellId || ''),
        text: String(cell.text || '').trim()
      });
    }

    if (Object.keys(grouped).length === 0) {
      // Fallback for pages without reliable row/col indices: group by Y bands.
      const withBbox = cells
        .filter((c: any) => Number.isFinite(c?.bbox?.y0) && Number.isFinite(c?.bbox?.x0))
        .sort((a: any, b: any) => {
          const ay = a.bbox?.y0 ?? 0;
          const by = b.bbox?.y0 ?? 0;
          if (ay !== by) return ay - by;
          return (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0);
        });

      const rowBands: Array<{ y: number; cells: any[] }> = [];
      const rowTolerance = Math.max(6, Number(page?.pageSize?.height || 1000) * 0.008);

      for (const cell of withBbox) {
        const y0 = Number(cell.bbox?.y0 || 0);
        const band = rowBands.find((b) => Math.abs(b.y - y0) <= rowTolerance);
        if (band) {
          band.cells.push(cell);
          band.y = (band.y + y0) / 2;
        } else {
          rowBands.push({ y: y0, cells: [cell] });
        }
      }

      rowBands
        .sort((a, b) => a.y - b.y)
        .forEach((band, rowIdx) => {
          grouped[rowIdx] = (band.cells || [])
            .sort((a: any, b: any) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0))
            .map((cell: any, colIdx: number) => ({
              col: colIdx,
              cellId: String(cell.cellId || ''),
              text: String(cell.text || '').trim()
            }));
        });

      // Last-resort fallback when even bbox grouping is unavailable.
      if (Object.keys(grouped).length === 0) {
        let rowIdx = 0;
        for (const cell of cells) {
          const text = String(cell?.text || '').trim();
          if (!text) continue;
          grouped[rowIdx] = [{
            col: 0,
            cellId: String(cell?.cellId || ''),
            text
          }];
          rowIdx++;
        }
      }
    }

    return Object.keys(grouped)
      .map(Number)
      .sort((a, b) => a - b)
      .map(row => {
        const rowCells = grouped[row].sort((a, b) => a.col - b.col);
        return {
          row,
          text: rowCells.map(c => c.text).filter(Boolean).join(' | '),
          cells: rowCells.map(c => ({ cellId: c.cellId, text: c.text }))
        };
      });
  }

  private detectAmbitoFromText(text: string): { ambito: string; item: string } | null {
    const t = this.normalizeForMatch(text);
    if (/dia\s*cama/.test(t)) return { ambito: 'DIA_CAMA', item: 'Dia Cama' };
    if (/pabell|derecho\s+pabell/.test(t)) return { ambito: 'PABELLON', item: 'Derecho Pabellon' };
    if (/honorario/.test(t)) return { ambito: 'HONORARIOS', item: 'Honorarios Medicos' };
    if (/medicament|farmac/.test(t)) return { ambito: 'MEDICAMENTOS', item: 'Medicamentos' };
    if (/material|insumo/.test(t)) return { ambito: 'MATERIALES', item: 'Materiales e Insumos' };
    if (/protesis|ortesis/.test(t)) return { ambito: 'PROTESIS', item: 'Protesis y Ortesis' };
    if (/examen|laboratorio|imagen|tac|resonancia/.test(t)) return { ambito: 'EXAMENES', item: 'Examenes y Diagnostico' };
    if (/quimioterapia/.test(t)) return { ambito: 'QUIMIOTERAPIA', item: 'Quimioterapia' };
    if (/urgenc/.test(t)) return { ambito: 'URGENCIA', item: 'Urgencia' };
    if (/ambulator/.test(t)) return { ambito: 'AMBULATORIO', item: 'Ambulatorio' };
    return null;
  }

  private extractNumbersByRegex(text: string, pattern: RegExp): number[] {
    const values: number[] = [];
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const token = String(m[1] || '').trim();
      let normalized = token;
      if (token.includes('.') && token.includes(',')) {
        // e.g. 1.234,56 -> 1234.56
        normalized = token.replace(/\./g, '').replace(',', '.');
      } else if (token.includes(',')) {
        // e.g. 1,4 -> 1.4
        normalized = token.replace(',', '.');
      }
      const val = Number(normalized);
      if (!Number.isNaN(val)) values.push(val);
    }
    return values;
  }

  private makeUnknownTope() {
    return { estado: 'UNKNOWN', valor: null, unidad: 'UNKNOWN', tipo: 'TOPE_BONIFICACION' as const };
  }

  private makeSinTope() {
    return { estado: 'SIN_TOPE_ITEM', valor: null, unidad: 'SIN_TOPE', tipo: 'TOPE_BONIFICACION' as const };
  }

  private isMetaAdministrativeText(text: string): boolean {
    return /(tipo de plan|tramos de edad|cotizantes|cargas|precio|equivalencia|para calcular|plan complementario|beneficiario|factor de riesgo|edad|sexo)/i
      .test(text || '');
  }

  private makeTope(valor: number | null, unidad: 'UF' | 'VA', esCopagoFijo: boolean) {
    if (valor === null || Number.isNaN(valor)) return this.makeUnknownTope();
    return {
      estado: 'CON_TOPE',
      valor,
      unidad,
      tipo: esCopagoFijo ? 'COPAGO_FIJO' as const : 'TOPE_BONIFICACION' as const,
      sujeto_tope_general_anual: !esCopagoFijo
    };
  }

  private normalizeCoverageUnit(unit: any): string {
    const u = this.normalizeForMatch(String(unit || '')).replace(/\s+/g, '');
    if (!u) return 'UNKNOWN';
    if (u === 'uf' || u === 'u.f.') return 'UF';
    if (u === 'va' || u === 'v.a.' || u === 'vam' || u === 'vecesarancel' || u === 'vecesarancelmasvida') return 'VA';
    if (u.includes('sin') && u.includes('tope')) return 'SIN_TOPE';
    if (u === 'clp') return 'CLP';
    if (u.includes('dia') || u.includes('hora')) return 'DIAS';
    return String(unit || '').toUpperCase();
  }

  private canonicalizeUnitsInItems(items: any[]): void {
    for (const item of (items || [])) {
      const rules = [...(item?.preferente?.rules || []), ...(item?.libre_eleccion?.rules || [])];
      for (const r of rules) {
        if (r?.tope_evento) r.tope_evento.unidad = this.normalizeCoverageUnit(r.tope_evento.unidad);
        if (r?.tope_anual) r.tope_anual.unidad = this.normalizeCoverageUnit(r.tope_anual.unidad);
        if (r?.copago_fijo?.unidad) r.copago_fijo.unidad = this.normalizeCoverageUnit(r.copago_fijo.unidad) === 'CLP' ? 'CLP' : 'UF';
      }
    }
  }

  private semanticFallbackFromPage(
    page: any,
    options: { hospitalFirst?: boolean; allowServiceLevels?: boolean } = {}
  ): any {
    const hospitalFirst = options.hospitalFirst ?? false;
    const allowServiceLevels = options.allowServiceLevels ?? true;
    const rowLines = this.buildRowLines(page);
    const items: any[] = [];
    const service_levels: any[] = [];
    const warnings: any[] = [];

    for (const row of rowLines) {
      const rowText = row.text;
      if (!rowText || rowText.length < 3) continue;

      const norm = this.normalizeForMatch(rowText);
      if (!norm) continue;
      if (this.isMetaAdministrativeText(norm)) continue;

      const dayMatch = norm.match(/(\d+(?:[.,]\d+)?)\s*\b(dias?|horas?)\b/);
      if (allowServiceLevels && dayMatch && !/(uf|v\.?a\.?|va|vam)/.test(norm)) {
        const valor = Number(dayMatch[1].replace(',', '.'));
        if (!Number.isNaN(valor)) {
          service_levels.push({
            item: rowText.substring(0, 120),
            valor,
            unidad: /hora/.test(dayMatch[2]) ? 'HORAS' : 'DIAS',
            evidence: { page: page.page, cells: row.cells }
          });
        }
        continue;
      }

      const ambitoDetected = this.detectAmbitoFromText(norm);
      if (!ambitoDetected) continue;

      if (hospitalFirst && ['AMBULATORIO', 'OTROS'].includes(String(ambitoDetected.ambito))) continue;

      const hasFinancialSignals = /(%|uf|v\.?a\.?|va|vam|sin\s+tope|copago|veces?\s+arancel)/.test(norm);
      if (!hasFinancialSignals) continue;

      const normalizedUpper = norm.toUpperCase();
      const percentages = this.extractNumbersByRegex(normalizedUpper, /(\d{1,3})\s*%/g);
      const ufValues = this.extractNumbersByRegex(normalizedUpper, /(\d+(?:[.,]\d+)?)\s*UF/g);
      const vaValues = this.extractNumbersByRegex(normalizedUpper, /(\d+(?:[.,]\d+)?)\s*(?:V\.?A\.?|VA|VAM|VECES?\s+ARANCEL(?:\s+MASVIDA)?)/g);
      const hasSinTope = /sin\s+tope/.test(norm);
      const hasPrefMarker = /(preferente|staff|bono|institucional)/.test(norm);
      const hasLibreMarker = /libre\s*elecci/.test(norm);

      const isUrgencia = ambitoDetected.ambito === 'URGENCIA' || /urgenc/.test(norm);
      const evidence = { page: page.page, cells: row.cells.slice(0, 6) };

      const topeFromIndex = (idx: number) => {
        if (ufValues[idx] !== undefined) return this.makeTope(ufValues[idx], 'UF', isUrgencia);
        if (vaValues[idx] !== undefined) return this.makeTope(vaValues[idx], 'VA', false);
        if (hasSinTope) return this.makeSinTope();
        return this.makeUnknownTope();
      };

      const buildRule = (modality: 'PREFERENTE' | 'LIBRE_ELECCION' | 'UNKNOWN', idx: number) => {
        const topeEvento = topeFromIndex(idx);
        const rawUf = ufValues[idx] !== undefined ? ufValues[idx] : null;
        return {
          subred_id: modality === 'LIBRE_ELECCION' ? 'LIBRE_ELECCION' : modality === 'PREFERENTE' ? 'PREF_TIER_1' : 'UNKNOWN_MODALIDAD',
          condiciones: [],
          porcentaje: percentages[idx] ?? null,
          clinicas: [],
          tope_evento: topeEvento,
          tope_anual: this.makeUnknownTope(),
          copago_fijo: isUrgencia && rawUf !== null ? { valor: rawUf, unidad: 'UF' } : null,
          evidence
        };
      };

      const prefRules: any[] = [];
      const libreRules: any[] = [];

      if (hasPrefMarker && hasLibreMarker) {
        prefRules.push(buildRule('PREFERENTE', 0));
        libreRules.push(buildRule('LIBRE_ELECCION', 1));
      } else if (hasPrefMarker) {
        prefRules.push(buildRule('PREFERENTE', 0));
      } else if (hasLibreMarker) {
        libreRules.push(buildRule('LIBRE_ELECCION', 0));
      } else {
        prefRules.push(buildRule('UNKNOWN', 0));
        warnings.push({
          type: 'UNKNOWN_MODALITY_FALLBACK',
          detail: `Fila ambigua en pagina ${page.page}: modalidad no explicita para "${ambitoDetected.item}".`
        });
      }

      if (prefRules.length === 0 && libreRules.length === 0) continue;

      items.push({
        ambito: ambitoDetected.ambito,
        item: ambitoDetected.item,
        preferente: { rules: prefRules },
        libre_eleccion: { rules: libreRules }
      });
    }

    if (hospitalFirst && items.length === 0) {
      const rescuedHospitalItems = this.semanticHospitalCoreFallback(page);
      if (rescuedHospitalItems.length > 0) {
        items.push(...rescuedHospitalItems);
        warnings.push({
          type: 'HOSPITAL_CORE_SEMANTIC_RESCUE',
          detail: `Rescate hospitalario semantico aplicado en pagina ${page.page}.`
        });
      }
    }

    if (items.length > 0 || service_levels.length > 0) {
      warnings.push({
        type: 'SEMANTIC_FALLBACK_USED',
        detail: `Fallback semantico activado en pagina ${page.page} por falla de grilla/anclaje`
      });
    }

    return { items, service_levels, warnings, detectedSchema: null };
  }

  private semanticHospitalCoreFallback(page: any): any[] {
    const rawText = (page.cells || []).map((c: any) => String(c?.text || '')).join(' ');
    const normText = this.normalizeForMatch(rawText);
    const ufValues = this.extractNumbersByRegex(String(rawText || '').toUpperCase(), /(\d+(?:[.,]\d+)?)\s*UF/g);
    const vaValues = this.extractNumbersByRegex(String(rawText || '').toUpperCase(), /(\d+(?:[.,]\d+)?)\s*(?:V\.?A\.?|VA|VAM|VECES?\s+ARANCEL(?:\s+MASVIDA)?)/g);

    const valuePool: Array<{ valor: number; unidad: 'UF' | 'VA' }> = [
      ...ufValues.map((v) => ({ valor: v, unidad: 'UF' as const })),
      ...vaValues.map((v) => ({ valor: v, unidad: 'VA' as const }))
    ];
    if (valuePool.length === 0) return [];

    const targets = [
      { ambito: 'DIA_CAMA', item: 'Dia Cama', pattern: /dia\s*cama|hospitalizaci/ },
      { ambito: 'PABELLON', item: 'Derecho Pabellon', pattern: /pabell|derecho\s+pabell/ },
      { ambito: 'MEDICAMENTOS', item: 'Medicamentos', pattern: /medicament|farmac/ },
      { ambito: 'MATERIALES', item: 'Materiales e Insumos', pattern: /material|insumo/ }
    ];

    const rescued: any[] = [];
    let valueIdx = 0;

    for (const t of targets) {
      if (!t.pattern.test(normText)) continue;

      const selected = valuePool[Math.min(valueIdx, valuePool.length - 1)];
      valueIdx++;

      const evidenceCells = (page.cells || [])
        .filter((c: any) => {
          const nt = this.normalizeForMatch(String(c?.text || ''));
          return t.pattern.test(nt) || /\b\d+(?:[.,]\d+)?\s*(uf|v\.?a\.?|va|vam)\b/i.test(String(c?.text || ''));
        })
        .slice(0, 6)
        .map((c: any) => ({ cellId: String(c?.cellId || ''), text: String(c?.text || '') }));

      rescued.push({
        ambito: t.ambito,
        item: t.item,
        preferente: {
          rules: [
            {
              subred_id: 'UNKNOWN_MODALIDAD',
              condiciones: [],
              porcentaje: null,
              clinicas: [],
              tope_evento: {
                estado: 'CON_TOPE',
                valor: selected.valor,
                unidad: selected.unidad,
                tipo: 'TOPE_BONIFICACION',
                sujeto_tope_general_anual: true
              },
              tope_anual: this.makeUnknownTope(),
              copago_fijo: null,
              evidence: { page: page.page, cells: evidenceCells }
            }
          ]
        },
        libre_eleccion: { rules: [] }
      });
    }

    if (
      rescued.length === 0 &&
      /(hospitalarias?|cirugia\s+mayor\s+ambulatoria|cma)/.test(normText)
    ) {
      const selected = valuePool[0];
      const evidenceCells = (page.cells || [])
        .filter((c: any) => {
          const nt = this.normalizeForMatch(String(c?.text || ''));
          return /(hospitalarias?|cirugia\s+mayor\s+ambulatoria|cma)/.test(nt) ||
            /\b\d+(?:[.,]\d+)?\s*(uf|v\.?a\.?|va|vam)\b/i.test(String(c?.text || ''));
        })
        .slice(0, 6)
        .map((c: any) => ({ cellId: String(c?.cellId || ''), text: String(c?.text || '') }));

      rescued.push({
        ambito: 'OTROS',
        item: 'Hospitalarias y Cirugia Mayor Ambulatoria',
        preferente: {
          rules: [
            {
              subred_id: 'UNKNOWN_MODALIDAD',
              condiciones: [],
              porcentaje: null,
              clinicas: [],
              tope_evento: {
                estado: 'CON_TOPE',
                valor: selected.valor,
                unidad: selected.unidad,
                tipo: 'TOPE_BONIFICACION',
                sujeto_tope_general_anual: true
              },
              tope_anual: this.makeUnknownTope(),
              copago_fijo: null,
              evidence: { page: page.page, cells: evidenceCells }
            }
          ]
        },
        libre_eleccion: { rules: [] }
      });
    }

    return rescued;
  }

  private sanitizeFinancialVsServiceLevels(
    items: any[],
    serviceLevels: any[],
    warnings: any[]
  ): { items: any[]; serviceLevels: any[]; warnings: any[] } {
    const moved: any[] = [];
    const normWarnings: any[] = [...warnings];

    const isDaysLike = (value: any) => /\b(dias?|horas?)\b/i.test(this.normalizeForMatch(String(value || '')));
    const isUrgenciaItem = (item: any) =>
      String(item?.ambito || '').toUpperCase() === 'URGENCIA' || /URGENCIA/i.test(String(item?.item || ''));

    const sanitized = (items || []).map((item: any) => {
      const out = { ...item };
      out.preferente = out.preferente || { rules: [] };
      out.libre_eleccion = out.libre_eleccion || { rules: [] };

      const sanitizeRules = (rules: any[], modality: 'PREFERENTE' | 'LIBRE_ELECCION') => {
        const normalized: any[] = [];
        for (const rule of (rules || [])) {
          const ruleCopy = { ...rule };

          if (modality === 'PREFERENTE' && String(ruleCopy.subred_id || '').toUpperCase() === 'LIBRE_ELECCION') {
            ruleCopy.subred_id = 'PREF_TIER_1';
            normWarnings.push({
              type: 'SUBRED_NORMALIZED',
              detail: `Normalizado subred_id invÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡lido en preferente para item "${out.item || out.ambito}".`
            });
          }

          const evidenceText = this.normalizeForMatch(JSON.stringify(ruleCopy?.evidence?.cells || []));
          const evidenceHasUF = /\buf\b/.test(evidenceText);
          const evidenceHasVA = /\bva\b|v\.a\.|\bvam\b|veces?\s+arancel/.test(evidenceText);
          const evidenceHasTime = /\b(dias?|horas?)\b/.test(evidenceText);

          // Recover unit leaks where model outputs DIAS/HORAS but evidence is clearly UF/VA.
          if (isDaysLike(ruleCopy?.tope_evento?.unidad) && !evidenceHasTime && (evidenceHasUF || evidenceHasVA)) {
            ruleCopy.tope_evento = {
              ...ruleCopy.tope_evento,
              unidad: evidenceHasUF ? 'UF' : 'VA'
            };
          }
          if (isDaysLike(ruleCopy?.tope_anual?.unidad) && !evidenceHasTime && (evidenceHasUF || evidenceHasVA)) {
            ruleCopy.tope_anual = {
              ...ruleCopy.tope_anual,
              unidad: evidenceHasUF ? 'UF' : 'VA'
            };
          }

          const dayContamination =
            isDaysLike(ruleCopy?.tope_evento?.unidad) ||
            isDaysLike(ruleCopy?.tope_anual?.unidad) ||
            evidenceHasTime;

          if (dayContamination) {
            const val = ruleCopy?.tope_evento?.valor ?? ruleCopy?.tope_anual?.valor ?? null;
            if (typeof val === 'number' && !Number.isNaN(val)) {
              moved.push({
                item: out.item || out.ambito || 'Servicio',
                valor: val,
                unidad: /HORA/i.test(String(ruleCopy?.tope_evento?.unidad || ruleCopy?.tope_anual?.unidad || '')) ? 'HORAS' : 'DIAS',
                evidence: ruleCopy?.evidence || { page: null, cells: [] }
              });
            }
            continue;
          }

          if (isUrgenciaItem(out) && ruleCopy?.tope_evento?.valor != null && ['UF', 'CLP'].includes(String(ruleCopy?.tope_evento?.unidad || '').toUpperCase())) {
            ruleCopy.tope_evento = {
              ...ruleCopy.tope_evento,
              tipo: 'COPAGO_FIJO'
            };
            ruleCopy.copago_fijo = ruleCopy.copago_fijo || {
              valor: ruleCopy.tope_evento.valor,
              unidad: String(ruleCopy.tope_evento.unidad || 'UF').toUpperCase() === 'CLP' ? 'CLP' : 'UF'
            };
          }

          normalized.push(ruleCopy);
        }
        return normalized;
      };

      out.preferente.rules = sanitizeRules(out.preferente.rules, 'PREFERENTE');
      out.libre_eleccion.rules = sanitizeRules(out.libre_eleccion.rules, 'LIBRE_ELECCION');
      return out;
    }).filter((item: any) =>
      (item?.preferente?.rules?.length || 0) > 0 || (item?.libre_eleccion?.rules?.length || 0) > 0
    );

    this.canonicalizeUnitsInItems(sanitized);

    if (moved.length > 0) {
      normWarnings.push({
        type: 'DAYS_MOVED_TO_SERVICE_LEVELS',
        detail: `${moved.length} regla(s) con unidad de tiempo fueron movidas de items financieros a service_levels.`
      });
    }

    return {
      items: sanitized,
      serviceLevels: [...serviceLevels, ...moved],
      warnings: normWarnings
    };
  }

  private hasHospitalCore(items: any[]): boolean {
    const hasUfVa = (rule: any) =>
      ['UF', 'VA', 'VAM'].includes(String(rule?.tope_evento?.unidad || '').toUpperCase()) ||
      ['UF', 'VA', 'VAM'].includes(String(rule?.tope_anual?.unidad || '').toUpperCase());

    for (const item of (items || [])) {
      const itemText = this.normalizeForMatch(`${item?.item || ''} ${item?.ambito || ''}`);
      const looksHospitalCore = /(dia\s*cama|pabell|derecho\s+pabell|medicament|material|insumo|hospital|hospitalizaci)/.test(itemText);
      if (!looksHospitalCore) continue;

      const rules = [...(item?.preferente?.rules || []), ...(item?.libre_eleccion?.rules || [])];
      if (rules.some(hasUfVa)) return true;
    }
    return false;
  }

  private filterMetaItems(items: any[], warnings: any[], page: number): any[] {
    let removed = 0;
    const kept = (items || []).filter((item: any) => {
      const itemText = String(item?.item || '');
      const reject = this.isMetaAdministrativeText(itemText);
      if (reject) removed++;
      return !reject;
    });
    if (removed > 0) {
      warnings.push({
        type: 'META_ITEMS_FILTERED',
        detail: `Se removieron ${removed} item(s) administrativos/no clinicos en pagina ${page}.`
      });
    }
    return kept;
  }

  private isHeaderLikeLabel(text: string): boolean {
    const t = this.normalizeForMatch(text);
    if (!t) return false;
    return /(prestaciones?|beneficios?|descripcion|servicios?|item|cobertura|bonificacion|valor\s+real|tope\s+anual|tope\s+evento|plan\s+complementario|red\s+preferente|libre\s+elecci)/.test(t);
  }

  private hasMeaningfulFinancialData(rule: any): boolean {
    const hasNumber = (v: any) => typeof v === 'number' && !Number.isNaN(v);
    const unit = (u: any) => String(u || '').toUpperCase();
    const meaningfulUnits = new Set(['UF', 'VA', 'VAM', 'SIN_TOPE', 'CLP']);
    return (
      hasNumber(rule?.porcentaje) ||
      hasNumber(rule?.tope_evento?.valor) ||
      hasNumber(rule?.tope_anual?.valor) ||
      hasNumber(rule?.copago_fijo?.valor) ||
      meaningfulUnits.has(unit(rule?.tope_evento?.unidad)) ||
      meaningfulUnits.has(unit(rule?.tope_anual?.unidad)) ||
      meaningfulUnits.has(unit(rule?.copago_fijo?.unidad))
    );
  }

  private filterHeaderArtifactsFromItems(
    page: any,
    items: any[],
    schema: any,
    warnings: any[],
    pageNumber: number
  ): any[] {
    const headerRows = new Set<number>();
    const schemaCols = [
      schema?.item_col,
      schema?.prestacion_col,
      schema?.preferente_pct_col,
      schema?.preferente_tope_evento_col,
      schema?.preferente_tope_anual_col,
      schema?.libre_pct_col,
      schema?.libre_tope_evento_col,
      schema?.libre_tope_anual_col
    ].filter(Boolean);
    for (const cid of schemaCols) {
      const idx = this.parseCellId(String(cid));
      if (idx) headerRows.add(idx.row);
    }
    if (headerRows.size === 0) {
      const topHeaderRow = (page?.cells || [])
        .map((c: any) => ({ c, idx: this.getCellPosition(c) }))
        .filter((x: any) => x.idx && this.isHeaderLikeLabel(String(x?.c?.text || '')))
        .sort((a: any, b: any) => (a.idx.row - b.idx.row))[0];
      if (topHeaderRow?.idx?.row !== undefined) headerRows.add(topHeaderRow.idx.row);
    }

    const getRuleEvidence = (rule: any): Array<{ cellId: string; text: string }> =>
      Array.isArray(rule?.evidence?.cells) ? rule.evidence.cells : [];

    let removedRules = 0;
    let removedItems = 0;

    const out = (items || []).map((item: any) => {
      const clone = {
        ...item,
        preferente: { ...(item?.preferente || {}), rules: [...(item?.preferente?.rules || [])] },
        libre_eleccion: { ...(item?.libre_eleccion || {}), rules: [...(item?.libre_eleccion?.rules || [])] }
      };

      const cleanRules = (rules: any[]) =>
        (rules || []).filter((rule: any) => {
          const ev = getRuleEvidence(rule);
          const rows = ev
            .map((c: any) => this.parseCellId(String(c?.cellId || ''))?.row)
            .filter((r: any) => Number.isFinite(r)) as number[];
          const texts = ev.map((c: any) => String(c?.text || '')).filter(Boolean);

          const onlyHeaderRows = rows.length > 0 && headerRows.size > 0 && rows.every((r) => headerRows.has(r));
          const onlyHeaderTexts = texts.length > 0 && texts.every((t) => this.isHeaderLikeLabel(t));
          const hasFinancial = this.hasMeaningfulFinancialData(rule);

          const drop = !hasFinancial && (onlyHeaderRows || onlyHeaderTexts);
          if (drop) removedRules++;
          return !drop;
        });

      clone.preferente.rules = cleanRules(clone.preferente.rules);
      clone.libre_eleccion.rules = cleanRules(clone.libre_eleccion.rules);
      return clone;
    }).filter((item: any) => {
      const pref = item?.preferente?.rules || [];
      const libre = item?.libre_eleccion?.rules || [];
      const hasRules = pref.length > 0 || libre.length > 0;
      if (hasRules) return true;

      const itemText = String(item?.item || '');
      const dropByLabel = this.isHeaderLikeLabel(itemText) || this.isMetaAdministrativeText(itemText);
      if (dropByLabel) {
        removedItems++;
        return false;
      }
      return false;
    });

    if (removedRules > 0 || removedItems > 0) {
      warnings.push({
        type: 'HEADER_ARTIFACTS_FILTERED',
        detail: `Se removieron ${removedRules} regla(s) y ${removedItems} item(s) de cabecera/metadata en pagina ${pageNumber}.`
      });
    }

    return out;
  }

  private sanitizeEvidenceCellIds(parsed: any, validCellIds: string[], page: number): void {
    const validSet = new Set(validCellIds);
    let removed = 0;

    const sanitizeEvidence = (evidence: any) => {
      if (!evidence || !Array.isArray(evidence.cells)) return;
      const before = evidence.cells.length;
      evidence.cells = evidence.cells.filter((c: any) => c && validSet.has(c.cellId));
      removed += Math.max(0, before - evidence.cells.length);
    };

    for (const item of (parsed.items || [])) {
      for (const rule of (item?.preferente?.rules || [])) sanitizeEvidence(rule?.evidence);
      for (const rule of (item?.libre_eleccion?.rules || [])) sanitizeEvidence(rule?.evidence);
    }
    for (const sl of (parsed.service_levels || [])) sanitizeEvidence(sl?.evidence);

    if (removed > 0) {
      parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      parsed.warnings.push({
        type: 'INVALID_EVIDENCE_CELLS_REMOVED',
        detail: `Se eliminaron ${removed} referencias a cellId invalidos en pagina ${page}.`
      });
    }
  }

  private findCellById(page: any, cellId: string): any | null {
    return (page.cells || []).find((c: any) => c.cellId === cellId) || null;
  }

  private overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
    const start = Math.max(a0, b0);
    const end = Math.min(a1, b1);
    if (end <= start) return 0;
    const overlap = end - start;
    const base = Math.max(1, Math.min(a1 - a0, b1 - b0));
    return overlap / base;
  }

  private projectRightCellsByRowBand(page: any, anchorCell: any): any[] {
    const y0 = anchorCell?.bbox?.y0;
    const y1 = anchorCell?.bbox?.y1;
    const x1 = anchorCell?.bbox?.x1;
    if ([y0, y1, x1].some(v => typeof v !== 'number')) return [];

    return (page.cells || [])
      .filter((c: any) => {
        const cb = c?.bbox;
        if (!cb) return false;
        if ((cb.x0 ?? 0) <= x1) return false;
        return this.overlapRatio(cb.y0 ?? 0, cb.y1 ?? 0, y0, y1) >= 0.6;
      })
      .sort((a: any, b: any) => (a?.bbox?.x0 ?? 0) - (b?.bbox?.x0 ?? 0));
  }

  private parseCoverageSignalsFromCells(cells: any[]): {
    percentages: number[];
    uf: number[];
    va: number[];
    hasSinTope: boolean;
  } {
    const text = (cells || []).map((c: any) => String(c?.text || '')).join(' ').toUpperCase();
    const parseNums = (pattern: RegExp) =>
      Array.from(text.matchAll(pattern))
        .map(m => {
          const token = String(m[1] || '').trim();
          if (token.includes('.') && token.includes(',')) return Number(token.replace(/\./g, '').replace(',', '.'));
          if (token.includes(',')) return Number(token.replace(',', '.'));
          return Number(token);
        })
        .filter(v => !Number.isNaN(v));

    return {
      percentages: parseNums(/(\d{1,3})\s*%/g),
      uf: parseNums(/(\d+(?:[.,]\d+)?)\s*UF/g),
      va: parseNums(/(\d+(?:[.,]\d+)?)\s*(?:V\.?A\.?|VA|VAM|VECES?\s+ARANCEL(?:\s+MASVIDA)?)/g),
      hasSinTope: /SIN\s+TOPE/.test(text)
    };
  }

  private applyRowBandProjection(page: any, parsed: any, schema: any): void {
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    const itemColId = schema?.item_col || schema?.prestacion_col;
    const itemColIdx = itemColId ? this.parseCellId(itemColId)?.col : undefined;

    for (const item of (parsed.items || [])) {
      const rulesPref = item?.preferente?.rules || [];
      const rulesLibre = item?.libre_eleccion?.rules || [];
      const allRules = [...rulesPref, ...rulesLibre];

      let anchorCell: any | null = null;

      for (const rule of allRules) {
        for (const evCell of (rule?.evidence?.cells || [])) {
          const cell = this.findCellById(page, evCell.cellId);
          if (!cell) continue;
          if (itemColIdx !== undefined) {
            const idx = this.parseCellId(cell.cellId);
            if (idx && idx.col === itemColIdx) {
              anchorCell = cell;
              break;
            }
          }
          if (!anchorCell && String(cell.text || '').toUpperCase().includes(String(item?.item || '').toUpperCase())) {
            anchorCell = cell;
            break;
          }
        }
        if (anchorCell) break;
      }

      if (!anchorCell && item?.item) {
        const target = String(item.item).toUpperCase();
        anchorCell = (page.cells || []).find((c: any) => String(c.text || '').toUpperCase().includes(target)) || null;
      }
      if (!anchorCell) continue;

      const rightCells = this.projectRightCellsByRowBand(page, anchorCell);
      if (rightCells.length === 0) continue;

      const signals = this.parseCoverageSignalsFromCells(rightCells);
      const hasUsefulSignals = signals.percentages.length > 0 || signals.uf.length > 0 || signals.va.length > 0 || signals.hasSinTope;
      if (!hasUsefulSignals) continue;

      const makeProjectedTope = () => {
        if (signals.uf.length > 0) return { estado: 'CON_TOPE', valor: signals.uf[0], unidad: 'UF', tipo: 'TOPE_BONIFICACION' };
        if (signals.va.length > 0) return { estado: 'CON_TOPE', valor: signals.va[0], unidad: 'VA', tipo: 'TOPE_BONIFICACION' };
        if (signals.hasSinTope) return { estado: 'SIN_TOPE_ITEM', valor: null, unidad: 'SIN_TOPE', tipo: 'TOPE_BONIFICACION' };
        return { estado: 'UNKNOWN', valor: null, unidad: 'UNKNOWN', tipo: 'TOPE_BONIFICACION' };
      };

      const libreNeedsRule = (rulesLibre.length === 0);
      if (libreNeedsRule) {
        item.libre_eleccion.rules.push({
          subred_id: 'LIBRE_ELECCION',
          condiciones: [],
          porcentaje: signals.percentages[0] ?? null,
          clinicas: [],
          tope_evento: makeProjectedTope(),
          tope_anual: { estado: 'UNKNOWN', valor: null, unidad: 'UNKNOWN' },
          copago_fijo: null,
          evidence: {
            page: page.page,
            cells: rightCells.slice(0, 6).map((c: any) => ({ cellId: c.cellId, text: c.text }))
          },
          attached_by: 'ROW_BAND_PROJECTION'
        });
        warnings.push({
          type: 'ROW_BAND_PROJECTION_APPLIED',
          detail: `Se proyectÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ libre elecciÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³n para "${item.item}" en pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡gina ${page.page}.`
        });
        continue;
      }

      for (const lr of rulesLibre) {
        const hasUnknownTope = !lr?.tope_evento || String(lr?.tope_evento?.estado || '').toUpperCase() === 'UNKNOWN';
        if (hasUnknownTope) {
          lr.tope_evento = makeProjectedTope();
          lr.attached_by = 'ROW_BAND_PROJECTION';
          warnings.push({
            type: 'ROW_BAND_PROJECTION_APPLIED',
            detail: `Se completÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ tope libre elecciÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³n para "${item.item}" en pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡gina ${page.page}.`
          });
        }
      }
    }

    parsed.warnings = warnings;
  }

  private classifyTableHard(page: any): "COVERAGE_GRID" | "FACTOR_TABLE" | "ARANCEL_CATALOG" | "WAIT_TIMES_TABLE" | "DEFINITIONS_TEXT" | "SERVICE_LEVEL" | "UNKNOWN" {
    const text = this.normalizeForMatch((page.cells || []).map((c: any) => c.text).join(" "));
    const coreCoverageHits = (text.match(/hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|urgenc|uci|uti/g) || []).length;
    const metaHits = (text.match(/tipo de plan|tabla de factores|cotizacion legal|cotizantes|cargas|tramos de edad|precio base|equivalencia|firma de afiliado|huella dactilar/g) || []).length;
    const marketingHits = (text.match(/plan lite|que es un plan|cuales son los beneficios|contactan|app movil|sucursales 600 600 3600/g) || []).length;
    const hasPercentages = (text.match(/%/g) || []).length;

    if (text.includes("anos") && (text.includes("0 a") || text.includes("65 y mas") || text.includes("mayor de") || text.includes("beneficiario"))) {
      if (!text.includes("hospitalario") && !text.includes("ambulatorio")) return "FACTOR_TABLE";
    }

    if (text.includes("tiempo maximo") || text.includes("garantia explicita") || (text.includes("espera") && text.includes("dias"))) {
      return "WAIT_TIMES_TABLE";
    }

    if (marketingHits >= 2) return "DEFINITIONS_TEXT";
    if (metaHits >= 5 && hasPercentages <= 2) return "FACTOR_TABLE";
    if (metaHits >= 2 && coreCoverageHits === 0 && hasPercentages === 0) return "FACTOR_TABLE";

    const codeMatches = text.match(/\b\d{7}\b/g) || [];
    if (codeMatches.length > 5 && hasPercentages === 0) return "ARANCEL_CATALOG";

    const definitionSignals = ["definicion", "glosario", "condiciones generales", "nota", "articulo", "circular", "en virtud de", "se entendera por", "el presente", "se excluye", "exclusion", "restriccion"];
    const hasDefinitions = definitionSignals.some(s => text.includes(s));
    if (hasDefinitions && hasPercentages < 2 && coreCoverageHits === 0) return "DEFINITIONS_TEXT";

    const hasUfVa = /(\buf\b|u\.f\.|\bv\.?a\.?\b|\bvam\b|veces?\s+arancel(?:\s+masvida)?|sin\s+tope|copago)/i.test(text);
    const hasCoverageTerms = /(hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|urgenc|bonificaci|preferente|libre\s*elecci|tope)/i.test(text);
    const hasModalities = /(preferente|libre\s*elecci|bonificaci|tope|copago)/i.test(text);

    if (hasCoverageTerms && (hasPercentages >= 1 || hasUfVa)) return "COVERAGE_GRID";
    if (coreCoverageHits >= 1 && hasUfVa) return "COVERAGE_GRID";
    if (hasModalities && hasPercentages >= 1) return "COVERAGE_GRID";

    if (text.includes("tiempo") && text.includes("maximo") && (text.includes("entrega") || text.includes("respuesta") || text.includes("plazo") || text.includes("dias habiles"))) {
      return "SERVICE_LEVEL";
    }

    return "UNKNOWN";
  }

  private unknownLooksLikeCoverage(page: any): boolean {
    const text = this.normalizeForMatch((page.cells || []).map((c: any) => c.text).join(" "));
    const pct = (text.match(/%/g) || []).length;
    const ufVa = (text.match(/\buf\b|u\.f\.|\bv\.?a\.?\b|\bvam\b|veces?\s+arancel(?:\s+masvida)?|sin\s+tope|copago/g) || []).length;
    const core = (text.match(/hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|urgenc|uci|uti/g) || []).length;
    const modalities = (text.match(/preferente|libre\s*elecci|bonificaci|tope/g) || []).length;
    const meta = (text.match(/tipo de plan|tramos de edad|cotizantes|cargas|precio|equivalencia|factor de riesgo|firma de afiliado|huella dactilar/g) || []).length;

    if (meta >= 3 && core === 0 && modalities === 0 && ufVa === 0) return false;
    if (core >= 1 && (pct >= 1 || ufVa >= 1 || modalities >= 1)) return true;
    if (modalities >= 1 && (pct >= 1 || ufVa >= 1)) return true;
    if (ufVa >= 2 && pct >= 1) return true;
    if (core >= 2) return true;
    return false;
  }

  private pageHasFinancialSignals(page: any): boolean {
    const text = this.normalizeForMatch((page?.cells || []).map((c: any) => c?.text || '').join(' '));
    const pct = (text.match(/%/g) || []).length;
    const ufVa = (text.match(/\buf\b|u\.f\.|\bv\.?a\.?\b|\bvam\b|veces?\s+arancel(?:\s+masvida)?|sin\s+tope|copago/g) || []).length;
    return pct >= 1 || ufVa >= 1;
  }

  private pageLooksAdministrative(page: any): boolean {
    const text = this.normalizeForMatch((page?.cells || []).map((c: any) => c?.text || '').join(' '));
    const meta = (text.match(/tipo de plan|tramos de edad|cotizantes|cargas|precio|equivalencia|factor de riesgo|firma de afiliado|huella dactilar|tabla de factores|cotizacion legal/g) || []).length;
    const coverageCore = (text.match(/hospital|hospitalizaci|dia\s*cama|pabell|honorar|medicament|material|insumo|urgenc|preferente|libre\s*elecci/g) || []).length;
    const financial = this.pageHasFinancialSignals(page);
    return meta >= 1 && coverageCore === 0 && !financial;
  }

  private pageLooksHospitalCoverage(page: any): boolean {
    const text = this.normalizeForMatch((page?.cells || []).map((c: any) => c?.text || '').join(' '));
    const hospitalSignals = /(hospital|hospitalizaci|dia\s*cama|pabell|medicament|material|insumo)/.test(text);
    const financialSignals = /(%|\buf\b|\bv\.?a\.?\b|\bvam\b|veces?\s+arancel(?:\s+masvida)?|sin\s+tope|tope|copago)/.test(text);
    return hospitalSignals && financialSignals;
  }

  private pageResultHasHospitalDetail(items: any[]): boolean {
    const coreAmbitos = new Set(['DIA_CAMA', 'PABELLON', 'MEDICAMENTOS', 'MATERIALES', 'HONORARIOS']);
    const present = new Set<string>();
    for (const item of (items || [])) {
      const amb = String(item?.ambito || '').toUpperCase();
      if (coreAmbitos.has(amb)) present.add(amb);
    }
    return present.size >= 2;
  }

  private isPlaceholderItem(item: any): boolean {
    const name = this.normalizeForMatch(String(item?.item || ''));
    const amb = String(item?.ambito || '').toUpperCase();
    const badName = /^(unknown(\s+service)?|servicio\s+desconocido|item|n\/a|na|null|undefined|unknown)$/;
    if (badName.test(name)) return true;
    if (amb === 'OTROS' && /^(unknown|unknown service|servicio desconocido)$/.test(name)) return true;
    return false;
  }

  private pruneWeakCoverageItems(items: any[], warnings: any[], page: number): any[] {
    const filtered = (items || []).filter((it: any) => !this.isPlaceholderItem(it));
    const removed = (items || []).length - filtered.length;
    if (removed > 0) {
      warnings.push({
        type: 'PLACEHOLDER_ITEMS_FILTERED',
        detail: `Se removieron ${removed} item(s) placeholder/no confiables en pagina ${page}.`
      });
    }
    return filtered;
  }

  private pageResultLooksWeak(items: any[]): boolean {
    const arr = items || [];
    if (arr.length === 0) return true;
    const cleaned = arr.filter((it: any) => !this.isPlaceholderItem(it));
    if (cleaned.length === 0) return true;
    const allOtros = cleaned.every((it: any) => String(it?.ambito || '').toUpperCase() === 'OTROS');
    const noFinancialRules = cleaned.every((it: any) => {
      const rules = [...(it?.preferente?.rules || []), ...(it?.libre_eleccion?.rules || [])];
      return rules.every((r: any) => {
        const u1 = String(r?.tope_evento?.unidad || '').toUpperCase();
        const u2 = String(r?.tope_anual?.unidad || '').toUpperCase();
        return !['UF', 'VA', 'VAM', 'SIN_TOPE'].includes(u1) && !['UF', 'VA', 'VAM', 'SIN_TOPE'].includes(u2);
      });
    });
    return allOtros || noFinancialRules;
  }

  private ruleKey(rule: any): string {
    return [
      String(rule?.subred_id || ''),
      String(rule?.porcentaje ?? ''),
      String(rule?.tope_evento?.estado || ''),
      String(rule?.tope_evento?.valor ?? ''),
      String(rule?.tope_evento?.unidad || ''),
      String(rule?.tope_anual?.estado || ''),
      String(rule?.tope_anual?.valor ?? ''),
      String(rule?.tope_anual?.unidad || ''),
      String(rule?.copago_fijo?.valor ?? ''),
      String(rule?.copago_fijo?.unidad ?? '')
    ].join('|');
  }

  private mergeRuleArrays(baseRules: any[], extraRules: any[]): any[] {
    const out: any[] = [...(baseRules || [])];
    const seen = new Set(out.map((r: any) => this.ruleKey(r)));
    for (const r of (extraRules || [])) {
      const key = this.ruleKey(r);
      if (seen.has(key)) continue;
      out.push(r);
      seen.add(key);
    }
    return out;
  }

  private mergeCoverageItems(baseItems: any[], extraItems: any[]): any[] {
    const merged: any[] = [...(baseItems || [])];
    const keyOf = (item: any) => `${String(item?.ambito || '').toUpperCase()}|${this.normalizeForMatch(String(item?.item || ''))}`;

    for (const extra of (extraItems || [])) {
      const key = keyOf(extra);
      const idx = merged.findIndex((m) => keyOf(m) === key);
      if (idx === -1) {
        merged.push(extra);
        continue;
      }

      const target = merged[idx];
      target.preferente = target.preferente || { rules: [] };
      target.libre_eleccion = target.libre_eleccion || { rules: [] };
      target.preferente.rules = this.mergeRuleArrays(target.preferente.rules, extra?.preferente?.rules || []);
      target.libre_eleccion.rules = this.mergeRuleArrays(target.libre_eleccion.rules, extra?.libre_eleccion?.rules || []);
      merged[idx] = target;
    }

    return merged;
  }

  private pruneHospitalBlockHeaders(items: any[]): any[] {
    const hasDetailedHospital = this.pageResultHasHospitalDetail(items || []);
    if (!hasDetailedHospital) return items || [];

    return (items || []).filter((item: any) => {
      const amb = String(item?.ambito || '').toUpperCase();
      const title = this.normalizeForMatch(String(item?.item || ''));
      const isBlockHeader = amb === 'OTROS' && /(hospitalarias?|cirugia\s+mayor\s+ambulatoria|hospitalari|cma)/.test(title);
      return !isBlockHeader;
    });
  }

  private shouldForceHospitalSemanticMerge(page: any, pageResult: any): boolean {
    if (!this.pageLooksHospitalCoverage(page)) return false;
    const hasNoGridLinesIssue = (page?.issues || []).some((i: any) => String(i.code || '').toUpperCase() === 'NO_GRID_LINES');
    const items = pageResult?.items || [];
    const hasHospitalDetail = this.pageResultHasHospitalDetail(items);
    const hasOnlyGenericHospitalBlock = items.some((it: any) => {
      const amb = String(it?.ambito || '').toUpperCase();
      const title = this.normalizeForMatch(String(it?.item || ''));
      return amb === 'OTROS' && /(hospitalarias?|cirugia\s+mayor\s+ambulatoria|hospitalari|cma)/.test(title);
    });

    return hasNoGridLinesIssue || !hasHospitalDetail || hasOnlyGenericHospitalBlock;
  }

  private shouldApplySemanticFallback(page: any, pageResult: any): boolean {
    const warningTypes = new Set((pageResult?.warnings || []).map((w: any) => String(w.type || '').toUpperCase()));
    const hasFatalExtractionWarning =
      warningTypes.has('PAGE_FAILURE') ||
      warningTypes.has('MISSING_HEADERS') ||
      warningTypes.has('INVALID_HEADERS');
    const hasNoGridLinesIssue = (page?.issues || []).some((i: any) => String(i.code || '').toUpperCase() === 'NO_GRID_LINES');
    const noStructuredOutput =
      (!(pageResult?.items) || pageResult.items.length === 0) &&
      (!(pageResult?.service_levels) || pageResult.service_levels.length === 0);

    return noStructuredOutput && (hasFatalExtractionWarning || hasNoGridLinesIssue);
  }

  async auditLayout(
    layoutDoc: LayoutGridDoc,
    anchors: string[] = []
  ): Promise<AuditorBResult> {
    this.log(`Iniciando auditoria semantica iterativa (${layoutDoc?.doc?.pages?.length || 0} paginas)...`);

    if (!layoutDoc || !layoutDoc.doc || !layoutDoc.doc.pages || layoutDoc.doc.pages.length === 0) {
      this.log('Error: layoutDoc structure is invalid or missing pages.');
      throw new Error('Invalid layoutDoc structure: doc.pages is missing.');
    }

    const allItems: any[] = [];
    const allWarnings: any[] = [];
    const allServiceLevels: any[] = [];
    const detectedSchemaByPage: Record<number, any> = {};
    let lastDetectedSchema: any = null;

    for (const page of layoutDoc.doc.pages) {
      this.log(`Analizando pagina ${page.page}...`);
      const tableType = this.classifyTableHard(page);
      this.log(`Clasificacion determinista: ${tableType}`);

      if (
        tableType === 'FACTOR_TABLE' ||
        tableType === 'ARANCEL_CATALOG' ||
        tableType === 'DEFINITIONS_TEXT' ||
        tableType === 'WAIT_TIMES_TABLE'
      ) {
        this.log(`Saltando pagina ${page.page} (tipo ${tableType})`);
        continue;
      }

      let pageResult: any;

      if (tableType === 'UNKNOWN') {
        const unknownLooksCoverage = this.unknownLooksLikeCoverage(page);
        const looksAdministrative = this.pageLooksAdministrative(page);

        if (!looksAdministrative) {
          this.log('Tabla UNKNOWN no administrativa: intento LLM con fallback.');
          pageResult = await this.auditSinglePage(page, lastDetectedSchema, anchors);

          const needsSemanticMerge =
            this.shouldApplySemanticFallback(page, pageResult) ||
            ((pageResult?.items || []).length === 0 && (unknownLooksCoverage || this.pageHasFinancialSignals(page) || this.pageLooksHospitalCoverage(page))) ||
            this.pageResultLooksWeak(pageResult?.items || []);

          if (needsSemanticMerge) {
            const fallbackResult = this.semanticFallbackFromPage(page, {
              hospitalFirst: true,
              allowServiceLevels: true
            });
            pageResult = {
              ...pageResult,
              items: [...(pageResult.items || []), ...(fallbackResult.items || [])],
              service_levels: [...(pageResult.service_levels || []), ...(fallbackResult.service_levels || [])],
              warnings: [...(pageResult.warnings || []), ...(fallbackResult.warnings || [])]
            };
          }
        } else {
          this.log('Tabla UNKNOWN administrativa: fallback semantico directo (sin LLM).');
          pageResult = this.semanticFallbackFromPage(page, { hospitalFirst: true, allowServiceLevels: false });
          pageResult.warnings = [
            ...(pageResult.warnings || []),
            {
              type: 'UNKNOWN_TABLE_SEMANTIC_ONLY',
              detail: `Pagina ${page.page} procesada sin LLM por clasificacion UNKNOWN.`
            }
          ];
        }
      } else {
        this.log(`Iniciando auditoria semantica en pagina ${page.page}...`);
        pageResult = await this.auditSinglePage(page, lastDetectedSchema, anchors);

        if (this.shouldApplySemanticFallback(page, pageResult)) {
          this.log(`Activando fallback semantico en pagina ${page.page}...`);
          const fallbackResult = this.semanticFallbackFromPage(page, {
            hospitalFirst: tableType !== 'SERVICE_LEVEL',
            allowServiceLevels: true
          });
          pageResult = {
            ...pageResult,
            items: [...(pageResult.items || []), ...(fallbackResult.items || [])],
            service_levels: [...(pageResult.service_levels || []), ...(fallbackResult.service_levels || [])],
            warnings: [...(pageResult.warnings || []), ...(fallbackResult.warnings || [])]
          };
        }

        if (tableType === 'SERVICE_LEVEL') {
          pageResult.items = [];
        }
      }

      if (tableType !== 'SERVICE_LEVEL' && this.shouldForceHospitalSemanticMerge(page, pageResult)) {
        const forcedHospitalFallback = this.semanticFallbackFromPage(page, {
          hospitalFirst: true,
          allowServiceLevels: false
        });
        if ((forcedHospitalFallback.items || []).length > 0) {
          pageResult = {
            ...pageResult,
            items: this.mergeCoverageItems(pageResult.items || [], forcedHospitalFallback.items || []),
            warnings: [
              ...(pageResult.warnings || []),
              ...(forcedHospitalFallback.warnings || []),
              {
                type: 'HOSPITAL_SEMANTIC_MERGE_APPLIED',
                detail: `Merge hospitalario semantico aplicado en pagina ${page.page}.`
              }
            ]
          };
          pageResult.items = this.pruneHospitalBlockHeaders(pageResult.items || []);
        }
      }

      pageResult.warnings = Array.isArray(pageResult.warnings) ? pageResult.warnings : [];
      pageResult.items = this.filterHeaderArtifactsFromItems(
        page,
        pageResult.items || [],
        pageResult.detectedSchema || lastDetectedSchema || {},
        pageResult.warnings,
        page.page
      );
      pageResult.items = this.pruneWeakCoverageItems(pageResult.items || [], pageResult.warnings, page.page);

      if (
        tableType !== 'SERVICE_LEVEL' &&
        this.pageResultLooksWeak(pageResult.items || []) &&
        (this.pageHasFinancialSignals(page) || this.pageLooksHospitalCoverage(page))
      ) {
        const forcedFallback = this.semanticFallbackFromPage(page, {
          hospitalFirst: true,
          allowServiceLevels: true
        });
        pageResult = {
          ...pageResult,
          items: this.mergeCoverageItems(pageResult.items || [], forcedFallback.items || []),
          service_levels: [...(pageResult.service_levels || []), ...(forcedFallback.service_levels || [])],
          warnings: [
            ...(pageResult.warnings || []),
            ...(forcedFallback.warnings || []),
            {
              type: 'WEAK_OUTPUT_SEMANTIC_MERGE',
              detail: `Merge semantico por salida debil aplicado en pagina ${page.page}.`
            }
          ]
        };
        pageResult.items = this.pruneWeakCoverageItems(pageResult.items || [], pageResult.warnings, page.page);
      }

      if (pageResult.items && pageResult.items.length > 0) {
        allItems.push(...pageResult.items);
        this.log(`Pagina ${page.page}: ${pageResult.items.length} items extraidos.`);
      }

      if (pageResult.service_levels && pageResult.service_levels.length > 0) {
        allServiceLevels.push(...pageResult.service_levels);
        this.log(`Pagina ${page.page}: ${pageResult.service_levels.length} service levels extraidos.`);
      }

      if (pageResult.detectedSchema && !detectedSchemaByPage[page.page]) {
        detectedSchemaByPage[page.page] = pageResult.detectedSchema;
        lastDetectedSchema = pageResult.detectedSchema;
        this.log(`Esquema de columnas detectado en pagina ${page.page}.`);
      }

      if (pageResult.warnings) {
        allWarnings.push(...pageResult.warnings.map((w: any) => ({
          ...w,
          detail: `[Pag ${page.page}] ${w.detail}`
        })));
      }
    }

    this.log(`Auditoria completada. Total items: ${allItems.length}`);

    let lastValidItem: any = null;
    const itemsToKeep: any[] = [];

    for (const item of allItems) {
      const itemName = String(item?.item || '').trim().toLowerCase();
      const isOrphan = !itemName || itemName === 'unknown' || itemName === 'item';

      if (isOrphan) {
        if (lastValidItem && item.ambito === lastValidItem.ambito) {
          if (item.preferente?.rules) {
            item.preferente.rules.forEach((r: any) => {
              lastValidItem.preferente.rules.push({ ...r, attached_by: 'BLOCK_SPAN_BACKFILL' });
            });
          }
          if (item.libre_eleccion?.rules) {
            item.libre_eleccion.rules.forEach((r: any) => {
              lastValidItem.libre_eleccion.rules.push({ ...r, attached_by: 'BLOCK_SPAN_BACKFILL' });
            });
          }
          continue;
        }
      } else {
        lastValidItem = item;
      }

      itemsToKeep.push(item);
    }

    const sanitized = this.sanitizeFinancialVsServiceLevels(itemsToKeep, allServiceLevels, allWarnings);
    const unitsFound = new Set<string>();
    for (const it of (sanitized.items || [])) {
      for (const r of [...(it?.preferente?.rules || []), ...(it?.libre_eleccion?.rules || [])]) {
        if (r?.tope_evento?.unidad) unitsFound.add(String(r.tope_evento.unidad).toUpperCase());
        if (r?.tope_anual?.unidad) unitsFound.add(String(r.tope_anual.unidad).toUpperCase());
      }
    }
    this.log(`UNITS FOUND: ${Array.from(unitsFound).join(', ') || '(none)'}`);
    const hospitalCorePresent = this.hasHospitalCore(sanitized.items);
    this.log(`hospitalCorePresent=${hospitalCorePresent}`);
    const normalizedDocText = this.normalizeForMatch(
      layoutDoc.doc.pages
        .map((p: any) => (p.cells || []).map((c: any) => c.text || '').join(' '))
        .join(' ')
    );
    const expectsHospitalCore = /(hospital|hospitalizaci|dia\s*cama|pabell|material|insumo|medicament)/.test(normalizedDocText);

    const docMeta: Record<string, any> = {
      docId: layoutDoc.doc.docId,
      source: 'contract_audit_topology',
      totalPages: layoutDoc.doc.pages.length,
      allowFinancialAudit: true
    };

    let finalItems = sanitized.items;
    let finalWarnings = sanitized.warnings;

    if (expectsHospitalCore && !hospitalCorePresent) {
      docMeta.estado = 'INCOMPLETO_POR_EXTRACCION';
      docMeta.motivo = 'FALTA_BLOQUE_HOSPITALARIO';
      docMeta.allowFinancialAudit = false;
      finalWarnings = [
        ...finalWarnings,
        {
          type: 'HOSPITAL_CORE_MISSING',
          detail: 'Gate HOSPITAL_CORE_PRESENT fallo: faltan items hospitalarios core con tope UF/VA. Se bloquea salida financiera.'
        }
      ];
      this.log('Gate HOSPITAL_CORE_PRESENT: fallo. allowFinancialAudit=false, se mantienen items para trazabilidad.');
    }

    return {
      docMeta,
      detectedSchema: Object.keys(detectedSchemaByPage).length > 0 ? detectedSchemaByPage : null,
      service_levels: sanitized.serviceLevels,
      items: finalItems,
      warnings: finalWarnings
    };
  }

  private async auditSinglePage(
    page: any,
    suggestedSchema: any,
    anchors: string[]
  ): Promise<any> {
    // OPTIMIZATION: Remove tokens to save context window
    const optimizedPage = {
      ...page,
      cells: (page.cells || []).map((cell: any) => {
        const { tokens, ...rest } = cell;
        return rest;
      }),
      grid: {
        ...(page.grid || {}),
        rectangles: page.grid?.rectangles || []
      }
    };

    // Pre-compute explicit cellId whitelist for anti-hallucination
    const validCellIds = (page.cells || []).map((c: any) => c.cellId).filter(Boolean);

    const prompt = `
YOU ARE A CONTRACT AUDITOR.
You are processing PAGE ${page.page} of a medical contract.
Your task: Extract EVERY single row from the provided table topology into structured JSON.

DEFINITIONS:
- V.A / VA = "NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºmero de veces el valor asignado a cada prestaciÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³n en el arancel".
- UF = Unidad de Fomento.
- "Sin Tope" ONLY exists if explicitly stated.
- "Tope por evento" = item ceiling.
- "Tope anual" = max ceiling per year.
- Extraction discipline = geometry first. If a value is not explicitly visible in the row band or merged-cell span, keep it as UNKNOWN.

CONTEXT:
${suggestedSchema ? `Suggested Column Schema (use these IDs if they match): ${JSON.stringify(suggestedSchema)}` : "No schema suggested yet. Identify headers first."}
Anchors: ${JSON.stringify(anchors)}

TASK:
1) Identify the role of each column (Item, %, Ceiling, etc.).
2) For EVERY row that represents a medical service, extract its data.
3) Inclusion Rule: Extract all rows that are actual medical coverages/services with financial coverage signals.
4) Exclude headers, categories, definitions and administrative metadata rows.
5) Response MUST be valid JSON matching this schema:
{
  "detectedSchema": {
    "item_col": "EXTRACT EXACT cellId FROM TOPOLOGY (e.g. p1_c_0_0) | null",
    "preferente_pct_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null",
    "preferente_tope_evento_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null",
    "preferente_tope_anual_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null",
    "libre_pct_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null",
    "libre_tope_evento_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null",
    "libre_tope_anual_col": "EXTRACT EXACT cellId FROM TOPOLOGY | null"
  },
  "items": [
    {
      "ambito": "DIA_CAMA|PABELLON|HONORARIOS|MEDICAMENTOS|MATERIALES|EXAMENES|PROTESIS|QUIMIOTERAPIA|URGENCIA|AMBULATORIO|OTROS",
      "item": "string",
      "preferente": {
        "rules": [
          {
            "subred_id": "PREF_TIER_1|PREF_TIER_2|LIBRE_ELECCION|string",
            "condiciones": ["MEDICOS_STAFF", "VENTA_BONO", "INSTITUCIONAL", "string"],
            "porcentaje": number|null,
            "clinicas": ["string"],
            "tope_evento": { 
                "estado": "CON_TOPE|SIN_TOPE_ITEM|SUB_LIMITE", 
                "valor": number|null, 
                "unidad": "UF|VA|SIN_TOPE|UNKNOWN", 
                "tipo": "TOPE_BONIFICACION|COPAGO_FIJO",
                "sujeto_tope_general_anual": boolean 
            },
            "tope_anual": { 
                "estado": "CON_TOPE|SIN_TOPE_ITEM|UNKNOWN", 
                "valor": number|null, 
                "unidad": "UF|VA|SIN_TOPE|UNKNOWN" 
            },
            "copago_fijo": { "valor": number, "unidad": "UF|CLP" } | null,
            "evidence": { "page": ${page.page}, "cells": [ { "cellId": "string", "text": "string" } ] }
          }
        ]
      },
      "libre_eleccion": {
        "rules": [
          {
            "subred_id": "LIBRE_ELECCION",
            "condiciones": [],
            "porcentaje": number|null,
            "clinicas": ["string"],
            "tope_evento": { 
                "estado": "CON_TOPE|SIN_TOPE_ITEM", 
                "valor": number|null, 
                "unidad": "UF|VA|SIN_TOPE|UNKNOWN", 
                "tipo": "TOPE_BONIFICACION",
                "sujeto_tope_general_anual": boolean 
            },
            "tope_anual": { 
                "estado": "CON_TOPE|SIN_TOPE_ITEM|UNKNOWN", 
                "valor": number|null, 
                "unidad": "UF|VA|SIN_TOPE|UNKNOWN" 
            },
            "copago_fijo": { "valor": number, "unidad": "UF|CLP" } | null,
            "evidence": { "page": ${page.page}, "cells": [ { "cellId": "string", "text": "string" } ] }
          }
        ]
      }
    }
  ],
  "service_levels": [
    {
      "item": "string",
      "valor": number,
      "unidad": "DIAS|HORAS|PERCENT",
      "evidence": { "page": ${page.page}, "cells": [ { "cellId": "string", "text": "string" } ] }
    }
  ],
  "warnings": [
    {
      "type": "string",
      "detail": "string"
    }
  ]
}

CRITICAL HARD CONSTRAINTS:
1. DO NOT INVENT cellIds under any circumstances.
2. DO NOT invent cellIds. Use only cellIds present inside INPUT TOPOLOGY.
3. Search the 'text' of the cells to find the headers, then use the EXACT 'cellId' corresponding to that text.
4. If a column header does not exist, use null.
5. The 'warnings' array must strictly contain objects with 'type' and 'detail' string properties. Do not return arrays of characters or strings.
6. For "ambito", use the MOST SPECIFIC value: DIA_CAMA for beds, PABELLON for surgical rooms, HONORARIOS for doctor fees, MEDICAMENTOS for drugs, MATERIALES for clinical supplies, EXAMENES for lab/imaging, PROTESIS for prosthetics, QUIMIOTERAPIA for chemo, URGENCIA for emergency, AMBULATORIO for outpatient. Use OTROS only if no specific match.

SPECIAL RULES:
- V.A / VA / Veces Arancel -> NORMALIZAR SIEMPRE A "VA".
- Copago Fijo (Urgencia) -> Mapear a "copago_fijo" y poner "tipo": "COPAGO_FIJO" en el tope.
- Empty Cells (-) -> "UNKNOWN", nunca "SIN_TOPE".
- Merged Cells & Spatial Index -> Use "spatialIndex" to see which row range a merged cell spans. If a cell spans rows 5-10, APPLY ITS RULES TO ALL ITEMS IN ROWS 5-10.
- Propagation discipline -> Only propagate when the merged-cell span or topology makes the propagation visually defensible.
- No silent completion -> If a tope anual is not explicitly visible for the row or merged block, keep estado "UNKNOWN".
- No contract-wide assumptions -> Do not assume "Sin Tope" or annual limits from general contract knowledge. Use page evidence only.
- Multi-Percentage Blocks -> If a preferente block contains "100% DÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡vila, 90% Indisa", create TWO rules in the "rules" array.
- Rule Conditions extraction -> MUST look for text patterns in the cells:
    * "(MÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dicos Staff)" or "(Staff)" -> Add "MEDICOS_STAFF" to condiciones.
    * "(SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³lo con Bonos)" or "(Bono)" -> Add "VENTA_BONO" to condiciones.
    * "(SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³lo Institucional)" or "(En InstituciÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³n)" -> Add "INSTITUCIONAL" to condiciones.
- Subred Identification -> Assign subred_id like "PREF_TIER_1" for the highest coverage group, "PREF_TIER_2" for the next, and "LIBRE_ELECCION" for LE rules.
- "Sin Tope" Normalization ->
    * If cell says "Sin Tope", set estado: "SIN_TOPE_ITEM", valor: null, unidad: "SIN_TOPE".
    * If cell has a value (e.g., "5 UF"), set estado: "CON_TOPE", valor: 5, unidad: "UF".
    * TOPE ANUAL INFERENCE (A2): If tope_evento.estado is "SIN_TOPE_ITEM" and no specific annual limit/number is shown for that item, SET tope_anual.estado: "SIN_TOPE_ITEM" and unidad: "SIN_TOPE" by default.
    * sujeto_tope_general_anual: ALMOST ALWAYS TRUE for Isapre contracts, unless item explicitly says "No sujeto a tope general".
    * Override for M12 discipline: if no explicit annual value is visible in the row band or merged block, prefer estado "UNKNOWN" over inferred "SIN_TOPE_ITEM".
- Row-Band Projection -> To find the Libre ElecciÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³n limits (often on the far right), track the y0-y1 coordinates (the "Row Band") of the service item. Look for cells intersecting this Y-band on the right side.
- DETECTED SCHEMA -> "preferente_pct_col" and "preferente_tope_evento_col" MUST NOT BE THE SAME CELL. If a merged cell contains both % and Tope, leave the column identifiers as null.

INPUT TOPOLOGY (PAGE ${page.page}):
(Note: Use "spatialIndex" to resolve which cells belong to which rows and columns deterministically)
${JSON.stringify(optimizedPage)}
`;

    try {
      const responseText = await this.gemini.extractText(prompt, {
        responseMimeType: "application/json",
        temperature: 0.0,
        topP: 0.01
      });

      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch (rawParseErr) {
        const repaired = jsonrepair(responseText);
        parsed = JSON.parse(repaired);
      }

      // 1. Mandatory Header Anchoring & Anti-Collapse Check
      const schema = parsed.detectedSchema || {};
      let anchorCol = schema.item_col || schema.prestacion_col; // Fallback in case LLM uses the old name
      let hasBasicCols = !!anchorCol; // We only strictly need item_col to anchor the rows. % cols can be null if merged.
      const isCollapsed = schema.preferente_pct_col && schema.preferente_pct_col === schema.preferente_tope_evento_col;

      // Strict validation: Does the anchor cell actually exist in the page geometry?
      let anchorCellExists = page.cells && page.cells.some((c: any) => c.cellId === anchorCol);

      // Deterministic rescue: infer item_col from topology if missing/invalid.
      if (!hasBasicCols || !anchorCellExists) {
        const rescuedAnchor = this.inferItemColumnDeterministic(page, schema, suggestedSchema);
        if (rescuedAnchor) {
          anchorCol = rescuedAnchor;
          schema.item_col = rescuedAnchor;
          parsed.detectedSchema = schema;
          anchorCellExists = true;
          parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
          parsed.warnings.push({
            type: "ITEM_COL_RESCUED",
            detail: `item_col inferido deterministicamente como ${rescuedAnchor}`
          });
          this.log(`Rescate determinista: item_col=${rescuedAnchor} en pag ${page.page}.`);
        }
      }
      hasBasicCols = !!anchorCol;

      if (!hasBasicCols) {
        this.log(`Error: fallo anclaje en pag ${page.page}. El LLM no identifico item_col y el rescate no encontro columna valida.`);
        return {
          items: [],
          warnings: [{ type: "MISSING_HEADERS", detail: `No se identifico la celda cabecera de la columna de prestaciones. Schema devuelto: ${JSON.stringify(schema)}` }],
          detectedSchema: null
        };
      }

      if (anchorCol && !anchorCellExists) {
        this.log(`Error: fallo anclaje en pag ${page.page}. Celda ${anchorCol} no existe en geometria.`);
        return {
          items: [],
          warnings: [{ type: "INVALID_HEADERS", detail: `El LLM invento un ID de celda (${anchorCol}) que no existe en el Input Topology.` }],
          detectedSchema: null
        };
      }

      if (isCollapsed) {
        this.log(`Warning: schema collapse detectado en pagina ${page.page}. Corrigiendo a null.`);
        // If col collapsed, the LLM confused a merged data cell with a column header. Set to null.
        schema.preferente_pct_col = null;
        schema.preferente_tope_evento_col = null;
        parsed.detectedSchema = schema; // Push the fixed schema back to the parsed object tracking
        parsed.warnings = parsed.warnings || [];
        parsed.warnings.push({ type: "SCHEMA_COLLAPSE_FIXED", detail: "Columnas % y Tope apuntaban a la misma celda. Se corrigio a null." });
      }

      // 2. Fix Warning Serialization
      if (parsed.warnings && !Array.isArray(parsed.warnings)) {
        // If it's the "string-as-object" bug, convert to a single warning
        if (typeof parsed.warnings === 'object') {
          const vals = Object.values(parsed.warnings).join("");
          parsed.warnings = [{ type: "SERIALIZATION_FIX", detail: vals }];
        } else {
          parsed.warnings = [{ type: "GENERIC", detail: String(parsed.warnings) }];
        }
      }

      parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
      parsed.service_levels = Array.isArray(parsed.service_levels) ? parsed.service_levels : [];

      this.canonicalizeUnitsInItems(parsed.items);
      parsed.items = this.filterMetaItems(parsed.items, parsed.warnings, page.page);
      this.sanitizeEvidenceCellIds(parsed, validCellIds, page.page);
      this.applyRowBandProjection(page, parsed, schema);
      this.canonicalizeUnitsInItems(parsed.items);
      parsed.items = this.filterHeaderArtifactsFromItems(
        page,
        parsed.items || [],
        schema || {},
        parsed.warnings,
        page.page
      );

      return parsed;

    } catch (err) {
      this.log(`Error auditing page ${page.page}: ${err}`);
      return { items: [], warnings: [{ type: "PAGE_FAILURE", detail: String(err) }] };
    }
  }
}
