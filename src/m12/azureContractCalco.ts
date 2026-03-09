import type {
  M12AuditContractVariant,
  M12AuditGeometryRef,
  M12AuditLiteralRef,
  M12AuditResolution,
  M12AuditSemanticRole,
  M12AuditSourceKind,
  M12AuditUnit,
  M12AuditValueKind,
  M12ContractCalco,
  M12ContractCalcoCell,
  M12ContractCalcoFootnote,
  M12ContractCalcoHeader,
  M12ContractCalcoPage,
  M12ContractCalcoRow,
  M12ContractCalcoScope,
} from './contractAuditSchema';

type AzureBoundingRegion = {
  pageNumber: number;
  polygon?: number[];
};

type AzureSpan = {
  offset?: number;
  length?: number;
};

type AzureTableCell = {
  kind?: string;
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  content?: string;
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

type AzureTable = {
  rowCount: number;
  columnCount: number;
  cells: AzureTableCell[];
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

type AzureParagraph = {
  content?: string;
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

type AzureAnalyzeResult = {
  modelId?: string;
  stringIndexType?: string;
  pages?: any[];
  tables?: AzureTable[];
  paragraphs?: AzureParagraph[];
};

type AzureLayoutPayload = {
  status?: string;
  analyzeResult?: AzureAnalyzeResult;
};

type LogicalCellRef = {
  cell: AzureTableCell;
  rowIndex: number;
  columnIndex: number;
  isSpanCarry: boolean;
};

function normalize(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function upper(text: string): string {
  return normalize(text).toUpperCase();
}

function slugify(text: string): string {
  return normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'section';
}

function toBBox(polygon?: number[] | null): M12AuditGeometryRef['bbox'] {
  if (!Array.isArray(polygon) || polygon.length < 8) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < polygon.length; i += 2) {
    xs.push(Number(polygon[i]));
    ys.push(Number(polygon[i + 1]));
  }
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

function geometryFromRegions(
  regions: AzureBoundingRegion[] | undefined,
  spans: AzureSpan[] | undefined,
  source: M12AuditSourceKind,
  rowIndex?: number | null,
  columnIndex?: number | null
): M12AuditGeometryRef[] {
  const span = Array.isArray(spans) && spans.length > 0 ? spans[0] : undefined;
  return (regions || []).map((region) => ({
    page: Number(region.pageNumber || 0),
    polygon: Array.isArray(region.polygon) ? region.polygon : null,
    bbox: toBBox(region.polygon),
    rowIndex: rowIndex ?? null,
    columnIndex: columnIndex ?? null,
    spanOffset: typeof span?.offset === 'number' ? span.offset : null,
    spanLength: typeof span?.length === 'number' ? span.length : null,
    source,
  }));
}

function literalFromCell(cell: AzureTableCell, source: M12AuditSourceKind): M12AuditLiteralRef {
  return {
    text: String(cell.content || ''),
    normalized: normalize(String(cell.content || '')) || null,
    source,
    geometry: geometryFromRegions(
      cell.boundingRegions,
      cell.spans,
      source,
      cell.rowIndex,
      cell.columnIndex
    ),
  };
}

function extractMarkers(text: string): string[] {
  const matches = String(text || '').match(/\(\*+\)|\([1-9]\)|\*{2,4}/g) || [];
  return Array.from(new Set(matches.map((m) => m.trim())));
}

function isNumericLike(text: string): boolean {
  const value = upper(text);
  if (!value) return false;
  return /^(\d+(?:[.,]\d+)?)\s*(UF|VA|VAM|AC2|CLP|%|PESOS)?$/.test(value) || value === 'SIN TOPE';
}

function parseUnit(text: string): M12AuditUnit | null {
  const value = upper(text);
  if (!value) return null;
  if (value.includes('SIN TOPE')) return 'SIN_TOPE';
  if (/\bUF\b/.test(value)) return 'UF';
  if (/\bVAM\b/.test(value)) return 'VAM';
  if (/\bVA\b/.test(value)) return 'VA';
  if (/\bAC2\b/.test(value)) return 'AC2';
  if (/\bCLP\b/.test(value) || value.includes('$') || value.includes('PESO')) return 'CLP';
  return null;
}

function parseNumericValue(text: string): number | null {
  const match = String(text || '').match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function deriveValueKind(text: string, role: M12AuditSemanticRole): M12AuditValueKind {
  const value = normalize(text);
  if (!value) return 'EMPTY';
  if (extractMarkers(value).length > 0 && value.length <= 6) return 'MARKER';
  if (role === 'COBERTURA_PCT' || value.includes('%')) return 'PERCENT';
  if (role !== 'PRESTACION' && (parseNumericValue(value) !== null || parseUnit(value))) return 'NUMERIC_LIMIT';
  return 'TEXT';
}

function detectVariant(table: AzureTable, headerRowCount: number): M12AuditContractVariant {
  const headerText = upper(
    table.cells
      .filter((cell) => cell.rowIndex < headerRowCount)
      .map((cell) => cell.content || '')
      .join(' ')
  );
  if (headerText.includes('OFERTA PREFERENTE') || headerText.includes('LIBRE ELECCION')) {
    return 'PREFERENTE_LIBRE_ELECCION';
  }
  if (
    headerText.includes('TOPE BONIFICACION INTERNACIONAL') ||
    headerText.includes('AMPLIACION DE COBERTURA') ||
    headerText.includes('(1)') ||
    headerText.includes('(2)')
  ) {
    return 'GRID_1_2_3_4';
  }
  if (headerText.includes('COPAGO FIJO') || headerText.includes('COBERTURA')) {
    return 'SINGLE_MODE';
  }
  return 'UNKNOWN';
}

function detectHeaderRowCount(table: AzureTable): number {
  let count = 0;
  const maxRows = Math.min(table.rowCount, 4);
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const rowCells = table.cells.filter((cell) => cell.rowIndex === rowIndex);
    const hasHeader = rowCells.some((cell) => String(cell.kind || '').toLowerCase() === 'columnheader');
    if (!hasHeader) break;
    count = rowIndex + 1;
  }
  return count || 1;
}

function buildLogicalGrid(table: AzureTable): Array<Array<LogicalCellRef | null>> {
  const grid = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.columnCount }, () => null as LogicalCellRef | null)
  );
  for (const cell of table.cells) {
    const rowSpan = Math.max(1, Number(cell.rowSpan || 1));
    const columnSpan = Math.max(1, Number(cell.columnSpan || 1));
    for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
      for (let colOffset = 0; colOffset < columnSpan; colOffset += 1) {
        const rowIndex = cell.rowIndex + rowOffset;
        const columnIndex = cell.columnIndex + colOffset;
        if (!grid[rowIndex] || grid[rowIndex][columnIndex]) continue;
        grid[rowIndex][columnIndex] = {
          cell,
          rowIndex,
          columnIndex,
          isSpanCarry: rowOffset > 0 || colOffset > 0,
        };
      }
    }
  }
  return grid;
}

