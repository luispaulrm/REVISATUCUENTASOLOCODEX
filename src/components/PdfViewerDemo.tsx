import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Database, Download, FileText, Link2, Rows3, ToggleLeft, ToggleRight, Trash2, Type, Upload } from 'lucide-react';
import PdfCalcoPage, { OverlayEntry, OverlayMode, TextClickPayload } from './PdfCalcoPage';
import BillAuditChat from './BillAuditChat';

type RowKind = 'header' | 'item' | 'footer' | 'unknown';
type RowTag = 'admin' | 'chargeLike' | 'unknown';

type NormalizedRow = {
  id: string;
  page: number;
  bbox: OverlayEntry['bbox'];
  text: string;
  source: 'native' | 'fallback' | 'azure' | 'ocr';
  confidence?: number;
  pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown';
  rowKind: RowKind;
  rowTag: RowTag;
  normalizedText: string;
  terms: string[];
};

type LogicalLine = {
  id: string;
  page: number;
  rowIds: string[];
  fullText: string;
  fullTextParts: string[];
  rowKind: RowKind;
  rowTag: RowTag;
  bbox: OverlayEntry['bbox'];
  moneyTokens: number[];
  mergeMethod: 'STITCH_YX_V1';
  mergeParams: {
    yTolerance: number;
    xJoinGap: number;
    minOverlap: number;
  };
  mergeScore: number;
  sourceUsed: Array<'native' | 'fallback' | 'azure' | 'ocr'>;
  parts: Array<{
    rowId: string;
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    source: 'native' | 'fallback' | 'azure' | 'ocr';
    rowTag: RowTag;
  }>;
  fields: {
    codigo?: string;
    fecha?: string;
    cantidad?: number;
    precioUnitario?: number;
    valor?: number;
    bonificacion?: number;
    copago?: number;
    otrosMontos?: number[];
    mergeCount?: number;
  };
  fieldsConfidence: {
    codigo: number;
    fecha: number;
    cantidad: number;
    precioUnitario: number;
    valor: number;
  };
};

type DerivedValuedLine = {
  id: string;
  page: number;
  logicalLineId: string;
  rowTag: RowTag;
  descriptionText: string;
  amountCandidates: number[];
  chosenAmount: number;
  chosenAmountReason: 'single_token' | 'rightmost_token' | 'max_token' | 'reconciliation_adjusted';
  rawText: string;
  bbox: OverlayEntry['bbox'];
  reconciliationAdjustment?: {
    from: number;
    to: number;
    delta: number;
    targetGapBefore: number;
  };
  trace: {
    rowIds: string[];
    mergeMethod: 'STITCH_YX_V1';
  };
};

type TokenType = 'moneyCandidate' | 'rutCandidate' | 'idCandidate' | 'dateCandidate' | 'qtyCandidate' | 'codeCandidate';

type SignalEntry = {
  page: number;
  rowId: string;
  text: string;
  tokens: Array<{
    raw: string;
    value: number;
    tokenType: TokenType;
  }>;
  reason: string;
};

type NormalizedBillItem = {
  index?: number;
  id: string;
  page: number;
  bbox: OverlayEntry['bbox'];
  description: string;
  total: number;
  code?: string;
  codeInternal?: string;
  date?: string;
  quantity?: number;
  unitPrice?: number;
  rawText: string;
  source: 'native' | 'fallback' | 'azure' | 'ocr';
  rowIds?: string[];
  trace?: {
    rowIds: string[];
    calcoVisible: boolean;
  };
  rowKind?: RowKind;
  rowTag?: RowTag;
  fields?: LogicalLine['fields'];
  fieldsConfidence?: LogicalLine['fieldsConfidence'];
};

type ItemAnomalyStatus = 'auto_fixed' | 'flagged' | 'excluded';
type ItemAnomalySeverity = 'low' | 'medium' | 'high';
type ItemAnomalyCategory =
  | 'negative_row'
  | 'placeholder_total'
  | 'zero_backed_amount'
  | 'devolution_applied'
  | 'reversal_applied'
  | 'structured_total_correction'
  | 'unbacked_total'
  | 'unit_total_mismatch';

type ItemAnomaly = {
  id: string;
  page: number;
  itemId?: string;
  code?: string;
  date?: string;
  description: string;
  rawText: string;
  status: ItemAnomalyStatus;
  severity: ItemAnomalySeverity;
  category: ItemAnomalyCategory;
  detail: string;
  originalTotal?: number;
  normalizedTotal?: number;
  evidence?: Partial<EmpresaLayoutColumnSums> & {
    quantity?: number;
    unitPrice?: number;
    expectedTotal?: number;
  };
};

type PayloadItemAnomaliesSummary = {
  total: number;
  autoFixed: number;
  flagged: number;
  excluded: number;
  high: number;
  medium: number;
  low: number;
};

type PayloadAuditFlags = {
  hasMathErrors: boolean;
  hasSectionMismatch: boolean;
  hasTaxConfusion: boolean;
  hasSuspiciousDuplicates: boolean;
  hasUnmappedItems: boolean;
  hasCompletenessGap: boolean;
};

type PayloadValidation = {
  isStrictAuditable: boolean;
  errors: string[];
  warnings: string[];
};

type PayloadGateStatus = 'PASS' | 'FAIL';

type PayloadGateResult = {
  gate: string;
  status: PayloadGateStatus;
  detail: string;
};

type PayloadPassFailResult = {
  overallStatus: PayloadGateStatus;
  summary: {
    specVersion: string;
    itemCount: number;
    strict: boolean;
    reconciliationStatus: string;
    gap: number;
    extracted: number;
    target: number;
    mathMismatch: number;
    codeCoveragePct: number;
    dateCoveragePct: number;
    quantityCoveragePct: number;
    unitPriceCoveragePct: number;
    residualAdjustmentLines: number;
    residualAdjustmentAmount: number;
  };
  gates: PayloadGateResult[];
};

type RawEvidencePage = {
  page: number;
  sourcesUsed: Array<'native' | 'fallback' | 'azure' | 'ocr'>;
  rows: Array<{
    id: string;
    page: number;
    bbox: OverlayEntry['bbox'];
    text: string;
    source: 'native' | 'fallback' | 'azure' | 'ocr';
    confidence?: number;
    rowTag: RowTag;
    numericTokens: number[];
  }>;
};

type EmpresaLayoutColumnSums = {
  itemTotal: number;
  valorBruto: number;
  exento: number;
  afecto: number;
  iva: number;
  valorIsa: number;
  empresa: number;
};

type EmpresaSubtotalDiagnosticGapSet = {
  itemTotal: number;
  valorBruto: number;
  valorIsa: number;
  empresa: number;
  afectoMasIva: number;
  exentoMasAfectoMasIva: number;
};

type EmpresaSubtotalDiagnosticClosestMetric =
  'itemTotal' | 'valorBruto' | 'valorIsa' | 'empresa' | 'afectoMasIva' | 'exentoMasAfectoMasIva';

type EmpresaSubtotalDiagnosticSection = {
  label: string;
  startPage: number;
  endPage: number;
  headerPage: number;
  headerText: string;
  itemCount: number;
  parsedItemCount: number;
  subtotalPage: number | null;
  subtotalText: string | null;
  targetSubtotal: number | null;
  sums: EmpresaLayoutColumnSums;
  gaps: EmpresaSubtotalDiagnosticGapSet | null;
  closestMetric: EmpresaSubtotalDiagnosticClosestMetric | null;
};

type EmpresaSubtotalDiagnosticBlock = {
  label: string;
  startPage: number;
  endPage: number;
  subtotalPage: number;
  subtotalText: string;
  targetSubtotal: number;
  itemCount: number;
  parsedItemCount: number;
  sums: EmpresaLayoutColumnSums;
  gaps: EmpresaSubtotalDiagnosticGapSet;
  closestMetric: EmpresaSubtotalDiagnosticClosestMetric;
  sections?: EmpresaSubtotalDiagnosticSection[];
};

type SantaMariaSubtotalDiagnosticSums = {
  itemTotal: number;
  codedItemTotal: number;
  codedLogicalLineTotal: number;
  missingCodedLineTotal: number;
};

type SantaMariaSubtotalDiagnosticGapSet = {
  itemTotal: number;
  codedItemTotal: number;
  codedLogicalLineTotal: number;
  missingCodedLineTotal: number;
};

type SantaMariaSubtotalDiagnosticClosestMetric =
  'itemTotal' | 'codedItemTotal' | 'codedLogicalLineTotal';

type SantaMariaSubtotalDiagnosticMissingLine = {
  lineId: string;
  page: number;
  code?: string;
  date?: string;
  amount: number;
  text: string;
  itemId?: string | null;
};

type SantaMariaSubtotalDiagnosticBlock = {
  label: string;
  subtotalKind: 'tipo' | 'centro';
  startPage: number;
  endPage: number;
  headerPage: number | null;
  headerText: string | null;
  subtotalPage: number;
  subtotalText: string;
  pairedSubtotalText?: string | null;
  targetSubtotal: number;
  itemCount: number;
  codedItemCount: number;
  codedLogicalLineCount: number;
  missingCodedLineCount: number;
  sums: SantaMariaSubtotalDiagnosticSums;
  gaps: SantaMariaSubtotalDiagnosticGapSet;
  closestMetric: SantaMariaSubtotalDiagnosticClosestMetric;
  missingCodedLines: SantaMariaSubtotalDiagnosticMissingLine[];
};

type NormalizedBillPayload = {
  specVersion: 'BILL_SPEC_v1' | 'BILL_SPEC_v2_TRANSPARENT';
  source: 'pdf-calco';
  generatedAt: string;
  scope: 'single-page' | 'all-pages';
  page: number;
  patientName?: string;
  clinicName?: string;
  date?: string;
  currency: 'CLP';
  isRenderable: boolean;
  isReconciled: boolean;
  isComplete: boolean;
  qualityFlags: PayloadAuditFlags;
  quality: {
    isStrict: boolean;
    errors: string[];
    warnings: string[];
    overExtractionPct?: number | null;
    underExtractionPct?: number | null;
    deadPages?: number[];
  };
  // Legacy aliases for compatibility with existing consumers.
  isAuditable: boolean;
  auditFlags: PayloadAuditFlags;
  validation: PayloadValidation;
  passFail?: PayloadPassFailResult;
  itemAnomalies: {
    summary: PayloadItemAnomaliesSummary;
    items: ItemAnomaly[];
  };
  raw: {
    pages: RawEvidencePage[];
  };
  derived: {
    logicalLines: LogicalLine[];
    valuedLines: DerivedValuedLine[];
  };
  signals: {
    rutLines: SignalEntry[];
    idLines: SignalEntry[];
    totalLines: SignalEntry[];
    subtotalLines: SignalEntry[];
    pamLines: SignalEntry[];
    noiseLines: SignalEntry[];
  };
  nonItems: Array<{
    page: number;
    rowId: string;
    text: string;
    reason: string;
    tokens: Array<{
      raw: string;
      value: number;
      tokenType: TokenType;
    }>;
  }>;
  chargeLines: DerivedValuedLine[];
  extractedLines: DerivedValuedLine[];
  rows: NormalizedRow[];
  logicalLines: LogicalLine[];
  pages: Record<string, { rows: NormalizedRow[]; logicalLineIds: string[]; valuedLineIds: string[]; itemIds: string[]; subtotal: number }>;
  items: NormalizedBillItem[];
  reconciliation?: {
    clinicDeclaredTotal: number;
    isapreDeclaredSubtotalSum: number;
    subtotalsDetected: number;
    gapVsClinicTotal: number | null;
    source: 'ocr-rows';
    declaredTotals?: {
      clinicTotalGeneral: { page: number; amount: number; text: string; detectedBy: 'same_row' | 'lookahead_1' | 'lookahead_2' | 'lookahead_3' } | null;
      subtotalsPorPrestador: Array<{ page: number; amount: number; text: string }>;
    };
    extractedTotals?: {
      sumChosenAmounts: number;
      sumFinalItemsTotal?: number;
      sumAllAmountCandidatesMax: number;
      valuedLinesCount: number;
    };
    gaps?: {
      gapVsClinicTotalGeneral: number | null;
    };
    deadPages?: number[];
    status?: 'OK' | 'INCOMPLETE' | 'NO_TOTAL_FOUND' | 'STRUCTURE_WEAK';
    totals?: {
      clinicDeclaredTotal: number;
      subtotalIsapreSum: number;
      itemsExtractedSum: number;
      expectedScope: 'bill-only' | 'full';
      targetDeclaredTotal?: number;
      targetDeclaredTotalSource?: 'billDeclaredTotal' | 'clinicTotalGeneral' | 'subtotalIsapreSum' | 'unknown';
      status: 'OK' | 'GAP' | 'OVER' | 'UNDER' | 'UNKNOWN';
    };
    boundarySignals?: {
      page: number;
      evidenceRows: Array<{ rowId: string; text: string }>;
    } | null;
    details?: {
      clinicTotalLine: { page: number; amount: number; text: string } | null;
      includedSubtotals: Array<{ page: number; amount: number; text: string }>;
      excludedSubtotals: Array<{ page: number; amount: number; reason: 'pam' | 'noise'; text: string }>;
      gapLikelyExplainedBy: Array<{ page: number; amount: number; reason: 'pam' | 'noise'; text: string }>;
      activeScope?: 'bill' | 'pam' | 'unknown';
      reconMode?: 'BILL' | 'PAM' | 'MIXED' | 'UNKNOWN';
      pamPages?: number[];
      billPages?: number[];
      billDeclaredTotal?: number;
      pamDeclaredTotal?: number;
      targetDeclaredTotal?: number;
      targetDeclaredTotalSource?: 'billDeclaredTotal' | 'clinicTotalGeneral' | 'subtotalIsapreSum' | 'unknown';
      gapAdjustment?: {
        applied: number;
        targetGapBefore: number;
        residualGapAfter: number;
        lines: Array<{
          lineId: string;
          page: number;
          from: number;
          to: number;
          delta: number;
          description: string;
        }>;
      };
      clinicTotalLineBill?: { page: number; amount: number; text: string } | null;
      clinicTotalLinePam?: { page: number; amount: number; text: string } | null;
      includedSubtotalsBill?: Array<{ page: number; amount: number; text: string }>;
      includedSubtotalsPam?: Array<{ page: number; amount: number; text: string }>;
      billSubtotalSum?: number;
      pamSubtotalSum?: number;
      billItemsTotal?: number;
      pamTotalGeneral?: number;
      billBoundaryPage?: number | null;
      itemsScope?: 'full' | 'bill-only';
      extractedItemsTotal?: number;
      deadPages?: number[];
      deadPagesDetailed?: Array<{
        page: number;
        reason: 'NO_TEXT' | 'FILTERED_OUT' | 'LAYOUT_TABLE';
        rawRowsCount: number;
        heurRowsCount: number;
        moneyTokenRowsCount: number;
        itemCandidateCount: number;
      }>;
      subtotalDiagnostics?:
        | {
          mode: 'empresa-layout';
          blocks: EmpresaSubtotalDiagnosticBlock[];
        }
        | {
          mode: 'santa-maria-layout';
          blocks: SantaMariaSubtotalDiagnosticBlock[];
        };
      clinicGapVsItemsTotal?: number | null;
      isCompleteAgainstClinicTotal?: boolean;
    };
  };
};

type RawExtractResponse = {
  patientName?: string;
  clinicName?: string;
  date?: string;
  sections?: Array<{
    category?: string;
    items?: Array<{
      index?: number;
      rawPage?: number;
      description?: string;
      quantity?: number;
      unitPrice?: number;
      total?: number;
      rawY?: number;
      rawOcrDetail?: boolean;
    }>;
  }>;
  raw?: {
    pages?: Array<{
      pageNumber: number;
      width: number;
      height: number;
      ocrSource?: 'azure-layout' | 'openai-ocr' | 'native-textlayer' | 'unknown';
      pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown';
      pageClassConfidence?: number;
      pageClassReason?: string;
      rows?: Array<{ rowIndex: number; y: number; text: string }>;
      items?: Array<{ text: string; x: number; y: number; width?: number; height?: number }>;
    }>;
  };
};

const PASS_FAIL_THRESHOLD = 0.99;

const RAW_TIMEOUT_MS = 110000;
const RAW_STATUS_TICK_MS = 1000;
const RAW_ITEM_MIN_TOTAL = 100;
const RAW_ITEM_MAX_TOTAL = 20000000;
const RAW_NUMBER_TOKEN_RE = /-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;

const normalize = (value: string): string => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const terms = (value: string): string[] => [...new Set(normalize(value).replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2))];

const normalizeDenseNumericText = (value: string): string => {
  let text = String(value || '');
  for (let i = 0; i < 8; i += 1) {
    const next = text
      .replace(/(\d{1,3}[.,]\d{3})(\d{1,3}[.,]\d{3})(?![\d.,])/g, '$1 $2')
      .replace(/(\d{1,3}[.,]\d{3})(\d{1,3}[.,]\d{3}\b)/g, '$1 $2')
      .replace(/(\d{1,3}[.,]\d{3})(\d{1,3}[.,]\d{3}[.,]\d{3})(?![\d.,])/g, '$1 $2');
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, ' ').trim();
};

const CLINICAL_DATE_RE = /(\d{2}[/-]\d{2}[/-]\d{4})/;

const findClinicalDateMatch = (value: string): RegExpMatchArray | null =>
  String(value || '').match(CLINICAL_DATE_RE);

const parseMoney = (raw: string): number => {
  const cleaned = String(raw || '').replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return 0;
  if (cleaned.includes('.')) {
    const n = Number(cleaned.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    const n = Number(parts.length > 1 && parts[parts.length - 1].length === 3 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const parseStructuredQuantityToken = (raw: string): number => {
  const cleaned = String(raw || '').replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return 0;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  const unsigned = sign < 0 ? cleaned.slice(1) : cleaned;

  const groupedMatch = unsigned.match(/^(\d+)[.,](\d{3})$/);
  if (groupedMatch) {
    const whole = Number(groupedMatch[1] || 0);
    const fraction = String(groupedMatch[2] || '');
    if (fraction === '000') return sign * whole;
    if (whole === 0) {
      const fractional = Number(`0.${fraction}`);
      return Number.isFinite(fractional) ? sign * fractional : 0;
    }
  }

  const normalized = unsigned.replace(',', '.');
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return sign * direct;

  const integerFallback = Number(unsigned.replace(/[^\d]/g, ''));
  return Number.isFinite(integerFallback) ? sign * integerFallback : 0;
};

const hasFieldValue = (value: unknown): boolean => value !== null && value !== undefined && String(value).trim() !== '';
const coveragePct = (numerator: number, denominator: number): number => (denominator <= 0 ? 0 : numerator / denominator);
const formatCoveragePct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const countPayloadMathMismatches = (items: NormalizedBillPayload['items'] = []): number =>
  (items || []).filter((item) => {
    const quantity = Number(item.quantity ?? item.fields?.cantidad ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0);
    const total = Math.round(Number(item.total || 0));
    if (!(quantity > 0 && unitPrice > 0 && total > 0)) return false;
    const expected = Math.round(quantity * unitPrice);
    return Math.abs(expected - total) > Math.max(100, expected * 0.2);
  }).length;

const evaluatePayloadPassFail = (
  payload: Pick<NormalizedBillPayload, 'specVersion' | 'quality' | 'reconciliation' | 'items'>
): PayloadPassFailResult => {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const itemCount = items.length;
  const strict = Boolean(payload.quality?.isStrict);
  const reconStatus = String(payload.reconciliation?.status || 'UNKNOWN');
  const gap = Math.round(Number(payload.reconciliation?.gaps?.gapVsClinicTotalGeneral || 0));
  const extracted = Math.round(Number(payload.reconciliation?.totals?.itemsExtractedSum || 0));
  const target = Math.round(Number(payload.reconciliation?.totals?.targetDeclaredTotal || 0));

  const withCode = items.filter((item) => hasFieldValue(item.code) || hasFieldValue(item.fields?.codigo)).length;
  const withDate = items.filter((item) => hasFieldValue(item.date) || hasFieldValue(item.fields?.fecha)).length;
  const withQty = items.filter((item) => Number(item.quantity ?? item.fields?.cantidad ?? 0) > 0).length;
  const withUnit = items.filter((item) => Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0) > 0).length;
  const mathMismatch = countPayloadMathMismatches(items);
  const residualAdjustmentLines = Number(payload.reconciliation?.details?.gapAdjustment?.applied || 0);
  const residualAdjustmentAmount = Math.round(
    Number(
      (payload.reconciliation?.details?.gapAdjustment?.lines || []).reduce(
        (acc, line) => acc + Math.abs(Number(line.delta || 0)),
        0
      )
    )
  );

  const codePct = coveragePct(withCode, itemCount);
  const datePct = coveragePct(withDate, itemCount);
  const qtyPct = coveragePct(withQty, itemCount);
  const unitPct = coveragePct(withUnit, itemCount);

  const gates: PayloadGateResult[] = [
    {
      gate: 'strict_quality',
      status: strict ? 'PASS' : 'FAIL',
      detail: `quality.isStrict=${strict}`
    },
    {
      gate: 'reconciliation_exact',
      status: reconStatus === 'OK' && Math.abs(gap) <= 1 ? 'PASS' : 'FAIL',
      detail: `status=${reconStatus} gap=${gap.toLocaleString('es-CL')} extracted=${extracted.toLocaleString('es-CL')} target=${target.toLocaleString('es-CL')}`
    },
    {
      gate: 'math_consistency',
      status: mathMismatch === 0 ? 'PASS' : 'FAIL',
      detail: `mathMismatch=${mathMismatch}`
    },
    {
      gate: 'code_coverage',
      status: codePct >= PASS_FAIL_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withCode}/${itemCount} (${formatCoveragePct(codePct)})`
    },
    {
      gate: 'date_coverage',
      status: datePct >= PASS_FAIL_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withDate}/${itemCount} (${formatCoveragePct(datePct)})`
    },
    {
      gate: 'quantity_coverage',
      status: qtyPct >= PASS_FAIL_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withQty}/${itemCount} (${formatCoveragePct(qtyPct)})`
    },
    {
      gate: 'unit_price_coverage',
      status: unitPct >= PASS_FAIL_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withUnit}/${itemCount} (${formatCoveragePct(unitPct)})`
    }
  ];

  return {
    overallStatus: gates.every((gate) => gate.status === 'PASS') ? 'PASS' : 'FAIL',
    summary: {
      specVersion: String(payload.specVersion || ''),
      itemCount,
      strict,
      reconciliationStatus: reconStatus,
      gap,
      extracted,
      target,
      mathMismatch,
      codeCoveragePct: Number(codePct.toFixed(4)),
      dateCoveragePct: Number(datePct.toFixed(4)),
      quantityCoveragePct: Number(qtyPct.toFixed(4)),
      unitPriceCoveragePct: Number(unitPct.toFixed(4)),
      residualAdjustmentLines,
      residualAdjustmentAmount
    },
    gates
  };
};

type NumberTokenDetail = {
  raw: string;
  value: number;
  start: number;
  end: number;
  isLikelyIdentifier: boolean;
  tokenType: TokenType;
};

type MonetaryExtractOptions = {
  excludeLikelyIdentifiers?: boolean;
  requireMoneySignature?: boolean;
  tableLike?: boolean;
  minAmountIfNoGrouping?: number;
};

const ID_CONTEXT_RE = /\b(RUT|PACIENTE|COTIZANTE|BENEFICIARIO|TITULAR|ROL|MEDICO|TRATANTE|NUM FICHA|ID LIQUID|ID INGRESO|LIQUIDACION|DIAGNOSTICO)\b/i;
const CHARGE_CONTEXT_RE = /\b(CODIGO|DESCRIP|CANT|PRECIO|VALOR|EXENTO|AFECTO|NETO|IVA|TOTAL REC|SUB TOTAL|SUBTOTAL|PRESTACION|INSUMOS|MEDICAMENTOS|DIAS CAMA|CONVENCIONAL)\b/i;

const isLikelyIdentifierTokenInText = (text: string, tokenRaw: string, start: number, end: number): boolean => {
  const left = String(text || '').slice(Math.max(0, start - 48), start);
  const right = String(text || '').slice(end, Math.min(String(text || '').length, end + 10));
  const around = String(text || '').slice(Math.max(0, start - 8), Math.min(String(text || '').length, end + 8));
  const lineUpper = normalize(text).toUpperCase();
  const leftUpper = normalize(left).toUpperCase();
  const digits = String(tokenRaw || '').replace(/\D/g, '');
  const parsed = parseMoney(tokenRaw);

  // Typical Chilean RUT suffix: 12.345.678-9 or 12.345.678-K
  if (/^\s*-\s*[0-9Kk]\b/.test(right)) return true;

  const hasIdContext = ID_CONTEXT_RE.test(leftUpper) || ID_CONTEXT_RE.test(lineUpper);
  const hasChargeContext = CHARGE_CONTEXT_RE.test(lineUpper);
  const hasCurrencyHint = /\$|CLP|PESOS?/i.test(around);

  // Anti-year: plain 4-digit year tokens without currency signal are not money.
  if (/^\d{4}$/.test(digits) && parsed >= 1900 && parsed <= 2099 && !hasCurrencyHint) return true;

  if (digits.length >= 7 && hasIdContext && !hasChargeContext) return true;
  if (digits.length >= 7 && /^(PACIENTE|COTIZANTE|BENEFICIARIO|RUT|ROL)\b/i.test(leftUpper.trim())) return true;

  return false;
};

const classifyNumberTokenType = (text: string, tokenRaw: string, start: number, end: number, parsed: number): TokenType => {
  const left = String(text || '').slice(Math.max(0, start - 48), start);
  const right = String(text || '').slice(end, Math.min(String(text || '').length, end + 12));
  const leftUpper = normalize(left).toUpperCase();
  const lineUpper = normalize(text).toUpperCase();
  const digits = String(tokenRaw || '').replace(/\D/g, '');
  const hasGrouping = /[.,]/.test(String(tokenRaw || ''));

  if (/^\s*-\s*[0-9Kk]\b/.test(right)) return 'rutCandidate';
  if (/^\d{4}$/.test(digits) && parsed >= 1900 && parsed <= 2099) return 'dateCandidate';
  if (digits.length <= 2 && /\b(CANT|CANTIDAD)\b/.test(lineUpper)) return 'qtyCandidate';
  if (digits.length >= 5 && /\b(CODIGO|FOLIO|PRESTACION)\b/.test(leftUpper)) return 'codeCandidate';
  if (digits.length >= 6 && /\b(ID|FICHA|INGRESO|LIQUID|CTA|CUENTA|ROL)\b/.test(leftUpper)) return 'idCandidate';
  if (isLikelyIdentifierTokenInText(text, tokenRaw, start, end)) return 'idCandidate';

  // Money candidate signature for scanned table text.
  if (hasGrouping) return 'moneyCandidate';
  if (parsed >= 10000 && /\b(VALOR|TOTAL|NETO|IVA|COPAGO|BONIFIC|REC)\b/.test(lineUpper)) return 'moneyCandidate';
  return 'idCandidate';
};

const extractNumberTokenDetailsFromText = (value: string): NumberTokenDetail[] => {
  const text = normalizeDenseNumericText(String(value || ''));
  const re = new RegExp(RAW_NUMBER_TOKEN_RE.source, 'g');
  const out: NumberTokenDetail[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = String(match[0] || '');
    const parsed = parseMoney(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const start = Number(match.index || 0);
    const end = start + raw.length;
    const tokenType = classifyNumberTokenType(text, raw, start, end, parsed);
    out.push({
      raw,
      value: parsed,
      start,
      end,
      isLikelyIdentifier: tokenType === 'rutCandidate' || tokenType === 'idCandidate' || tokenType === 'dateCandidate',
      tokenType
    });
  }
  return out;
};

const extractMonetaryCandidatesFromText = (value: string, options?: MonetaryExtractOptions | boolean): number[] => {
  const opts: MonetaryExtractOptions = typeof options === 'boolean'
    ? { excludeLikelyIdentifiers: options }
    : (options || {});
  const minAmountIfNoGrouping = Number(opts.minAmountIfNoGrouping || 10000);
  const text = normalizeDenseNumericText(String(value || ''));
  return extractNumberTokenDetailsFromText(text)
    .filter((token) => token.tokenType === 'moneyCandidate')
    .filter((token) => !opts.excludeLikelyIdentifiers || !token.isLikelyIdentifier)
    .filter((token) => {
      if (!opts.requireMoneySignature) return true;
      const hasGrouping = /[.,]/.test(String(token.raw || ''));
      if (hasGrouping) return true;
      if (token.value >= 1900 && token.value <= 2099) return false;
      if (opts.tableLike) return token.value >= RAW_ITEM_MIN_TOTAL;
      return token.value >= minAmountIfNoGrouping;
    })
    .map((token) => token.value)
    .filter((n) => Number.isFinite(n) && n > 0);
};

const extractMoneyTokensFromText = (value: string): number[] =>
  extractMonetaryCandidatesFromText(value, false);

const hasTotalEmpresaSignal = (value: string): boolean =>
  normalize(value).toUpperCase().includes('TOTAL EMPRESA');

const hasSantaMariaSubtotalSignal = (value: string): boolean => {
  const upper = normalize(value).toUpperCase();
  return upper.includes('TOTAL CENTRO') || upper.includes('TOTAL TIPO');
};

const hasSantaMariaAdjustmentSignal = (value: string): boolean =>
  normalize(value).toUpperCase().includes('TOTAL DEVOLUCIONES');

const hasClinicTotalGeneralSignal = (value: string): boolean => {
  const upper = normalize(value).toUpperCase();
  return upper.includes('TOTAL GENERAL') || upper.includes('TOTAL CUENTA');
};

const hasPamTotalSignal = (value: string): boolean =>
  normalize(value).toUpperCase().includes('TOTAL PAM');

const extractEmpresaLayoutColumnsFromRawText = (
  rawText: string
): Omit<EmpresaLayoutColumnSums, 'itemTotal'> | null => {
  const text = normalizeDenseNumericText(String(rawText || '').replace(/\s+/g, ' ').trim());
  if (!text || !findClinicalDateMatch(text)) return null;
  const values = (text.match(RAW_NUMBER_TOKEN_RE) || [])
    .map((token) => parseMoney(token))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const tail = values.slice(-8);
  if (tail.length < 8) return null;
  return {
    valorBruto: Math.round(Number(tail[2] || 0)),
    exento: Math.round(Number(tail[3] || 0)),
    afecto: Math.round(Number(tail[4] || 0)),
    iva: Math.round(Number(tail[5] || 0)),
    valorIsa: Math.round(Number(tail[6] || 0)),
    empresa: Math.round(Number(tail[7] || 0))
  };
};

const selectGrossAmountFromEmpresaLayout = (amountCandidates: number[], rawText = ''): number => {
  const columns = rawText ? extractEmpresaLayoutColumnsFromRawText(rawText) : null;
  if (columns?.valorIsa && columns.valorIsa >= RAW_ITEM_MIN_TOTAL && columns.valorIsa <= RAW_ITEM_MAX_TOTAL) {
    if (columns.valorIsa >= Math.max(columns.valorBruto || 0, columns.empresa || 0)) {
      return columns.valorIsa;
    }
  }

  const values = amountCandidates
    .map((value) => Math.round(Number(value || 0)))
    .filter((value) => value >= RAW_ITEM_MIN_TOTAL && value <= RAW_ITEM_MAX_TOTAL);
  if (values.length < 2) return 0;
  const empresaAmount = values[values.length - 1];
  const grossAmount = values[values.length - 2];
  if (!(grossAmount > 0) || !(empresaAmount > 0)) return 0;
  return grossAmount > empresaAmount ? grossAmount : 0;
};

const computeEmpresaGapSet = (
  sums: EmpresaLayoutColumnSums,
  targetSubtotal: number
): EmpresaSubtotalDiagnosticGapSet => ({
  itemTotal: Math.round(sums.itemTotal - targetSubtotal),
  valorBruto: Math.round(sums.valorBruto - targetSubtotal),
  valorIsa: Math.round(sums.valorIsa - targetSubtotal),
  empresa: Math.round(sums.empresa - targetSubtotal),
  afectoMasIva: Math.round((sums.afecto + sums.iva) - targetSubtotal),
  exentoMasAfectoMasIva: Math.round((sums.exento + sums.afecto + sums.iva) - targetSubtotal)
});

const resolveClosestEmpresaMetric = (
  gaps: EmpresaSubtotalDiagnosticGapSet
): EmpresaSubtotalDiagnosticClosestMetric =>
  (Object.entries(gaps) as Array<[EmpresaSubtotalDiagnosticClosestMetric, number]>)
    .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0]?.[0] || 'itemTotal';

const hasNearbyEmpresaTableHeader = (orderedLines: LogicalLine[], index: number): boolean => {
  for (let offset = 1; offset <= 4; offset += 1) {
    const next = orderedLines[index + offset];
    if (!next) break;
    const pageDelta = Math.abs(Number(next.page || 0) - Number(orderedLines[index]?.page || 0));
    if (pageDelta > 1) break;
    const nextText = String(next.fullText || '').replace(/\s+/g, ' ').trim();
    if (!nextText) continue;
    if (hasTableHeaderSignature(nextText)) return true;
    if (findClinicalDateMatch(nextText)) break;
  }
  return false;
};

const isEmpresaSectionHeaderLine = (line: LogicalLine, orderedLines: LogicalLine[], index: number): boolean => {
  const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text) || hasTableHeaderSignature(text)) return false;
  if (isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text) || hasPamPageSignal(text)) return false;
  if (findClinicalDateMatch(text)) return false;
  const money = extractMonetaryCandidatesFromText(text, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 10000
  }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (money.length > 0) return false;

  const normalizedText = normalize(text).toUpperCase();
  const stripped = normalizedText.replace(/^\d{3,6}\s+/, '').trim();
  if (!stripped || /(CODIGO|DESCRIP|RUT|PROF|CANT|PRECIO|VALOR|AFECTO|IVA|BONIF|RECARGO|DESCTO|DOCTO|FONASA)/.test(stripped)) return false;
  const alphaCount = (stripped.match(/[A-Z]/g) || []).length;
  if (alphaCount < 6) return false;
  const wordCount = stripped.split(/\s+/).filter((part) => /[A-Z]/.test(part)).length;
  if (wordCount < 2) return false;
  if (!/^[0-9A-Z .:/()_-]+$/.test(stripped)) return false;
  if (!hasNearbyEmpresaTableHeader(orderedLines, index)) return false;
  return /\b(UCI|UTI|PEDIATR|PABELL|CIRUG|PISO|LABORATORIO|HEMATO|BANCO|IMAGENO|PAB|UNIDAD|U\.C\.E\.|PBELLON)\b/.test(stripped)
    || /^\d{3,6}\s+[A-Z]/.test(normalizedText);
};

