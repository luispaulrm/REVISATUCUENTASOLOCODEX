import fs from 'fs';
import path from 'path';

type BillItem = {
  code?: string;
  date?: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  fields?: {
    codigo?: string;
    fecha?: string;
    cantidad?: number;
    precioUnitario?: number;
  };
};

type BillPayload = {
  specVersion?: string;
  quality?: {
    isStrict?: boolean;
    warnings?: string[];
    errors?: string[];
  };
  reconciliation?: {
    status?: string;
    details?: {
      gapAdjustment?: {
        applied?: number;
        lines?: Array<{
          delta?: number;
        }>;
      };
    };
    gaps?: {
      gapVsClinicTotalGeneral?: number | null;
    };
    totals?: {
      itemsExtractedSum?: number;
      targetDeclaredTotal?: number;
    };
  };
  items?: BillItem[];
};

type GateStatus = 'PASS' | 'FAIL';

type GateResult = {
  gate: string;
  status: GateStatus;
  detail: string;
};

const PASS_THRESHOLD = 0.99;

function readPayload(filePath: string): BillPayload {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BillPayload;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function countMathMismatches(items: BillItem[]): number {
  return items.filter((item) => {
    const quantity = Number(item.quantity ?? item.fields?.cantidad ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0);
    const total = Math.round(Number(item.total || 0));
    if (!(quantity > 0 && unitPrice > 0 && total > 0)) return false;
    const expected = Math.round(quantity * unitPrice);
    return Math.abs(expected - total) > Math.max(100, expected * 0.2);
  }).length;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function evaluatePayload(payload: BillPayload): {
  overallStatus: GateStatus;
  summary: Record<string, number | string | boolean>;
  gates: GateResult[];
} {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const itemCount = items.length;
  const strict = Boolean(payload.quality?.isStrict);
  const reconStatus = String(payload.reconciliation?.status || 'UNKNOWN');
  const gap = Math.round(Number(payload.reconciliation?.gaps?.gapVsClinicTotalGeneral || 0));
  const extracted = Math.round(Number(payload.reconciliation?.totals?.itemsExtractedSum || 0));
  const target = Math.round(Number(payload.reconciliation?.totals?.targetDeclaredTotal || 0));

  const withCode = items.filter((item) => hasValue(item.code) || hasValue(item.fields?.codigo)).length;
  const withDate = items.filter((item) => hasValue(item.date) || hasValue(item.fields?.fecha)).length;
  const withQty = items.filter((item) => Number(item.quantity ?? item.fields?.cantidad ?? 0) > 0).length;
  const withUnit = items.filter((item) => Number(item.unitPrice ?? item.fields?.precioUnitario ?? 0) > 0).length;
  const mathMismatch = countMathMismatches(items);

  const codePct = pct(withCode, itemCount);
  const datePct = pct(withDate, itemCount);
  const qtyPct = pct(withQty, itemCount);
  const unitPct = pct(withUnit, itemCount);

  const gates: GateResult[] = [
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
      status: codePct >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withCode}/${itemCount} (${formatPct(codePct)})`
    },
    {
      gate: 'date_coverage',
      status: datePct >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withDate}/${itemCount} (${formatPct(datePct)})`
    },
    {
      gate: 'quantity_coverage',
      status: qtyPct >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withQty}/${itemCount} (${formatPct(qtyPct)})`
    },
    {
      gate: 'unit_price_coverage',
      status: unitPct >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
      detail: `${withUnit}/${itemCount} (${formatPct(unitPct)})`
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
      residualAdjustmentLines: Number(payload.reconciliation?.details?.gapAdjustment?.applied || 0),
      residualAdjustmentAmount: Math.round(
        Number(
          (payload.reconciliation?.details?.gapAdjustment?.lines || []).reduce(
            (acc, line) => acc + Math.abs(Number(line.delta || 0)),
            0
          )
        )
      )
    },
    gates
  };
}

function run(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const fileArgs = args.filter((arg) => arg !== '--json');
  if (!fileArgs.length) {
    console.error('Usage: npm run eval:bill -- <payload.json> [more.json] [--json]');
    process.exit(1);
  }

  const results = fileArgs.map((filePath) => {
    const resolved = path.resolve(filePath);
    const payload = readPayload(resolved);
    return {
      file: resolved,
      ...evaluatePayload(payload)
    };
  });

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const result of results) {
    console.log(`${result.overallStatus} ${result.file}`);
    for (const gate of result.gates) {
      console.log(`  ${gate.status} ${gate.gate}: ${gate.detail}`);
    }
  }
}

run();