function detectSemanticRole(label: string, columnIndex: number, variant: M12AuditContractVariant): M12AuditSemanticRole {
  const value = upper(label);
  if (value.includes('PRESTACION')) return 'PRESTACION';
  if (value.includes('AMPLIACION')) return 'AMPLIACION_COBERTURA';
  if (value.includes('INTERNACIONAL')) return 'TOPE_INTERNACIONAL';
  if (value.includes('ANO CONTRATO') || value.includes('AÑO CONTRATO') || value.includes('ANUAL')) return 'TOPE_ANUAL';
  if (value.includes('BONIFICACION') && value.includes('TOPE')) return 'TOPE_EVENTO';
  if (value === '%' || (value.includes('BONIFICACION') && !value.includes('TOPE'))) return 'COBERTURA_PCT';
  if (variant === 'PREFERENTE_LIBRE_ELECCION') {
    if (columnIndex === 0) return 'PRESTACION';
    if (columnIndex === 1 || columnIndex === 4) return 'COBERTURA_PCT';
    if (columnIndex === 2 || columnIndex === 5) return 'TOPE_EVENTO';
    if (columnIndex === 3 || columnIndex === 6) return 'TOPE_ANUAL';
  }
  if (variant === 'GRID_1_2_3_4') {
    if (columnIndex === 0) return 'PRESTACION';
    if (columnIndex === 1) return 'COBERTURA_PCT';
    if (columnIndex === 2) return 'TOPE_EVENTO';
    if (columnIndex === 3) return 'TOPE_ANUAL';
    if (columnIndex === 4) return 'TOPE_INTERNACIONAL';
    if (columnIndex === 5) return 'AMPLIACION_COBERTURA';
  }
  return 'UNKNOWN';
}