const extractEmpresaInternalSubtotalAmount = (text: string): number => {
  const tokenTexts = normalizeDenseNumericText(String(text || '')).match(RAW_NUMBER_TOKEN_RE) || [];
  const parsed = tokenTexts
    .map((token) => ({ token, value: parseMoney(token) }))
    .filter((entry) => entry.value >= 1000 && entry.value <= RAW_ITEM_MAX_TOTAL);
  if (!parsed.length) return 0;
  const grouped = parsed.filter((entry) => /[.,]/.test(String(entry.token)));
  const sourceList = grouped.length ? grouped : parsed;
  if (sourceList.length >= 2) return sourceList[sourceList.length - 2].value;
  return sourceList[sourceList.length - 1].value;
};

const isEmpresaInternalSubtotalLine = (line: LogicalLine): boolean => {
  const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (hasTotalEmpresaSignal(text) || hasTableHeaderSignature(text)) return false;
  if (findClinicalDateMatch(text)) return false;
  if (isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text) || hasPamPageSignal(text)) return false;
  const values = extractMonetaryCandidatesFromText(text, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 1000
  }).filter((n) => n >= 1000 && n <= RAW_ITEM_MAX_TOTAL);
  return values.length >= 6 && extractEmpresaInternalSubtotalAmount(text) > 0;
};

const accumulateEmpresaSums = (blockItems: NormalizedBillItem[]): {
  sums: EmpresaLayoutColumnSums;
  parsedItemCount: number;
} => {
  let parsedItemCount = 0;
  const sums = blockItems.reduce<EmpresaLayoutColumnSums>((acc, item) => {
    acc.itemTotal += Math.round(Number(item.total || 0));
    const columns = extractEmpresaLayoutColumnsFromRawText(item.rawText || '');
    if (!columns) return acc;
    parsedItemCount += 1;
    acc.valorBruto += columns.valorBruto;
    acc.exento += columns.exento;
    acc.afecto += columns.afecto;
    acc.iva += columns.iva;
    acc.valorIsa += columns.valorIsa;
    acc.empresa += columns.empresa;
    return acc;
  }, {
    itemTotal: 0,
    valorBruto: 0,
    exento: 0,
    afecto: 0,
    iva: 0,
    valorIsa: 0,
    empresa: 0
  });
  return { sums, parsedItemCount };
};

const buildEmpresaSectionDiagnostics = (
  items: NormalizedBillItem[],
  logicalLines: LogicalLine[],
  blockStartPage: number,
  blockEndPage: number
): EmpresaSubtotalDiagnosticSection[] => {
  const blockItems = items.filter((item) => {
    const page = Math.max(1, Number(item.page || 1));
    return page >= blockStartPage && page <= blockEndPage;
  });
  if (!blockItems.length) return [];

  const orderedLines = logicalLines
    .filter((line) => {
      const page = Math.max(1, Number(line.page || 1));
      return page >= blockStartPage && page <= blockEndPage;
    })
    .sort((a, b) => Number(a.page || 0) - Number(b.page || 0) || Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0));
  const headerLines = orderedLines.filter((line, index) => isEmpresaSectionHeaderLine(line, orderedLines, index));
  if (!headerLines.length) return [];

  return headerLines.flatMap((header, idx) => {
    const nextHeader = headerLines[idx + 1] || null;
    const sectionItemsBeforeNextHeader = blockItems.filter((item) => {
      const page = Math.max(1, Number(item.page || 1));
      const y = Number(item.bbox?.y || 0);
      const afterStart = page > Number(header.page || 0)
        || (page === Number(header.page || 0) && y >= Number(header.bbox?.y || 0));
      const beforeEnd = !nextHeader
        || page < Number(nextHeader.page || 0)
        || (page === Number(nextHeader.page || 0) && y < Number(nextHeader.bbox?.y || 0));
      return afterStart && beforeEnd;
    });
    const sectionLinesBeforeNextHeader = orderedLines.filter((line) => {
      const page = Math.max(1, Number(line.page || 1));
      const y = Number(line.bbox?.y || 0);
      const afterStart = page > Number(header.page || 0)
        || (page === Number(header.page || 0) && y >= Number(header.bbox?.y || 0));
      const beforeEnd = !nextHeader
        || page < Number(nextHeader.page || 0)
        || (page === Number(nextHeader.page || 0) && y < Number(nextHeader.bbox?.y || 0));
      return afterStart && beforeEnd;
    });
    const subtotalLine = [...sectionLinesBeforeNextHeader].reverse().find((line) => isEmpresaInternalSubtotalLine(line)) || null;
    const targetSubtotal = subtotalLine ? extractEmpresaInternalSubtotalAmount(subtotalLine.fullText || '') : 0;
    const sectionItems = subtotalLine
      ? sectionItemsBeforeNextHeader.filter((item) => {
        const page = Math.max(1, Number(item.page || 1));
        const y = Number(item.bbox?.y || 0);
        return page < Number(subtotalLine.page || 0)
          || (page === Number(subtotalLine.page || 0) && y < Number(subtotalLine.bbox?.y || 0));
      })
      : sectionItemsBeforeNextHeader;
    const trailingItems = subtotalLine
      ? sectionItemsBeforeNextHeader.filter((item) => {
        const page = Math.max(1, Number(item.page || 1));
        const y = Number(item.bbox?.y || 0);
        return page > Number(subtotalLine.page || 0)
          || (page === Number(subtotalLine.page || 0) && y > Number(subtotalLine.bbox?.y || 0));
      })
      : [];
    const { sums, parsedItemCount } = accumulateEmpresaSums(sectionItems);
    const gaps = targetSubtotal > 0 ? computeEmpresaGapSet(sums, targetSubtotal) : null;
    const closestMetric = gaps ? resolveClosestEmpresaMetric(gaps) : null;
    const sectionEndPage = sectionItems.length
      ? Math.max(...sectionItems.map((item) => Math.max(1, Number(item.page || 1))))
      : Math.max(Number(header.page || blockStartPage), subtotalLine ? Number(subtotalLine.page || header.page || blockStartPage) : Number(header.page || blockStartPage));

    const sections: EmpresaSubtotalDiagnosticSection[] = [{
      label: `${idx + 1}. ${String(header.fullText || '').replace(/\s+/g, ' ').trim()}`,
      startPage: Math.max(1, Number(header.page || blockStartPage)),
      endPage: Math.max(Math.max(1, Number(header.page || blockStartPage)), sectionEndPage),
      headerPage: Math.max(1, Number(header.page || blockStartPage)),
      headerText: String(header.fullText || '').replace(/\s+/g, ' ').trim(),
      itemCount: sectionItems.length,
      parsedItemCount,
      subtotalPage: subtotalLine ? Math.max(1, Number(subtotalLine.page || 0)) : null,
      subtotalText: subtotalLine ? String(subtotalLine.fullText || '').replace(/\s+/g, ' ').trim() : null,
      targetSubtotal: targetSubtotal > 0 ? targetSubtotal : null,
      sums,
      gaps,
      closestMetric
    }];

    if (trailingItems.length > 0) {
      const trailingStartPage = Math.min(...trailingItems.map((item) => Math.max(1, Number(item.page || 1))));
      const trailingEndPage = Math.max(...trailingItems.map((item) => Math.max(1, Number(item.page || 1))));
      const trailingHeaderText = `POST-SUBTOTAL ${String(header.fullText || '').replace(/\s+/g, ' ').trim()}`;
      const trailing = accumulateEmpresaSums(trailingItems);
      sections.push({
        label: `${idx + 1}b. Items posteriores al subtotal`,
        startPage: trailingStartPage,
        endPage: trailingEndPage,
        headerPage: subtotalLine ? Math.max(1, Number(subtotalLine.page || trailingStartPage)) : trailingStartPage,
        headerText: trailingHeaderText,
        itemCount: trailingItems.length,
        parsedItemCount: trailing.parsedItemCount,
        subtotalPage: null,
        subtotalText: null,
        targetSubtotal: null,
        sums: trailing.sums,
        gaps: null,
        closestMetric: null
      });
    }

    return sections;
  });
};

const buildEmpresaSubtotalDiagnostics = (
  items: NormalizedBillItem[],
  subtotals: Array<{ page: number; amount: number; text: string }>,
  logicalLines: LogicalLine[]
): EmpresaSubtotalDiagnosticBlock[] => {
  if (!items.length || !subtotals.length) return [];
  const orderedSubtotals = [...subtotals]
    .filter((entry) => Number(entry.page || 0) > 0 && Number(entry.amount || 0) > 0)
    .sort((a, b) => Number(a.page || 0) - Number(b.page || 0));
  if (!orderedSubtotals.length) return [];

  const itemPages = items.map((item) => Math.max(1, Number(item.page || 1)));
  const firstPage = itemPages.length ? Math.min(...itemPages) : 1;

  return orderedSubtotals.map((subtotal, idx) => {
    const startPage = idx === 0 ? firstPage : Math.max(1, Number(orderedSubtotals[idx - 1].page || 0) + 1);
    const endPage = Math.max(startPage, Number(subtotal.page || startPage));
    const blockItems = items.filter((item) => {
      const page = Math.max(1, Number(item.page || 1));
      return page >= startPage && page <= endPage;
    });

    const { sums, parsedItemCount } = accumulateEmpresaSums(blockItems);

    const targetSubtotal = Math.round(Number(subtotal.amount || 0));
    const gaps = computeEmpresaGapSet(sums, targetSubtotal);
    const closestMetric = resolveClosestEmpresaMetric(gaps);
    const sections = buildEmpresaSectionDiagnostics(items, logicalLines, startPage, endPage);

    return {
      label: `${startPage}-${endPage}`,
      startPage,
      endPage,
      subtotalPage: Math.max(1, Number(subtotal.page || endPage)),
      subtotalText: String(subtotal.text || '').trim(),
      targetSubtotal,
      itemCount: blockItems.length,
      parsedItemCount,
      sums,
      gaps,
      closestMetric,
      sections: sections.length > 0 ? sections : undefined
    };
  });
};

const comparePageY = (
  pageA: number,
  yA: number,
  pageB: number,
  yB: number
): number => pageA - pageB || yA - yB;

const LEADING_CLINICAL_CODE_RE = /^\s*((?:\d{2,8}(?:-\d{1,3}){1,4})|\d{5,10})(?=\D|$)/;

const extractLeadingClinicalCode = (value: string): string => {
  const compact = normalizeDenseNumericText(String(value || '').replace(/\s+/g, ' ').trim());
  const match = compact.match(LEADING_CLINICAL_CODE_RE);
  return String(match?.[1] || '').trim();
};

const cleanClinicalDescriptionWithLeadingCode = (value: string): string => {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const leadingCode = extractLeadingClinicalCode(compact);
  let trimmed = compact;
  if (leadingCode) {
    const leadingMatch = compact.match(LEADING_CLINICAL_CODE_RE);
    if (leadingMatch) {
      trimmed = compact.slice((leadingMatch.index || 0) + leadingMatch[0].length).trim();
    }
  }
  const dateMatch = findClinicalDateMatch(trimmed);
  if (dateMatch) {
    trimmed = trimmed.slice(0, Number(dateMatch.index || 0)).trim();
  }
  trimmed = trimmed.replace(/^\|\s*/, '').trim();
  return trimmed || cleanRawDescription(compact);
};

const extractStructuredChargeTotalFromText = (value: string): number => {
  const compact = normalizeDenseNumericText(String(value || '').replace(/\s+/g, ' ').trim());
  if (!compact) return 0;
  const code = extractLeadingClinicalCode(compact);
  const date = extractDateForClinicalKey(compact);
  if (!code || !date) return 0;
  const description = cleanClinicalDescriptionWithLeadingCode(compact);
  if (!isAuditableDescription(description)) return 0;
  const dateMatch = findClinicalDateMatch(compact);
  const tail = dateMatch ? compact.slice((dateMatch.index || 0) + dateMatch[0].length) : compact;
  const values = (tail.match(RAW_NUMBER_TOKEN_RE) || [])
    .map(parseMoney)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= RAW_ITEM_MAX_TOTAL);
  if (values.length < 2) return 0;
  return Math.round(Number(values[values.length - 1] || 0));
};

const extractSantaMariaChargeAmountFromText = (
  value: string,
  options?: { allowNegative?: boolean }
): number => {
  const text = normalizeDenseNumericText(String(value || '').replace(/\s+/g, ' ').trim());
  if (!text) return 0;
  const dateMatch = findClinicalDateMatch(text);
  const tail = dateMatch ? text.slice((dateMatch.index || 0) + dateMatch[0].length) : text;
  const tokens = (tail.match(RAW_NUMBER_TOKEN_RE) || [])
    .map(parseMoney)
    .filter((n) => Number.isFinite(n) && Math.abs(n) <= RAW_ITEM_MAX_TOTAL)
    .filter((n) => options?.allowNegative ? n !== 0 : n > 0);
  if (!tokens.length) return 0;
  const last = Math.round(Number(tokens[tokens.length - 1] || 0));
  if (!options?.allowNegative && last <= 0) return 0;
  return last;
};

const extractSantaMariaChargeTotalFromText = (value: string): number => {
  const amount = extractSantaMariaChargeAmountFromText(value);
  return amount > 0 ? amount : 0;
};

const isSantaMariaSectionHeaderLine = (line: LogicalLine): boolean => {
  const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text) || hasTableHeaderSignature(text)) return false;
  if (isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text) || hasPamPageSignal(text)) return false;
  if (findClinicalDateMatch(text)) return false;
  if (extractLeadingClinicalCode(text)) return false;
  const money = extractMonetaryCandidatesFromText(text, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 100
  }).filter((n) => n > 0 && n <= RAW_ITEM_MAX_TOTAL);
  if (money.length > 0) return false;
  const upper = normalize(text).toUpperCase();
  if (!upper) return false;
  if (upper.includes('EMPRESA EMISORA') || upper.includes('EMITIR BONOS') || upper.includes('CLINICA SANTA MARIA')) return false;
  const alphaCount = (upper.match(/[A-Z]/g) || []).length;
  if (alphaCount < 4) return false;
  return /^[A-Z0-9 .:/()#_-]+$/.test(upper);
};

const extractSantaMariaSubtotalAmount = (value: string): number => {
  const money = extractMonetaryCandidatesFromText(String(value || ''), {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 1
  }).filter((n) => n > 0 && n <= RAW_ITEM_MAX_TOTAL);
  return money.length ? Math.round(Number(money[money.length - 1] || 0)) : 0;
};

const extractSantaMariaSubtotalKind = (value: string): 'tipo' | 'centro' => {
  const upper = normalize(value).toUpperCase();
  return upper.includes('TOTAL TIPO') ? 'tipo' : 'centro';
};

type SantaMariaChargeLineCandidate = {
  line: LogicalLine;
  code: string;
  date: string;
  description: string;
  amount: number;
};

const extractSantaMariaChargeLineCandidate = (
  line: LogicalLine,
  options?: { allowNegative?: boolean }
): SantaMariaChargeLineCandidate | null => {
  const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text) || hasTableHeaderSignature(text)) return null;
  if (isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text) || hasPamPageSignal(text)) return null;
  const canonical = extractCanonicalFieldsFromLogicalText(text, 0);
  const code = String(extractLeadingClinicalCode(text) || canonical.fields.codigo || '').trim();
  const date = String(canonical.fields.fecha || extractDateForClinicalKey(text) || '').trim();
  const description = cleanClinicalDescriptionWithLeadingCode(text);
  const signedAmount = Math.round(Number(extractSantaMariaChargeAmountFromText(text, { allowNegative: true }) || 0));
  if (!options?.allowNegative && signedAmount < 0) return null;
  const amount = options?.allowNegative
    ? signedAmount
    : Math.round(Number(canonical.fields.valor || extractSantaMariaChargeTotalFromText(text) || 0));
  if (!code || !date || !(options?.allowNegative ? amount !== 0 : amount > 0)) return null;
  if (!isAuditableDescription(description)) return null;
  return {
    line,
    code,
    date,
    description,
    amount
  };
};

const isCodedAuditableItem = (item: NormalizedBillItem): boolean => {
  const code = String(item.codeInternal || item.code || item.fields?.codigo || '').trim();
  const description = cleanClinicalDescriptionWithLeadingCode(item.description || item.rawText || '');
  const total = Math.round(Number(item.total || 0));
  return Boolean(code) && isAuditableDescription(description) && total > 0;
};

const matchItemToSantaMariaChargeLine = (
  item: NormalizedBillItem,
  candidate: SantaMariaChargeLineCandidate
): boolean => {
  const itemRowIds = new Set(item.rowIds || item.trace?.rowIds || []);
  if (candidate.line.rowIds.some((rowId) => itemRowIds.has(rowId))) return true;
  if (String(item.id || '').endsWith(candidate.line.id)) return true;
  if (Math.max(1, Number(item.page || 1)) !== Math.max(1, Number(candidate.line.page || 1))) return false;
  const itemCode = String(item.codeInternal || item.code || item.fields?.codigo || '').trim();
  const itemDate = String(item.date || item.fields?.fecha || '').trim();
  const itemAmount = Math.round(Number(item.total || 0));
  const itemDescription = canonicalDescriptionForKey(cleanClinicalDescriptionWithLeadingCode(item.description || item.rawText || ''));
  const lineDescription = canonicalDescriptionForKey(candidate.description);
  if (itemCode && candidate.code && itemCode !== candidate.code) return false;
  if (itemDate && candidate.date && itemDate !== candidate.date) return false;
  if (itemAmount > 0 && Math.abs(itemAmount - candidate.amount) > 1) return false;
  return itemDescription.length > 0 && itemDescription === lineDescription;
};

const parseSortableClinicalDate = (value: string): number => {
  const match = String(value || '').match(/\b(\d{2})[/-](\d{2})[/-](\d{4})\b/);
  if (!match) return 0;
  return Number(`${match[3]}${match[2]}${match[1]}`);
};

