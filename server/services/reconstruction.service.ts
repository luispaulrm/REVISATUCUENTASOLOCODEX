
export interface RawCell {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  dir?: string;
  fontName?: string;
}

export interface RawRow {
  rowIndex: number;
  y: number;
  text: string;
  cells: RawCell[];
  isStitched?: boolean;
}

export interface ReconstructionOptions {
  yTolerance?: number;
  stitchEnabled?: boolean;
  traceId?: string;
}

type ReconstructableItem = {
  id: number | string;
  description: string;
  total: number;
  sectionCategory?: string;
  raw: any;
};

function parseAmountCLP(value: any): number {
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'string') {
    const parsed = parseInt(value.replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function flattenAccountItems(account: any, claimedItemIds: Set<number | string> = new Set()): ReconstructableItem[] {
  const sections = Array.isArray(account?.sections) ? account.sections : [];
  const items: ReconstructableItem[] = [];
  let fallbackId = 1;

  for (const section of sections) {
    const sectionItems = Array.isArray(section?.items) ? section.items : [];
    for (const item of sectionItems) {
      const id = item?.index ?? item?.id ?? fallbackId;
      fallbackId += 1;
      if (claimedItemIds.has(id)) continue;

      const total = parseAmountCLP(item?.total ?? item?.calculatedTotal ?? item?.amount);
      if (total <= 0) continue;

      items.push({
        id,
        description: String(item?.description || item?.name || item?.label || '').trim(),
        total,
        sectionCategory: String(section?.category || '').trim(),
        raw: item
      });
    }
  }

  return items;
}

function findExactSubset(items: ReconstructableItem[], target: number, maxItems = 28): ReconstructableItem[] | null {
  const candidates = items
    .filter((item) => item.total > 0 && item.total <= target)
    .slice(0, maxItems);
  const bySum = new Map<number, ReconstructableItem[]>();
  bySum.set(0, []);

  for (const item of candidates) {
    const snapshots = Array.from(bySum.entries());
    for (const [sum, subset] of snapshots) {
      const next = sum + item.total;
      if (next > target || bySum.has(next)) continue;
      const nextSubset = [...subset, item];
      if (next === target) return nextSubset;
      bySum.set(next, nextSubset);
    }
  }

  return null;
}

function buildReconstructionRationale(originalRationale: string, items: ReconstructableItem[], target: number): string {
  const detail = items
    .map((item) => `- ${item.description || 'Item sin descripcion'}: $${item.total.toLocaleString('es-CL')}`)
    .join('\n');
  const total = items.reduce((sum, item) => sum + item.total, 0);
  const intraop = items.some((item) => /pabell[oó]n|intraop|anest|fentan|propofol|rocuronio/i.test(`${item.sectionCategory} ${item.description}`));
  const normativeText = intraop
    ? '\n\nReclasificacion: medicacion intraoperatoria desagregada desde farmacia de pabellon; el cobro queda identificado por trazabilidad aritmetica y detalle de items.'
    : '';

  return [
    originalRationale || 'Opacidad detectada.',
    '',
    `DETALLE RECONSTRUIDO: suma exacta $${total.toLocaleString('es-CL')} contra monto observado $${target.toLocaleString('es-CL')}.`,
    detail,
    normativeText
  ].join('\n').trim();
}

export class ArithmeticReconstructor {
  static reconstructFinding(account: any, finding: any, claimedItemIds: Set<number | string> = new Set()): any {
    const target = parseAmountCLP(finding?.amount ?? finding?.montoObjetado);
    if (target <= 0) return finding;

    const items = flattenAccountItems(account, claimedItemIds);
    const subset = findExactSubset(items, target);
    if (!subset) return finding;

    for (const item of subset) {
      claimedItemIds.add(item.id);
    }

    return {
      ...finding,
      category: 'A',
      categoria: 'A',
      action: finding?.action === 'SOLICITAR_ACLARACION' ? 'OBJETAR_COBRO' : finding?.action,
      label: /Identificado Forense/i.test(String(finding?.label || ''))
        ? finding.label
        : `${finding?.label || 'Cobro opaco'} - Identificado Forense`,
      rationale: buildReconstructionRationale(String(finding?.rationale || ''), subset, target),
      evidenceRefs: [
        ...(Array.isArray(finding?.evidenceRefs) ? finding.evidenceRefs : []),
        ...subset.map((item) => `ITEM INDEX: ${item.id} ${item.description}`.trim())
      ],
      reconstructedItems: subset.map((item) => ({
        id: item.id,
        description: item.description,
        total: item.total,
        sectionCategory: item.sectionCategory
      }))
    };
  }

  static reconstructAll(account: any, findings: any[], claimedItemIds: Set<number | string> = new Set()): any[] {
    return findings.map((finding) => {
      const shouldReconstruct =
        finding?.category === 'Z' ||
        /PRESTACION NO CONTEMPLADA|GASTOS? NO CUBIERTO|OPAC/i.test(String(finding?.label || finding?.rationale || ''));
      return shouldReconstruct ? this.reconstructFinding(account, finding, claimedItemIds) : finding;
    });
  }
}

export function reconstructAllOpaque(
  account: any,
  findings: any[],
  claimedItemIds: Set<number | string> = new Set()
): any[] {
  return ArithmeticReconstructor.reconstructAll(account, findings, claimedItemIds);
}

export class ReconstructionService {
  /**
   * Reconstructs a logical grid of rows from raw PDF.js text items.
   * Based on the high-fidelity M13 reconstruction engine.
   */
  static reconstructPage(items: RawCell[], options: ReconstructionOptions = {}): RawRow[] {
    const yTolerance = options.yTolerance || 3.5;
    const groups: Array<{ y: number; ys: number[]; cells: RawCell[] }> = [];
    
    // 1. Group by Y tolerance (matching the refined logic in raw-extract)
    for (const cell of [...items].sort((a, b) => b.y - a.y)) {
      let matched = false;
      for (const group of groups) {
        if (Math.abs(cell.y - group.y) <= yTolerance) {
          group.cells.push(cell);
          group.ys.push(cell.y);
          group.y = group.ys.reduce((acc, val) => acc + val, 0) / group.ys.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        groups.push({ y: cell.y, ys: [cell.y], cells: [cell] });
      }
    }

    const rows: RawRow[] = groups
      .map((group, index) => {
        const ordered = [...group.cells].sort((a, b) => a.x - b.x);
        const text = ordered.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim();
        return {
          rowIndex: index + 1,
          y: group.y,
          text,
          cells: ordered
        };
      })
      .sort((a, b) => b.y - a.y); // Ensure top-to-bottom

    if (options.stitchEnabled !== false) {
      return this.stitchRows(rows, options.traceId);
    }

    return rows;
  }

  /**
   * Stitches misaligned rows (e.g. descriptions vs amounts) based on financial signals.
   * Essential for billing documents where text layers are often fractured.
   */
  private static stitchRows(rows: RawRow[], traceId?: string): RawRow[] {
    const resultRows: RawRow[] = [...rows];
    const traceLabel = traceId ? `[${traceId}] ` : '';

    for (let i = 0; i < resultRows.length; i++) {
        const currentRow = resultRows[i];
        const text = currentRow.text.toUpperCase();
        
        // Detection logic: Does this row look like it ONLY has financial data (amounts)?
        // Refined for Chilean bills: looking for VA, VAM, CLP signs or large numbers at the end
        const hasFinance = /[\d.]+/.test(text) && (text.includes('VA') || text.includes('VAM') || text.includes('$') || text.includes('%'));
        const labelLength = text.replace(/[\d.,$%\s/-]/g, '').length;
        const isOrphanFinance = hasFinance && labelLength < 4;

        if (isOrphanFinance && i > 0) {
            // Find a suitable label row above (search up to 2 rows back)
            let targetIdx = -1;
            for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
                const target = resultRows[j];
                const targetText = target.text.toUpperCase();
                const targetLabelLength = targetText.replace(/[\d.,$%\s/-]/g, '').length;
                const targetHasFinance = /[\d.]+/.test(targetText) && (targetText.includes('VA') || targetText.includes('VAM') || targetText.includes('$'));
                
                // If target has a good label but NO finance, it's the anchor
                if (targetLabelLength > 10 && !targetHasFinance) {
                    targetIdx = j;
                    break;
                }
            }

            if (targetIdx !== -1) {
                const targetRow = resultRows[targetIdx];
                if (traceId) console.log(`${traceLabel}[RECONSTRUCT] Stitching orphan finance "${currentRow.text}" -> "${targetRow.text}"`);
                
                targetRow.cells = [...targetRow.cells, ...currentRow.cells].sort((a, b) => a.x - b.x);
                targetRow.text = targetRow.cells.map(c => c.text).join(' ').trim();
                targetRow.isStitched = true;
                
                resultRows.splice(i, 1);
                i--;
            }
        }
    }

    return resultRows;
  }
}