function deriveColumnKey(
  columnIndex: number,
  role: M12AuditSemanticRole,
  variant: M12AuditContractVariant,
  label: string
): string {
  if (variant === 'PREFERENTE_LIBRE_ELECCION') {
    const keys = [
      'prestacion',
      'preferente_pct',
      'preferente_tope_evento',
      'preferente_tope_anual',
      'libre_pct',
      'libre_tope_evento',
      'libre_tope_anual',
    ];
    if (keys[columnIndex]) return keys[columnIndex];
  }
  if (variant === 'GRID_1_2_3_4') {
    const keys = [
      'prestacion',
      'cobertura_pct',
      'tope_bonificacion_1',
      'tope_anual_2',
      'tope_internacional_3',
      'ampliacion_4',
    ];
    if (keys[columnIndex]) return keys[columnIndex];
  }
  switch (role) {
    case 'PRESTACION':
      return 'prestacion';
    case 'COBERTURA_PCT':
      return `cobertura_pct_${columnIndex}`;
    case 'TOPE_EVENTO':
      return `tope_evento_${columnIndex}`;
    case 'TOPE_ANUAL':
      return `tope_anual_${columnIndex}`;
    case 'TOPE_INTERNACIONAL':
      return `tope_internacional_${columnIndex}`;
    case 'AMPLIACION_COBERTURA':
      return `ampliacion_${columnIndex}`;
    default:
      return slugify(label || `col_${columnIndex}`);
  }
}

function buildHeaders(
  table: AzureTable,
  grid: Array<Array<LogicalCellRef | null>>,
  headerRowCount: number,
  variant: M12AuditContractVariant
): M12ContractCalcoHeader[] {
  const headers: M12ContractCalcoHeader[] = [];
  for (let columnIndex = 0; columnIndex < table.columnCount; columnIndex += 1) {
    const seen = new Set<AzureTableCell>();
    const headerCells: AzureTableCell[] = [];
    for (let rowIndex = 0; rowIndex < headerRowCount; rowIndex += 1) {
      const logical = grid[rowIndex]?.[columnIndex];
      if (!logical) continue;
      if (logical.cell.rowIndex >= headerRowCount) continue;
      if (seen.has(logical.cell)) continue;
      seen.add(logical.cell);
      headerCells.push(logical.cell);
    }
    const labelParts = headerCells
      .map((cell) => normalize(String(cell.content || '')))
      .filter(Boolean);
    const label = Array.from(new Set(labelParts)).join(' | ') || `Columna ${columnIndex + 1}`;
    const semanticRole = detectSemanticRole(label, columnIndex, variant);
    headers.push({
      columnKey: deriveColumnKey(columnIndex, semanticRole, variant, label),
      label,
      marker: extractMarkers(label)[0] || null,
      semanticRole,
      evidence: headerCells.map((cell) => literalFromCell(cell, 'AZURE_LAYOUT_WEB')),
    });
  }
  return headers;
}

function isLikelySectionTitleCell(cell: AzureTableCell | undefined): boolean {
  const text = normalize(String(cell?.content || ''));
  if (!text) return false;
  const value = upper(text);
  if (value.includes('HOSPITALARIA') || value.includes('AMBULATORIA') || value.includes('URGENCIA')) return true;
  if (value.includes('PRESTACIONES RESTRINGIDAS') || value.includes('OTRAS PRESTACIONES')) return true;
  return text === value && text.length > 6;
}

function tableTitleFromHeaders(headers: M12ContractCalcoHeader[]): string {
  const labels = headers
    .map((header) => header.label)
    .filter((label) => normalize(label) && !/^Columna \d+$/i.test(label));
  return labels[0] || 'Tabla contrato';
}