const normalizeSantaMariaItems = (
  items: NormalizedBillItem[],
  logicalLines: LogicalLine[],
  scopePages: number[]
): { items: NormalizedBillItem[]; anomalies: ItemAnomaly[] } => {
  const anomalies: ItemAnomaly[] = [];
  const scopeSet = new Set(scopePages.filter((page) => Number(page || 0) > 0).map((page) => Number(page || 0)));
  if (!scopeSet.size) return { items, anomalies };

  const negativeAdjustments = logicalLines
    .filter((line) => scopeSet.has(Math.max(1, Number(line.page || 1))))
    .sort((a, b) => comparePageY(Number(a.page || 0), Number(a.bbox?.y || 0), Number(b.page || 0), Number(b.bbox?.y || 0)))
    .map((line) => extractSantaMariaChargeLineCandidate(line, { allowNegative: true }))
    .filter((candidate): candidate is SantaMariaChargeLineCandidate => Boolean(candidate) && Number(candidate.amount || 0) < 0);
  if (!negativeAdjustments.length) return { items, anomalies };

  const adjustedItems: Array<NormalizedBillItem | null> = [...items];

  for (const adjustment of negativeAdjustments) {
    const adjustmentAmount = Math.abs(Math.round(Number(adjustment.amount || 0)));
    if (!(adjustmentAmount > 0)) continue;
    const adjustmentDescKey = canonicalDescriptionForKey(adjustment.description);
    const adjustmentDateKey = parseSortableClinicalDate(adjustment.date);

    let best: {
      index: number;
      mode: 'drop_item' | 'decrement_unit';
      score: number;
    } | null = null;

    for (let index = 0; index < adjustedItems.length; index += 1) {
      const item = adjustedItems[index];
      if (!item) continue;
      const itemTotal = Math.round(Number(item.total || 0));
      if (!(itemTotal > 0)) continue;
      if (Math.max(1, Number(item.page || 1)) > Math.max(1, Number(adjustment.line.page || 1))) continue;

      const itemCode = String(item.codeInternal || item.code || item.fields?.codigo || '').trim();
      if (!itemCode || itemCode !== adjustment.code) continue;

      const itemDescKey = canonicalDescriptionForKey(cleanClinicalDescriptionWithLeadingCode(item.description || item.rawText || ''));
      const descriptionsMatch = itemDescKey && adjustmentDescKey
        ? (
          itemDescKey === adjustmentDescKey ||
          itemDescKey.includes(adjustmentDescKey) ||
          adjustmentDescKey.includes(itemDescKey)
        )
        : true;
      if (!descriptionsMatch) continue;

      const quantity = Math.max(0, Number(item.quantity ?? item.fields?.cantidad ?? 0));
      const unitPrice = Math.round(Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0));
      const rawMoneyContext = extractRawLineMoneyContext(String(item.rawText || ''));
      const rawQuantity = Math.max(0, Number(rawMoneyContext.quantity || 0));
      const rawMoneyTokens = rawMoneyContext.moneyTokens
        .map((value) => Math.round(Number(value || 0)))
        .filter((value) => value > 0 && value <= RAW_ITEM_MAX_TOTAL);
      const structuredUnitFromRaw = rawQuantity > 1
        ? (rawMoneyTokens.find((value) =>
          Math.abs(value * rawQuantity - itemTotal) <= Math.max(2, Math.round(itemTotal * 0.01))
        ) || rawMoneyTokens.find((value) => value < itemTotal) || 0)
        : 0;
      const effectiveQuantity = Math.max(quantity, rawQuantity);
      const effectiveUnitPrice = [unitPrice, structuredUnitFromRaw]
        .filter((value) => value > 0)
        .sort((a, b) => Math.abs(a - adjustmentAmount) - Math.abs(b - adjustmentAmount))[0] || 0;
      const itemDateKey = parseSortableClinicalDate(String(item.date || item.fields?.fecha || ''));
      const pageDistance = Math.max(0, Math.max(1, Number(adjustment.line.page || 1)) - Math.max(1, Number(item.page || 1)));
      const yDistance = Math.abs(Number(adjustment.line.bbox?.y || 0) - Number(item.bbox?.y || 0));
      const dateDistance = adjustmentDateKey > 0 && itemDateKey > 0 ? Math.abs(adjustmentDateKey - itemDateKey) : 999999;
      const datedBeforeOrEqual = adjustmentDateKey > 0 && itemDateKey > 0 && itemDateKey <= adjustmentDateKey;

      let mode: 'drop_item' | 'decrement_unit' | null = null;
      let score = 0;

      if (effectiveQuantity > 1 && effectiveUnitPrice > 0 && Math.abs(effectiveUnitPrice - adjustmentAmount) <= 2 && itemTotal - adjustmentAmount > 0) {
        mode = 'decrement_unit';
        score = 300;
      } else if (Math.abs(itemTotal - adjustmentAmount) <= 2) {
        mode = 'drop_item';
        score = 260;
      }

      if (!mode) continue;

      score += datedBeforeOrEqual ? 30 : 0;
      score -= Math.min(80, pageDistance * 12);
      score -= Math.min(40, Math.round(yDistance / 18));
      score -= Math.min(60, Math.round(dateDistance / 3));

      if (!best || score > best.score) {
        best = { index, mode, score };
      }
    }

    if (!best) {
      anomalies.push({
        id: `anom-santa-dev-unresolved-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        code: adjustment.code,
        date: adjustment.date,
        description: adjustment.description,
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'flagged',
        severity: 'medium',
        category: 'negative_row',
        detail: 'Linea de devolucion sin item positivo compatible para netear.',
        originalTotal: -adjustmentAmount,
        normalizedTotal: 0
      });
      continue;
    }

    const targetItem = adjustedItems[best.index];
    if (!targetItem) continue;
    const originalTotal = Math.round(Number(targetItem.total || 0));
    const originalQuantity = Math.max(0, Number(targetItem.quantity ?? targetItem.fields?.cantidad ?? 0));
    const originalUnitPrice = Math.round(Number(targetItem.unitPrice ?? targetItem.fields?.precioUnitario ?? 0));
    const targetRawMoneyContext = extractRawLineMoneyContext(String(targetItem.rawText || ''));
    const targetRawQuantity = Math.max(0, Number(targetRawMoneyContext.quantity || 0));
    const targetRawMoneyTokens = targetRawMoneyContext.moneyTokens
      .map((value) => Math.round(Number(value || 0)))
      .filter((value) => value > 0 && value <= RAW_ITEM_MAX_TOTAL);
    const targetStructuredUnit = targetRawQuantity > 1
      ? (targetRawMoneyTokens.find((value) =>
        Math.abs(value * targetRawQuantity - originalTotal) <= Math.max(2, Math.round(originalTotal * 0.01))
      ) || targetRawMoneyTokens.find((value) => value < originalTotal) || 0)
      : 0;
    const baseQuantity = Math.max(originalQuantity, targetRawQuantity);
    const baseUnitPrice = [originalUnitPrice, targetStructuredUnit]
      .filter((value) => value > 0)
      .sort((a, b) => Math.abs(a - adjustmentAmount) - Math.abs(b - adjustmentAmount))[0] || originalUnitPrice;

    if (best.mode === 'drop_item') {
      adjustedItems[best.index] = null;
      anomalies.push({
        id: `anom-santa-dev-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        itemId: targetItem.id,
        code: targetItem.code || targetItem.codeInternal,
        date: targetItem.date,
        description: String(targetItem.description || targetItem.rawText || '').trim(),
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'auto_fixed',
        severity: 'medium',
        category: 'devolution_applied',
        detail: 'Devolucion Santa Maria aplicada excluyendo un item completo del detalle neto.',
        originalTotal,
        normalizedTotal: 0,
        evidence: {
          quantity: baseQuantity || undefined,
          unitPrice: baseUnitPrice || undefined,
          expectedTotal: adjustmentAmount
        }
      });
      continue;
    }

    const nextQuantity = Math.max(1, baseQuantity - 1);
    const nextTotal = Math.max(0, originalTotal - adjustmentAmount);
    if (!(nextTotal > 0)) {
      adjustedItems[best.index] = null;
      anomalies.push({
        id: `anom-santa-dev-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        itemId: targetItem.id,
        code: targetItem.code || targetItem.codeInternal,
        date: targetItem.date,
        description: String(targetItem.description || targetItem.rawText || '').trim(),
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'auto_fixed',
        severity: 'medium',
        category: 'devolution_applied',
        detail: 'Devolucion Santa Maria aplicada agotando el item positivo asociado.',
        originalTotal,
        normalizedTotal: 0,
        evidence: {
          quantity: baseQuantity || undefined,
          unitPrice: baseUnitPrice || undefined,
          expectedTotal: adjustmentAmount
        }
      });
      continue;
    }

    const normalizedUnitPrice = baseUnitPrice > 0 ? baseUnitPrice : Math.max(1, Math.round(nextTotal / Math.max(1, nextQuantity)));
    adjustedItems[best.index] = {
      ...targetItem,
      total: nextTotal,
      quantity: nextQuantity,
      unitPrice: normalizedUnitPrice,
      fields: {
        ...(targetItem.fields || {}),
        cantidad: nextQuantity,
        precioUnitario: normalizedUnitPrice,
        valor: nextTotal
      }
    };
    anomalies.push({
      id: `anom-santa-dev-${adjustment.line.id}`,
      page: Math.max(1, Number(adjustment.line.page || 1)),
      itemId: targetItem.id,
      code: targetItem.code || targetItem.codeInternal,
      date: targetItem.date,
      description: String(targetItem.description || targetItem.rawText || '').trim(),
      rawText: String(adjustment.line.fullText || '').trim(),
      status: 'auto_fixed',
      severity: 'medium',
      category: 'devolution_applied',
      detail: 'Devolucion Santa Maria aplicada reduciendo una unidad del item positivo asociado.',
      originalTotal,
      normalizedTotal: nextTotal,
      evidence: {
        quantity: baseQuantity || undefined,
        unitPrice: baseUnitPrice || undefined,
        expectedTotal: adjustmentAmount
      }
    });
  }

  return {
    items: adjustedItems.filter((item): item is NormalizedBillItem => Boolean(item) && Math.round(Number(item.total || 0)) > 0),
    anomalies
  };
};

const buildSantaMariaSubtotalDiagnostics = (
  items: NormalizedBillItem[],
  logicalLines: LogicalLine[],
  scopePages: number[]
): SantaMariaSubtotalDiagnosticBlock[] => {
  const scopeSet = new Set(scopePages.filter((page) => Number(page || 0) > 0).map((page) => Number(page || 0)));
  if (!scopeSet.size) return [];

  const orderedLines = logicalLines
    .filter((line) => scopeSet.has(Math.max(1, Number(line.page || 1))))
    .sort((a, b) => comparePageY(Number(a.page || 0), Number(a.bbox?.y || 0), Number(b.page || 0), Number(b.bbox?.y || 0)));
  if (!orderedLines.length) return [];

  const rawSubtotals = orderedLines
    .map((line, orderedIndex) => {
      const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
      if (!hasSantaMariaSubtotalSignal(text)) return null;
      const amount = extractSantaMariaSubtotalAmount(text);
      if (!(amount > 0)) return null;
      return {
        line,
        orderedIndex,
        amount,
        kind: extractSantaMariaSubtotalKind(text)
      };
    })
    .filter((entry): entry is { line: LogicalLine; orderedIndex: number; amount: number; kind: 'tipo' | 'centro' } => Boolean(entry));
  if (!rawSubtotals.length) return [];

  const subtotals = rawSubtotals.filter((entry, idx) => {
    if (entry.kind !== 'centro') return true;
    const next = rawSubtotals[idx + 1];
    if (!next) return true;
    if (next.kind !== 'tipo') return true;
    if (Math.max(1, Number(next.line.page || 1)) !== Math.max(1, Number(entry.line.page || 1))) return true;
    if (Math.abs(Number(next.line.bbox?.y || 0) - Number(entry.line.bbox?.y || 0)) > 30) return true;
    return Math.abs(next.amount - entry.amount) > 1;
  });

  return subtotals.map((subtotalEntry, idx) => {
    const previousSubtotal = subtotals[idx - 1]?.line || null;
    const startPage = previousSubtotal ? Math.max(1, Number(previousSubtotal.page || 1)) : Math.max(1, Number(orderedLines[0]?.page || 1));
    const startY = previousSubtotal ? Number(previousSubtotal.bbox?.y || 0) : Number.NEGATIVE_INFINITY;
    const endPage = Math.max(1, Number(subtotalEntry.line.page || 1));
    const endY = Number(subtotalEntry.line.bbox?.y || 0);

    const sectionLines = orderedLines.filter((line) => {
      const page = Math.max(1, Number(line.page || 1));
      const y = Number(line.bbox?.y || 0);
      const afterStart = !previousSubtotal || comparePageY(page, y, startPage, startY) > 0;
      const beforeEnd = comparePageY(page, y, endPage, endY) < 0;
      return afterStart && beforeEnd;
    });
    const sectionItems = items.filter((item) => {
      const page = Math.max(1, Number(item.page || 1));
      const y = Number(item.bbox?.y || 0);
      const afterStart = !previousSubtotal || comparePageY(page, y, startPage, startY) > 0;
      const beforeEnd = comparePageY(page, y, endPage, endY) < 0;
      return afterStart && beforeEnd;
    });

    const chargeLines = sectionLines
      .map((line) => extractSantaMariaChargeLineCandidate(line))
      .filter((entry): entry is SantaMariaChargeLineCandidate => Boolean(entry));
    const codedItems = sectionItems.filter((item) => isCodedAuditableItem(item));
    const headerLines = sectionLines.filter((line) => isSantaMariaSectionHeaderLine(line));
    const lastHeaders = headerLines.slice(-3);
    const headerText = lastHeaders.length
      ? lastHeaders.map((line) => String(line.fullText || '').replace(/\s+/g, ' ').trim()).join(' / ')
      : null;
    const headerPage = lastHeaders.length ? Math.max(1, Number(lastHeaders[lastHeaders.length - 1].page || 1)) : null;

    const missingCodedLines = chargeLines.flatMap((candidate) => {
      const matchedItem = codedItems.find((item) => matchItemToSantaMariaChargeLine(item, candidate)) || null;
      if (matchedItem) return [];
      return [{
        lineId: candidate.line.id,
        page: Math.max(1, Number(candidate.line.page || 1)),
        code: candidate.code,
        date: candidate.date,
        amount: candidate.amount,
        text: String(candidate.line.fullText || '').replace(/\s+/g, ' ').trim(),
        itemId: null
      }];
    });

    const sums: SantaMariaSubtotalDiagnosticSums = {
      itemTotal: Math.round(sectionItems.reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0)),
      codedItemTotal: Math.round(codedItems.reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0)),
      codedLogicalLineTotal: Math.round(chargeLines.reduce((acc, candidate) => acc + Math.round(Number(candidate.amount || 0)), 0)),
      missingCodedLineTotal: Math.round(missingCodedLines.reduce((acc, line) => acc + Math.round(Number(line.amount || 0)), 0))
    };
    const targetSubtotal = Math.round(Number(subtotalEntry.amount || 0));
    const gaps: SantaMariaSubtotalDiagnosticGapSet = {
      itemTotal: Math.round(sums.itemTotal - targetSubtotal),
      codedItemTotal: Math.round(sums.codedItemTotal - targetSubtotal),
      codedLogicalLineTotal: Math.round(sums.codedLogicalLineTotal - targetSubtotal),
      missingCodedLineTotal: Math.round(sums.missingCodedLineTotal)
    };
    const closestMetric = (Object.entries({
      itemTotal: gaps.itemTotal,
      codedItemTotal: gaps.codedItemTotal,
      codedLogicalLineTotal: gaps.codedLogicalLineTotal
    }) as Array<[SantaMariaSubtotalDiagnosticClosestMetric, number]>)
      .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0]?.[0] || 'codedLogicalLineTotal';

    const previousRawSubtotal = rawSubtotals.find((entry) =>
      entry.kind === 'centro' &&
      Math.max(1, Number(entry.line.page || 1)) === endPage &&
      Math.abs(Number(entry.line.bbox?.y || 0) - endY) <= 30 &&
      Math.abs(entry.amount - targetSubtotal) <= 1 &&
      comparePageY(Number(entry.line.page || 0), Number(entry.line.bbox?.y || 0), endPage, endY) < 0
    );

    return {
      label: headerText || `${String(subtotalEntry.kind).toUpperCase()} p${endPage}`,
      subtotalKind: subtotalEntry.kind,
      startPage: sectionLines.length ? Math.max(1, Number(sectionLines[0].page || endPage)) : endPage,
      endPage,
      headerPage,
      headerText,
      subtotalPage: endPage,
      subtotalText: String(subtotalEntry.line.fullText || '').replace(/\s+/g, ' ').trim(),
      pairedSubtotalText: previousRawSubtotal ? String(previousRawSubtotal.line.fullText || '').replace(/\s+/g, ' ').trim() : null,
      targetSubtotal,
      itemCount: sectionItems.length,
      codedItemCount: codedItems.length,
      codedLogicalLineCount: chargeLines.length,
      missingCodedLineCount: missingCodedLines.length,
      sums,
      gaps,
      closestMetric,
      missingCodedLines
    };
  });
};

const selectGrossAmountFromSubtotalLookahead = (
  logicalLines: LogicalLine[],
  lineIndex: number,
  currentChosenAmount: number
): number => {
  const current = logicalLines[lineIndex];
  const next = logicalLines[lineIndex + 1];
  if (!current || !next) return 0;
  if (Number(current.page || 0) !== Number(next.page || 0)) return 0;
  const yGap = Number(next.bbox?.y || 0) - Number(current.bbox?.y || 0);
  if (yGap < 0 || yGap > 18) return 0;

  const nextText = String(next.fullText || '').replace(/\s+/g, ' ').trim();
  if (!nextText || findClinicalDateMatch(nextText)) return 0;
  if (hasTotalEmpresaSignal(nextText) || hasTableHeaderSignature(nextText)) return 0;

  const values = extractMonetaryCandidatesFromText(nextText, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 1000
  }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (values.length < 4) return 0;

  const last = Math.round(Number(values[values.length - 1] || 0));
  const penultimate = Math.round(Number(values[values.length - 2] || 0));
  if (last !== Math.round(Number(currentChosenAmount || 0))) return 0;
  if (!(penultimate > last)) return 0;
  return penultimate;
};

const isNegativeEmpresaLayoutRow = (rawText: string): boolean => {
  const text = normalizeDenseNumericText(String(rawText || '').replace(/\s+/g, ' ').trim());
  if (!text) return false;
  return /(^|\|)\s*-\d+[.,]\d+/.test(text);
};

const isPlaceholderEmpresaLayoutTotal = (item: NormalizedBillItem): boolean => {
  const total = Math.round(Number(item.total || 0));
  return [1000, 3000, 4000, 5000, 6000, 7000, 8000, 10000].includes(total);
};

const isZeroBackedEmpresaLayoutRow = (rawText: string): boolean => {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const parts = text.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length < 8) return false;
  const tail = parts.slice(-8);
  return tail.every((part) => {
    const compact = part.replace(/\s+/g, '');
    return compact === '0' || compact === '0,0' || compact === '0.0';
  });
};

type EmpresaNegativeAdjustmentCandidate = {
  line: LogicalLine;
  code: string;
  date: string;
  description: string;
  amount: number;
  evidence: Omit<EmpresaLayoutColumnSums, 'itemTotal'> | null;
};

const extractEmpresaNegativeAdjustmentAmount = (rawText: string): number => {
  const text = normalizeDenseNumericText(String(rawText || '').replace(/\s+/g, ' ').trim());
  if (!text) return 0;

  const dateMatch = findClinicalDateMatch(text);
  const tail = dateMatch ? text.slice((dateMatch.index || 0) + dateMatch[0].length) : text;
  const negativeTokens = (tail.match(RAW_NUMBER_TOKEN_RE) || [])
    .map((token) => parseMoney(token))
    .filter((value) => value < 0)
    .map((value) => Math.abs(Math.round(Number(value || 0))))
    .filter((value) => value >= RAW_ITEM_MIN_TOTAL && value <= RAW_ITEM_MAX_TOTAL)
    .sort((a, b) => b - a);
  if (negativeTokens.length > 0) return negativeTokens[0];

  const columns = extractEmpresaLayoutColumnsFromRawText(rawText);
  if (!columns) return 0;
  const candidates = [
    Math.round(Number(columns.valorIsa || 0)),
    Math.round(Number((columns.exento || 0) + (columns.afecto || 0) + (columns.iva || 0))),
    Math.round(Number(columns.valorBruto || 0))
  ].filter((value) => value >= RAW_ITEM_MIN_TOTAL && value <= RAW_ITEM_MAX_TOTAL);
  return candidates.sort((a, b) => b - a)[0] || 0;
};

const extractEmpresaNegativeAdjustmentLineCandidate = (
  line: LogicalLine
): EmpresaNegativeAdjustmentCandidate | null => {
  const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text || !isNegativeEmpresaLayoutRow(text)) return null;
  if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text) || hasTableHeaderSignature(text)) return null;
  if (isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text) || hasPamPageSignal(text)) return null;

  const canonical = extractCanonicalFieldsFromLogicalText(text, 0, {
    preferGrossOnTotalEmpresaLayout: true
  });
  const code = String(canonical.fields.codigo || '').trim();
  const date = String(canonical.fields.fecha || extractDateForClinicalKey(text) || '').trim();
  const description = cleanClinicalDescriptionWithLeadingCode(text);
  const amount = Math.round(Number(extractEmpresaNegativeAdjustmentAmount(text) || 0));
  const evidence = extractEmpresaLayoutColumnsFromRawText(text);
  if (!date || !isAuditableDescription(description) || !(amount > 0)) return null;
  return {
    line,
    code,
    date,
    description,
    amount,
    evidence
  };
};

const summarizeItemAnomalies = (anomalies: ItemAnomaly[] = []): PayloadItemAnomaliesSummary => ({
  total: anomalies.length,
  autoFixed: anomalies.filter((anomaly) => anomaly.status === 'auto_fixed').length,
  flagged: anomalies.filter((anomaly) => anomaly.status === 'flagged').length,
  excluded: anomalies.filter((anomaly) => anomaly.status === 'excluded').length,
  high: anomalies.filter((anomaly) => anomaly.severity === 'high').length,
  medium: anomalies.filter((anomaly) => anomaly.severity === 'medium').length,
  low: anomalies.filter((anomaly) => anomaly.severity === 'low').length
});

const normalizeEmpresaLayoutItems = (
  items: NormalizedBillItem[],
  logicalLines?: LogicalLine[],
  scopePages?: number[],
  subtotalLines?: Array<{ page: number; amount: number; text: string }>
): { items: NormalizedBillItem[]; anomalies: ItemAnomaly[] } => {
  const anomalies: ItemAnomaly[] = [];
  const pendingNegativeRows: Array<{
    page: number;
    itemId: string;
    code?: string;
    date?: string;
    description: string;
    rawText: string;
    originalTotal: number;
  }> = [];
  const normalizedItems = items.flatMap((item) => {
    const rawText = String(item.rawText || '');
    const baseInfo = {
      page: Math.max(1, Number(item.page || 1)),
      itemId: item.id,
      code: item.code,
      date: item.date,
      description: String(item.description || item.rawText || '').trim(),
      rawText
    };
    if (isNegativeEmpresaLayoutRow(rawText)) {
      pendingNegativeRows.push({
        ...baseInfo,
        originalTotal: Math.round(Number(item.total || 0))
      });
      return [];
    }

    const columns = extractEmpresaLayoutColumnsFromRawText(rawText);
    if (!columns) return [item];

    const total = Math.round(Number(item.total || 0));
    const placeholder = isPlaceholderEmpresaLayoutTotal(item);
    const valueIsZeroLine = columns.valorIsa <= 0 && columns.valorBruto <= 0 && columns.afecto <= 0 && columns.iva <= 0;
    const zeroBackedLine = isZeroBackedEmpresaLayoutRow(rawText);
    if (placeholder && valueIsZeroLine) {
      anomalies.push({
        id: `anom-placeholder-${item.id}`,
        ...baseInfo,
        status: 'excluded',
        severity: 'high',
        category: 'placeholder_total',
        detail: 'Fila placeholder descartada: monto artificial sin respaldo estructurado.',
        originalTotal: total,
        evidence: columns
      });
      return [];
    }
    if (zeroBackedLine && total > 0) {
      anomalies.push({
        id: `anom-zero-backed-${item.id}`,
        ...baseInfo,
        status: 'excluded',
        severity: 'high',
        category: 'zero_backed_amount',
        detail: 'Fila descartada: cola estructural completa en cero con monto aislado.',
        originalTotal: total,
        evidence: columns
      });
      return [];
    }

    if (placeholder && columns.valorIsa > 0 && columns.valorIsa < total) {
      const normalizedTotal = Math.round(columns.valorIsa);
      anomalies.push({
        id: `anom-fix-${item.id}`,
        ...baseInfo,
        status: 'auto_fixed',
        severity: 'medium',
        category: 'structured_total_correction',
        detail: 'Total placeholder autocorregido usando valor estructurado de la fila.',
        originalTotal: total,
        normalizedTotal,
        evidence: columns
      });
      return [{
        ...item,
        total: normalizedTotal,
        unitPrice: Number(item.quantity || item.fields?.cantidad || 0) > 1
          ? Math.round(normalizedTotal / Math.max(1, Number(item.quantity || item.fields?.cantidad || 1)))
          : normalizedTotal,
        fields: {
          ...(item.fields || {}),
          valor: normalizedTotal
        }
      }];
    }

    return [item];
  });
  const scopeSet = new Set((scopePages || []).filter((page) => Number(page || 0) > 0).map((page) => Number(page || 0)));
  if (!logicalLines?.length || !scopeSet.size || !pendingNegativeRows.length) {
    pendingNegativeRows.forEach((entry) => {
      anomalies.push({
        id: `anom-negative-${entry.itemId}`,
        page: entry.page,
        itemId: entry.itemId,
        code: entry.code,
        date: entry.date,
        description: entry.description,
        rawText: entry.rawText,
        status: 'excluded',
        severity: 'high',
        category: 'negative_row',
        detail: 'Fila con monto negativo/reverso excluida del detalle canónico.',
        originalTotal: entry.originalTotal
      });
    });
    return { items: normalizedItems, anomalies };
  }

  const pendingNegativeMap = new Map<string, typeof pendingNegativeRows[number]>();
  pendingNegativeRows.forEach((entry) => {
    const key = `${entry.page}|${normalizeDenseNumericText(String(entry.rawText || '').replace(/\s+/g, ' ').trim())}`;
    if (!pendingNegativeMap.has(key)) pendingNegativeMap.set(key, entry);
  });

  const adjustedItems: Array<NormalizedBillItem | null> = [...normalizedItems];
  const subtotalDiagnostics = logicalLines?.length && Array.isArray(subtotalLines) && subtotalLines.length > 0
    ? buildEmpresaSubtotalDiagnostics(normalizedItems, subtotalLines, logicalLines)
    : [];
  const remainingPositiveGapByBlock = new Map<string, number>();
  subtotalDiagnostics.forEach((block) => {
    const blockKey = `${block.startPage}-${block.endPage}-${block.subtotalPage}`;
    remainingPositiveGapByBlock.set(blockKey, Math.max(0, Math.round(Number(block.gaps.itemTotal || 0))));
  });
  const negativeAdjustments = logicalLines
    .filter((line) => scopeSet.has(Math.max(1, Number(line.page || 1))))
    .sort((a, b) => comparePageY(Number(a.page || 0), Number(a.bbox?.y || 0), Number(b.page || 0), Number(b.bbox?.y || 0)))
    .map((line) => extractEmpresaNegativeAdjustmentLineCandidate(line))
    .filter((candidate): candidate is EmpresaNegativeAdjustmentCandidate => Boolean(candidate));

  for (const adjustment of negativeAdjustments) {
    const adjustmentKey = `${Math.max(1, Number(adjustment.line.page || 1))}|${normalizeDenseNumericText(String(adjustment.line.fullText || '').replace(/\s+/g, ' ').trim())}`;
    pendingNegativeMap.delete(adjustmentKey);
    const adjustmentDescKey = canonicalDescriptionForKey(adjustment.description);
    const adjustmentDateKey = parseSortableClinicalDate(adjustment.date);
    const block = subtotalDiagnostics.find((entry) =>
      Math.max(1, Number(adjustment.line.page || 1)) >= Math.max(1, Number(entry.startPage || 1)) &&
      Math.max(1, Number(adjustment.line.page || 1)) <= Math.max(1, Number(entry.endPage || 1))
    ) || null;
    const blockKey = block ? `${block.startPage}-${block.endPage}-${block.subtotalPage}` : '';

    let best: {
      index: number;
      mode: 'drop_item' | 'decrement_unit';
      score: number;
    } | null = null;

    for (let index = 0; index < adjustedItems.length; index += 1) {
      const item = adjustedItems[index];
      if (!item) continue;
      const itemTotal = Math.round(Number(item.total || 0));
      if (!(itemTotal > 0)) continue;
      if (Math.max(1, Number(item.page || 1)) > Math.max(1, Number(adjustment.line.page || 1))) continue;

      const itemDescription = cleanClinicalDescriptionWithLeadingCode(item.description || item.rawText || '');
      const itemDescKey = canonicalDescriptionForKey(itemDescription);
      if (!itemDescKey || !adjustmentDescKey || itemDescKey !== adjustmentDescKey) continue;

      const itemDate = String(item.date || item.fields?.fecha || '').trim();
      if (itemDate && adjustment.date && itemDate !== adjustment.date) continue;

      const itemCode = String(item.codeInternal || item.code || item.fields?.codigo || '').trim();

      const quantity = Math.max(0, Number(item.quantity ?? item.fields?.cantidad ?? 0));
      const unitPrice = Math.round(Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0));
      const rawMoneyContext = extractRawLineMoneyContext(String(item.rawText || ''));
      const rawQuantity = Math.max(0, Number(rawMoneyContext.quantity || 0));
      const rawMoneyTokens = rawMoneyContext.moneyTokens
        .map((value) => Math.round(Number(value || 0)))
        .filter((value) => value > 0 && value <= RAW_ITEM_MAX_TOTAL);
      const structuredUnitFromRaw = rawQuantity > 1
        ? (rawMoneyTokens.find((value) =>
          Math.abs(value * rawQuantity - itemTotal) <= Math.max(2, Math.round(itemTotal * 0.01))
        ) || rawMoneyTokens.find((value) => value < itemTotal) || 0)
        : 0;
      const derivedUnitFromRawTotal = rawQuantity > 1 && itemTotal > 0
        ? Math.max(1, Math.round(itemTotal / rawQuantity))
        : 0;
      const effectiveQuantity = Math.max(quantity, rawQuantity);
      const effectiveUnitPrice = [unitPrice, structuredUnitFromRaw, derivedUnitFromRawTotal]
        .filter((value) => value > 0)
        .sort((a, b) => Math.abs(a - adjustment.amount) - Math.abs(b - adjustment.amount))[0] || 0;
      const itemDateKey = parseSortableClinicalDate(itemDate);
      const pageDistance = Math.max(0, Math.max(1, Number(adjustment.line.page || 1)) - Math.max(1, Number(item.page || 1)));
      const yDistance = Math.abs(Number(adjustment.line.bbox?.y || 0) - Number(item.bbox?.y || 0));
      const beforeAdjustmentOnSamePage = pageDistance === 0
        ? Number(item.bbox?.y || 0) <= Number(adjustment.line.bbox?.y || 0)
        : true;
      const dateDistance = adjustmentDateKey > 0 && itemDateKey > 0 ? Math.abs(adjustmentDateKey - itemDateKey) : 999999;

      let mode: 'drop_item' | 'decrement_unit' | null = null;
      let score = 0;
      const exactCodeMatch = Boolean(adjustment.code && itemCode && adjustment.code === itemCode);
      const codeMismatch = Boolean(adjustment.code && itemCode && adjustment.code !== itemCode);

      if (Math.abs(itemTotal - adjustment.amount) <= 2) {
        mode = 'drop_item';
        score = 320;
      } else if (
        effectiveQuantity > 1 &&
        effectiveUnitPrice > 0 &&
        Math.abs(effectiveUnitPrice - adjustment.amount) <= 2 &&
        itemTotal - adjustment.amount > 0
      ) {
        mode = 'decrement_unit';
        score = 280;
      }

      if (!mode) continue;

      score += exactCodeMatch ? 40 : 0;
      score += codeMismatch ? -20 : 0;
      score += itemDate && adjustment.date && itemDate === adjustment.date ? 30 : 0;
      score += beforeAdjustmentOnSamePage ? 20 : -40;
      score += mode === 'decrement_unit' && exactCodeMatch && pageDistance === 0 ? 70 : 0;
      score += mode === 'drop_item' && codeMismatch && pageDistance > 1 ? -90 : 0;
      score -= Math.min(60, pageDistance * 15);
      score -= Math.min(40, Math.round(yDistance / 16));
      score -= Math.min(60, Math.round(dateDistance / 3));

      if (!best || score > best.score) {
        best = { index, mode, score };
      }
    }

    if (!best) {
      anomalies.push({
        id: `anom-empresa-negative-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        code: adjustment.code,
        date: adjustment.date,
        description: adjustment.description,
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'excluded',
        severity: 'high',
        category: 'negative_row',
        detail: 'Reverso Empresa detectado, pero sin item positivo compatible para netear.',
        originalTotal: adjustment.amount,
        evidence: adjustment.evidence || undefined
      });
      continue;
    }

    const remainingBlockGap = blockKey ? Number(remainingPositiveGapByBlock.get(blockKey) || 0) : Number.POSITIVE_INFINITY;
    const allowSmallOvershoot = 250;
    if (Number.isFinite(remainingBlockGap) && remainingBlockGap <= 0) {
      anomalies.push({
        id: `anom-empresa-negative-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        code: adjustment.code,
        date: adjustment.date,
        description: adjustment.description,
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'excluded',
        severity: 'medium',
        category: 'negative_row',
        detail: 'Reverso Empresa conservado como traza: el subtotal del bloque ya no requiere mas neteo.',
        originalTotal: adjustment.amount,
        evidence: adjustment.evidence || undefined
      });
      continue;
    }
    if (Number.isFinite(remainingBlockGap) && adjustment.amount > remainingBlockGap + allowSmallOvershoot) {
      anomalies.push({
        id: `anom-empresa-negative-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        code: adjustment.code,
        date: adjustment.date,
        description: adjustment.description,
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'excluded',
        severity: 'medium',
        category: 'negative_row',
        detail: 'Reverso Empresa conservado como traza: aplicarlo sobrepasaria el subtotal del bloque.',
        originalTotal: adjustment.amount,
        evidence: adjustment.evidence || undefined
      });
      continue;
    }

    const targetItem = adjustedItems[best.index];
    if (!targetItem) continue;
    const originalTotal = Math.round(Number(targetItem.total || 0));
    const originalQuantity = Math.max(0, Number(targetItem.quantity ?? targetItem.fields?.cantidad ?? 0));
    const originalUnitPrice = Math.round(Number(targetItem.unitPrice ?? targetItem.fields?.precioUnitario ?? 0));
    const targetRawMoneyContext = extractRawLineMoneyContext(String(targetItem.rawText || ''));
    const targetRawQuantity = Math.max(0, Number(targetRawMoneyContext.quantity || 0));
    const targetRawMoneyTokens = targetRawMoneyContext.moneyTokens
      .map((value) => Math.round(Number(value || 0)))
      .filter((value) => value > 0 && value <= RAW_ITEM_MAX_TOTAL);
    const targetStructuredUnit = targetRawQuantity > 1
      ? (targetRawMoneyTokens.find((value) =>
        Math.abs(value * targetRawQuantity - originalTotal) <= Math.max(2, Math.round(originalTotal * 0.01))
      ) || targetRawMoneyTokens.find((value) => value < originalTotal) || 0)
      : 0;
    const derivedTargetUnitFromRawTotal = targetRawQuantity > 1 && originalTotal > 0
      ? Math.max(1, Math.round(originalTotal / targetRawQuantity))
      : 0;
    const baseQuantity = Math.max(originalQuantity, targetRawQuantity);
    const baseUnitPrice = [originalUnitPrice, targetStructuredUnit, derivedTargetUnitFromRawTotal]
      .filter((value) => value > 0)
      .sort((a, b) => Math.abs(a - adjustment.amount) - Math.abs(b - adjustment.amount))[0] || originalUnitPrice;

    if (best.mode === 'drop_item') {
      adjustedItems[best.index] = null;
      anomalies.push({
        id: `anom-empresa-reversal-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        itemId: targetItem.id,
        code: targetItem.code || targetItem.codeInternal,
        date: targetItem.date,
        description: String(targetItem.description || targetItem.rawText || '').trim(),
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'auto_fixed',
        severity: 'medium',
        category: 'reversal_applied',
        detail: 'Reverso Empresa aplicado excluyendo un item positivo completo del detalle neto.',
        originalTotal,
        normalizedTotal: 0,
        evidence: {
          ...(adjustment.evidence || {}),
          quantity: baseQuantity || undefined,
          unitPrice: baseUnitPrice || undefined,
          expectedTotal: adjustment.amount
        }
      });
      if (blockKey) {
        remainingPositiveGapByBlock.set(blockKey, remainingBlockGap - adjustment.amount);
      }
      continue;
    }

    const nextQuantity = Math.max(1, baseQuantity - 1);
    const nextTotal = Math.max(0, originalTotal - adjustment.amount);
    if (!(nextTotal > 0)) {
      adjustedItems[best.index] = null;
      anomalies.push({
        id: `anom-empresa-reversal-${adjustment.line.id}`,
        page: Math.max(1, Number(adjustment.line.page || 1)),
        itemId: targetItem.id,
        code: targetItem.code || targetItem.codeInternal,
        date: targetItem.date,
        description: String(targetItem.description || targetItem.rawText || '').trim(),
        rawText: String(adjustment.line.fullText || '').trim(),
        status: 'auto_fixed',
        severity: 'medium',
        category: 'reversal_applied',
        detail: 'Reverso Empresa aplicado agotando el item positivo asociado.',
        originalTotal,
        normalizedTotal: 0,
        evidence: {
          ...(adjustment.evidence || {}),
          quantity: baseQuantity || undefined,
          unitPrice: baseUnitPrice || undefined,
          expectedTotal: adjustment.amount
        }
      });
      if (blockKey) {
        remainingPositiveGapByBlock.set(blockKey, remainingBlockGap - adjustment.amount);
      }
      continue;
    }

    const normalizedUnitPrice = baseUnitPrice > 0 ? baseUnitPrice : Math.max(1, Math.round(nextTotal / Math.max(1, nextQuantity)));
    adjustedItems[best.index] = {
      ...targetItem,
      total: nextTotal,
      quantity: nextQuantity,
      unitPrice: normalizedUnitPrice,
      fields: {
        ...(targetItem.fields || {}),
        cantidad: nextQuantity,
        precioUnitario: normalizedUnitPrice,
        valor: nextTotal
      }
    };
    anomalies.push({
      id: `anom-empresa-reversal-${adjustment.line.id}`,
      page: Math.max(1, Number(adjustment.line.page || 1)),
      itemId: targetItem.id,
      code: targetItem.code || targetItem.codeInternal,
      date: targetItem.date,
      description: String(targetItem.description || targetItem.rawText || '').trim(),
      rawText: String(adjustment.line.fullText || '').trim(),
      status: 'auto_fixed',
      severity: 'medium',
      category: 'reversal_applied',
      detail: 'Reverso Empresa aplicado reduciendo una unidad del item positivo asociado.',
      originalTotal,
      normalizedTotal: nextTotal,
      evidence: {
        ...(adjustment.evidence || {}),
        quantity: baseQuantity || undefined,
        unitPrice: baseUnitPrice || undefined,
        expectedTotal: adjustment.amount
      }
    });
    if (blockKey) {
      remainingPositiveGapByBlock.set(blockKey, remainingBlockGap - adjustment.amount);
    }
  }

  pendingNegativeMap.forEach((entry) => {
    anomalies.push({
      id: `anom-negative-${entry.itemId}`,
      page: entry.page,
      itemId: entry.itemId,
      code: entry.code,
      date: entry.date,
      description: entry.description,
      rawText: entry.rawText,
      status: 'excluded',
      severity: 'high',
      category: 'negative_row',
      detail: 'Fila con monto negativo/reverso excluida del detalle canónico.',
      originalTotal: entry.originalTotal
    });
  });

  return {
    items: adjustedItems.filter((item): item is NormalizedBillItem => Boolean(item) && Math.round(Number(item.total || 0)) > 0),
    anomalies
  };
};

const detectNumericItemAnomalies = (items: NormalizedBillItem[]): ItemAnomaly[] => {
  const anomalies: ItemAnomaly[] = [];
  for (const item of items) {
    const rawText = String(item.rawText || '').replace(/\s+/g, ' ').trim();
    const description = String(item.description || rawText || '').trim();
    const total = Math.round(Number(item.total || 0));
    const quantity = Number(item.quantity ?? item.fields?.cantidad ?? 0);
    const unitPrice = Math.round(Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0));
    const expectedTotal = quantity > 0 && unitPrice > 0 ? Math.round(quantity * unitPrice) : 0;
    const columns = extractEmpresaLayoutColumnsFromRawText(rawText);
    const structuredCandidates = columns
      ? [
        columns.valorBruto,
        columns.valorIsa,
        columns.empresa,
        columns.afecto + columns.iva,
        columns.exento + columns.afecto + columns.iva
      ].map((value) => Math.round(Number(value || 0))).filter((value) => value > 0)
      : [];
    const matchesStructured = structuredCandidates.some((value) => Math.abs(value - total) <= Math.max(2, value * 0.01));

    if (columns && total > 0 && structuredCandidates.length > 0 && !matchesStructured) {
      anomalies.push({
        id: `anom-unbacked-${item.id}`,
        page: Math.max(1, Number(item.page || 1)),
        itemId: item.id,
        code: item.code,
        date: item.date,
        description,
        rawText,
        status: 'flagged',
        severity: 'high',
        category: 'unbacked_total',
        detail: 'Total final no coincide con ninguna columna estructurada visible en la fila.',
        originalTotal: total,
        evidence: {
          ...columns,
          quantity: quantity > 0 ? quantity : undefined,
          unitPrice: unitPrice > 0 ? unitPrice : undefined,
          expectedTotal: expectedTotal > 0 ? expectedTotal : undefined
        }
      });
    }

    if (expectedTotal > 0 && total > 0) {
      const delta = Math.abs(expectedTotal - total);
      const shouldFlagUnitMismatch =
        (quantity === 1 && delta > 100) ||
        delta > Math.max(100, expectedTotal * 0.2);
      if (shouldFlagUnitMismatch && !matchesStructured) {
        anomalies.push({
          id: `anom-unit-${item.id}`,
          page: Math.max(1, Number(item.page || 1)),
          itemId: item.id,
          code: item.code,
          date: item.date,
          description,
          rawText,
          status: 'flagged',
          severity: quantity === 1 ? 'medium' : 'high',
          category: 'unit_total_mismatch',
          detail: 'Cantidad x precio unitario no respalda el total final del item.',
          originalTotal: total,
          evidence: {
            ...(columns || {}),
            quantity,
            unitPrice,
            expectedTotal
          }
        });
      }
    }
  }
  return anomalies;
};

const extractSubtotalAmountFromRowText = (text: string): number => {
  const source = String(text || '');
  const normalizedSource = normalizeDenseNumericText(source);
  const normalized = normalize(source).toUpperCase();
  const isTotalEmpresa = hasTotalEmpresaSignal(source);
  const markerIdx = normalized.indexOf('SUB TOTAL POR PRESTADOR') >= 0
    ? normalized.indexOf('SUB TOTAL POR PRESTADOR')
    : normalized.indexOf('SUBTOTAL POR PRESTADOR');
  const tail = markerIdx >= 0 ? normalizedSource.slice(markerIdx) : normalizedSource;
  const tokenTexts = tail.match(RAW_NUMBER_TOKEN_RE) || [];
  if (!tokenTexts.length) return 0;

  const parsed = tokenTexts
    .map((token) => ({ token, value: parseMoney(token) }))
    .filter((entry) => entry.value >= 1000 && entry.value <= RAW_ITEM_MAX_TOTAL);
  if (!parsed.length) return 0;

  if (isTotalEmpresa) {
    const grouped = parsed.filter((entry) => /[.,]/.test(String(entry.token)));
    const sourceList = grouped.length ? grouped : parsed;
    if (sourceList.length >= 2) return sourceList[sourceList.length - 2].value;
    return sourceList[sourceList.length - 1].value;
  }

  const grouped = parsed.filter((entry) => /[.,]/.test(String(entry.token)));
  if (grouped.length) return grouped[0].value;
  return parsed[0].value;
};

const isPamCitationReferenceLine = (value: string): boolean => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const upper = normalize(text).toUpperCase();
  if (!upper) return false;
  const hasPamId = /\bP\.?A\.?M\s*:\s*\d/i.test(upper);
  const hasRole = /\bROL\b/i.test(upper);
  const hasRutLike = /\b\d{1,2}[.,]\d{3}[.,]\d{3}\s*-\s*[0-9K]\b/i.test(text) || /\b\d{7,8}\s*-\s*[0-9K]\b/i.test(text);
  return hasPamId && hasRole && hasRutLike;
};

const hasPamPageSignal = (value: string): boolean => {
  const n = normalize(value).toUpperCase();
  if (!n) return false;
  if (isPamCitationReferenceLine(value)) return false;
  return n.includes('PROGRAMA DE ATENCION MEDICA') ||
    n.includes('DOCUMENTOS VALORIZADOS') ||
    n.includes('DEPARTAMENTO DE BENEFICIOS') ||
    /FOLIO\s+P\.?A\.?M/i.test(n) ||
    /TOTAL\s+P\.?A\.?M/i.test(n) ||
    /POLI\s+P\.?A\.?M/i.test(n) ||
    /DOCUMENTO ASOCIADO:\s*P\.?A\.?M/i.test(n);
};

const hasBillStructureSignal = (value: string): boolean => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const upper = normalize(text).toUpperCase();
  return hasBillPageSignal(text) ||
    hasSantaMariaSubtotalSignal(text) ||
    hasTotalEmpresaSignal(text) ||
    hasClinicTotalGeneralSignal(text) ||
    upper.includes('TOTAL HONORARIOS MEDICOS') ||
    upper.includes('TOTAL CLINICA + SERVICIOS');
};

const hasStrongPamDocumentSignal = (value: string): boolean => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (isPamCitationReferenceLine(text)) return false;
  return hasPamPageSignal(text) || isPamRawDescription(text);
};

const isPamOnlyContextSignal = (value: string): boolean =>
  hasStrongPamDocumentSignal(value) && !hasBillStructureSignal(value);

const hasBillPageSignal = (value: string): boolean => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  // Avoid recursive classification loop:
  // isPamOnlyContextSignal -> hasBillStructureSignal -> hasBillPageSignal -> isPamOnlyContextSignal
  if (isAdministrativeRawDescription(text) || isPamResidualNoise(text) || hasStrongPamDocumentSignal(text)) return false;
  const upper = normalize(text).toUpperCase();
  if (upper.includes('CODIGO') && upper.includes('DESCRIP') && (upper.includes('CANT') || upper.includes('PRECIO') || upper.includes('VALOR'))) return true;
  const hasCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
  const hasDate = Boolean(findClinicalDateMatch(text));
  const moneyTokens = extractMonetaryCandidatesFromText(text, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true
  }).filter((v) => v >= RAW_ITEM_MIN_TOTAL && v <= RAW_ITEM_MAX_TOTAL);
  return (hasCode && moneyTokens.length >= 1) || (hasDate && moneyTokens.length >= 2);
};

type RowScopeSeed = {
  page: number;
  text: string;
  pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown';
};

const computeDocumentZones = (rows: RowScopeSeed[]) => {
  const byPage = new Map<number, RowScopeSeed[]>();
  for (const row of rows) {
    const page = Number(row.page || 0);
    const text = String(row.text || '').trim();
    if (!(page > 0) || !text) continue;
    const current = byPage.get(page) || [];
    current.push({ page, text, pageClass: row.pageClass });
    byPage.set(page, current);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const pageSignals = new Map<number, { pam: boolean; bill: boolean; totalGeneral: boolean }>();
  for (const page of pages) {
    const pageRows = byPage.get(page) || [];
    const billStructureHits = pageRows.filter((row) => row.pageClass === 'bill' || hasBillStructureSignal(row.text)).length;
    const pamStructureHits = pageRows.filter((row) => row.pageClass === 'pam' || isPamOnlyContextSignal(row.text)).length;
    const billSignal = billStructureHits > 0;
    const pamSignal = pamStructureHits > 0 && billStructureHits === 0;
    const totalGeneralSignal = pageRows.some((row) => normalize(row.text).toUpperCase().includes('TOTAL GENERAL'));
    pageSignals.set(page, { pam: pamSignal, bill: billSignal, totalGeneral: totalGeneralSignal });
  }

  let pamStartPage: number | null = null;
  for (let i = 0; i < pages.length; i += 1) {
    const windowPages = pages.slice(i, i + 3);
    const pamHits = windowPages.filter((page) => pageSignals.get(page)?.pam === true).length;
    if (pamHits >= 2) {
      pamStartPage = windowPages.find((page) => pageSignals.get(page)?.pam === true) || pages[i];
      break;
    }
  }
  if (!pamStartPage) {
    pamStartPage = pages.find((page) => pageSignals.get(page)?.pam === true) || null;
  }

  let billBoundaryPage: number | null = null;
  if (pamStartPage) {
    const candidates = pages.filter((page) => page < pamStartPage && pageSignals.get(page)?.bill === true);
    if (candidates.length) {
      billBoundaryPage = Math.max(...candidates);
    } else if (pamStartPage > 1) {
      billBoundaryPage = pamStartPage - 1;
    }
  } else {
    const candidates = pages.filter((page) => pageSignals.get(page)?.bill === true);
    if (candidates.length) billBoundaryPage = Math.max(...candidates);
  }

  const pamPages = new Set<number>(
    pamStartPage ? pages.filter((page) => page >= pamStartPage) : pages.filter((page) => pageSignals.get(page)?.pam === true)
  );
  const billPages = new Set<number>(
    billBoundaryPage ? pages.filter((page) => page <= billBoundaryPage) : pages.filter((page) => pageSignals.get(page)?.bill === true)
  );

  return {
    pages,
    pageSignals,
    pamPages,
    billPages,
    pamStartPage,
    billBoundaryPage
  };
};

const resolveIsapreDeclaredTotals = (rows: NormalizedRow[], logicalLines: LogicalLine[] = []) => {
  const uniqueRows = new Map<string, { page: number; y: number; text: string; pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown' }>();
  for (const row of rows) {
    const text = String(row.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    uniqueRows.set(`${row.page}|${Math.round(Number(row.bbox?.y || 0))}|${normalize(text)}`, {
      page: Number(row.page || 0),
      y: Number(row.bbox?.y || 0),
      text,
      pageClass: row.pageClass
    });
  }
  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex += 1) {
    const line = logicalLines[lineIndex];
    const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!hasTotalLineSignal(text) && !hasSubtotalLineSignal(text)) continue;
    uniqueRows.set(`logical|${line.page}|${Math.round(Number(line.bbox?.y || 0))}|${normalize(text)}`, {
      page: Number(line.page || 0),
      y: Number(line.bbox?.y || 0),
      text,
      pageClass: 'summary'
    });
  }
  const dedupedRows = [...uniqueRows.values()].sort((a, b) =>
    Number(a.page || 0) - Number(b.page || 0) || Number(a.y || 0) - Number(b.y || 0)
  );
  const zones = computeDocumentZones(dedupedRows);
  const pamPages = zones.pamPages;
  const billPages = zones.billPages;

  const subtotalsPorPrestador: Array<{ page: number; amount: number; text: string }> = [];
  const includedSubtotalsBill: Array<{ page: number; amount: number; text: string }> = [];
  const includedSubtotalsPam: Array<{ page: number; amount: number; text: string }> = [];
  const excludedSubtotals: Array<{ page: number; amount: number; reason: 'pam' | 'noise'; text: string }> = [];
  const totalGeneralCandidates: Array<{
    page: number;
    amount: number;
    text: string;
    detectedBy: 'same_row' | 'lookahead_1' | 'lookahead_2' | 'lookahead_3';
    pageLooksPam: boolean;
    pageLooksBill: boolean;
  }> = [];

  const resolveTotalGeneralWithLookAhead = (startIdx: number): { amount: number; text: string; detectedBy: 'same_row' | 'lookahead_1' | 'lookahead_2' | 'lookahead_3' } | null => {
    const row = dedupedRows[startIdx];
    if (!row) return null;
    const own = extractMonetaryCandidatesFromText(row.text, {
      excludeLikelyIdentifiers: true,
      requireMoneySignature: true,
      tableLike: true
    }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
    if (own.length > 0) {
      return {
        amount: Math.max(...own),
        text: row.text,
        detectedBy: 'same_row'
      };
    }
    for (let step = 1 as 1 | 2 | 3; step <= 3; step += 1) {
      const next = dedupedRows[startIdx + step];
      if (!next || Number(next.page || 0) !== Number(row.page || 0)) break;
      if (Math.abs(Number(next.y || 0) - Number(row.y || 0)) > 120) break;
      const nextValues = extractMonetaryCandidatesFromText(next.text, {
        excludeLikelyIdentifiers: true,
        requireMoneySignature: true,
        tableLike: true
      }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
      if (nextValues.length > 0) {
        return {
          amount: Math.max(...nextValues),
          text: `${row.text} || ${next.text}`,
          detectedBy: `lookahead_${step}` as const
        };
      }
    }
    return null;
  };

  for (let idx = 0; idx < dedupedRows.length; idx += 1) {
    const row = dedupedRows[idx];
    const text = row.text;
    const upper = normalize(text).toUpperCase();
    const pageIsPam = pamPages.has(Number(row.page || 0));
    const pageIsBill = billPages.has(Number(row.page || 0));
    const rowLooksPam = row.pageClass === 'pam' || pageIsPam || isPamOnlyContextSignal(text);

    if (hasClinicTotalGeneralSignal(text) || hasPamTotalSignal(text)) {
      const resolved = resolveTotalGeneralWithLookAhead(idx);
      if (resolved) {
        totalGeneralCandidates.push({
          page: row.page,
          amount: resolved.amount,
          text: resolved.text,
          detectedBy: resolved.detectedBy,
          pageLooksPam: rowLooksPam,
          pageLooksBill: pageIsBill || hasBillPageSignal(text)
        });
      }
      continue;
    }

    const isSubtotalPrestador =
      upper.includes('SUB TOTAL POR PRESTADOR') ||
      upper.includes('SUBTOTAL POR PRESTADOR') ||
      hasTotalEmpresaSignal(text);
    if (!isSubtotalPrestador) continue;

    const amount = extractSubtotalAmountFromRowText(text);
    if (!(amount >= 1000 && amount <= RAW_ITEM_MAX_TOTAL)) {
      excludedSubtotals.push({ page: row.page, amount: 0, reason: 'noise', text });
      continue;
    }

    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      excludedSubtotals.push({ page: row.page, amount, reason: 'noise', text });
      continue;
    }

    subtotalsPorPrestador.push({ page: row.page, amount, text });
    if (rowLooksPam) {
      includedSubtotalsPam.push({ page: row.page, amount, text });
      excludedSubtotals.push({ page: row.page, amount, reason: 'pam', text });
      continue;
    }

    if (pageIsBill || !pageIsPam) {
      includedSubtotalsBill.push({ page: row.page, amount, text });
    }
  }

  const sortTotalCandidates = (
    candidates: Array<{
      page: number;
      amount: number;
      text: string;
      detectedBy: 'same_row' | 'lookahead_1' | 'lookahead_2' | 'lookahead_3';
      pageLooksPam: boolean;
      pageLooksBill: boolean;
    }>
  ) => [...candidates].sort((a, b) => b.amount - a.amount || a.page - b.page);

  let billTotalCandidate = sortTotalCandidates(
    totalGeneralCandidates.filter((candidate) => candidate.pageLooksBill && !candidate.pageLooksPam)
  )[0] || null;

  const pamTotalCandidate = sortTotalCandidates(
    totalGeneralCandidates.filter((candidate) => candidate.pageLooksPam)
  )[0] || null;

  const clinicTotalCandidate = billTotalCandidate
    || sortTotalCandidates(totalGeneralCandidates.filter((candidate) => !candidate.pageLooksPam))[0]
    || sortTotalCandidates(totalGeneralCandidates)[0]
    || null;

  // Transitional fallback: if TOTAL GENERAL is on the first mixed page right after BILL boundary,
  // treat it as billDeclaredTotal for basic reconciliation in Cuenta mode.
  const transitionPage = zones.billBoundaryPage && zones.billBoundaryPage > 0 ? zones.billBoundaryPage + 1 : null;
  if (!billTotalCandidate && clinicTotalCandidate && transitionPage && Number(clinicTotalCandidate.page || 0) === Number(transitionPage || 0)) {
    const transitionRows = dedupedRows.filter((row) => Number(row.page || 0) === Number(transitionPage || 0));
    const transitionHasBillSignals = transitionRows.some((row) => hasBillPageSignal(row.text));
    if (transitionHasBillSignals) {
      billTotalCandidate = clinicTotalCandidate;
    }
  }

  const clinicTotalGeneral = clinicTotalCandidate
    ? {
      page: clinicTotalCandidate.page,
      amount: clinicTotalCandidate.amount,
      text: clinicTotalCandidate.text,
      detectedBy: clinicTotalCandidate.detectedBy
    }
    : null;

  const billSubtotalSum = Math.round(includedSubtotalsBill.reduce((acc, v) => acc + v.amount, 0));
  const pamSubtotalSum = Math.round(includedSubtotalsPam.reduce((acc, v) => acc + v.amount, 0));
  const subtotalTotal = Math.round(subtotalsPorPrestador.reduce((acc, v) => acc + Math.round(Number(v.amount || 0)), 0));
  const clinicDeclaredTotal = Math.round(Number(clinicTotalGeneral?.amount || 0));
  const billDeclaredTotal = Math.round(Number(billTotalCandidate?.amount || 0));
  const pamDeclaredTotal = Math.round(Number(pamTotalCandidate?.amount || 0));
  const gapVsClinicTotal = clinicDeclaredTotal > 0
    ? Math.round(clinicDeclaredTotal - subtotalTotal)
    : null;

  const hasBill = billPages.size > 0 || billSubtotalSum > 0;
  const hasPam = pamPages.size > 0 || pamSubtotalSum > 0;
  const activeScope: 'bill' | 'pam' | 'unknown' =
    hasBill
      ? 'bill'
      : (hasPam ? 'pam' : 'unknown');
  const reconMode: 'BILL' | 'PAM' | 'MIXED' | 'UNKNOWN' =
    hasBill && hasPam ? 'MIXED' : (hasBill ? 'BILL' : (hasPam ? 'PAM' : 'UNKNOWN'));

  const clinicTotalLine = clinicTotalGeneral
    ? { page: clinicTotalGeneral.page, amount: clinicTotalGeneral.amount, text: clinicTotalGeneral.text }
    : null;
  const clinicTotalLineBill = billTotalCandidate
    ? { page: billTotalCandidate.page, amount: billTotalCandidate.amount, text: billTotalCandidate.text }
    : null;
  const clinicTotalLinePam = pamTotalCandidate
    ? { page: pamTotalCandidate.page, amount: pamTotalCandidate.amount, text: pamTotalCandidate.text }
    : null;
  const includedSubtotals = subtotalsPorPrestador;
  const isapreDeclaredSubtotalSum = subtotalTotal;

  const gapLikelyExplainedBy = excludedSubtotals.filter((row) =>
    gapVsClinicTotal !== null && Math.abs(Number(row.amount || 0) - gapVsClinicTotal) <= 2
  );

  return {
    clinicDeclaredTotal,
    isapreDeclaredSubtotalSum,
    subtotalsDetected: includedSubtotals.length,
    gapVsClinicTotal,
    source: 'ocr-rows' as const,
    declaredTotals: {
      clinicTotalGeneral,
      subtotalsPorPrestador
    },
    details: {
      clinicTotalLine,
      includedSubtotals,
      excludedSubtotals,
      gapLikelyExplainedBy,
      activeScope,
      reconMode,
      pamPages: [...pamPages].sort((a, b) => a - b),
      billPages: [...billPages].sort((a, b) => a - b),
      billDeclaredTotal,
      pamDeclaredTotal,
      clinicTotalLineBill,
      clinicTotalLinePam,
      includedSubtotalsBill,
      includedSubtotalsPam,
      billSubtotalSum,
      pamSubtotalSum,
      pamTotalGeneral: pamDeclaredTotal,
      billBoundaryPage: zones.billBoundaryPage
    }
  };
};

const scoreBillPage = (rows: Array<{ page: number; text: string; pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown' }>, page: number): number => {
  const pageRows = rows.filter((r) => Number(r.page || 0) === Number(page || 0));
  if (!pageRows.length) return -999;
  const pageTexts = pageRows.map((r) => String(r.text || ''));
  const billStructureHits = pageTexts.filter((text) => hasBillStructureSignal(text)).length;

  const admin = pageTexts.filter((text) =>
    isAdministrativeRawDescription(text) || isPamRawDescription(text) || isPamResidualNoise(text)
  ).length;
  const pamSignals = pageTexts.filter((text) => isPamOnlyContextSignal(text)).length;
  const explicitPam = pageRows.filter((row) => row.pageClass === 'pam').length;
  const clinicalLike = pageTexts.filter((text) =>
    hasRawDetailSignature(text) && isAuditableDescription(cleanRawDescription(text))
  ).length;
  const totalGeneral = pageTexts.filter((text) => hasClinicTotalGeneralSignal(text)).length;

  return clinicalLike * 3 + billStructureHits * 2 - admin * 2 - pamSignals * 3 - explicitPam * 6 + Math.min(2, totalGeneral) * 2;
};

const resolveClinicBillBoundaryPage = (rows: NormalizedRow[]): number | null => {
  const deduped = new Map<string, { page: number; text: string; pageClass?: 'bill' | 'pam' | 'admin' | 'summary' | 'unknown' }>();
  for (const row of rows) {
    const text = String(row.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    deduped.set(`${row.page}|${normalize(text)}`, { page: Number(row.page || 0), text, pageClass: row.pageClass });
  }

  const allRows = [...deduped.values()];
  const zones = computeDocumentZones(allRows);
  const pamPages = zones.pamPages;
  if (zones.billBoundaryPage) return zones.billBoundaryPage;
  const candidates = [...new Set(allRows
    .filter((row) => {
      const upper = normalize(row.text).toUpperCase();
      const page = Number(row.page || 0);
      const rowPam = row.pageClass === 'pam';
        return hasClinicTotalGeneralSignal(upper) && !hasPamTotalSignal(upper) && !pamPages.has(page) && !rowPam;
    })
    .map((row) => Number(row.page || 0))
    .filter((page) => page > 0)
  )];
  if (!candidates.length) {
    if (pamPages.size > 0) {
      const firstPamPage = Math.min(...[...pamPages]);
      return firstPamPage > 1 ? firstPamPage - 1 : null;
    }
    return null;
  }

  let best: { page: number; score: number } | null = null;
  for (const candidatePage of candidates) {
    const score = scoreBillPage(allRows, candidatePage);
    if (!best || score > best.score || (score === best.score && candidatePage < best.page)) {
      best = { page: candidatePage, score };
    }
  }
  if (!best || best.score < 3) {
    if (pamPages.size > 0) {
      const firstPamPage = Math.min(...[...pamPages]);
      return firstPamPage > 1 ? firstPamPage - 1 : null;
    }
    return null;
  }
  return best.page;
};

const shouldUseBillBoundaryScope = (rows: NormalizedRow[], boundaryPage: number | null): boolean => {
  if (!(boundaryPage && boundaryPage > 0)) return false;
  const after = rows.filter((r) => Number(r.page || 0) > boundaryPage);
  if (after.length < 20) return false;
  const billStructuredAfter = after.filter((r) => hasBillStructureSignal(String(r.text || ''))).length;
  if (billStructuredAfter >= 4) return false;
  const pamOrNoise = after.filter((r) => {
    const text = String(r.text || '');
    return isPamOnlyContextSignal(text) || isPamResidualNoise(text) || isAdministrativeRawDescription(text);
  }).length;
  return pamOrNoise / Math.max(1, after.length) >= 0.1;
};

const shouldIncludeBoundaryPlusOneAsBill = (
  line: DerivedValuedLine,
  logicalLineById: Map<string, LogicalLine>,
  boundaryPage: number | null
): boolean => {
  if (!(boundaryPage && boundaryPage > 0)) return false;
  const pageNum = Number(line.page || 0);
  if (pageNum !== Number(boundaryPage || 0) + 1) return false;

  const logical = logicalLineById.get(String(line.logicalLineId || ''));
  const text = String(line.rawText || logical?.fullText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text)) return false;
  if (isPamOnlyContextSignal(text) || isPamResidualNoise(text) || isAdministrativeRawDescription(text)) return false;

  const amountCandidates = extractMonetaryCandidatesFromText(text, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: true,
    minAmountIfNoGrouping: 10000
  }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (!amountCandidates.length) return false;

  const hasCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
  const hasDate = Boolean(findClinicalDateMatch(text));
  const hasGloss = /[a-zA-ZÁÉÍÓÚÑáéíóúñ]{3,}/.test(text);

  return hasGloss && (hasCode || hasDate);
};

const validatePayloadStrict = (
  rows: NormalizedRow[],
  items: NormalizedBillItem[],
  pages: NormalizedBillPayload['pages']
): { flags: PayloadAuditFlags; validation: PayloadValidation; normalizedItems: NormalizedBillItem[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rowIdSet = new Set(rows.map((r) => r.id));

  const itemsOrdered = [...items].sort((a, b) => {
    const p = Number(a.page || 0) - Number(b.page || 0);
    if (p !== 0) return p;
    return Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0);
  });

  const normalizedItems = itemsOrdered.map((item, idx) => {
    const traceRowIds = Array.isArray(item.rowIds) ? item.rowIds.filter((id) => rowIdSet.has(id)) : [];
    return {
      ...item,
      index: idx + 1,
      rowIds: traceRowIds,
      trace: { rowIds: traceRowIds, calcoVisible: traceRowIds.length > 0 }
    };
  });

  let hasUnmappedItems = false;
  let hasMathErrors = false;
  let hasTaxConfusion = false;

  const duplicateKeyCount = new Map<string, number>();
  for (const item of normalizedItems) {
    const page = Number(item.page || 0);
    const description = String(item.description || '').trim();
    const rawText = String(item.rawText || '').trim();
    const total = Math.round(Number(item.total || 0));
    const bbox = item.bbox;
    const rowIds = item.trace?.rowIds || [];

    if (!(page > 0)) errors.push(`Item ${item.id} sin page valido.`);
    if (!description) errors.push(`Item ${item.id} sin description.`);
    if (!rawText) errors.push(`Item ${item.id} sin rawText.`);
    if (!(total > 0 && total <= RAW_ITEM_MAX_TOTAL)) errors.push(`Item ${item.id} con total fuera de rango (${total}).`);
    if (!bbox || Number(bbox.w || 0) <= 0 || Number(bbox.h || 0) <= 0) errors.push(`Item ${item.id} sin bbox valido.`);

    if (rowIds.length === 0) hasUnmappedItems = true;

    const quantity = Number(item.fields?.cantidad || 0);
    const unitPrice = Number(item.fields?.precioUnitario || 0);
    if (quantity > 0 && unitPrice > 0 && total > 0) {
      const expected = Math.round(quantity * unitPrice);
      if (Math.abs(expected - total) > Math.max(100, expected * 0.2)) hasMathErrors = true;
    }

    const upper = normalize(`${description} ${rawText}`).toUpperCase();
    if (upper.includes('NETO') && (upper.includes('IVA') || upper.includes('BRUTO'))) {
      hasTaxConfusion = true;
    }

    const duplicateKey = `${page}|${canonicalDescriptionForKey(description)}|${total}`;
    duplicateKeyCount.set(duplicateKey, (duplicateKeyCount.get(duplicateKey) || 0) + 1);
  }

  const hasSuspiciousDuplicates = [...duplicateKeyCount.values()].some((count) => count > 1);
  if (hasSuspiciousDuplicates) warnings.push('Se detectaron posibles duplicados en items.');
  if (hasMathErrors) warnings.push('Se detectaron discrepancias de cantidad*precio vs total en algunos items.');
  if (hasTaxConfusion) warnings.push('Se detectaron posibles lineas con mezcla neto/bruto.');
  if (hasUnmappedItems) errors.push('Existen items sin trazabilidad a filas de calco (rowIds).');

  let hasSectionMismatch = false;
  for (const [pageKey, pageData] of Object.entries(pages || {})) {
    const pageNum = Number(pageKey || 0);
    if (!(pageNum > 0)) continue;
    const pageItemsTotal = Math.round(
      normalizedItems
        .filter((item) => Number(item.page || 0) === pageNum)
        .reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0)
    );
    const pageSubtotal = Math.round(Number(pageData?.subtotal || 0));
    if (Math.abs(pageItemsTotal - pageSubtotal) > 1) {
      hasSectionMismatch = true;
      errors.push(`Descuadre en pagina ${pageNum}: subtotal=${pageSubtotal}, items=${pageItemsTotal}.`);
    }
  }

  if (normalizedItems.length === 0) warnings.push('Sin items auditables (modo filas RAW).');

  const flags: PayloadAuditFlags = {
    hasMathErrors,
    hasSectionMismatch,
    hasTaxConfusion,
    hasSuspiciousDuplicates,
    hasUnmappedItems,
    hasCompletenessGap: false
  };
  const validation: PayloadValidation = {
    isStrictAuditable: errors.length === 0,
    errors,
    warnings
  };
  return { flags, validation, normalizedItems };
};

const isAdministrativeRawDescription = (value: string): boolean => {
  const n = normalize(value).toUpperCase();
  if (!n) return true;
  if (/^CTA\d+_\d+_/.test(n)) return true;
  const patterns = [
    'FOLIO PAM',
    'FOLIO P.A.M',
    'FECHA-HORA INICIO',
    'FECHA-HORA TERMINO',
    'FECHA HORA INICIO',
    'FECHA HORA TERMINO',
    'COTIZANTE',
    'BENEFICIARIO',
    'PRESTADOR',
    'SOCIEDAD',
    'RUT',
    'DIRECCION',
    'TELEFONO',
    'PAGINA',
    'PAGINA 1 DE 1',
    'HORA IMPRESION',
    'PLAN:',
    'FACTOR/CONV',
    'DOCUMENTO ASOCIADO',
    'DOCUMENTO VALIDO POR',
    'PRESTADOR / INSTITUCION',
    'NOMBRE COTIZANTE',
    'TOTAL GENERAL',
    'TOTAL CUENTA',
    'TOTAL PAM',
    'TOTAL EMPRESA',
    'ESTADO CUENTA',
    'INFORME DE CUENTAS',
    'BONO DEBE SER COBRADO',
    'LIQUIDAC',
    'ID LIQUID',
    'FECHA CORTE',
    'EJECUTIVO',
    'NUM FICHA',
    'RUT PACIENTE',
    'RUT TITULAR',
    'PREVISION',
    'CONVENIO',
    'FECHA INGRESO',
    'FECHA ALTA',
    'TIPO COBRO',
    'TIPO ALTA',
    'LUGAR DE DERIVACION',
    'MEDICO TRATANTE'
  ];
  return patterns.some((p) => n.includes(p));
};

const isPamRawDescription = (value: string): boolean => {
  const n = normalize(value).toUpperCase();
  if (!n) return false;
  const patterns = [
    'PROGRAMA DE ATENCION MEDICA',
    'DEPARTAMENTO DE BENEFICIOS',
    'DEPARTAMENTOS DE BENEFICIOS',
    'DOCUMENTOS VALORIZADOS',
    'BONO DEBE SER COBRADO',
    'FOLIO PAM',
    'FOLIO P.A.M',
    'NOMBRE COTIZANTE',
    'COTIZANTE',
    'BENEFICIARIO',
    'PRESTADOR',
    'SOCIEDAD',
    'NOMBRE PLAN',
    'NOMBRE PRODUCTO',
    'LIBRE ELECCION',
    'P.A.M'
  ];
  return patterns.some((p) => n.includes(p));
};

const isPamResidualNoise = (value: string): boolean => {
  const n = normalize(value).toUpperCase();
  if (!n) return false;
  const patterns = [
    'PRESTACION NO CONTEMPLADA EN EL ARANCEL',
    'CARECE DE CODIGO EN EL ARANCEL',
    'ARANCEL FONASA',
    'NO TIENE COBERTURA',
    'DOCUMENTOS VALORIZADOS',
    'HORA IMPRESION',
    'DOCUMENTO VALIDO POR'
  ];
  return patterns.some((p) => n.includes(p));
};

const isCodeOnlyDescription = (value: string): boolean =>
  /^\s*\d{7,}(?:-[A-Z0-9])?\s*$/i.test(String(value || '').trim());

const isLikelyCodeLabelOnlyLine = (value: string): boolean => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (findClinicalDateMatch(text)) return false;
  const startsWithCode = /^\s*(?:CODIGO\s+)?\d{5,8}\b/i.test(text);
  if (!startsWithCode) return false;
  const moneyTokens = (normalizeDenseNumericText(text).match(RAW_NUMBER_TOKEN_RE) || [])
    .map(parseMoney)
    .filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  return moneyTokens.length <= 2;
};

const hasRawDetailSignature = (value: string): boolean => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (isAdministrativeRawDescription(text)) return false;
  if (isLikelyCodeLabelOnlyLine(text)) return false;
  const hasCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
  const hasDate = Boolean(findClinicalDateMatch(text));
  const hasLetters = /\p{L}{3,}/u.test(text);
  const numericTokens = normalizeDenseNumericText(text).match(RAW_NUMBER_TOKEN_RE) || [];
  const moneyLike = numericTokens.map(parseMoney).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (hasDate && hasLetters && moneyLike.length >= 2) return true;
  if (!hasDate) {
    const quantityRaw = parseMoney(numericTokens[0] || '');
    const hasQty = quantityRaw > 0 && quantityRaw <= 99;
    return hasCode && hasQty && moneyLike.length >= 4;
  }
  return hasCode && moneyLike.length >= 2;
};

const cleanRawDescription = (value: string): string => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const cleaned = text
    .replace(/^\d{2}-\d{2}-\d{3}-\d{2}\s+/, '')
    .replace(/^CODIGO\s+\d{5,8}\s+/i, '')
    .replace(/^\d{5,8}\s+/, '')
    .trim();
  const dateMatch = findClinicalDateMatch(cleaned);
  if (dateMatch) {
    return cleaned.slice(0, Number(dateMatch.index || 0)).trim() || text;
  }
  return cleaned || text;
};

const canonicalDescriptionForKey = (value: string): string =>
  cleanClinicalDescriptionWithLeadingCode(cleanRawDescription(value))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b\d[\d.,/-]*\b/g, ' ')
    .replace(/[|.,:;()#_%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const descriptionQuality = (value: string): number => {
  const text = String(value || '').trim();
  const letters = (text.match(/[a-zA-ZÁÉÍÓÚÑáéíóúñ]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return letters - digits * 0.35 + text.length * 0.02;
};

const isAuditableDescription = (value: string): boolean => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (!/[a-zA-ZÁÉÍÓÚÑáéíóúñ]{3,}/.test(text)) return false;
  if (isCodeOnlyDescription(text)) return false;
  if (isAdministrativeRawDescription(text)) return false;
  if (isPamRawDescription(text)) return false;
  if (isPamResidualNoise(text)) return false;
  return true;
};

const cleanAuditableItems = (items: NormalizedBillItem[]): NormalizedBillItem[] => {
  const out = new Map<string, NormalizedBillItem>();
  for (const item of items) {
    const description = cleanRawDescription(item.description || item.rawText || '');
    const total = Math.round(Number(item.total || 0));
    if (!isAuditableDescription(description)) continue;
    if (total < RAW_ITEM_MIN_TOTAL || total > RAW_ITEM_MAX_TOTAL) continue;

    const normalized: NormalizedBillItem = {
      ...item,
      description,
      total
    };
    const yBucket = Math.round(Number(normalized.bbox?.y || 0) / 8);
    const key = `${Math.max(1, Number(normalized.page || 1))}|${canonicalDescriptionForKey(description)}|${total}|${yBucket}`;
    const prev = out.get(key);
    if (!prev || descriptionQuality(normalized.description) > descriptionQuality(prev.description)) {
      out.set(key, normalized);
    }
  }
  return [...out.values()];
};

type RawLineMoneyBreakdown = {
  valor: number;
  bonificacion?: number;
  copago?: number;
  otrosMontos: number[];
  quantity: number;
  moneyTokens: number[];
  hasDate: boolean;
};

const extractRawLineMoneyContext = (value: string): { hasDate: boolean; quantity: number; moneyTokens: number[] } => {
  const text = normalizeDenseNumericText(String(value || '').replace(/\s+/g, ' ').trim());
  if (!text) return { hasDate: false, quantity: 1, moneyTokens: [] };

  const dateMatch = findClinicalDateMatch(text);
  const hasDate = Boolean(dateMatch);
  const tail = dateMatch ? text.slice((dateMatch.index || 0) + dateMatch[0].length) : text;
  const tokenTexts = tail.match(RAW_NUMBER_TOKEN_RE) || [];
  if (!tokenTexts.length) return { hasDate, quantity: 1, moneyTokens: [] };

  const parsedTokens = tokenTexts
    .map((token, idx) => {
      const raw = String(token || '').trim();
      return {
        token: raw,
        idx,
        value: parseMoney(raw),
        hasGrouping: /[.,]/.test(raw),
        digitsOnly: raw.replace(/\D/g, '')
      };
    });

  let quantity = 1;
  let quantityTokenIndex = -1;
  if (hasDate && parsedTokens.length >= 3) {
    const unitCandidate = Math.round(Number(parsedTokens[0]?.value || 0));
    const qtyCandidate = Number(parseStructuredQuantityToken(tokenTexts[1] || ''));
    const totalCandidate = Math.round(Number(parsedTokens[2]?.value || 0));
    const expectedTotal = Math.round(unitCandidate * qtyCandidate);
    const fitsStructuredTableLine =
      unitCandidate > 0 &&
      qtyCandidate > 0 &&
      qtyCandidate <= 99 &&
      totalCandidate > 0 &&
      (Math.abs(totalCandidate - expectedTotal) <= Math.max(100, expectedTotal * 0.2)
        || (qtyCandidate === 1 && Math.abs(totalCandidate - unitCandidate) <= 2));
    if (fitsStructuredTableLine) {
      quantity = qtyCandidate;
      quantityTokenIndex = 1;
    }
  }
  if (quantityTokenIndex < 0 && hasDate && parsedTokens.length >= 4) {
    const leadingInternalCode = Math.round(Number(parsedTokens[0]?.value || 0));
    const qtyCandidate = Number(parseStructuredQuantityToken(tokenTexts[1] || ''));
    const unitCandidate = Math.round(Number(parsedTokens[2]?.value || 0));
    const totalCandidate = Math.round(Number(parsedTokens[3]?.value || 0));
    const expectedTotal = Math.round(unitCandidate * qtyCandidate);
    const looksLikeEmpresaStructuredLine =
      leadingInternalCode >= 1000 &&
      qtyCandidate > 0 &&
      qtyCandidate <= 99 &&
      unitCandidate >= 1 &&
      totalCandidate > 0 &&
      (Math.abs(totalCandidate - expectedTotal) <= Math.max(100, expectedTotal * 0.2)
        || (qtyCandidate === 1 && Math.abs(totalCandidate - unitCandidate) <= 2));
    if (looksLikeEmpresaStructuredLine) {
      quantity = qtyCandidate;
      quantityTokenIndex = 1;
    }
  }
  if (quantityTokenIndex < 0) {
    const quantityRaw = Number(parseStructuredQuantityToken(tokenTexts[0] || ''));
    if (quantityRaw > 0 && quantityRaw <= 99) {
      quantity = quantityRaw;
      quantityTokenIndex = 0;
    }
  }

  const hasGroupedLarge = parsedTokens.some((candidate) => candidate.hasGrouping && candidate.value >= 1000);

  const moneyTokens = parsedTokens
    .filter((candidate) => Number.isFinite(candidate.value) && candidate.value > 0)
    .filter((candidate) => {
      if (candidate.idx === quantityTokenIndex) return false;
      if (candidate.value < RAW_ITEM_MIN_TOTAL || candidate.value > RAW_ITEM_MAX_TOTAL) return false;

      const token = String(candidate.token || '').trim();
      const hasGrouping = candidate.hasGrouping;
      const digitsOnly = candidate.digitsOnly;
      const looksLikeProcedureCode = /^\d{2}[.,]\d{2}[.,]\d{3}(?:[.,]\d{2})?$/.test(token);
      if (!hasDate && looksLikeProcedureCode) return false;
      // Plain long integers at the start of lines without date are often IDs/codes.
      if (!hasDate && !hasGrouping && candidate.idx <= 2 && digitsOnly.length >= 6) return false;
      // OCR sometimes injects a long plain integer (without thousand separators) from adjacent columns.
      if (hasDate && !hasGrouping && digitsOnly.length >= 7 && hasGroupedLarge) return false;
      return true;
    })
    .map((candidate) => candidate.value);

  return { hasDate, quantity, moneyTokens };
};

const resolveAuditableMoneyBreakdownFromRawText = (text: string, preferredTotal = 0): RawLineMoneyBreakdown => {
  if (isLikelyCodeLabelOnlyLine(text)) {
    return { valor: 0, otrosMontos: [], quantity: 1, moneyTokens: [], hasDate: false };
  }

  const preferred = Number(preferredTotal || 0);
  const ctx = extractRawLineMoneyContext(text);
  const money = ctx.moneyTokens.map((n) => Math.round(Number(n || 0))).filter((n) => n > 0);
  if (!money.length) {
    return { valor: 0, otrosMontos: [], quantity: ctx.quantity, moneyTokens: [], hasDate: ctx.hasDate };
  }
  if (!ctx.hasDate && money.length < 3) {
    return { valor: 0, otrosMontos: [], quantity: ctx.quantity, moneyTokens: money, hasDate: ctx.hasDate };
  }

  const q = Number(ctx.quantity || 0) > 0 ? Number(ctx.quantity || 0) : 1;
  const tokenCounts = new Map<number, number>();
  for (const value of money) tokenCounts.set(value, (tokenCounts.get(value) || 0) + 1);

  let valor = 0;
  if (preferred >= RAW_ITEM_MIN_TOTAL && preferred <= RAW_ITEM_MAX_TOTAL) {
    const preferredMatch = money.find((candidate) => Math.abs(candidate - preferred) <= 2);
    if (preferredMatch) valor = preferredMatch;
  }

  if (!(valor >= RAW_ITEM_MIN_TOTAL)) {
    const duplicatedCandidates = [...tokenCounts.entries()]
      .filter(([value, count]) => count >= 2 && value >= RAW_ITEM_MIN_TOTAL && value <= RAW_ITEM_MAX_TOTAL)
      .map(([value]) => value)
      .sort((a, b) => b - a);
    if (duplicatedCandidates.length) valor = duplicatedCandidates[0];
  }

  if (!(valor >= RAW_ITEM_MIN_TOTAL)) {
    const unitCandidates = money.slice(0, Math.min(3, money.length));
    let best: { total: number; score: number } | null = null;
    for (const totalCandidate of money) {
      for (const unitCandidate of unitCandidates) {
        const expected = Math.round(unitCandidate * q);
        const absDiff = Math.abs(totalCandidate - expected);
        const relDiff = absDiff / Math.max(1, expected);
        if (absDiff <= 100 || relDiff <= 0.2) {
          const score = absDiff + relDiff * 1000 + (totalCandidate === money[money.length - 1] ? 0 : 8);
          if (!best || score < best.score) best = { total: totalCandidate, score };
        }
      }
    }
    if (best && best.total >= RAW_ITEM_MIN_TOTAL && best.total <= RAW_ITEM_MAX_TOTAL) valor = best.total;
  }

  if (!(valor >= RAW_ITEM_MIN_TOTAL)) {
    const maxCandidate = Math.max(...money);
    if (maxCandidate >= RAW_ITEM_MIN_TOTAL && maxCandidate <= RAW_ITEM_MAX_TOTAL) valor = maxCandidate;
  }

  if (!(valor >= RAW_ITEM_MIN_TOTAL && valor <= RAW_ITEM_MAX_TOTAL)) {
    return { valor: 0, otrosMontos: [], quantity: q, moneyTokens: money, hasDate: ctx.hasDate };
  }

  const remaining = money.filter((candidate) => Math.abs(candidate - valor) > 2);
  const ranked = remaining
    .filter((v) => v >= RAW_ITEM_MIN_TOTAL && v <= RAW_ITEM_MAX_TOTAL)
    .sort((a, b) => b - a);
  const bonificacion = ranked.length >= 1 ? ranked[0] : undefined;
  const copago = ranked.length >= 2 ? ranked[ranked.length - 1] : undefined;
  const others = ranked.filter((value, idx) => value !== bonificacion && (ranked.length < 2 || idx !== ranked.length - 1));

  return {
    valor,
    bonificacion,
    copago,
    otrosMontos: [...new Set(others)],
    quantity: q,
    moneyTokens: money,
    hasDate: ctx.hasDate
  };
};

const extractDateForClinicalKey = (value: string): string => {
  const match = findClinicalDateMatch(value);
  if (!match) return '';
  return match[0].replace(/-/g, '/');
};

const extractCanonicalFieldsFromLogicalText = (
  text: string,
  fallbackAmount = 0,
  options?: { preferGrossOnTotalEmpresaLayout?: boolean }
): Pick<LogicalLine, 'fields' | 'fieldsConfidence'> => {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const codeMatch = compact.match(/\b\d{2}-\d{2}-\d{3}-\d{2}\b/)
    || compact.match(/^\s*(?:CODIGO\s+)?(\d{5,8})\b/i)
    || compact.match(/\b\d{7,8}\b/);
  const codeValue = codeMatch
    ? String(codeMatch[1] || codeMatch[0] || '').trim()
    : '';
  const dateValue = extractDateForClinicalKey(compact);

  const amountCandidates = extractMonetaryCandidatesFromText(compact, {
    excludeLikelyIdentifiers: true,
    requireMoneySignature: true,
    tableLike: hasTableHeaderSignature(compact),
    minAmountIfNoGrouping: 10000
  }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  const grossEmpresaAmount = options?.preferGrossOnTotalEmpresaLayout && dateValue
    ? selectGrossAmountFromEmpresaLayout(amountCandidates, compact)
    : 0;
  const structuredFallbackAmount = amountCandidates.length === 0
    ? extractStructuredChargeTotalFromText(compact)
    : 0;
  const preferredAmount = Math.round(Number(
    fallbackAmount || grossEmpresaAmount || structuredFallbackAmount || amountCandidates[amountCandidates.length - 1] || 0
  ));
  const breakdown = resolveAuditableMoneyBreakdownFromRawText(compact, preferredAmount);
  const quantity = Number(breakdown.quantity || 0) > 0
    ? Math.round(Number(breakdown.quantity || 0) * 1000) / 1000
    : undefined;
  const empresaAmount = grossEmpresaAmount > 0 && amountCandidates.length >= 1
    ? Math.round(Number(amountCandidates[amountCandidates.length - 1] || 0))
    : 0;
  const valor = Math.round(Number(grossEmpresaAmount || breakdown.valor || preferredAmount || 0));

  let precioUnitario: number | undefined;
  if (quantity && quantity > 1 && valor > 0) {
    const expectedUnit = Math.round(valor / quantity);
    const unitCandidate = breakdown.moneyTokens.find((candidate) => Math.abs(candidate - expectedUnit) <= Math.max(20, expectedUnit * 0.05));
    precioUnitario = unitCandidate || expectedUnit;
  } else if (quantity === 1 && valor > 0) {
    precioUnitario = valor;
  }

  const fields: LogicalLine['fields'] = {
    codigo: codeValue || undefined,
    fecha: dateValue || undefined,
    cantidad: quantity,
    precioUnitario: precioUnitario && precioUnitario > 0 ? precioUnitario : undefined,
    valor: valor > 0 ? valor : undefined,
    bonificacion: grossEmpresaAmount > 0 && empresaAmount > 0 && grossEmpresaAmount > empresaAmount
      ? Math.round(grossEmpresaAmount - empresaAmount)
      : breakdown.bonificacion,
    copago: grossEmpresaAmount > 0 && empresaAmount > 0 ? empresaAmount : breakdown.copago,
    otrosMontos: grossEmpresaAmount > 0
      ? amountCandidates.filter((candidate) => Math.abs(candidate - valor) > 2 && Math.abs(candidate - empresaAmount) > 2)
      : breakdown.otrosMontos
  };

  const hasStrongCode = /\d{2}-\d{2}-\d{3}-\d{2}/.test(codeValue);
  const exactUnitMatch = Boolean(quantity && precioUnitario && valor && Math.abs(precioUnitario * quantity - valor) <= Math.max(100, valor * 0.05));
  return {
    fields,
    fieldsConfidence: {
      codigo: codeValue ? (hasStrongCode ? 0.95 : 0.7) : 0.1,
      fecha: dateValue ? 0.95 : 0.1,
      cantidad: quantity ? (dateValue || codeValue ? 0.8 : 0.6) : 0.1,
      precioUnitario: precioUnitario ? (exactUnitMatch ? 0.85 : 0.55) : 0.1,
      valor: valor > 0 ? 0.8 : 0.2
    }
  };
};

const mergeItemsByClinicalKey = (items: NormalizedBillItem[]): NormalizedBillItem[] => {
  const groups = new Map<string, NormalizedBillItem[]>();
  for (const item of items) {
    const page = Math.max(1, Number(item.page || 1));
    const canonical = canonicalDescriptionForKey(item.description || item.rawText || '');
    if (!canonical) continue;
    const code = String(item.codeInternal || '').trim();
    const date = extractDateForClinicalKey(item.rawText || item.description || '');
    const key = `${page}|${code || 'na'}|${date || 'na'}|${canonical}`;
    const bucket = groups.get(key) || [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const merged: NormalizedBillItem[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0]);
      continue;
    }

    const totals = bucket
      .map((item) => Math.round(Number(item.total || 0)))
      .filter((n) => n > 0);
    const uniqueTotals = [...new Set(totals)];
    // In empresa-layout PDFs, same code/date/description can represent split professional shares.
    // Only collapse exact duplicates; preserve buckets that carry different monetary lines.
    if (uniqueTotals.length > 1) {
      merged.push(...bucket);
      continue;
    }

    const ranked = [...bucket].sort((a, b) => {
      const deltaTotal = Math.round(Number(b.total || 0)) - Math.round(Number(a.total || 0));
      if (deltaTotal !== 0) return deltaTotal;
      const descRank = descriptionQuality(String(b.description || b.rawText || '')) - descriptionQuality(String(a.description || a.rawText || ''));
      if (descRank !== 0) return descRank;
      return Math.round(Number(a.bbox?.y || 0)) - Math.round(Number(b.bbox?.y || 0));
    });

    const base = { ...ranked[0] };
    const valor = uniqueTotals.length ? Math.max(...uniqueTotals) : Math.round(Number(base.total || 0));
    const others = uniqueTotals.filter((value) => Math.abs(value - valor) > 2).sort((a, b) => b - a);
    const bonificacion = others.length >= 1 ? others[0] : undefined;
    const copago = others.length >= 2 ? others[others.length - 1] : undefined;
    const otrosMontos = others.filter((value, idx) => value !== bonificacion && (others.length < 2 || idx !== others.length - 1));

    const mergedRowIds = [...new Set(ranked.flatMap((item) => item.rowIds || []))];
    const existingOthers = (base.fields?.otrosMontos || []).map((v) => Math.round(Number(v || 0))).filter((n) => n > 0);
    const combinedOthers = [...new Set([...existingOthers, ...otrosMontos])].filter((n) => Math.abs(n - valor) > 2);

    base.total = valor;
    base.rowIds = mergedRowIds;
    base.fields = {
      ...(base.fields || {}),
      valor,
      bonificacion: bonificacion ?? base.fields?.bonificacion,
      copago: copago ?? base.fields?.copago,
      otrosMontos: combinedOthers,
      mergeCount: bucket.length
    };
    merged.push(base);
  }

  return merged.sort((a, b) => {
    const byPage = Math.max(1, Number(a.page || 1)) - Math.max(1, Number(b.page || 1));
    if (byPage !== 0) return byPage;
    return Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0);
  });
};

const hasBoundaryAdministrativeSignal = (value: string): boolean => {
  const t = normalize(value).toUpperCase();
  if (!t) return false;
  return t.includes('FECHA CORTE') ||
    t.includes('TOTAL GENERAL') ||
    t.includes('SUB TOTAL POR PRESTADOR') ||
    t.includes('SUBTOTAL POR PRESTADOR') ||
    t.includes('TOTAL PAM') ||
    t.includes('PAM');
};

const looksLikeProcedureSummary = (value: string): boolean => {
  const t = normalize(value).toUpperCase();
  if (!t) return false;
  return t.includes('APENDIC') ||
    t.includes('LAPAROS') ||
    t.includes('CIRUG') ||
    t.includes('ANEST') ||
    t.includes('PABELL') ||
    t.includes('DERECHO PABELLON');
};

const shouldExcludeBoundaryMixedItem = (item: NormalizedBillItem, boundaryPage: number | null): boolean => {
  if (!(boundaryPage && boundaryPage > 0)) return false;
  if (Number(item.page || 0) !== Number(boundaryPage || 0)) return false;

  const text = String(item.rawText || item.description || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (hasBoundaryAdministrativeSignal(text) || isAdministrativeRawDescription(text) || isPamRawDescription(text)) return true;

  const money = extractMoneyTokensFromText(text).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (looksLikeProcedureSummary(text) && money.length >= 2 && money.length <= 5) return true;
  if (money.length > 0 && money.length <= 2) {
    const allEqual = money.every((n) => Math.abs(n - money[0]) <= 2);
    if (allEqual) return true;
  }
  return false;
};

const classifyRow = (text: string): RowKind => {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  if (/^(codigo|descripcion|rut|empresa|sucursal|nombre paciente|detalle|informe|fecha|pagina)/i.test(t)) return 'header';
  if (/\b(total|subtotal)\b/i.test(t)) return 'footer';
  if (/\d/.test(t) && /[a-zA-Z]/.test(t)) return 'item';
  return 'unknown';
};

const classifyRowTag = (text: string): RowTag => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'unknown';
  if (isAdministrativeRawDescription(t) || isPamRawDescription(t) || isPamResidualNoise(t)) return 'admin';
  const moneyTokens = extractMonetaryCandidatesFromText(t, true).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
  if (moneyTokens.length > 0) return 'chargeLike';
  return 'unknown';
};

const toNormalizedRows = (entries: OverlayEntry[]): NormalizedRow[] =>
  entries
    .filter((entry) => String(entry.text || '').trim().length > 0)
    .map((entry) => ({
    id: entry.id,
    page: entry.page,
    bbox: entry.bbox,
    text: entry.text || '',
    source: entry.source || 'native',
    rowKind: classifyRow(entry.text || ''),
    rowTag: classifyRowTag(entry.text || ''),
    normalizedText: normalize(entry.text || ''),
    terms: terms(entry.text || '')
  }));

const buildRawPages = (rows: NormalizedRow[]): RawEvidencePage[] => {
  const pages = [...new Set(rows.map((row) => Number(row.page || 0)).filter((page) => page > 0))].sort((a, b) => a - b);
  return pages.map((page) => {
    const pageRows = rows.filter((row) => Number(row.page || 0) === page);
    const sourcesUsed = [...new Set(pageRows.map((row) => row.source))];
    return {
      page,
      sourcesUsed,
      rows: pageRows.map((row) => ({
        id: row.id,
        page,
        bbox: row.bbox,
        text: row.text,
        source: row.source,
        confidence: row.confidence,
        rowTag: row.rowTag,
        numericTokens: extractMoneyTokensFromText(row.text)
      }))
    };
  });
};

const buildLogicalLinesFromRows = (
  rows: NormalizedRow[],
  options?: { preferGrossOnTotalEmpresaLayout?: boolean }
): LogicalLine[] => {
  const yTolerance = 6;
  const xJoinGap = 18;
  const minOverlap = 0.4;
  const byPage = new Map<number, NormalizedRow[]>();
  for (const row of rows) {
    const page = Number(row.page || 0);
    if (!(page > 0)) continue;
    const bucket = byPage.get(page) || [];
    bucket.push(row);
    byPage.set(page, bucket);
  }

  const logicalLines: LogicalLine[] = [];
  for (const [page, pageRows] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sortedRows = [...pageRows].sort((a, b) =>
      Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0) || Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0)
    );
    const clusters: Array<{ anchorY: number; rows: NormalizedRow[] }> = [];
    for (const row of sortedRows) {
      const rowCenterY = Number(row.bbox?.y || 0) + Number(row.bbox?.h || 0) / 2;
      let bestCluster: { anchorY: number; rows: NormalizedRow[] } | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const cluster of clusters) {
        const delta = Math.abs(cluster.anchorY - rowCenterY);
        if (delta <= yTolerance && delta < bestDelta) {
          bestCluster = cluster;
          bestDelta = delta;
        }
      }
      if (!bestCluster) {
        clusters.push({ anchorY: rowCenterY, rows: [row] });
      } else {
        bestCluster.rows.push(row);
        bestCluster.anchorY = bestCluster.rows.reduce((acc, r) => acc + (Number(r.bbox?.y || 0) + Number(r.bbox?.h || 0) / 2), 0) / bestCluster.rows.length;
      }
    }

    const pageLines = clusters
      .sort((a, b) => a.anchorY - b.anchorY)
      .map((cluster, idx) => {
        const ordered = [...cluster.rows].sort((a, b) => Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0));
        const parts = ordered.map((row) => ({
          rowId: row.id,
          text: String(row.text || '').trim(),
          x: Number(row.bbox?.x || 0),
          y: Number(row.bbox?.y || 0),
          w: Number(row.bbox?.w || 0),
          h: Number(row.bbox?.h || 0),
          source: row.source,
          rowTag: row.rowTag
        }));
        const texts = parts.map((part) => part.text).filter((value) => value.length > 0);
        const fullText = texts.join(' | ');
        const minX = Math.min(...parts.map((part) => part.x));
        const minY = Math.min(...parts.map((part) => part.y));
        const maxX = Math.max(...parts.map((part) => part.x + part.w));
        const maxY = Math.max(...parts.map((part) => part.y + part.h));
        const rowTag: RowTag = parts.some((part) => part.rowTag === 'chargeLike')
          ? 'chargeLike'
          : (parts.some((part) => part.rowTag === 'admin') ? 'admin' : 'unknown');
        const sourceUsed = [...new Set(parts.map((part) => part.source))];
        const mergeScore = Math.min(1, 0.55 + parts.length * 0.15);
        const moneyTokens = extractMonetaryCandidatesFromText(fullText, true).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
        const canonical = extractCanonicalFieldsFromLogicalText(
          fullText,
          moneyTokens[moneyTokens.length - 1] || 0,
          options
        );
        return {
          id: `logical-p${page}-${idx + 1}`,
          page,
          rowIds: parts.map((part) => part.rowId),
          fullText,
          fullTextParts: texts,
          rowKind: parts.some((part) => classifyRow(part.text) === 'item') ? 'item' : 'unknown',
          rowTag,
          bbox: {
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            w: Math.max(1, maxX - minX),
            h: Math.max(1, maxY - minY)
          },
          moneyTokens,
          mergeMethod: 'STITCH_YX_V1' as const,
          mergeParams: { yTolerance, xJoinGap, minOverlap },
          mergeScore,
          sourceUsed,
          parts,
          fields: canonical.fields,
          fieldsConfidence: canonical.fieldsConfidence
        } as LogicalLine;
      });
    logicalLines.push(...pageLines);
  }
  return logicalLines;
};

const hasTableHeaderSignature = (value: string): boolean => {
  const upper = normalize(value).toUpperCase();
  return upper.includes('CODIGO') &&
    upper.includes('DESCRIP') &&
    (upper.includes('CANT') || upper.includes('CANTIDAD')) &&
    (upper.includes('VALOR') || upper.includes('TOTAL REC') || upper.includes('COPAGO') || upper.includes('BONIFIC'));
};

const hasTotalLineSignal = (value: string): boolean =>
  hasClinicTotalGeneralSignal(value) || hasPamTotalSignal(value);
const hasSubtotalLineSignal = (value: string): boolean =>
  normalize(value).toUpperCase().includes('SUB TOTAL POR PRESTADOR') ||
  normalize(value).toUpperCase().includes('SUBTOTAL POR PRESTADOR') ||
  hasTotalEmpresaSignal(value) ||
  hasSantaMariaSubtotalSignal(value) ||
  hasSantaMariaAdjustmentSignal(value);

const hasChargeEvidenceInPage = (
  pageNumber: number,
  logicalLines: LogicalLine[],
  tableLikePages: Set<number>
): boolean => {
  const pageLines = logicalLines.filter((line) => Number(line.page || 0) === Number(pageNumber || 0));
  if (!pageLines.length) return false;
  const tableLike = tableLikePages.has(Number(pageNumber || 0));
  for (const line of pageLines) {
    const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (hasTotalLineSignal(text) || hasSubtotalLineSignal(text)) continue;
    if (isAdministrativeRawDescription(text) || isPamOnlyContextSignal(text)) continue;
    const hasCanonicalCode = Boolean(String(line.fields?.codigo || extractLeadingClinicalCode(text) || '').trim());
    const hasDetailSignal = Boolean(findClinicalDateMatch(text))
      || /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text)
      || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
    let amountCandidates = extractMonetaryCandidatesFromText(text, {
      excludeLikelyIdentifiers: true,
      requireMoneySignature: true,
      tableLike,
      minAmountIfNoGrouping: 10000
    }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
    const structuredFallbackAmount = Math.round(Number(line.fields?.valor || extractStructuredChargeTotalFromText(text) || 0));
    if (!amountCandidates.length && hasCanonicalCode && hasDetailSignal && structuredFallbackAmount > 0) {
      amountCandidates = [structuredFallbackAmount];
    }
    if (!amountCandidates.length) continue;
    if (hasDetailSignal || tableLike) return true;
  }
  return false;
};

const resolveReconciliationTargetTotal = (
  reconciliation: NormalizedBillPayload['reconciliation'] | undefined,
  expectedScope: 'bill-only' | 'full'
): {
  targetTotal: number;
  targetSource: 'billDeclaredTotal' | 'clinicTotalGeneral' | 'subtotalIsapreSum' | 'unknown';
  clinicDeclaredTotal: number;
  billDeclaredTotal: number;
  pamDeclaredTotal: number;
} => {
  const clinicDeclaredTotal = Math.round(Number(
    reconciliation?.declaredTotals?.clinicTotalGeneral?.amount || reconciliation?.clinicDeclaredTotal || 0
  ));
  const billDeclaredTotal = Math.round(Number(reconciliation?.details?.billDeclaredTotal || 0));
  const pamDeclaredTotal = Math.round(Number(reconciliation?.details?.pamDeclaredTotal || 0));
  const subtotalDeclaredTotal = Math.round(Number(reconciliation?.isapreDeclaredSubtotalSum || 0));

  if (expectedScope === 'bill-only') {
    if (billDeclaredTotal > 0) {
      return {
        targetTotal: billDeclaredTotal,
        targetSource: 'billDeclaredTotal',
        clinicDeclaredTotal,
        billDeclaredTotal,
        pamDeclaredTotal
      };
    }
    if (clinicDeclaredTotal > 0) {
      return {
        targetTotal: clinicDeclaredTotal,
        targetSource: 'clinicTotalGeneral',
        clinicDeclaredTotal,
        billDeclaredTotal,
        pamDeclaredTotal
      };
    }
    if (subtotalDeclaredTotal > 0) {
      return {
        targetTotal: subtotalDeclaredTotal,
        targetSource: 'subtotalIsapreSum',
        clinicDeclaredTotal: subtotalDeclaredTotal,
        billDeclaredTotal,
        pamDeclaredTotal
      };
    }
    return {
      targetTotal: 0,
      targetSource: 'unknown',
      clinicDeclaredTotal,
      billDeclaredTotal,
      pamDeclaredTotal
    };
  }

  if (clinicDeclaredTotal > 0) {
    return {
      targetTotal: clinicDeclaredTotal,
      targetSource: 'clinicTotalGeneral',
      clinicDeclaredTotal,
      billDeclaredTotal,
      pamDeclaredTotal
    };
  }

  if (subtotalDeclaredTotal > 0) {
    return {
      targetTotal: subtotalDeclaredTotal,
      targetSource: 'subtotalIsapreSum',
      clinicDeclaredTotal: subtotalDeclaredTotal,
      billDeclaredTotal,
      pamDeclaredTotal
    };
  }

  return {
    targetTotal: 0,
    targetSource: 'unknown',
    clinicDeclaredTotal,
    billDeclaredTotal,
    pamDeclaredTotal
  };
};

const shouldForceRawHydration = (payload: Pick<NormalizedBillPayload, 'rows' | 'signals'>): boolean => {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.some((row) => hasTotalEmpresaSignal(String(row.text || '')))) return true;
  if (rows.some((row) => hasSantaMariaSubtotalSignal(String(row.text || '')) || hasSantaMariaAdjustmentSignal(String(row.text || '')))) return true;
  const subtotalSignals = payload.signals?.subtotalLines || [];
  return subtotalSignals.some((entry) =>
    hasTotalEmpresaSignal(String(entry.text || '')) ||
    hasSantaMariaSubtotalSignal(String(entry.text || '')) ||
    hasSantaMariaAdjustmentSignal(String(entry.text || ''))
  );
};

const isProtectedEmpresaGrossMove = (line: DerivedValuedLine, from: number, to: number): boolean => {
  const rawText = String(line.rawText || '').replace(/\s+/g, ' ').trim();
  if (!rawText || !(from > 0) || !(to > 0) || !(to < from)) return false;
  const columns = extractEmpresaLayoutColumnsFromRawText(rawText);
  if (!columns) return false;

  const gross = Math.round(Number(columns.valorIsa || 0));
  if (!(gross >= RAW_ITEM_MIN_TOTAL) || Math.abs(from - gross) > Math.max(2, gross * 0.01)) return false;

  const structuredLowerAmounts = [
    Math.round(Number(columns.valorBruto || 0)),
    Math.round(Number(columns.afecto || 0)),
    Math.round(Number(columns.empresa || 0)),
    Math.round(Number((columns.exento || 0) + (columns.afecto || 0))),
    Math.round(Number((columns.exento || 0) + (columns.afecto || 0) + (columns.iva || 0)))
  ].filter((value) => value > 0 && value < gross);

  if (to === 1000 && gross > 1000) return true;
  if (structuredLowerAmounts.some((value) => Math.abs(value - to) <= 2)) return true;
  return to <= Math.round(gross * 0.95);
};

const isProtectedClinicalTotalMove = (line: DerivedValuedLine, from: number, to: number): boolean => {
  if (isProtectedEmpresaGrossMove(line, from, to)) return true;
  const rawText = String(line.rawText || '').replace(/\s+/g, ' ').trim();
  if (!rawText || !(from > 0) || !(to > 0)) return false;

  const canonical = extractCanonicalFieldsFromLogicalText(rawText, from, {
    preferGrossOnTotalEmpresaLayout: Boolean(extractEmpresaLayoutColumnsFromRawText(rawText))
  });
  const quantity = Math.round(Number(canonical.fields.cantidad || 0));
  const unitPrice = Math.round(Number(canonical.fields.precioUnitario || 0));
  const expected = quantity > 0 && unitPrice > 0 ? Math.round(quantity * unitPrice) : 0;
  const exactClinicalMatch = expected > 0 && Math.abs(expected - from) <= Math.max(1, expected * 0.01);
  if (!exactClinicalMatch) return false;

  const relativeMove = Math.abs(expected - to) / Math.max(1, expected);
  const targetRatio = to / Math.max(1, expected);
  const hasStructuredCode = /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(rawText);
  // Prevent collapsing a clinically valid total into a small tax/copay residue.
  if (quantity === 1 && unitPrice === expected && targetRatio <= 0.25) return true;
  return relativeMove >= 0.2 && (quantity > 1 || hasStructuredCode);
};

const reconcileResidualGapInValuedLines = (
  valuedLines: DerivedValuedLine[],
  targetDeclaredTotal: number,
  context?: { billBoundaryPage?: number | null }
): {
  valuedLines: DerivedValuedLine[];
  targetGapBefore: number;
  residualGapAfter: number;
  applied: Array<{
    lineId: string;
    page: number;
    from: number;
    to: number;
    delta: number;
    description: string;
  }>;
} => {
  const currentSum = Math.round(valuedLines.reduce((acc, line) => acc + Math.round(Number(line.chosenAmount || 0)), 0));
  const target = Math.round(Number(targetDeclaredTotal || 0));
  const gap = target > 0 ? Math.round(target - currentSum) : 0;
  if (!(target > 0) || gap === 0) {
    return { valuedLines, targetGapBefore: gap, residualGapAfter: gap, applied: [] };
  }
  // Keep this conservative: only auto-adjust when the residual is small.
  if (Math.abs(gap) > 120000) {
    return { valuedLines, targetGapBefore: gap, residualGapAfter: gap, applied: [] };
  }

  type CandidateMove = {
    lineIdx: number;
    lineId: string;
    page: number;
    from: number;
    to: number;
    delta: number;
    altRank: number;
    score: number;
    description: string;
  };

  const boundaryPage = Number(context?.billBoundaryPage || 0) || null;
  const boundaryPlusOne = boundaryPage ? boundaryPage + 1 : null;
  const desiredSign = Math.sign(gap);
  const candidates: CandidateMove[] = [];

  for (let i = 0; i < valuedLines.length; i += 1) {
    const line = valuedLines[i];
    const from = Math.round(Number(line.chosenAmount || 0));
    if (!(from > 0)) continue;
    const uniqAlternatives = [...new Set((line.amountCandidates || []).map((v) => Math.round(Number(v || 0))))];
    const plausibleAlternatives = uniqAlternatives
      .filter((to) => to > 0 && to !== from && Math.sign(to - from) === desiredSign)
      .sort((a, b) => desiredSign < 0 ? b - a : a - b)
      .slice(0, 2);
    for (let altRank = 0; altRank < plausibleAlternatives.length; altRank += 1) {
      const to = plausibleAlternatives[altRank];
      if (isProtectedClinicalTotalMove(line, from, to)) continue;
      const delta = to - from;
      if (Math.abs(delta) > Math.abs(gap)) continue;
      const page = Number(line.page || 0);
      const desc = String(line.descriptionText || line.rawText || '').replace(/\s+/g, ' ').trim();
      let score = 0;
      if (boundaryPlusOne && page === boundaryPlusOne) score += 30;
      if (line.chosenAmountReason === 'rightmost_token') score += 10;
      if (line.rowTag === 'unknown') score += 5;
      score += Math.max(0, 14 - altRank * 7);
      score += Math.max(0, 40 - Math.round((Math.abs(delta) / Math.max(1, from)) * 100));
      score += Math.max(0, 20 - Math.abs(Math.abs(gap) - Math.abs(delta)));
      candidates.push({
        lineIdx: i,
        lineId: String(line.id || `valued-${i}`),
        page,
        from,
        to,
        delta,
        altRank,
        score,
        description: desc
      });
    }
  }

  if (!candidates.length) {
    return { valuedLines, targetGapBefore: gap, residualGapAfter: gap, applied: [] };
  }

  const ranked = [...candidates]
    .sort((a, b) =>
      b.score - a.score ||
      a.altRank - b.altRank ||
      Math.abs(Math.abs(gap) - Math.abs(a.delta)) - Math.abs(Math.abs(gap) - Math.abs(b.delta)) ||
      Math.abs(b.delta) - Math.abs(a.delta)
    )
    .slice(0, 180);

  let best = {
    diff: Math.abs(gap),
    sumDelta: 0,
    picks: [] as CandidateMove[]
  };
  const maxDepth = 8;

  const dfs = (start: number, runningDelta: number, picks: CandidateMove[], usedLineIdx: Set<number>): boolean => {
    const diff = Math.abs(gap - runningDelta);
    if (diff < best.diff) {
      best = { diff, sumDelta: runningDelta, picks: [...picks] };
      if (diff === 0) return true;
    }
    if (picks.length >= maxDepth) return false;
    for (let idx = start; idx < ranked.length; idx += 1) {
      const candidate = ranked[idx];
      if (usedLineIdx.has(candidate.lineIdx)) continue;
      const nextDelta = runningDelta + candidate.delta;
      if (Math.abs(nextDelta) > Math.abs(gap)) continue;
      usedLineIdx.add(candidate.lineIdx);
      picks.push(candidate);
      const done = dfs(idx + 1, nextDelta, picks, usedLineIdx);
      picks.pop();
      usedLineIdx.delete(candidate.lineIdx);
      if (done) return true;
    }
    return false;
  };

  dfs(0, 0, [], new Set<number>());
  if (!best.picks.length) {
    return { valuedLines, targetGapBefore: gap, residualGapAfter: gap, applied: [] };
  }

  const pickedByLineId = new Map(best.picks.map((pick) => [pick.lineId, pick]));
  const adjusted = valuedLines.map((line) => {
    const pick = pickedByLineId.get(String(line.id || ''));
    if (!pick) return line;
    return {
      ...line,
      chosenAmount: pick.to,
      chosenAmountReason: 'reconciliation_adjusted' as const,
      reconciliationAdjustment: {
        from: pick.from,
        to: pick.to,
        delta: pick.delta,
        targetGapBefore: gap
      }
    };
  });
  const adjustedSum = Math.round(adjusted.reduce((acc, line) => acc + Math.round(Number(line.chosenAmount || 0)), 0));
  const residualGapAfter = Math.round(target - adjustedSum);
  const applied = best.picks.map((pick) => ({
    lineId: pick.lineId,
    page: pick.page,
    from: pick.from,
    to: pick.to,
    delta: pick.delta,
    description: pick.description
  }));

  return {
    valuedLines: adjusted,
    targetGapBefore: gap,
    residualGapAfter,
    applied
  };
};

const deriveValuedLines = (
  logicalLines: LogicalLine[],
  options?: { preferGrossOnTotalEmpresaLayout?: boolean }
): {
  valuedLines: DerivedValuedLine[];
  nonItems: NormalizedBillPayload['nonItems'];
  signals: NormalizedBillPayload['signals'];
  tableLikePages: Set<number>;
} => {
  const tableLikePages = new Set<number>(
    logicalLines
      .filter((line) => hasTableHeaderSignature(line.fullText || ''))
      .map((line) => Number(line.page || 0))
      .filter((page) => page > 0)
  );
  const valuedLines: DerivedValuedLine[] = [];
  const nonItems: NormalizedBillPayload['nonItems'] = [];
  const signals: NormalizedBillPayload['signals'] = {
    rutLines: [],
    idLines: [],
    totalLines: [],
    subtotalLines: [],
    pamLines: [],
    noiseLines: []
  };

  const pushSignal = (
    bucket: keyof NormalizedBillPayload['signals'],
    line: LogicalLine,
    text: string,
    tokens: Array<{ raw: string; value: number; tokenType: TokenType }>,
    reason: string
  ) => {
    if (!line.rowIds.length) return;
    signals[bucket].push({
      page: Number(line.page || 0),
      rowId: String(line.rowIds[0] || line.id),
      text,
      tokens,
      reason
    });
  };

  const pushNonItem = (
    line: LogicalLine,
    text: string,
    reason: string,
    tokens: Array<{ raw: string; value: number; tokenType: TokenType }>
  ) => {
    if (!line.rowIds.length) return;
    nonItems.push({
      page: Number(line.page || 0),
      rowId: String(line.rowIds[0] || line.id),
      text,
      reason,
      tokens
    });
  };

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex += 1) {
    const line = logicalLines[lineIndex];
    const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tokenDetails = extractNumberTokenDetailsFromText(text);
    const signalTokens = tokenDetails.map((token) => ({ raw: token.raw, value: token.value, tokenType: token.tokenType }));
    const hasRutToken = tokenDetails.some((token) => token.tokenType === 'rutCandidate');
    const hasIdToken = tokenDetails.some((token) => token.tokenType === 'idCandidate');
    const isPam = isPamOnlyContextSignal(text);
    const isAdmin = isAdministrativeRawDescription(text);
    const isTotal = hasTotalLineSignal(text);
    const isSubtotal = hasSubtotalLineSignal(text);
    const hasCanonicalCode = Boolean(String(line.fields?.codigo || extractLeadingClinicalCode(text) || '').trim());
    const isPureNumeric = !/[a-zA-ZÁÉÍÓÚÑáéíóúñ]{2,}/.test(text);

    if (hasRutToken) pushSignal('rutLines', line, text, signalTokens, 'RUT detectado en linea');
    if (hasIdToken) pushSignal('idLines', line, text, signalTokens, 'ID/folio detectado en linea');
    if (isPam) pushSignal('pamLines', line, text, signalTokens, 'Linea con señal PAM');
    if (isTotal) {
      pushSignal('totalLines', line, text, signalTokens, 'Linea de total general');
      pushNonItem(line, text, 'total_line', signalTokens);
      continue;
    }
    if (isSubtotal) {
      pushSignal('subtotalLines', line, text, signalTokens, 'Linea de subtotal');
      pushNonItem(line, text, 'subtotal_line', signalTokens);
      continue;
    }

    let amountCandidates = extractMonetaryCandidatesFromText(text, {
      excludeLikelyIdentifiers: true,
      requireMoneySignature: true,
      tableLike: tableLikePages.has(Number(line.page || 0)),
      minAmountIfNoGrouping: 10000
    }).filter((n) => n >= RAW_ITEM_MIN_TOTAL && n <= RAW_ITEM_MAX_TOTAL);
    const canonicalFallbackAmount = Math.round(Number(line.fields?.valor || extractStructuredChargeTotalFromText(text) || 0));
    if (!amountCandidates.length) {
      const hasGloss = /[a-zA-ZÃÃ‰ÃÃ“ÃšÃ‘Ã¡Ã©Ã­Ã³ÃºÃ±]{3,}/.test(text) && !isAdmin;
      const hasDetailSignal = Boolean(findClinicalDateMatch(text)) || /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
      if (!isAdmin && !isPam && hasCanonicalCode && hasGloss && hasDetailSignal && canonicalFallbackAmount > 0) {
        amountCandidates = [canonicalFallbackAmount];
      }
    }
    if (!amountCandidates.length) {
      if (isAdmin || isPam || isPureNumeric || signalTokens.length) {
        pushSignal('noiseLines', line, text, signalTokens, 'Sin moneyCandidates validos');
        pushNonItem(line, text, 'no_money_candidates', signalTokens);
      }
      continue;
    }

    const hasGloss = /[a-zA-ZÁÉÍÓÚÑáéíóúñ]{3,}/.test(text) && !isAdmin;
    const hasDetailSignal = Boolean(findClinicalDateMatch(text)) || /\b\d{2}-\d{2}-\d{3}-\d{2}\b/.test(text) || /^\s*(CODIGO\s+)?\d{5,8}\b/i.test(text);
    const hasMonetaryStructure = amountCandidates.length >= 2;
    const score = [hasGloss, hasDetailSignal, hasMonetaryStructure].filter(Boolean).length;
    const isItemCandidate = score >= 2 && !isPam && !isAdmin && !isPureNumeric;
    if (!isItemCandidate) {
      pushSignal('noiseLines', line, text, signalTokens, `No cumple firma minima de item facturable (${score}/3).`);
      pushNonItem(line, text, `not_item_candidate_${score}_of_3`, signalTokens);
      continue;
    }

    const grossFromRow = options?.preferGrossOnTotalEmpresaLayout && Boolean(findClinicalDateMatch(text))
      ? selectGrossAmountFromEmpresaLayout(amountCandidates, text)
      : 0;
    const rightmost = amountCandidates[amountCandidates.length - 1];
    const grossFromLookahead = options?.preferGrossOnTotalEmpresaLayout && Boolean(findClinicalDateMatch(text))
      ? selectGrossAmountFromSubtotalLookahead(logicalLines, lineIndex, rightmost)
      : 0;
    const grossEmpresaAmount = Math.max(grossFromRow, grossFromLookahead);
    const maxCandidate = Math.max(...amountCandidates);
    const chosenAmount = amountCandidates.length === 1
      ? amountCandidates[0]
      : (grossEmpresaAmount > 0 ? grossEmpresaAmount : (rightmost >= RAW_ITEM_MIN_TOTAL ? rightmost : maxCandidate));
    const chosenAmountReason: DerivedValuedLine['chosenAmountReason'] =
      amountCandidates.length === 1 ? 'single_token' : (chosenAmount === rightmost ? 'rightmost_token' : 'max_token');
    const descriptionText = cleanRawDescription(text) || text;

    valuedLines.push({
      id: `valued-${line.id}`,
      page: line.page,
      logicalLineId: line.id,
      rowTag: line.rowTag,
      descriptionText,
      amountCandidates,
      chosenAmount,
      chosenAmountReason,
      rawText: text,
      bbox: line.bbox,
      trace: {
        rowIds: [...line.rowIds],
        mergeMethod: line.mergeMethod
      }
    });
  }
  return { valuedLines, nonItems, signals, tableLikePages };
};

const buildPayload = (
  rows: NormalizedRow[],
  page: number,
  allPages: boolean,
  meta?: { patientName?: string; clinicName?: string; date?: string },
  forcedItems?: NormalizedBillItem[]
): NormalizedBillPayload => {
  const rawPages = buildRawPages(rows);
  const preferGrossOnTotalEmpresaLayout = rows.some((row) => hasTotalEmpresaSignal(String(row.text || '')));
  const logicalLines: LogicalLine[] = buildLogicalLinesFromRows(rows, { preferGrossOnTotalEmpresaLayout });
  const derived = deriveValuedLines(logicalLines, { preferGrossOnTotalEmpresaLayout });
  const allValuedLines = derived.valuedLines;
  const nonItems = derived.nonItems;
  const signals = derived.signals;
  const logicalLineById = new Map(logicalLines.map((line) => [line.id, line]));
  const billBoundaryPage = resolveClinicBillBoundaryPage(rows);
  const useBillOnlyScope = allPages && shouldUseBillBoundaryScope(rows, billBoundaryPage);
  const expectedScope: 'bill-only' | 'full' = useBillOnlyScope ? 'bill-only' : 'full';
  let valuedLines = useBillOnlyScope && billBoundaryPage
    ? allValuedLines.filter((line) => {
      const pageNum = Number(line.page || 0);
      if (!(pageNum > 0)) return false;
      if (pageNum <= Number(billBoundaryPage || 0)) return true;
      return shouldIncludeBoundaryPlusOneAsBill(line, logicalLineById, billBoundaryPage);
    })
    : allValuedLines;
  const scopedPageSet = new Set(valuedLines.map((line) => Number(line.page || 0)).filter((pageNum) => pageNum > 0));
  const usesSantaMariaLayout = !preferGrossOnTotalEmpresaLayout && rows.some((row) =>
    hasSantaMariaSubtotalSignal(String(row.text || '')) || hasSantaMariaAdjustmentSignal(String(row.text || ''))
  );
  const hasScopedSantaMariaDevolutions = usesSantaMariaLayout && logicalLines.some((line) => {
    const pageNum = Number(line.page || 0);
    if (!scopedPageSet.has(pageNum)) return false;
    const text = String(line.fullText || '').replace(/\s+/g, ' ').trim();
    if (hasSantaMariaAdjustmentSignal(text)) return true;
    const candidate = extractSantaMariaChargeLineCandidate(line, { allowNegative: true });
    return Boolean(candidate) && Number(candidate?.amount || 0) < 0;
  });
  const reconciliation = resolveIsapreDeclaredTotals(rows, logicalLines);
  const reconciliationTargetBefore = resolveReconciliationTargetTotal(reconciliation, expectedScope);
  const gapAdjustment = hasScopedSantaMariaDevolutions
    ? (() => {
      const currentSum = Math.round(valuedLines.reduce((acc, line) => acc + Math.round(Number(line.chosenAmount || 0)), 0));
      const target = Math.round(Number(reconciliationTargetBefore.targetTotal || 0));
      const gap = target > 0 ? Math.round(target - currentSum) : 0;
      return {
        valuedLines,
        targetGapBefore: gap,
        residualGapAfter: gap,
        applied: [] as Array<{
          lineId: string;
          page: number;
          from: number;
          to: number;
          delta: number;
          description: string;
        }>
      };
    })()
    : reconcileResidualGapInValuedLines(valuedLines, reconciliationTargetBefore.targetTotal, { billBoundaryPage });
  if (gapAdjustment.applied.length > 0) {
    valuedLines = gapAdjustment.valuedLines;
  }
  const legacyItemsFromValued: NormalizedBillItem[] = valuedLines.map((line, idx) => {
    const logical = logicalLineById.get(line.logicalLineId);
    const baseFields = logical?.fields || {};
    const normalizedTotal = Math.round(Number(line.chosenAmount || 0));
    const quantity = Number(baseFields.cantidad || 0) > 0 ? Number(baseFields.cantidad || 0) : undefined;
    const baseUnitPrice = Number(baseFields.precioUnitario || 0) > 0 ? Math.round(Number(baseFields.precioUnitario || 0)) : undefined;
    const expectedFromBase = quantity && baseUnitPrice ? Math.round(quantity * baseUnitPrice) : 0;
    const shouldRealignUnitPrice = Boolean(
      normalizedTotal > 0 &&
      quantity &&
      (!baseUnitPrice || Math.abs(expectedFromBase - normalizedTotal) > Math.max(100, normalizedTotal * 0.2))
    );
    const normalizedUnitPrice = shouldRealignUnitPrice && quantity
      ? Math.max(1, Math.round(normalizedTotal / quantity))
      : baseUnitPrice;
    const mergedFields: LogicalLine['fields'] = {
      ...baseFields,
      cantidad: quantity,
      precioUnitario: normalizedUnitPrice,
      valor: normalizedTotal,
      otrosMontos: line.amountCandidates.filter((n) => Math.abs(n - normalizedTotal) > 2)
    };
    return {
      index: idx + 1,
      id: `item-${line.id}`,
      page: line.page,
      bbox: line.bbox,
      description: line.descriptionText,
      total: normalizedTotal,
      code: baseFields.codigo,
      codeInternal: baseFields.codigo,
      date: baseFields.fecha,
      quantity,
      unitPrice: normalizedUnitPrice,
      rawText: line.rawText,
      source: logical?.sourceUsed[0] || 'fallback',
      rowIds: [...line.trace.rowIds],
      trace: { rowIds: [...line.trace.rowIds], calcoVisible: line.trace.rowIds.length > 0 },
      rowKind: logical?.rowKind || 'item',
      rowTag: line.rowTag,
      fields: mergedFields,
      fieldsConfidence: logical?.fieldsConfidence || { codigo: 0.2, fecha: 0.2, cantidad: 0.2, precioUnitario: 0.2, valor: 0.6 }
    };
  });
  const forcedLegacyItems = Array.isArray(forcedItems) ? forcedItems.filter((item) => Number(item.total || 0) > 0) : [];
  const candidateItemsRaw = forcedLegacyItems.length > 0 ? forcedLegacyItems : legacyItemsFromValued;
  const preNormalizationDetails = reconciliation.details || {
    clinicTotalLine: null,
    includedSubtotals: [],
    excludedSubtotals: [],
    gapLikelyExplainedBy: []
  };
  const empresaNormalization = preferGrossOnTotalEmpresaLayout
    ? normalizeEmpresaLayoutItems(
      candidateItemsRaw,
      logicalLines,
      [...scopedPageSet],
      preNormalizationDetails.includedSubtotalsBill || preNormalizationDetails.includedSubtotals || []
    )
    : { items: candidateItemsRaw, anomalies: [] as ItemAnomaly[] };
  const santaMariaNormalization = usesSantaMariaLayout
    ? normalizeSantaMariaItems(
      empresaNormalization.items,
      logicalLines,
      [...scopedPageSet]
    )
    : { items: empresaNormalization.items, anomalies: [] as ItemAnomaly[] };
  const normalizedCandidateItems = santaMariaNormalization.items;
  const candidateItems = preferGrossOnTotalEmpresaLayout
    ? mergeItemsByClinicalKey(normalizedCandidateItems)
    : normalizedCandidateItems;
  const pages: NormalizedBillPayload['pages'] = {};
  const uniquePages = [...new Set([
    ...rows.map((r) => r.page),
    ...logicalLines.map((l) => l.page),
    ...valuedLines.map((v) => v.page)
  ])].sort((a, b) => a - b);
  for (const p of uniquePages) {
    const pageRows = rows.filter((r) => r.page === p);
    const pageLines = logicalLines.filter((l) => l.page === p);
    const pageValuedLines = valuedLines.filter((v) => v.page === p);
    const pageItems = candidateItems.filter((i) => i.page === p);
    pages[String(p)] = {
      rows: pageRows,
      logicalLineIds: pageLines.map((l) => l.id),
      valuedLineIds: pageValuedLines.map((line) => line.id),
      itemIds: pageItems.map((i) => i.id),
      subtotal: Math.round(pageItems.reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0))
    };
  }
  const strict = validatePayloadStrict(rows, candidateItems, pages);
  const items = strict.normalizedItems;
  const itemAnomalies = [
    ...empresaNormalization.anomalies,
    ...santaMariaNormalization.anomalies,
    ...detectNumericItemAnomalies(items)
  ];
  const itemAnomaliesSummary = summarizeItemAnomalies(itemAnomalies);

  // Keep item index references in pages after strict normalization.
  for (const p of Object.keys(pages)) {
    const pageNum = Number(p);
    pages[p].itemIds = items.filter((i) => Number(i.page || 0) === pageNum).map((i) => i.id);
    pages[p].subtotal = Math.round(items
      .filter((item) => Number(item.page || 0) === pageNum)
      .reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0));
  }

  const sumChosenAmounts = Math.round(valuedLines.reduce((acc, line) => acc + Math.round(Number(line.chosenAmount || 0)), 0));
  const sumFinalItemsTotal = Math.round(items.reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0));
  const sumAllAmountCandidatesMax = Math.round(valuedLines.reduce((acc, line) =>
    acc + Math.round(Math.max(0, ...line.amountCandidates.map((n) => Number(n || 0)))), 0));
  const extractedItemsTotal = sumFinalItemsTotal;
  const details: NonNullable<NormalizedBillPayload['reconciliation']>['details'] = reconciliation.details || {
    clinicTotalLine: null,
    includedSubtotals: [],
    excludedSubtotals: [],
    gapLikelyExplainedBy: []
  };
  const reconciliationTarget = resolveReconciliationTargetTotal(reconciliation, expectedScope);
  const targetDeclaredTotal = reconciliationTarget.targetTotal;
  const targetDeclaredTotalSource = reconciliationTarget.targetSource;
  const clinicTotalGeneral = reconciliationTarget.clinicDeclaredTotal;
  const billDeclaredTotal = reconciliationTarget.billDeclaredTotal;
  const pamDeclaredTotal = reconciliationTarget.pamDeclaredTotal;
  const gapVsClinicTotalGeneral = targetDeclaredTotal > 0 ? Math.round(targetDeclaredTotal - extractedItemsTotal) : null;
  const extractionRatio = targetDeclaredTotal > 0 ? extractedItemsTotal / targetDeclaredTotal : null;
  const overExtractionPct = extractionRatio !== null ? Math.max(0, extractionRatio - 1) : null;
  const underExtractionPct = extractionRatio !== null ? Math.max(0, 1 - extractionRatio) : null;
  const pagesInScope = useBillOnlyScope && billBoundaryPage
    ? uniquePages.filter((p) => Number(p || 0) > 0 && Number(p || 0) <= Number(billBoundaryPage || 0))
    : uniquePages;
  const deadPages = pagesInScope.filter((pageNum) => {
    const rawRowsCount = rawPages.find((pageInfo) => pageInfo.page === pageNum)?.rows.length || 0;
    const valuedLinesCount = valuedLines.filter((line) => Number(line.page || 0) === Number(pageNum || 0)).length;
    const hasChargeEvidence = hasChargeEvidenceInPage(pageNum, logicalLines, derived.tableLikePages);
    if (rawRowsCount === 0) return true;
    if (!hasChargeEvidence) return false;
    return valuedLinesCount === 0;
  });
  const overExtraction = targetDeclaredTotal > 0 && extractedItemsTotal > targetDeclaredTotal * 1.2;
  const underExtraction = targetDeclaredTotal > 0 && extractedItemsTotal < targetDeclaredTotal * 0.8;
  const totalsStatus: 'OK' | 'GAP' | 'OVER' | 'UNDER' | 'UNKNOWN' =
    targetDeclaredTotal <= 0
      ? 'UNKNOWN'
      : (overExtraction
        ? 'OVER'
        : (underExtraction ? 'UNDER' : (Math.abs(Number(gapVsClinicTotalGeneral || 0)) <= 1 ? 'OK' : 'GAP')));
  let status: 'OK' | 'INCOMPLETE' | 'NO_TOTAL_FOUND' | 'STRUCTURE_WEAK' =
    targetDeclaredTotal <= 0
      ? 'NO_TOTAL_FOUND'
      : (deadPages.length > 0
        ? 'STRUCTURE_WEAK'
        : (gapVsClinicTotalGeneral !== null && Math.abs(gapVsClinicTotalGeneral) <= 1 ? 'OK' : 'INCOMPLETE'));
  const reconciliationGateFailed = targetDeclaredTotal > 0 && (overExtraction || underExtraction);
  if (reconciliationGateFailed && status === 'OK') {
    status = 'INCOMPLETE';
  }
  const gateMessage = reconciliationGateFailed
    ? `Gate de conciliacion fallido: total=${targetDeclaredTotal.toLocaleString('es-CL')} vs items=${extractedItemsTotal.toLocaleString('es-CL')} (fuera de [80%,120%]).`
    : '';
  const scopeFallbackWarning =
    expectedScope === 'bill-only' && targetDeclaredTotalSource === 'clinicTotalGeneral' && billDeclaredTotal <= 0
      ? 'Total BILL no explicito: se usa TOTAL GENERAL como objetivo de conciliacion basica.'
      : '';
  const subtotalFallbackWarning =
    targetDeclaredTotalSource === 'subtotalIsapreSum'
      ? 'Sin TOTAL GENERAL explicito: se usan subtotales tipo Total Empresa como objetivo de conciliacion.'
      : '';
  const mergedValidationErrors = gateMessage
    ? [...strict.validation.errors, gateMessage]
    : [...strict.validation.errors];
  let mergedValidationWarnings = gateMessage
    ? [...strict.validation.warnings, 'Sobre-extraccion o sub-extraccion detectada por conciliacion dura.']
    : [...strict.validation.warnings];
  if (scopeFallbackWarning && !mergedValidationWarnings.includes(scopeFallbackWarning)) {
    mergedValidationWarnings = [...mergedValidationWarnings, scopeFallbackWarning];
  }
  if (subtotalFallbackWarning && !mergedValidationWarnings.includes(subtotalFallbackWarning)) {
    mergedValidationWarnings = [...mergedValidationWarnings, subtotalFallbackWarning];
  }
  if (gapAdjustment.applied.length > 0) {
    const adjustMsg =
      `Ajuste residual aplicado: ${gapAdjustment.applied.length} linea(s), ` +
      `gap ${Number(gapAdjustment.targetGapBefore || 0).toLocaleString('es-CL')} -> ${Number(gapAdjustment.residualGapAfter || 0).toLocaleString('es-CL')}.`;
    if (!mergedValidationWarnings.includes(adjustMsg)) {
      mergedValidationWarnings = [...mergedValidationWarnings, adjustMsg];
    }
  }
  if (itemAnomaliesSummary.total > 0) {
    const anomalyMsg =
      `Item anomalies v1: total=${itemAnomaliesSummary.total}, auto_fixed=${itemAnomaliesSummary.autoFixed}, ` +
      `flagged=${itemAnomaliesSummary.flagged}, excluded=${itemAnomaliesSummary.excluded}.`;
    if (!mergedValidationWarnings.includes(anomalyMsg)) {
      mergedValidationWarnings = [...mergedValidationWarnings, anomalyMsg];
    }
  }
  const strictQualityNow = mergedValidationErrors.length === 0;
  const isRenderable = rows.length > 0;
  const isReconciled = totalsStatus === 'OK' && deadPages.length === 0;
  const isComplete = isRenderable && targetDeclaredTotal > 0 && deadPages.length === 0 && !reconciliationGateFailed;
  const isCompleteAgainstClinicTotal = isReconciled;
  const boundarySignals = billBoundaryPage
    ? {
      page: Number(billBoundaryPage || 0),
      evidenceRows: rows
        .filter((row) => Number(row.page || 0) === Number(billBoundaryPage || 0))
        .filter((row) => hasTotalLineSignal(row.text) || hasSubtotalLineSignal(row.text) || isPamOnlyContextSignal(row.text))
        .slice(0, 25)
        .map((row) => ({ rowId: row.id, text: String(row.text || '').trim() }))
    }
    : null;
  const empresaSubtotalDiagnostics = preferGrossOnTotalEmpresaLayout
    ? buildEmpresaSubtotalDiagnostics(items, details.includedSubtotalsBill || details.includedSubtotals || [], logicalLines)
    : [];
  const santaMariaSubtotalDiagnostics = !preferGrossOnTotalEmpresaLayout && rows.some((row) => hasSantaMariaSubtotalSignal(String(row.text || '')))
    ? buildSantaMariaSubtotalDiagnostics(items, logicalLines, pagesInScope)
    : [];
  const santaMariaDiagnosticWarning = santaMariaSubtotalDiagnostics.length > 0
    ? (() => {
      const missingLines = santaMariaSubtotalDiagnostics.reduce((acc, block) => acc + Number(block.missingCodedLineCount || 0), 0);
      const worstGap = santaMariaSubtotalDiagnostics.reduce((acc, block) =>
        Math.max(acc, Math.abs(Number(block.gaps.codedLogicalLineTotal || 0))), 0);
      return `Subtotal diagnostics Santa Maria: secciones=${santaMariaSubtotalDiagnostics.length}, codedLines faltantes=${missingLines}, peor gap codedLogical=${worstGap.toLocaleString('es-CL')}.`;
    })()
    : '';
  if (santaMariaDiagnosticWarning && !mergedValidationWarnings.includes(santaMariaDiagnosticWarning)) {
    mergedValidationWarnings = [...mergedValidationWarnings, santaMariaDiagnosticWarning];
  }
  const subtotalDiagnostics = empresaSubtotalDiagnostics.length > 0
    ? {
      mode: 'empresa-layout' as const,
      blocks: empresaSubtotalDiagnostics
    }
    : (santaMariaSubtotalDiagnostics.length > 0
      ? {
        mode: 'santa-maria-layout' as const,
        blocks: santaMariaSubtotalDiagnostics
      }
      : undefined);

  const basePayload: NormalizedBillPayload = {
    specVersion: 'BILL_SPEC_v2_TRANSPARENT',
    source: 'pdf-calco',
    generatedAt: new Date().toISOString(),
    scope: allPages ? 'all-pages' : 'single-page',
    page,
    patientName: meta?.patientName,
    clinicName: meta?.clinicName,
    date: meta?.date,
    currency: 'CLP',
    isRenderable,
    isReconciled,
    isComplete,
    qualityFlags: {
      ...strict.flags,
      hasCompletenessGap: status !== 'OK' || reconciliationGateFailed
    },
    quality: {
      isStrict: strictQualityNow,
      errors: mergedValidationErrors,
      warnings: mergedValidationWarnings,
      overExtractionPct,
      underExtractionPct,
      deadPages: [...deadPages]
    },
    isAuditable: isRenderable && !reconciliationGateFailed,
    auditFlags: {
      ...strict.flags,
      hasCompletenessGap: status !== 'OK' || reconciliationGateFailed
    },
    validation: {
      isStrictAuditable: strictQualityNow,
      errors: mergedValidationErrors,
      warnings: mergedValidationWarnings
    },
    itemAnomalies: {
      summary: itemAnomaliesSummary,
      items: itemAnomalies
    },
    raw: {
      pages: rawPages
    },
    derived: {
      logicalLines,
      valuedLines
    },
    signals,
    nonItems,
    chargeLines: valuedLines,
    extractedLines: valuedLines,
    rows,
    logicalLines,
    pages,
    items,
    reconciliation: {
      ...reconciliation,
      extractedTotals: {
        sumChosenAmounts,
        sumFinalItemsTotal,
        sumAllAmountCandidatesMax,
        valuedLinesCount: valuedLines.length
      },
      totals: {
        clinicDeclaredTotal: clinicTotalGeneral,
        subtotalIsapreSum: Math.round(Number(reconciliation.isapreDeclaredSubtotalSum || 0)),
        itemsExtractedSum: extractedItemsTotal,
        expectedScope,
        targetDeclaredTotal,
        targetDeclaredTotalSource,
        status: totalsStatus
      },
      gaps: {
        gapVsClinicTotalGeneral
      },
      deadPages,
      status,
      boundarySignals,
      details: {
        ...details,
        billBoundaryPage: billBoundaryPage ?? details.billBoundaryPage ?? null,
        itemsScope: expectedScope,
        extractedItemsTotal,
        subtotalDiagnostics,
        billItemsTotal: extractedItemsTotal,
        billDeclaredTotal,
        pamDeclaredTotal,
        targetDeclaredTotal,
        targetDeclaredTotalSource,
        gapAdjustment: gapAdjustment.applied.length > 0
          ? {
            applied: gapAdjustment.applied.length,
            targetGapBefore: gapAdjustment.targetGapBefore,
            residualGapAfter: gapAdjustment.residualGapAfter,
            lines: gapAdjustment.applied
          }
          : undefined,
        pamTotalGeneral: pamDeclaredTotal,
        deadPages,
        clinicGapVsItemsTotal: gapVsClinicTotalGeneral,
        isCompleteAgainstClinicTotal
      }
    }
  };
  return {
    ...basePayload,
    passFail: evaluatePayloadPassFail(basePayload)
  };
};

const toBase64 = async (blob: Blob): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const idx = value.indexOf('base64,');
      if (idx < 0) {
        reject(new Error('No se pudo convertir el PDF a base64.'));
        return;
      }
      resolve(value.slice(idx + 7));
    };
    reader.onerror = () => reject(reader.error || new Error('Error leyendo PDF.'));
    reader.readAsDataURL(blob);
  });

const pdfToBase64 = async (pdfUrl: string): Promise<string> => {
  if (!pdfUrl) throw new Error('PDF no cargado.');
  if (pdfUrl.startsWith('data:application/pdf;base64,')) return pdfUrl.split('base64,')[1] || '';
  const response = await fetch(pdfUrl);
  if (!response.ok) throw new Error(`No se pudo leer PDF (${response.status}).`);
  return await toBase64(await response.blob());
};

type RawFetchOptions = {
  mode?: 'fast' | 'robust';
  renderScale?: number;
  force?: boolean;
};

const fetchRawPage = async (
  pdfBase64: string,
  page: number,
  timeoutMs = RAW_TIMEOUT_MS,
  opts?: RawFetchOptions
): Promise<RawExtractResponse> => {
  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const isDevVite = typeof window !== 'undefined' && String(window.location.port || '') === '3000';
  const mode: 'fast' | 'robust' = opts?.mode === 'robust' ? 'robust' : 'fast';
  const endpoints = isDevVite
    ? ['/api/extract-raw', 'http://127.0.0.1:5000/api/extract-raw']
    : ['/api/extract-raw'];

  let lastError: Error | null = null;
  const maxAttempts = mode === 'fast' ? 1 : 2;
  const effectiveTimeoutMs = mode === 'fast' ? Math.min(timeoutMs, 65000) : timeoutMs;

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), effectiveTimeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: pdfBase64,
            mimeType: 'application/pdf',
            maxPages: 1,
            page,
            timeoutMs: Math.max(15000, effectiveTimeoutMs - 5000),
            mode,
            renderScale: opts?.renderScale || 1.0,
            force: opts?.force === true
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          let detail = '';
          try {
            const body = await response.json();
            detail = body?.error ? String(body.error) : '';
          } catch {
            // noop
          }
          const retriable = response.status >= 500 || response.status === 429 || response.status === 408 || response.status === 504;
          const err = new Error(`RAW OCR HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
          if (retriable && attempt < maxAttempts) {
            lastError = err;
            await wait(800 * attempt);
            continue;
          }
          throw err;
        }
        return await response.json();
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          const timeoutError = new Error(`RAW OCR timeout (${Math.round(effectiveTimeoutMs / 1000)}s) en pagina ${page}.`);
          if (attempt < maxAttempts) {
            lastError = timeoutError;
            await wait(900 * attempt);
            continue;
          }
          throw timeoutError;
        }

        const isNetworkError = error instanceof TypeError || /Failed to fetch|ECONNRESET|ERR_CONNECTION_RESET/i.test(String(error?.message || ''));
        if (isNetworkError && attempt < maxAttempts) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await wait(700 * attempt);
          continue;
        }

        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    }
  }

  throw lastError || new Error(`RAW OCR fallo sin detalle (pagina ${page}).`);
};