function variantPriority(variant: M12AuditContractVariant): number {
  switch (variant) {
    case 'PREFERENTE_LIBRE_ELECCION':
      return 4;
    case 'GRID_1_2_3_4':
      return 3;
    case 'SINGLE_MODE':
      return 2;
    default:
      return 1;
  }
}

function isRelevantContractTable(table: AzureTable): boolean {
  const text = upper(table.cells.map((cell) => cell.content || '').join(' '));
  if (!text) return false;
  if ((text.includes('TRAMOS DE EDAD') || text.includes('COTIZANTE') || text.includes('CARGA')) && !text.includes('PRESTACIONES')) {
    return false;
  }
  if (text.includes('CODIGO') && text.includes('NOMBRE DE LA PRESTACION') && !text.includes('BONIFICACION')) {
    return false;
  }
  return (
    text.includes('PRESTACIONES') ||
    text.includes('COPAGO FIJO') ||
    text.includes('TOPE GENERAL') ||
    text.includes('COBERTURA SIN TOPE') ||
    (text.includes('PRESTACION') && (text.includes('COBERTURA') || text.includes('N° DIAS') || text.includes('Nº DIAS')))
  );
}

function collectTablePageNumber(table: AzureTable): number {
  const region = (table.boundingRegions || [])[0];
  return Number(region?.pageNumber || 0);
}

function buildRow(
  rowId: string,
  sectionKey: string,
  rowIndex: number,
  grid: Array<Array<LogicalCellRef | null>>,
  headers: M12ContractCalcoHeader[]
): M12ContractCalcoRow {
  const cells: M12ContractCalcoCell[] = [];
  const markers = new Set<string>();
  let itemLabel = '';

  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const header = headers[columnIndex];
    const logical = grid[rowIndex]?.[columnIndex];
    const baseCell = logical?.cell;
    const rawText = logical && !logical.isSpanCarry ? String(baseCell?.content || '') : null;
    const normalizedText = rawText ? normalize(rawText) : null;
    const cellMarkers = extractMarkers(rawText || '');
    for (const marker of cellMarkers) markers.add(marker);
    if (header.semanticRole === 'PRESTACION' && normalizedText) itemLabel = normalizedText;
    cells.push({
      cellId: `${rowId}:${header.columnKey}`,
      rowId,
      columnKey: header.columnKey,
      semanticRole: header.semanticRole,
      valueKind: deriveValueKind(rawText || '', header.semanticRole),
      rawText,
      normalizedText,
      numericValue: rawText ? parseNumericValue(rawText) : null,
      unit: rawText ? parseUnit(rawText) : null,
      scopeRef: null,
      confidence: rawText ? 'CONFIRMED' : (logical ? 'PARTIAL' : 'UNKNOWN'),
      evidence: logical && !logical.isSpanCarry && baseCell ? [literalFromCell(baseCell, 'AZURE_LAYOUT_WEB')] : [],
    });
  }

  const evidence = cells.flatMap((cell) => cell.evidence);
  return {
    rowId,
    sectionKey,
    itemLabel,
    markers: Array.from(markers),
    cells,
    evidence,
  };
}

function collectFootnotes(
  pageNumber: number,
  markers: string[],
  paragraphs: AzureParagraph[]
): M12ContractCalcoFootnote[] {
  return markers.map((marker) => {
    const matching = paragraphs.filter((paragraph) => {
      const samePage = (paragraph.boundingRegions || []).some((region) => Number(region.pageNumber || 0) === pageNumber);
      return samePage && String(paragraph.content || '').includes(marker);
    });
    const text = matching.map((paragraph) => normalize(String(paragraph.content || ''))).filter(Boolean).join(' ') || marker;
    return {
      footnoteId: `footnote_${pageNumber}_${slugify(marker)}`,
      marker,
      text,
      evidence: matching.map((paragraph) => ({
        text: String(paragraph.content || ''),
        normalized: normalize(String(paragraph.content || '')) || null,
        source: 'AZURE_LAYOUT_WEB',
        geometry: geometryFromRegions(paragraph.boundingRegions, paragraph.spans, 'AZURE_LAYOUT_WEB'),
      })),
    };
  });
}