const isRawEmpty = (raw?: RawExtractResponse, targetPage?: number): boolean => {
  const pageNum = Number(targetPage || 0);
  const pg = raw?.raw?.pages?.find((p) => Number(p.pageNumber || 0) === pageNum);
  const rowsCount = (pg?.rows || []).filter((r) => String(r.text || '').trim()).length;
  const itemsCount = (pg?.items || []).filter((r) => String(r.text || '').trim()).length;
  const sectionItemsCount = (raw?.sections || []).flatMap((s) => s.items || []).length;
  return rowsCount === 0 && itemsCount === 0 && sectionItemsCount === 0;
};

const fromRaw = (raw: RawExtractResponse, base: NormalizedBillPayload, page: number): NormalizedBillPayload => {
  const resolveRowSource = (ocrSource?: string): 'native' | 'fallback' | 'azure' | 'ocr' => {
    const source = String(ocrSource || '').toLowerCase();
    if (source.includes('native-textlayer')) return 'native';
    if (source.includes('azure')) return 'azure';
    if (source.includes('openai') || source.includes('ocr')) return 'ocr';
    return 'fallback';
  };
  const rows = (raw.raw?.pages || []).flatMap((pg) => {
    const pageNum = Number(pg.pageNumber || page);
    const pageHeight = Number(pg.height || 1200);
    const pageWidth = Number(pg.width || 900);
    const rowSource = resolveRowSource(pg.ocrSource);
    const lineItems = (pg.items || []).filter((cell) => String(cell.text || '').trim().length > 0);
    if (lineItems.length > 0) {
      return lineItems.map((cell, idx) => {
        const text = String(cell.text || '').trim();
        const h = Math.max(8, Number(cell.height || 10));
        const w = Math.max(10, Number(cell.width || Math.max(10, text.length * 6)));
        return {
          id: `raw-line-${pageNum}-${idx + 1}`,
          page: pageNum,
          bbox: {
            x: Math.max(0, Number(cell.x || 0)),
            y: Math.max(0, pageHeight - Number(cell.y || 0)),
            w: Math.min(Math.max(1, pageWidth), w),
            h
          },
          text,
          source: rowSource,
          pageClass: pg.pageClass || 'unknown',
          rowKind: classifyRow(text),
          rowTag: classifyRowTag(text),
          normalizedText: normalize(text),
          terms: terms(text)
        };
      });
    }
    return (pg.rows || [])
      .filter((r) => String(r.text || '').trim().length > 0)
      .map((r) => {
        const text = String(r.text || '').trim();
        return {
          id: `raw-row-${pg.pageNumber}-${r.rowIndex}`,
          page: pageNum,
          bbox: { x: 12, y: Math.max(0, pageHeight - Number(r.y || 0)), w: Math.max(1, pageWidth - 24), h: 11 },
          text,
          source: rowSource,
          pageClass: pg.pageClass || 'unknown',
          rowKind: classifyRow(text),
          rowTag: classifyRowTag(text),
          normalizedText: normalize(text),
          terms: terms(text)
        };
      });
  });

  // Transparent mode: keep OCR evidence as rows/lines and avoid parser-generated items from sections.
  const items: NormalizedBillItem[] = [];
  const pageFallbackRows = base.rows.filter((r) =>
    Number(r.page || 0) === Number(page || 0) && String(r.text || '').trim().length > 0
  );

  return buildPayload(rows.length ? rows : pageFallbackRows, page, false, {
    patientName: raw.patientName && raw.patientName !== 'N/A' ? raw.patientName : base.patientName,
    clinicName: raw.clinicName && raw.clinicName !== 'N/A' ? raw.clinicName : base.clinicName,
    date: raw.date || base.date
  }, items);
};

export default function PdfViewerDemo() {
  const [urlInput, setUrlInput] = useState('');
  const [activePdfUrl, setActivePdfUrl] = useState('');
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.5);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('rows');
  const [analyzeAllPages, setAnalyzeAllPages] = useState(false);
  const [useOpenAIFallback, setUseOpenAIFallback] = useState(false);
  const [hasTextLayer, setHasTextLayer] = useState(false);
  const [rows, setRows] = useState<OverlayEntry[]>([]);
  const [selected, setSelected] = useState<TextClickPayload | null>(null);
  const [m10m11Status, setM10m11Status] = useState('');
  const [loadedSource, setLoadedSource] = useState('');
  const [isHydratingAudit, setIsHydratingAudit] = useState(false);
  const [auditHydrationError, setAuditHydrationError] = useState<string | null>(null);
  const [pageOcrSourceMap, setPageOcrSourceMap] = useState<Record<number, string>>({});

  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hydrationInFlightRef = useRef<Promise<NormalizedBillPayload> | null>(null);
  const pdfBase64CacheRef = useRef<{ pdfUrl: string; base64: string } | null>(null);
  const rawByPageCacheRef = useRef<Map<number, RawExtractResponse>>(new Map());
  const hydratedPayloadCacheRef = useRef<{ key: string; payload: NormalizedBillPayload } | null>(null);

  const resetCaches = useCallback(() => {
    hydrationInFlightRef.current = null;
    pdfBase64CacheRef.current = null;
    rawByPageCacheRef.current.clear();
    hydratedPayloadCacheRef.current = null;
    setPageOcrSourceMap({});
  }, []);

  const handleClearCache = useCallback((): void => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    resetCaches();
    localStorage.removeItem('clinic_audit_result');
    localStorage.removeItem('clinic_audit_file_fingerprint');
    setUrlInput('');
    setActivePdfUrl('');
    setLoadedSource('');
    setPdfNumPages(0);
    setPageNumber(1);
    setHasTextLayer(false);
    setRows([]);
    setSelected(null);
    setAuditHydrationError(null);
    setM10m11Status('Cache y archivo en sesion borrados.');
  }, [resetCaches]);

  const mergeRawPageSources = useCallback((raw?: RawExtractResponse | null) => {
    const pages = raw?.raw?.pages;
    if (!Array.isArray(pages) || pages.length === 0) return;
    setPageOcrSourceMap((prev) => {
      const next = { ...prev };
      for (const pg of pages) {
        const page = Number(pg?.pageNumber || 0);
        if (!(page > 0)) continue;
        const source = String(pg?.ocrSource || '').trim();
        if (!source) continue;
        next[page] = source;
      }
      return next;
    });
  }, []);

  const normalizedBillPayload = useMemo(() => buildPayload(toNormalizedRows(rows), pageNumber, analyzeAllPages), [rows, pageNumber, analyzeAllPages]);
  const hydrationKey = useMemo(() => `${activePdfUrl}|${analyzeAllPages ? 'all' : `p-${pageNumber}`}|rows-${rows.length}|text-${hasTextLayer ? 1 : 0}|pdfPages-${pdfNumPages}`,
    [activePdfUrl, analyzeAllPages, pageNumber, rows.length, hasTextLayer, pdfNumPages]);

  const getPdfBase64Cached = useCallback(async (pdfUrl: string): Promise<string> => {
    const cached = pdfBase64CacheRef.current;
    if (cached && cached.pdfUrl === pdfUrl) return cached.base64;
    setM10m11Status('Preparando PDF para OCR RAW...');
    const startedAt = performance.now();
    const base64 = await pdfToBase64(pdfUrl);
    pdfBase64CacheRef.current = { pdfUrl, base64 };
    const sizeMb = ((base64.length * 3) / 4 / (1024 * 1024)).toFixed(2);
    console.log(`[PDF-AUDIT] PDF base64 listo (${sizeMb} MB) en ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
    return base64;
  }, []);

  const resolveAuditablePayload = useCallback(async (): Promise<NormalizedBillPayload> => {
    const base = normalizedBillPayload;
    if (!activePdfUrl) return base;
    // For scanned PDFs we must hydrate from OCR RAW when text layer exists but has no usable text.
    const hasUsableTextLayer = hasTextLayer && base.rows.some((r) => String(r.text || '').trim().length > 0);
    const forceRawHydration = shouldForceRawHydration(base);
    if (hasUsableTextLayer && base.derived.valuedLines.length > 0 && !forceRawHydration) return base;
    if (hasUsableTextLayer && !forceRawHydration) return base;

    const hydrated = hydratedPayloadCacheRef.current;
    if (hydrated && hydrated.key === hydrationKey) return hydrated.payload;

    if (hydrationInFlightRef.current) {
      console.log('[PDF-AUDIT] Reutilizando hidratacion OCR RAW en curso.');
      return hydrationInFlightRef.current;
    }

    setIsHydratingAudit(true);
    setAuditHydrationError(null);

    const run = (async (): Promise<NormalizedBillPayload> => {
      try {
        const pagesFromRows = [...new Set(base.rows.map((r) => Number(r.page)).filter((p) => Number.isFinite(p) && p > 0))].sort((a, b) => a - b);
        const pages = analyzeAllPages
          ? (!hasTextLayer && pdfNumPages > 0
            ? Array.from({ length: pdfNumPages }, (_, idx) => idx + 1)
            : (pagesFromRows.length
              ? pagesFromRows
              : (pdfNumPages > 0 ? Array.from({ length: pdfNumPages }, (_, idx) => idx + 1) : [])))
          : [Math.max(1, pageNumber)];
        if (!pages.length) pages.push(Math.max(1, pageNumber));

        const forceRawLabel = forceRawHydration ? 'OCR RAW forzado por formato de cuenta.' : 'Sin lineas valorizadas detectadas.';
        setM10m11Status(`${forceRawLabel} OCR RAW de ${pages.length} pagina(s) en curso...`);
        console.log(`[PDF-AUDIT] OCR RAW start pages=${pages.join(',')}`);

        const base64 = await getPdfBase64Cached(activePdfUrl);
        const mergedRows = new Map<string, NormalizedRow>();
        const failedPages: number[] = [];

        let patientName = base.patientName;
        let clinicName = base.clinicName;
        let date = base.date;

        const runPageWithHeartbeat = async <T,>(
          runTask: () => Promise<T>,
          buildLabel: (elapsedSeconds: number) => string
        ): Promise<T> => {
          let elapsedSeconds = 0;
          setM10m11Status(buildLabel(elapsedSeconds));
          const heartbeat = window.setInterval(() => {
            elapsedSeconds += 1;
            setM10m11Status(buildLabel(elapsedSeconds));
          }, RAW_STATUS_TICK_MS);
          try {
            return await runTask();
          } finally {
            window.clearInterval(heartbeat);
          }
        };

        for (let i = 0; i < pages.length; i += 1) {
          const targetPage = pages[i];
          const pageLabel = `OCR RAW pagina ${i + 1}/${pages.length}`;

          let raw = rawByPageCacheRef.current.get(targetPage);
          try {
            if (!raw) {
              const t0 = performance.now();
              console.log(`[PDF-AUDIT] OCR RAW page ${targetPage} (${i + 1}/${pages.length})`);
              raw = await runPageWithHeartbeat(
                () => fetchRawPage(base64, targetPage, RAW_TIMEOUT_MS, { mode: 'fast', renderScale: 1.0 }),
                (elapsedSeconds) => `${pageLabel} (${elapsedSeconds}s)...`
              );
              console.log(`[PDF-AUDIT] OCR RAW page ${targetPage} listo en ${((performance.now() - t0) / 1000).toFixed(1)}s`);
            }

            if (isRawEmpty(raw, targetPage)) {
              console.warn(`[PDF-AUDIT] RAW vacio en p${targetPage}. Reintentando modo robusto...`);
              const robustStartedAt = performance.now();
              raw = await runPageWithHeartbeat(
                () => fetchRawPage(base64, targetPage, Math.max(RAW_TIMEOUT_MS, 110000), { mode: 'robust', renderScale: 2.0, force: true }),
                (elapsedSeconds) => `${pageLabel} robusto (${elapsedSeconds}s)...`
              );
              console.log(
                `[PDF-AUDIT] OCR RAW page ${targetPage} robusto listo en ${((performance.now() - robustStartedAt) / 1000).toFixed(1)}s`
              );
              if (isRawEmpty(raw, targetPage)) {
                console.warn(`[PDF-AUDIT] RAW sigue vacio en p${targetPage} tras reintento robusto.`);
              }
            }

            rawByPageCacheRef.current.set(targetPage, raw);
            mergeRawPageSources(raw);
          } catch (error: any) {
            const msg = String(error?.message || 'error desconocido');
            console.error(`[PDF-AUDIT] OCR RAW fallo en pagina ${targetPage}:`, error);
            const retryableTimeout = /504|timeout|RAW OCR HTTP 5\d{2}/i.test(msg);
            if (retryableTimeout) {
              try {
                console.warn(`[PDF-AUDIT] p${targetPage} fallo fast por timeout/504. Reintentando robusto...`);
                const robustStartedAt = performance.now();
                raw = await runPageWithHeartbeat(
                  () => fetchRawPage(base64, targetPage, Math.max(RAW_TIMEOUT_MS, 140000), { mode: 'robust', renderScale: 2.0, force: true }),
                  (elapsedSeconds) => `${pageLabel} robusto-retry (${elapsedSeconds}s)...`
                );
                console.log(
                  `[PDF-AUDIT] OCR RAW page ${targetPage} robusto-retry listo en ${((performance.now() - robustStartedAt) / 1000).toFixed(1)}s`
                );
              } catch (robustError: any) {
                failedPages.push(targetPage);
                const robustMsg = String(robustError?.message || msg);
                console.error(`[PDF-AUDIT] OCR RAW robusto-retry fallo en pagina ${targetPage}:`, robustError);
                setM10m11Status(`${pageLabel} fallo: ${robustMsg}`);
                continue;
              }
            } else {
              failedPages.push(targetPage);
              setM10m11Status(`${pageLabel} fallo: ${msg}`);
              continue;
            }
          }
          if (!raw) {
            failedPages.push(targetPage);
            setM10m11Status(`${pageLabel} sin respuesta OCR util.`);
            continue;
          }

          const partial = fromRaw(raw, base, targetPage);
          for (const row of partial.rows) mergedRows.set(row.id, row);
          if (!patientName && partial.patientName) patientName = partial.patientName;
          if (!clinicName && partial.clinicName) clinicName = partial.clinicName;
          if (!date && partial.date) date = partial.date;
        }

        const output = buildPayload(
          mergedRows.size ? [...mergedRows.values()] : base.rows,
          pageNumber,
          analyzeAllPages,
          { patientName, clinicName, date }
        );

        const recon = output.reconciliation;
        const extractedItemsTotal = Math.round(output.items.reduce((acc, item) => acc + Math.round(Number(item.total || 0)), 0));
        const reconDetails = recon?.details;
        const itemsScopeNow: 'bill-only' | 'full' = reconDetails?.itemsScope === 'bill-only' ? 'bill-only' : 'full';
        const targetTotalsNow = resolveReconciliationTargetTotal(recon, itemsScopeNow);
        const clinicTotal = Math.round(Number(targetTotalsNow.targetTotal || 0));
        const clinicGapVsItemsTotal = clinicTotal > 0 ? Math.round(clinicTotal - extractedItemsTotal) : null;
        const boundaryPage = Number(reconDetails?.billBoundaryPage || resolveClinicBillBoundaryPage(output.rows) || 0) || null;
        const tableLikePagesNow = new Set<number>(
          output.logicalLines
            .filter((line) => hasTableHeaderSignature(String(line.fullText || '')))
            .map((line) => Number(line.page || 0))
            .filter((pageNum) => pageNum > 0)
        );
        const pagesInScope = analyzeAllPages && boundaryPage
          ? Array.from({ length: boundaryPage }, (_, idx) => idx + 1)
          : pages;
        const deadPagesDetailed = pagesInScope.flatMap((p) => {
          const pageNum = Number(p || 0);
          if (!(pageNum > 0)) return [];
          if (boundaryPage && pageNum === Number(boundaryPage || 0)) return [];
          const valuedLinesCount = output.derived.valuedLines.filter((i) => Number(i.page || 0) === pageNum).length;
          const chargeEvidence = hasChargeEvidenceInPage(pageNum, output.logicalLines, tableLikePagesNow);
          const rawRowsCount = output.rows.filter((r) =>
            Number(r.page || 0) === pageNum &&
            (/^raw-(row|line)-/i.test(String(r.id || ''))) &&
            String(r.text || '').trim().length > 0
          ).length;
          if (rawRowsCount > 0 && valuedLinesCount > 0) return [];
          if (rawRowsCount > 0 && !chargeEvidence) return [];
          const heurRowsCount = output.rows.filter((r) =>
            Number(r.page || 0) === pageNum &&
            String(r.id || '').startsWith('heur-row-') &&
            String(r.text || '').trim().length > 0
          ).length;
          const moneyTokenRowsCount = output.rows.filter((r) =>
            Number(r.page || 0) === pageNum &&
            extractMonetaryCandidatesFromText(String(r.text || ''), {
              excludeLikelyIdentifiers: true,
              requireMoneySignature: true,
              tableLike: true
            }).filter((v) => v >= RAW_ITEM_MIN_TOTAL && v <= RAW_ITEM_MAX_TOTAL).length > 0
          ).length;
          const reason: 'NO_TEXT' | 'FILTERED_OUT' | 'LAYOUT_TABLE' =
            rawRowsCount === 0 && heurRowsCount === 0
              ? 'NO_TEXT'
              : (chargeEvidence || moneyTokenRowsCount > 0 ? 'FILTERED_OUT' : 'LAYOUT_TABLE');
          return [{
            page: pageNum,
            reason,
            rawRowsCount,
            heurRowsCount,
            moneyTokenRowsCount,
            itemCandidateCount: valuedLinesCount
          }];
        });
        const deadPages = deadPagesDetailed.map((row) => row.page);
        const isCompleteAgainstClinicTotal = clinicTotal > 0 && clinicGapVsItemsTotal !== null
          ? Math.abs(clinicGapVsItemsTotal) <= 1
          : false;
        const hasCompletenessGap = deadPages.length > 0 || (clinicTotal > 0 && !isCompleteAgainstClinicTotal);

        if (recon) {
          const currentDetails: NonNullable<NormalizedBillPayload['reconciliation']>['details'] = recon.details || {
            clinicTotalLine: null,
            includedSubtotals: [],
            excludedSubtotals: [],
            gapLikelyExplainedBy: []
          };
          output.reconciliation = {
            ...recon,
            details: {
              ...currentDetails,
              extractedItemsTotal,
              billBoundaryPage: boundaryPage ?? currentDetails.billBoundaryPage ?? null,
              deadPages,
              deadPagesDetailed,
              clinicGapVsItemsTotal,
              isCompleteAgainstClinicTotal
            }
          };
        }

        output.qualityFlags = {
          ...output.qualityFlags,
          hasCompletenessGap
        };
        output.auditFlags = { ...output.qualityFlags };
        output.isReconciled = !hasCompletenessGap;
        output.isComplete = output.isRenderable && !hasCompletenessGap && clinicTotal > 0;
        if (hasCompletenessGap) {
          const warning = `Incompleto (${itemsScopeNow}) vs total objetivo: total=${clinicTotal.toLocaleString('es-CL')} items=${extractedItemsTotal.toLocaleString('es-CL')} gap=${Number(clinicGapVsItemsTotal || 0).toLocaleString('es-CL')} deadPages=${deadPages.join(',') || 'none'}.`;
          if (!output.quality.warnings.includes(warning)) {
            output.quality.warnings = [...output.quality.warnings, warning];
          }
          if (!output.validation.warnings.includes(warning)) {
            output.validation.warnings = [...output.validation.warnings, warning];
          }
        }

        if (output.derived.valuedLines.length > 0) {
          const partialTag = failedPages.length ? ` (parcial: fallaron ${failedPages.length} pagina(s))` : '';
          if (hasCompletenessGap) {
            setM10m11Status(
              `JSON transparente listo, pero INCOMPLETO vs total objetivo (${itemsScopeNow}). ` +
              `Total=${clinicTotal.toLocaleString('es-CL')} items=${extractedItemsTotal.toLocaleString('es-CL')} ` +
              `gap=${Number(clinicGapVsItemsTotal || 0).toLocaleString('es-CL')} | paginas muertas: ${deadPages.join(', ') || 'ninguna'}${partialTag}`
            );
          } else {
            setM10m11Status(`OCR RAW aplicado: ${output.derived.valuedLines.length} lineas valorizadas (${pages.length} pags).${partialTag}`);
          }
          hydratedPayloadCacheRef.current = { key: hydrationKey, payload: output };
          return output;
        }

        const detail = failedPages.length ? ` Fallaron paginas: ${failedPages.join(', ')}.` : '';
        setM10m11Status(`OCR RAW sin lineas valorizadas, pero con filas RAW disponibles.${detail}`);
        setAuditHydrationError(`OCR RAW no devolvio lineas valorizadas con monto.${detail}`);
        hydratedPayloadCacheRef.current = { key: hydrationKey, payload: output };
        return output;
      } catch (error: any) {
        const msg = error?.message || 'error desconocido';
        setM10m11Status(`No se pudo hidratar JSON transparente: ${msg}`);
        setAuditHydrationError(msg);
        return base;
      }
    })();

    hydrationInFlightRef.current = run;
    try {
      return await run;
    } finally {
      hydrationInFlightRef.current = null;
      setIsHydratingAudit(false);
    }
  }, [normalizedBillPayload, activePdfUrl, hasTextLayer, hydrationKey, analyzeAllPages, pageNumber, getPdfBase64Cached, pdfNumPages, mergeRawPageSources]);

  const resolveClickTextFromOcr = useCallback((payload: TextClickPayload, rawOverride?: RawExtractResponse): string => {
    const explicit = String(payload.text || '').trim();
    if (explicit) return explicit;

    const targetPage = Number(payload.page || 0);
    if (!(targetPage > 0)) return '';

    const clickCenterY = Number(payload.bboxPx.y || 0) + Number(payload.bboxPx.h || 0) / 2;
    const clickCenterX = Number(payload.bboxPx.x || 0) + Number(payload.bboxPx.w || 0) / 2;
    const pageHeight = Number(payload.pageHeight || 0);
    const clickNormY = pageHeight > 0 ? clickCenterY / pageHeight : null;
    const clickNormX = pageHeight > 0 ? clickCenterX / Math.max(1, Number(payload.pageWidth || 0) || clickCenterX || 1) : null;

    const cachedRaw = rawOverride || rawByPageCacheRef.current.get(targetPage);
    const rawPage = cachedRaw?.raw?.pages?.find((p) => Number(p.pageNumber || 0) === targetPage);
    if (rawPage && Array.isArray(rawPage.items) && rawPage.items.length > 0) {
      const itemMatch = String(payload.id || '').match(/^raw-line-(\d+)-(\d+)$/);
      if (itemMatch && Number(itemMatch[1]) === targetPage) {
        const lineIdx = Math.max(1, Number(itemMatch[2]));
        const byIdx = rawPage.items[Math.min(rawPage.items.length - 1, lineIdx - 1)];
        if (byIdx && String(byIdx.text || '').trim()) return String(byIdx.text || '').trim();
      }

      const rawHeight = Number(rawPage.height || 0);
      const rawWidth = Number(rawPage.width || 0);
      if (rawHeight > 0) {
        let bestText = '';
        let bestScore = Number.POSITIVE_INFINITY;
        for (const item of rawPage.items) {
          const text = String(item.text || '').trim();
          if (!text) continue;
          const rowNormY = (rawHeight - Number(item.y || 0)) / rawHeight;
          const rowNormX = rawWidth > 0 ? Number(item.x || 0) / rawWidth : 0;
          const deltaY = clickNormY === null ? 0 : Math.abs(rowNormY - clickNormY);
          const deltaX = clickNormX === null ? 0 : Math.abs(rowNormX - clickNormX);
          const score = deltaY + deltaX * 0.35;
          if (score < bestScore) {
            bestScore = score;
            bestText = text;
          }
        }
        if (bestText) return bestText;
      }
    }

    if (rawPage && Array.isArray(rawPage.rows) && rawPage.rows.length > 0) {
      const heurMatch = String(payload.id || '').match(/^heur-row-(\d+)-(\d+)$/);
      if (heurMatch && Number(heurMatch[1]) === targetPage) {
        const heurIdx = Math.max(1, Number(heurMatch[2]));
        const sortedByY = [...rawPage.rows]
          .filter((r) => String(r.text || '').trim().length > 0)
          .sort((a, b) => Number(b.y || 0) - Number(a.y || 0));
        const byOrdinal = sortedByY[Math.min(sortedByY.length - 1, heurIdx - 1)];
        if (byOrdinal && String(byOrdinal.text || '').trim()) return String(byOrdinal.text || '').trim();
      }

      const rawHeight = Number(rawPage.height || 0);
      if (rawHeight > 0) {
        let bestText = '';
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const row of rawPage.rows) {
          const text = String(row.text || '').trim();
          if (!text) continue;
          const rowNormY = (rawHeight - Number(row.y || 0)) / rawHeight;
          const delta = clickNormY === null ? 0 : Math.abs(rowNormY - clickNormY);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestText = text;
          }
        }
        if (bestText) return bestText;
      }
    }

    const hydrated = hydratedPayloadCacheRef.current;
    if (hydrated && hydrated.key === hydrationKey) {
      const pageRows = hydrated.payload.rows
        .filter((r) => Number(r.page || 0) === targetPage && String(r.text || '').trim().length > 0);
      if (pageRows.length > 0) {
        const estimatedHeight = pageRows.reduce((max, row) => Math.max(max, Number(row.bbox.y || 0) + Number(row.bbox.h || 0)), 0);
        if (estimatedHeight > 0) {
          const targetNorm = clickNormY === null ? 0 : clickNormY;
          let bestRowText = '';
          let bestDelta = Number.POSITIVE_INFINITY;
          for (const row of pageRows) {
            const rowCenter = Number(row.bbox.y || 0) + Number(row.bbox.h || 0) / 2;
            const rowNorm = rowCenter / estimatedHeight;
            const delta = Math.abs(rowNorm - targetNorm);
            if (delta < bestDelta) {
              bestDelta = delta;
              bestRowText = String(row.text || '').trim();
            }
          }
          if (bestRowText) return bestRowText;
        } else {
          return String(pageRows[0].text || '').trim();
        }
      }
    }

    return '';
  }, [hydrationKey]);

  const handleOverlayTextClick = useCallback((payload: TextClickPayload): void => {
    const explicit = String(payload.text || '').trim();
    if (explicit) {
      setSelected(payload);
      return;
    }

    const resolvedNow = resolveClickTextFromOcr(payload);
    if (resolvedNow) {
      setSelected({ ...payload, text: resolvedNow });
      return;
    }

    setSelected({ ...payload, text: '[Resolviendo OCR para esta linea...]' });
    if (!activePdfUrl || hasTextLayer) return;

    const targetPage = Math.max(1, Number(payload.page || pageNumber || 1));
    void (async () => {
      try {
        let raw = rawByPageCacheRef.current.get(targetPage);
        if (!raw) {
          setM10m11Status(`Resolviendo texto OCR para pagina ${targetPage}...`);
          const base64 = await getPdfBase64Cached(activePdfUrl);
          raw = await fetchRawPage(base64, targetPage, RAW_TIMEOUT_MS);
          rawByPageCacheRef.current.set(targetPage, raw);
          mergeRawPageSources(raw);
        }

        const recovered = resolveClickTextFromOcr(payload, raw);
        if (recovered) {
          setSelected((prev) => {
            if (!prev || prev.id !== payload.id) return prev;
            return { ...prev, text: recovered };
          });
          setM10m11Status(`Texto OCR recuperado (pagina ${targetPage}).`);
        } else {
          setSelected((prev) => {
            if (!prev || prev.id !== payload.id) return prev;
            return { ...prev, text: '[No se pudo recuperar OCR para esta linea]' };
          });
          setM10m11Status(`No se pudo mapear texto OCR para la linea seleccionada (pagina ${targetPage}).`);
        }
      } catch (error: any) {
        const msg = String(error?.message || 'error desconocido');
        setSelected((prev) => {
          if (!prev || prev.id !== payload.id) return prev;
          return { ...prev, text: `[Error OCR: ${msg}]` };
        });
        setM10m11Status(`No se pudo recuperar texto OCR en click: ${msg}`);
      }
    })();
  }, [resolveClickTextFromOcr, activePdfUrl, hasTextLayer, pageNumber, getPdfBase64Cached, mergeRawPageSources]);

  const handleLoadUrl = (): void => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    resetCaches();
    setPdfNumPages(0);
    setSelected(null);
    setM10m11Status('');
    setAuditHydrationError(null);
    setActivePdfUrl(trimmed);
    setLoadedSource(`URL: ${trimmed}`);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;
    resetCaches();
    setPdfNumPages(0);
    setUrlInput('');
    setSelected(null);
    setM10m11Status('');
    setAuditHydrationError(null);
    setActivePdfUrl(objectUrl);
    setLoadedSource(file.name);
  };
  const handleExportRowsJson = async (): Promise<void> => {
    if (overlayMode !== 'rows' || rows.length === 0) return;
    const payload = await resolveAuditablePayload();
    if (!payload.isRenderable) {
      const detail = payload.quality.errors.slice(0, 3).join(' | ');
      setM10m11Status(`Export JSON con advertencias de calidad. ${detail}`);
    }

    const exportPayloadBase = analyzeAllPages
      ? payload
      : (() => {
          const pageRows = payload.rows.filter((r) => r.page === pageNumber);
          const pageLines = payload.logicalLines.filter((l) => l.page === pageNumber);
          const pageItems = payload.items.filter((i) => i.page === pageNumber);
          const pageValuedLines = payload.derived.valuedLines.filter((line) => Number(line.page || 0) === Number(pageNumber || 0));
          const filterSignals = (entries: SignalEntry[]) => entries.filter((entry) => Number(entry.page || 0) === Number(pageNumber || 0));
          const pageSignals = {
            rutLines: filterSignals(payload.signals.rutLines || []),
            idLines: filterSignals(payload.signals.idLines || []),
            totalLines: filterSignals(payload.signals.totalLines || []),
            subtotalLines: filterSignals(payload.signals.subtotalLines || []),
            pamLines: filterSignals(payload.signals.pamLines || []),
            noiseLines: filterSignals(payload.signals.noiseLines || [])
          };
          const pageNonItems = (payload.nonItems || []).filter((entry) => Number(entry.page || 0) === Number(pageNumber || 0));
          const pageItemAnomaliesItems = (payload.itemAnomalies?.items || []).filter((entry) => Number(entry.page || 0) === Number(pageNumber || 0));
          const key = String(pageNumber);
          return {
            ...payload,
            scope: 'single-page' as const,
            page: pageNumber,
            raw: {
              pages: payload.raw.pages.filter((pageInfo) => Number(pageInfo.page || 0) === Number(pageNumber || 0))
            },
            derived: {
              logicalLines: pageLines,
              valuedLines: pageValuedLines
            },
            signals: pageSignals,
            nonItems: pageNonItems,
            itemAnomalies: {
              summary: summarizeItemAnomalies(pageItemAnomaliesItems),
              items: pageItemAnomaliesItems
            },
            chargeLines: pageValuedLines,
            extractedLines: pageValuedLines,
            rows: pageRows,
            logicalLines: pageLines,
            items: pageItems,
            pages: {
              [key]: payload.pages[key] || {
                rows: pageRows,
                logicalLineIds: pageLines.map((l) => l.id),
                valuedLineIds: pageValuedLines.map((line) => line.id),
                itemIds: pageItems.map((i) => i.id),
                subtotal: Math.round(pageValuedLines.reduce((acc, line) => acc + Math.round(Number(line.chosenAmount || 0)), 0))
              }
            }
          };
        })();
    const exportData = {
      ...exportPayloadBase,
      passFail: evaluatePayloadPassFail(exportPayloadBase)
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = analyzeAllPages ? 'rows-all-pages.json' : `rows-page-${pageNumber}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrepareForM10M11 = async (): Promise<void> => {
    if (overlayMode !== 'rows' || rows.length === 0) {
      setM10m11Status('Sin filas para normalizar. Activa modo Rows y verifica overlays.');
      return;
    }
    const payload = await resolveAuditablePayload();
    if (!payload.isRenderable) {
      const detail = payload.quality.errors.slice(0, 3).join(' | ');
      setM10m11Status(`M10/M11 con advertencias (modo desarrollo). ${detail}`);
    }
    localStorage.setItem('clinic_audit_result', JSON.stringify(payload));
    localStorage.setItem('clinic_audit_file_fingerprint', `${payload.generatedAt}|${payload.derived.valuedLines.length}|${payload.rows.length}`);
    const recon = payload.reconciliation;
    const deadPages = recon?.details?.deadPages || [];
    const isCompleteAgainstClinicTotal = recon?.details?.isCompleteAgainstClinicTotal === true && deadPages.length === 0;
    const residualAdjustmentLines = Number(payload.passFail?.summary.residualAdjustmentLines || 0);
    const residualAdjustmentAmount = Number(payload.passFail?.summary.residualAdjustmentAmount || 0);
    const reconMsg = recon
      ? ` | concil-basica: total=${Number(recon.totals?.targetDeclaredTotal || recon.declaredTotals?.clinicTotalGeneral?.amount || 0).toLocaleString('es-CL')} items=${Number(recon.totals?.itemsExtractedSum || recon.details?.extractedItemsTotal || 0).toLocaleString('es-CL')} gap=${Number(recon.gaps?.gapVsClinicTotalGeneral || 0).toLocaleString('es-CL')} status=${recon.status || 'UNKNOWN'}${deadPages.length ? ` | deadPages=${deadPages.join(',')}` : ''}`
      : '';
    const passFailMsg = payload.passFail?.overallStatus ? ` | gate=${payload.passFail.overallStatus}` : '';
    const residualMsg = residualAdjustmentLines > 0
      ? ` | ajusteResidual=${residualAdjustmentLines} linea(s) / ${residualAdjustmentAmount.toLocaleString('es-CL')}`
      : '';
    setM10m11Status(`${isCompleteAgainstClinicTotal ? 'clinic_audit_result listo' : 'clinic_audit_result guardado con brecha de completitud'}: ${payload.derived.valuedLines.length} lineas valorizadas (${payload.rows.length} filas).${reconMsg}${passFailMsg}${residualMsg}`);
    console.log('[Bill->M10/M11] clinic_audit_result actualizado', payload);
  };

  const handleTextLayerChange = useCallback((value: boolean): void => setHasTextLayer(value), []);
  const handleDocMeta = useCallback((meta: { numPages: number }): void => {
    const total = Math.max(0, Number(meta?.numPages || 0));
    setPdfNumPages(total);
  }, []);
  const hasFallbackRows = rows.some((r) => r.source !== 'native');
  const cachedHydratedPayload = hydratedPayloadCacheRef.current?.key === hydrationKey ? hydratedPayloadCacheRef.current.payload : null;
  const hasChargeLines = normalizedBillPayload.derived.valuedLines.length > 0 || (cachedHydratedPayload?.derived.valuedLines.length || 0) > 0;
  const strictQualityNow = Boolean(
    normalizedBillPayload.quality?.isStrict || cachedHydratedPayload?.quality?.isStrict
  );
  const hasCompletenessGapNow = Boolean(
    normalizedBillPayload.qualityFlags?.hasCompletenessGap || cachedHydratedPayload?.qualityFlags?.hasCompletenessGap
  );
  const completenessPayload = cachedHydratedPayload || normalizedBillPayload;
  const completeAgainstTotalNow = Boolean(completenessPayload.isComplete);
  const reconciledNow = Boolean(completenessPayload.isReconciled);
  const passFailNow = completenessPayload.passFail?.overallStatus === 'PASS';
  const passFailLabel = completenessPayload.passFail?.overallStatus || 'FAIL';
  const residualAdjustmentLinesNow = Number(completenessPayload.passFail?.summary.residualAdjustmentLines || 0);
  const residualAdjustmentAmountNow = Number(completenessPayload.passFail?.summary.residualAdjustmentAmount || 0);
  const itemAnomaliesSummaryNow = completenessPayload.itemAnomalies?.summary || summarizeItemAnomalies([]);

  const isRenderableNow = overlayMode === 'rows' && rows.length > 0;
  const currentPageOcrSource = pageOcrSourceMap[pageNumber] || (hasTextLayer ? 'native-textlayer' : 'unknown');
  const selectedPageOcrSource = selected
    ? (pageOcrSourceMap[Number(selected.page || 0)] || (hasTextLayer ? 'native-textlayer' : 'unknown'))
    : '';
  const auditReason = analyzeAllPages && !hasTextLayer
    ? (hasChargeLines
      ? (hasCompletenessGapNow
        ? 'JSON transparente generado, pero incompleto vs TOTAL GENERAL (revisar paginas muertas/gap).'
        : 'Documento completo representado y conciliado.')
      : 'Documento completo local. Para JSON transparente se ejecuta OCR RAW por pagina.')
    : rows.length === 0
      ? 'No se detectaron filas en esta pagina.'
      : (!strictQualityNow
        ? `JSON transparente con warnings de calidad.${normalizedBillPayload.quality.errors[0] ? ` ${normalizedBillPayload.quality.errors[0]}` : ''}`
        : (passFailNow
          ? (itemAnomaliesSummaryNow.flagged > 0
            ? 'Listo para calco visual y gate PASS, con anomalias numericas marcadas.'
            : 'Listo para calco visual, export JSON y gate PASS.')
          : (hasFallbackRows ? 'Listo para calco visual con filas de fallback.' : 'Listo para calco visual y export JSON.')));

  return (
    <div className="w-full p-4 xl:p-6 space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-4">
        <div className="flex items-center gap-2 text-slate-800"><FileText size={18} /><h2 className="text-sm font-black uppercase tracking-wider">Cuentas Clinicas - PDF Calco</h2></div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-6 flex gap-2"><input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://.../documento.pdf" className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm" /><button onClick={handleLoadUrl} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold inline-flex items-center gap-2"><Link2 size={14} /> Cargar URL</button></div>
          <div className="lg:col-span-2"><label className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-bold inline-flex items-center justify-center gap-2 cursor-pointer"><Upload size={14} /> Cargar Archivo<input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} /></label></div>
          <div className="lg:col-span-1"><input type="number" min={1} value={pageNumber} onChange={(e) => setPageNumber(Math.max(1, Number(e.target.value || 1)))} className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" /></div>
          <div className="lg:col-span-1"><input type="number" step={0.1} min={0.5} max={3} value={scale} onChange={(e) => setScale(Number(e.target.value || 1.5))} className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" /></div>
          <div className="lg:col-span-2 flex items-center justify-end gap-2">
            <button onClick={() => setAnalyzeAllPages((v) => !v)} className={`px-3 py-2 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${analyzeAllPages ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700'}`}>{analyzeAllPages ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Documento completo</button>
            <button onClick={() => setUseOpenAIFallback((v) => !v)} className={`px-3 py-2 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${useOpenAIFallback ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{useOpenAIFallback ? <ToggleRight size={14} /> : <ToggleLeft size={14} />} Fallback OpenAI</button>
            <button onClick={handleClearCache} className="px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold inline-flex items-center gap-2"><Trash2 size={14} /> Borrar caché</button>
            <button onClick={handlePrepareForM10M11} disabled={!(overlayMode === 'rows' && rows.length > 0) || isHydratingAudit} className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"><Database size={14} /> {isHydratingAudit ? 'Preparando...' : 'M10/M11 listo'}</button>
            <button onClick={handleExportRowsJson} disabled={!(overlayMode === 'rows' && rows.length > 0) || isHydratingAudit} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"><Download size={14} /> {isHydratingAudit ? 'Procesando...' : 'Export rows JSON'}</button>
          </div>
        </div>

        {loadedSource && <div className="text-xs font-semibold text-slate-600">Archivo en sesion: {loadedSource}</div>}
        <div className="flex items-center gap-2"><span className="text-xs font-bold text-slate-500">Modo:</span><button onClick={() => setOverlayMode('items')} className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'items' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}><Type size={14} /> Items</button><button onClick={() => setOverlayMode('rows')} className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-2 ${overlayMode === 'rows' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}><Rows3 size={14} /> Rows</button><span className="ml-3 text-xs text-slate-500 font-mono">{`textLayer=${hasTextLayer ? 'yes' : 'no'} | rows=${rows.length} | fallback=${useOpenAIFallback ? 'on' : 'off'} | pdfPages=${pdfNumPages || 0}`}</span><span className="text-xs text-slate-500 font-mono">{`scope=${analyzeAllPages ? 'all-pages' : 'single-page'}`}</span><span className="text-xs text-slate-500 font-mono">{`source[p${pageNumber}]=${currentPageOcrSource}`}</span><span className={`text-xs font-bold px-2 py-1 rounded ${isRenderableNow ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{isRenderableNow ? 'Renderable: SI' : 'Renderable: NO'}</span><span className={`text-xs font-bold px-2 py-1 rounded ${reconciledNow ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{reconciledNow ? 'Reconciliado: SI' : 'Reconciliado: NO'}</span><span className={`text-xs font-bold px-2 py-1 rounded ${completeAgainstTotalNow ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{completeAgainstTotalNow ? 'Completo: SI' : 'Completo: NO'}</span><span className={`text-xs font-bold px-2 py-1 rounded ${passFailNow ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{`Gate: ${passFailLabel}`}</span>{itemAnomaliesSummaryNow.total > 0 && <span className={`text-xs font-bold px-2 py-1 rounded ${itemAnomaliesSummaryNow.flagged > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>{`Anomalias: ${itemAnomaliesSummaryNow.total} (${itemAnomaliesSummaryNow.autoFixed} fix / ${itemAnomaliesSummaryNow.flagged} flag)`}</span>}{residualAdjustmentLinesNow > 0 && <span className="text-xs font-bold px-2 py-1 rounded bg-amber-100 text-amber-800">{`Ajuste residual: ${residualAdjustmentLinesNow}L / ${residualAdjustmentAmountNow.toLocaleString('es-CL')}`}</span>}</div>
        <div className={`text-xs px-3 py-2 rounded border ${isRenderableNow ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{auditReason}</div>
        {m10m11Status && <div className="text-xs px-3 py-2 rounded border bg-indigo-50 border-indigo-200 text-indigo-700">{m10m11Status}</div>}
        {auditHydrationError && <div className="text-xs px-3 py-2 rounded border bg-rose-50 border-rose-200 text-rose-700">{`Detalle OCR RAW: ${auditHydrationError}`}</div>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-10 overflow-auto bg-slate-50 border border-slate-200 rounded-2xl p-4">
          {activePdfUrl ? <div><PdfCalcoPage pdfUrl={activePdfUrl} pageNumber={pageNumber} scale={scale} overlayMode={overlayMode} analyzeAllPages={analyzeAllPages} useOpenAIFallback={useOpenAIFallback} onTextLayerChange={handleTextLayerChange} onRowsChange={setRows} onDocMeta={handleDocMeta} onTextClick={handleOverlayTextClick} /><BillAuditChat billContext={normalizedBillPayload} /></div> : <div className="h-[50vh] min-h-[320px] rounded-xl border border-dashed border-slate-300 bg-white flex items-center justify-center text-slate-500 text-sm">Carga una URL o archivo PDF para iniciar el calco.</div>}
        </div>
        <aside className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl p-3">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-700 mb-3">Seleccion Actual</h3>
          {selected ? <div className="space-y-3 text-[12px]"><div className="p-2 rounded bg-slate-50 border border-slate-100"><p className="text-[10px] uppercase font-bold text-slate-500 mb-1">Texto</p><p className="text-slate-800 whitespace-pre-wrap break-words">{selected.text || '(vacio)'}</p></div><div className="p-2 rounded bg-slate-50 border border-slate-100 font-mono text-[11px] text-slate-700">{`page: ${selected.page}`}<br />{`source: ${selectedPageOcrSource || 'unknown'}`}<br />{`x: ${selected.bboxPx.x.toFixed(1)}`}<br />{`y: ${selected.bboxPx.y.toFixed(1)}`}<br />{`w: ${selected.bboxPx.w.toFixed(1)}`}<br />{`h: ${selected.bboxPx.h.toFixed(1)}`}</div></div> : <p className="text-slate-400 text-sm">Haz click en un overlay para ver detalle.</p>}
        </aside>
      </div>
    </div>
  );
}