function attachExplicitScopes(
  rows: M12ContractCalcoRow[],
  headers: M12ContractCalcoHeader[],
  table: AzureTable,
  startRowIndex: number,
  endRowIndex: number,
  scopes: M12ContractCalcoScope[]
): void {
  for (const cell of table.cells) {
    const rowSpan = Math.max(1, Number(cell.rowSpan || 1));
    const columnSpan = Math.max(1, Number(cell.columnSpan || 1));
    if (rowSpan <= 1 && columnSpan <= 1) continue;
    if (cell.rowIndex < startRowIndex || cell.rowIndex > endRowIndex) continue;
    const text = normalize(String(cell.content || ''));
    if (!text) continue;
    const rowStart = rows.find((row) => row.rowId.endsWith(`r${cell.rowIndex}`));
    const rowEnd = rows.find((row) => row.rowId.endsWith(`r${Math.min(endRowIndex, cell.rowIndex + rowSpan - 1)}`));
    if (!rowStart || !rowEnd) continue;
    const startIndex = rows.findIndex((row) => row.rowId === rowStart.rowId);
    const endIndex = rows.findIndex((row) => row.rowId === rowEnd.rowId);
    if (startIndex === -1 || endIndex === -1) continue;

    for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
      const header = headers[cell.columnIndex + columnOffset];
      if (!header || header.semanticRole === 'PRESTACION') continue;
      const scopeId = `${rowStart.sectionKey}:scope:${header.columnKey}:${cell.rowIndex}:${cell.columnIndex}`;
      scopes.push({
        scopeId,
        columnKey: header.columnKey,
        rowStartId: rowStart.rowId,
        rowEndId: rowEnd.rowId,
        text,
        markers: extractMarkers(text),
        confidence: 'CONFIRMED',
        evidence: [literalFromCell(cell, 'AZURE_LAYOUT_WEB')],
      });
      for (let rowPointer = startIndex; rowPointer <= endIndex; rowPointer += 1) {
        const target = rows[rowPointer]?.cells.find((current) => current.columnKey === header.columnKey);
        if (target) target.scopeRef = scopeId;
      }
    }
  }
}

function attachImplicitScopes(rows: M12ContractCalcoRow[], headers: M12ContractCalcoHeader[], scopes: M12ContractCalcoScope[]): void {
  for (const header of headers) {
    if (header.semanticRole === 'PRESTACION') continue;
    let segment: M12ContractCalcoCell[] = [];
    const flush = () => {
      if (segment.length < 2) {
        segment = [];
        return;
      }
      const texts = segment.map((cell) => normalize(cell.rawText || '')).filter(Boolean);
      const joined = texts.join(' ');
      if (!joined || texts.every(isNumericLike)) {
        segment = [];
        return;
      }
      const firstCell = segment[0];
      const lastCell = segment[segment.length - 1];
      const firstRow = rows.find((row) => row.rowId === firstCell.rowId);
      const lastRow = rows.find((row) => row.rowId === lastCell.rowId);
      if (!firstRow || !lastRow) {
        segment = [];
        return;
      }
      const scopeId = `${firstRow.sectionKey}:scope:${header.columnKey}:${firstRow.rowId}`;
      scopes.push({
        scopeId,
        columnKey: header.columnKey,
        rowStartId: firstRow.rowId,
        rowEndId: lastRow.rowId,
        text: joined,
        markers: extractMarkers(joined),
        confidence: 'PARTIAL',
        evidence: segment.flatMap((cell) => cell.evidence),
      });
      for (const cell of segment) cell.scopeRef = scopeId;
      segment = [];
    };

    for (const row of rows) {
      const cell = row.cells.find((current) => current.columnKey === header.columnKey);
      if (!cell || !normalize(cell.rawText || '')) {
        flush();
        continue;
      }
      segment.push(cell);
    }
    flush();
  }
}

export function isAzureLayoutWebPayload(value: any): value is AzureLayoutPayload {
  return String(value?.status || '').toLowerCase() === 'succeeded' && !!value?.analyzeResult?.modelId;
}

export function buildContractCalcoFromAzureLayout(payload: AzureLayoutPayload): M12ContractCalco {
  if (!isAzureLayoutWebPayload(payload)) {
    throw new Error('El payload no corresponde a Azure web prebuilt-layout.');
  }

  const analyzeResult = payload.analyzeResult || {};
  const tables = (analyzeResult.tables || []).filter(isRelevantContractTable);
  const paragraphs = analyzeResult.paragraphs || [];
  const warnings: string[] = [];
  const pages: M12ContractCalcoPage[] = [];
  let globalVariant: M12AuditContractVariant = 'UNKNOWN';

  tables.forEach((table, tableIndex) => {
    const pageNumber = collectTablePageNumber(table);
    const headerRowCount = detectHeaderRowCount(table);
    const grid = buildLogicalGrid(table);
    const variant = detectVariant(table, headerRowCount);
    if (variantPriority(variant) > variantPriority(globalVariant)) globalVariant = variant;
    const headers = buildHeaders(table, grid, headerRowCount, variant);
    const defaultSectionTitle = tableTitleFromHeaders(headers);

    let currentSectionTitle = defaultSectionTitle;
    let currentSectionKey = `p${pageNumber}_t${tableIndex}_${slugify(defaultSectionTitle)}`;
    let currentRows: M12ContractCalcoRow[] = [];
    let sectionRowStart = headerRowCount;

    const flushSection = (endRowIndex: number) => {
      if (currentRows.length === 0) return;
      const scopes: M12ContractCalcoScope[] = [];
      attachExplicitScopes(currentRows, headers, table, sectionRowStart, endRowIndex, scopes);
      attachImplicitScopes(currentRows, headers, scopes);
      const markers = Array.from(new Set([
        ...headers.flatMap((header) => extractMarkers(header.label)),
        ...currentRows.flatMap((row) => row.markers),
        ...scopes.flatMap((scope) => scope.markers),
      ]));
      pages.push({
        pageNumber,
        sectionKey: currentSectionKey,
        sectionTitle: currentSectionTitle,
        headers,
        rows: currentRows,
        scopes,
        footnotes: collectFootnotes(pageNumber, markers, paragraphs),
      });
      currentRows = [];
    };

    for (let rowIndex = headerRowCount; rowIndex < table.rowCount; rowIndex += 1) {
      const originalCells = table.cells.filter((cell) => cell.rowIndex === rowIndex);
      const firstNonEmpty = originalCells.find((cell) => normalize(String(cell.content || '')));
      const hasAnyText = originalCells.some((cell) => normalize(String(cell.content || '')));
      if (!hasAnyText) continue;

      if (firstNonEmpty && isLikelySectionTitleCell(firstNonEmpty) && originalCells.filter((cell) => normalize(String(cell.content || ''))).length <= 2) {
        flushSection(rowIndex - 1);
        currentSectionTitle = normalize(String(firstNonEmpty.content || '')) || defaultSectionTitle;
        currentSectionKey = `p${pageNumber}_t${tableIndex}_${slugify(currentSectionTitle)}`;
        sectionRowStart = rowIndex + 1;
        continue;
      }

      const rowId = `${currentSectionKey}:r${rowIndex}`;
      currentRows.push(buildRow(rowId, currentSectionKey, rowIndex, grid, headers));
    }

    flushSection(table.rowCount - 1);
  });

  if (tables.length === 0) {
    warnings.push('Azure raw no entrego tablas contractuales relevantes para construir contract_calco.');
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      variant: globalVariant,
      sourceFingerprint: `${analyzeResult.modelId || 'prebuilt-layout'}:${(analyzeResult.pages || []).length}:${tables.length}`,
      stringIndexType: analyzeResult.stringIndexType || null,
      modelId: analyzeResult.modelId || null,
    },
    source: {
      kind: 'AZURE_LAYOUT_WEB',
      pageCount: Array.isArray(analyzeResult.pages) ? analyzeResult.pages.length : 0,
      rawStatus: payload.status || null,
      warnings,
    },
    pages,
  };
}
