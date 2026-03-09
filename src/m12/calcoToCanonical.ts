import type {
  M12AuditGeometryRef,
  M12AuditLiteralRef,
  M12AuditResolution,
  M12AuditUnit,
  M12CanonicalContract,
  M12CanonicalEvidenceBreakdown,
  M12CanonicalContractItem,
  M12CanonicalContractRule,
  M12CanonicalContractSection,
  M12CanonicalFinancialTerm,
  M12ContractCalco,
  M12ContractCalcoCell,
  M12ContractCalcoPage,
  M12ContractCalcoScope,
  M12ContractDoctrine,
  M12ContractDoctrineColumn,
  M12ContractDoctrineFootnoteLink,
  M12ContractDoctrineScopeAssignment,
  M12ContractReconstructibility,
} from './contractAuditSchema';

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

function parseNumeric(text: string | null | undefined): number | null {
  const match = String(text || '').match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function parseUnit(text: string | null | undefined): M12AuditUnit | null {
  const value = upper(String(text || ''));
  if (!value) return null;
  if (value.includes('SIN TOPE')) return 'SIN_TOPE';
  if (/\bUF\b/.test(value)) return 'UF';
  if (/\bVAM\b/.test(value)) return 'VAM';
  if (/\bVA\b/.test(value)) return 'VA';
  if (/\bAC2\b/.test(value)) return 'AC2';
  if (/\bCLP\b/.test(value) || value.includes('$') || value.includes('PESO')) return 'CLP';
  return null;
}

function mapDomainHint(sectionTitle: string): string | null {
  const value = upper(sectionTitle);
  if (value.includes('HOSPITALARIA')) return 'HOSPITALIZACION';
  if (value.includes('AMBULATORIA')) return 'AMBULATORIO';
  if (value.includes('URGENCIA')) return 'URGENCIA';
  if (value.includes('HONORARIO')) return 'HONORARIOS';
  if (value.includes('OBSTETRICA') || value.includes('NEONATOLOGIA')) return 'OBSTETRICIA_NEONATOLOGIA';
  if (value.includes('RESTRINGIDA')) return 'RESTRINGIDA';
  if (value.includes('OTRAS PRESTACIONES')) return 'OTROS';
  return null;
}

function describeColumnMeaning(columnKey: string): string {
  const value = upper(columnKey);
  if (value.includes('PRESTACION')) return 'Nombre literal de la prestacion.';
  if (value.includes('PCT') || value.includes('COBERTURA')) return 'Porcentaje de cobertura o bonificacion.';
  if (value.includes('EVENTO') || value.includes('BONIFICACION_1')) return 'Tope por evento o por prestacion.';
  if (value.includes('ANUAL') || value.includes('_2')) return 'Tope maximo anual por beneficiario.';
  if (value.includes('INTERNACIONAL') || value.includes('_3')) return 'Tope de bonificacion internacional.';
  if (value.includes('AMPLIACION') || value.includes('_4')) return 'Ampliacion adicional de cobertura.';
  return 'Semantica no resuelta.';
}

function parsePrestadores(texts: string[]): string[] {
  const joined = texts.join(' | ');
  const regex = /\b(?:Clinica|Clínica|Hospital)\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ\s]+/g;
  const matches = joined.match(regex) || [];
  const extras = ['Vidaintegra', 'Integramedica', 'Indisa', 'Davila', 'Vespucio', 'UC'];
  for (const extra of extras) {
    if (joined.toUpperCase().includes(extra.toUpperCase())) matches.push(extra);
  }
  return Array.from(new Set(matches.map((match) => normalize(match)).filter(Boolean)));
}

function isRestrictionText(text: string): boolean {
  const value = upper(text);
  return value.includes('SOLO') || value.includes('EXCEPTO') || value.includes('CLINICA') || value.includes('HOSPITAL');
}

function isSupplementalSection(page: M12ContractCalcoPage): boolean {
  const title = upper(page.sectionTitle);
  if (title.includes('IDENTIFICACION UNICA DEL ARANCEL')) return true;
  if (title.includes('ALGUNAS DE LAS PRESTACIONES INCLUIDAS')) return true;
  if (title.includes('COPAGO FIJO')) return true;
  if (title.includes('COPAGOS CONOCIDOS EN URGENCIA')) return true;
  if (title.includes('ATENCIONES DE URGENCIA INTEGRAL')) return true;
  if (title === 'PRESTACION' && page.headers.some((header) => header.columnKey === 'n_dias' || upper(header.label).includes('DIAS'))) return true;
  return false;
}

function cellWithScopeText(
  cell: M12ContractCalcoCell | undefined,
  scopesById: Map<string, M12ContractCalcoScope>
): string | null {
  if (!cell) return null;
  if (normalize(cell.rawText || '')) return cell.rawText || null;
  if (cell.scopeRef) return scopesById.get(cell.scopeRef)?.text || null;
  return null;
}

function resolveRowItemLabel(
  row: M12ContractCalcoPage['rows'][number],
  scopesById: Map<string, M12ContractCalcoScope>
): string {
  if (normalize(row.itemLabel)) return row.itemLabel;

  const firstPrestacion = row.cells.find((cell) => {
    const text = normalize(cellWithScopeText(cell, scopesById) || '');
    return cell.semanticRole === 'PRESTACION' && text;
  });
  if (firstPrestacion) return normalize(cellWithScopeText(firstPrestacion, scopesById) || '');

  const firstMeaningful = row.cells.find((cell, index) => {
    const text = normalize(cellWithScopeText(cell, scopesById) || '');
    if (!text) return false;
    if (index === 0) return true;
    if (text.includes('%')) return false;
    if (parseUnit(text) || /^\d+(?:[.,]\d+)?$/.test(text)) return false;
    return true;
  });
  return firstMeaningful ? normalize(cellWithScopeText(firstMeaningful, scopesById) || '') : '';
}

function buildDoctrine(calco: M12ContractCalco): M12ContractDoctrine {
  const columnMap = new Map<string, M12ContractDoctrineColumn>();
  const footnotes: M12ContractDoctrineFootnoteLink[] = [];
  const scopes: M12ContractDoctrineScopeAssignment[] = [];

  for (const page of calco.pages) {
    const rowIndexById = new Map(page.rows.map((row, index) => [row.rowId, index]));

    for (const header of page.headers) {
      if (columnMap.has(header.columnKey)) continue;
      columnMap.set(header.columnKey, {
        columnKey: header.columnKey,
        headerLabel: header.label,
        semanticRole: header.semanticRole === 'PRESTACION'
          ? 'PRESTACION'
          : header.semanticRole === 'COBERTURA_PCT'
            ? 'COBERTURA_PCT'
            : header.semanticRole === 'TOPE_EVENTO'
              ? 'TOPE_EVENTO'
              : header.semanticRole === 'TOPE_ANUAL'
                ? 'TOPE_ANUAL'
                : header.semanticRole === 'TOPE_INTERNACIONAL'
                  ? 'TOPE_INTERNACIONAL'
                  : header.semanticRole === 'AMPLIACION_COBERTURA'
                    ? 'AMPLIACION_COBERTURA'
                    : 'UNKNOWN',
        marker: header.marker || null,
        literalMeaning: describeColumnMeaning(header.columnKey),
        confidence: header.semanticRole === 'UNKNOWN' ? 'PARTIAL' : 'CONFIRMED',
        evidence: header.evidence,
      });
    }

    for (const scope of page.scopes) {
      const startIndex = rowIndexById.get(scope.rowStartId);
      const endIndex = rowIndexById.get(scope.rowEndId);
      const minIndex = typeof startIndex === 'number' && typeof endIndex === 'number'
        ? Math.min(startIndex, endIndex)
        : null;
      const maxIndex = typeof startIndex === 'number' && typeof endIndex === 'number'
        ? Math.max(startIndex, endIndex)
        : null;
      const rowIds = minIndex === null || maxIndex === null
        ? []
        : page.rows
            .filter((_, index) => index >= minIndex && index <= maxIndex)
            .map((row) => row.rowId);
      scopes.push({
        scopeId: scope.scopeId,
        columnKey: scope.columnKey,
        appliesToRowIds: rowIds,
        semanticMeaning: normalize(scope.text),
        confidence: scope.confidence,
      });
    }

    for (const footnote of page.footnotes) {
      const linkedRows = page.rows.filter((row) => row.markers.includes(footnote.marker)).map((row) => row.rowId);
      const linkedColumns = page.headers.filter((header) => header.marker === footnote.marker).map((header) => header.columnKey);
      const linkedScopes = page.scopes.filter((scope) => scope.markers.includes(footnote.marker)).map((scope) => scope.scopeId);
      footnotes.push({
        footnoteId: footnote.footnoteId,
        marker: footnote.marker,
        text: footnote.text,
        rowIds: linkedRows,
        columnKeys: linkedColumns,
        scopeIds: linkedScopes,
        confidence: linkedRows.length || linkedColumns.length || linkedScopes.length ? 'CONFIRMED' : 'PARTIAL',
      });
    }
  }

  return {
    columns: Array.from(columnMap.values()),
    footnotes,
    scopes,
  };
}

function buildFinancialTerm(
  role: M12CanonicalFinancialTerm['role'],
  cell: M12ContractCalcoCell | undefined,
  scope: M12ContractCalcoScope | undefined
): M12CanonicalFinancialTerm | null {
  const scopeText = scope?.text || null;
  const rawText = cell?.rawText || scopeText;
  if (!rawText && !scopeText) return null;
  const unit = parseUnit(rawText);
  const amount = parseNumeric(rawText);
  let state: M12CanonicalFinancialTerm['state'] = 'UNKNOWN';

  if (!normalize(rawText || '')) {
    state = 'EMPTY';
  } else if (unit === 'SIN_TOPE' || upper(rawText || '').includes('SIN TOPE')) {
    state = 'SIN_TOPE';
  } else if (amount !== null) {
    state = 'NUMERIC';
  } else if (scopeText) {
    state = 'UNKNOWN';
  } else {
    state = 'EMPTY';
  }

  return {
    role,
    state,
    amount,
    unit,
    literalText: rawText || null,
    sourceCellIds: cell?.cellId ? [cell.cellId] : [],
    sourceScopeIds: scope?.scopeId ? [scope.scopeId] : [],
  };
}

function isUsableFinancialTerm(term: M12CanonicalFinancialTerm | null): boolean {
  return term?.state === 'NUMERIC' || term?.state === 'SIN_TOPE';
}

function collectRestrictions(row: M12ContractCalcoPage['rows'][number], pageScopes: M12ContractCalcoScope[], doctrine: M12ContractDoctrine): string[] {
  const restrictions = new Set<string>();
  for (const cell of row.cells) {
    if (cell.scopeRef) {
      const scope = pageScopes.find((current) => current.scopeId === cell.scopeRef);
      if (scope && isRestrictionText(scope.text)) restrictions.add(normalize(scope.text));
    }
  }

  for (const marker of row.markers) {
    doctrine.footnotes
      .filter((footnote) => footnote.marker === marker)
      .forEach((footnote) => {
        if (isRestrictionText(footnote.text)) restrictions.add(normalize(footnote.text));
      });
  }

  return Array.from(restrictions);
}

type OrderedCellEntry = {
  header: M12ContractCalcoPage['headers'][number];
  cell: M12ContractCalcoCell;
  scope: M12ContractCalcoScope | undefined;
  index: number;
  text: string;
};

type OrderedCellRowEntry = OrderedCellEntry & {
  rowId: string;
  rowOrder: number;
};

function modalityHintFromEntry(entry: OrderedCellEntry): string | null {
  const label = upper(`${entry.header.label} ${entry.text}`);
  if (label.includes('LIBRE ELECCION')) return 'LIBRE_ELECCION';
  if (label.includes('PREFERENTE')) return 'PREFERENTE';
  if (label.includes('OFERTA CERRADA')) return 'OFERTA_CERRADA';
  return null;
}

function isCoverageSignal(entry: OrderedCellEntry): boolean {
  return entry.header.semanticRole === 'COBERTURA_PCT' || upper(entry.text).includes('%');
}

function isAnnualSignal(entry: OrderedCellEntry): boolean {
  const label = upper(`${entry.header.label} ${entry.text}`);
  return entry.header.semanticRole === 'TOPE_ANUAL' || label.includes('ANO CONTRATO') || label.includes('ANUAL');
}

function isLimitSignal(entry: OrderedCellEntry): boolean {
  const value = upper(entry.text);
  return Boolean(
    value &&
    (
      entry.header.semanticRole === 'TOPE_EVENTO' ||
      entry.header.semanticRole === 'TOPE_ANUAL' ||
      value.includes('SIN TOPE') ||
      parseUnit(value) ||
      /\d+(?:[.,]\d+)?\s*(UF|VA|VAM|AC2|CLP)\b/.test(value)
    )
  );
}

function hasFinancialSignalText(text: string): boolean {
  const value = upper(text);
  return Boolean(
    value &&
    (
      value.includes('%') ||
      value.includes('SIN TOPE') ||
      parseUnit(value) ||
      /\d+(?:[.,]\d+)?\s*(UF|VA|VAM|AC2|CLP)\b/.test(value)
    )
  );
}

function dedupeGeometryEvidence(items: M12AuditGeometryRef[]): M12AuditGeometryRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildEvidenceBreakdown(
  directLiteral: Iterable<string>,
  propagatedLiteral: Iterable<string>,
  directGeometry: Iterable<M12AuditGeometryRef>,
  propagatedGeometry: Iterable<M12AuditGeometryRef>
): M12CanonicalEvidenceBreakdown {
  const directLiteralEvidence = Array.from(new Set(Array.from(directLiteral).map((text) => normalize(text)).filter(Boolean)));
  const propagatedLiteralEvidence = Array.from(new Set(Array.from(propagatedLiteral).map((text) => normalize(text)).filter(Boolean)));
  const directGeometryEvidence = dedupeGeometryEvidence(Array.from(directGeometry));
  const propagatedGeometryEvidence = dedupeGeometryEvidence(Array.from(propagatedGeometry));

  let mode: M12CanonicalEvidenceBreakdown['mode'] = 'NONE';
  if (directLiteralEvidence.length || directGeometryEvidence.length) mode = 'DIRECT';
  if (propagatedLiteralEvidence.length || propagatedGeometryEvidence.length) {
    mode = mode === 'DIRECT' ? 'MIXED' : 'PROPAGATED';
  }

  return {
    mode,
    directLiteralEvidence,
    propagatedLiteralEvidence,
    directGeometryEvidence,
    propagatedGeometryEvidence,
  };
}

function financialCellText(
  cell: M12ContractCalcoCell | undefined,
  scopesById: Map<string, M12ContractCalcoScope>
): string {
  if (!cell) return '';
  const rawText = normalize(cell.rawText || '');
  const scopeText = normalize(cell.scopeRef ? scopesById.get(cell.scopeRef)?.text || '' : '');

  if (!scopeText) return rawText;
  if (!rawText) return scopeText;

  const rawHasSignal = hasFinancialSignalText(rawText);
  const scopeHasSignal = hasFinancialSignalText(scopeText);

  if (scopeHasSignal && !rawHasSignal) return scopeText;
  if (rawHasSignal && !scopeHasSignal) return rawText;
  if (scopeText.includes(rawText) && scopeText.length > rawText.length) return scopeText;
  if (rawText.includes(scopeText) && rawText.length > scopeText.length) return rawText;
  return scopeText.length >= rawText.length ? scopeText : rawText;
}

function isSingleModeIndexedPage(page: M12ContractCalcoPage): boolean {
  const keys = new Set(page.headers.map((header) => header.columnKey));
  return keys.has('cobertura_pct_1') && keys.has('tope_evento_2') && keys.has('tope_anual_3') && !keys.has('preferente_pct');
}

function resolvePropagatedEntry(
  entries: OrderedCellRowEntry[],
  targetRowOrder: number
): { entry: OrderedCellRowEntry; propagated: boolean } | null {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => a.rowOrder - b.rowOrder);
  const exact = sorted.find((entry) => entry.rowOrder === targetRowOrder);
  if (exact) return { entry: exact, propagated: false };

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = index > 0 ? sorted[index - 1] : null;
    const next = index < sorted.length - 1 ? sorted[index + 1] : null;
    const lowerBound = previous ? (previous.rowOrder + current.rowOrder) / 2 : Number.NEGATIVE_INFINITY;
    const upperBound = next ? (current.rowOrder + next.rowOrder) / 2 : Number.POSITIVE_INFINITY;
    if (targetRowOrder > lowerBound && targetRowOrder <= upperBound) {
      return { entry: current, propagated: true };
    }
  }

  return { entry: sorted[sorted.length - 1], propagated: true };
}

function buildRuleFromEntries(
  page: M12ContractCalcoPage,
  row: M12ContractCalcoPage['rows'][number],
  itemLabel: string,
  groupId: string,
  modality: string | null,
  entries: OrderedCellEntry[],
  restrictions: string[],
  prestadores: string[],
  literalEvidenceBase: Set<string>,
  geometryEvidence: M12AuditGeometryRef[]
): M12CanonicalContractRule | null {
  if (!entries.length) return null;

  const coverageEntry = entries.find(isCoverageSignal);
  const limitEntries = entries.filter((entry) => isLimitSignal(entry));
  const annualEntry = limitEntries.find(isAnnualSignal);
  let eventEntry = limitEntries.find((entry) => entry !== annualEntry) || null;
  let finalAnnualEntry = annualEntry || null;

  if (!eventEntry && coverageEntry && upper(coverageEntry.text).includes('SIN TOPE')) {
    eventEntry = coverageEntry;
  }
  if (!finalAnnualEntry && limitEntries.length >= 2) {
    finalAnnualEntry = limitEntries[1];
  }

  const coveragePct = coverageEntry ? parseNumeric(coverageEntry.text) : null;
  const topeEventoRaw = eventEntry ? buildFinancialTerm('TOPE_EVENTO', eventEntry.cell, eventEntry.scope) : null;
  const topeAnualRaw = finalAnnualEntry ? buildFinancialTerm('TOPE_ANUAL', finalAnnualEntry.cell, finalAnnualEntry.scope) : null;
  const topeEvento = isUsableFinancialTerm(topeEventoRaw) ? topeEventoRaw : null;
  const topeAnualBeneficiario = isUsableFinancialTerm(topeAnualRaw) ? topeAnualRaw : null;

  const hasMeaningfulData =
    coveragePct !== null ||
    isUsableFinancialTerm(topeEvento) ||
    isUsableFinancialTerm(topeAnualBeneficiario);

  if (!hasMeaningfulData) return null;

  const literalEvidence = new Set(literalEvidenceBase);
  entries
    .map((entry) => normalize(entry.text))
    .filter(Boolean)
    .forEach((text) => literalEvidence.add(text));
  const evidenceBreakdown = buildEvidenceBreakdown(
    literalEvidence,
    [],
    geometryEvidence,
    []
  );

  return {
    ruleId: `${row.rowId}:${groupId}`,
    sectionKey: page.sectionKey,
    itemId: row.rowId,
    itemLabel,
    domainHint: mapDomainHint(page.sectionTitle),
    modality,
    coveragePct,
    topeEvento,
    topeAnualBeneficiario,
    topeInternacional: null,
    ampliacionCobertura: null,
    restrictions,
    prestadores,
    footnoteMarkers: row.markers,
    literalEvidence: Array.from(literalEvidence),
    geometryEvidence,
    evidenceBreakdown,
    confidence: 'PARTIAL',
  };
}

function buildSingleModePropagatedRule(
  page: M12ContractCalcoPage,
  row: M12ContractCalcoPage['rows'][number],
  scopesById: Map<string, M12ContractCalcoScope>,
  itemLabel: string,
  restrictions: string[],
  prestadoresBase: string[],
  literalEvidenceBase: Set<string>,
  geometryEvidenceBase: M12AuditGeometryRef[]
): M12CanonicalContractRule | null {
  if (!isSingleModeIndexedPage(page)) return null;

  const rowOrderMap = new Map(page.rows.map((current, index) => [current.rowId, index]));
  const targetRowOrder = rowOrderMap.get(row.rowId);
  if (typeof targetRowOrder !== 'number') return null;

  const headerMap = new Map(page.headers.map((header, index) => [header.columnKey, { header, index }]));
  const coverageHeader = headerMap.get('cobertura_pct_1');
  const eventHeader = headerMap.get('tope_evento_2');
  const annualHeader = headerMap.get('tope_anual_3');
  if (!coverageHeader || !eventHeader || !annualHeader) return null;

  const buildEntries = (
    columnKey: string,
    predicate: (entry: OrderedCellEntry) => boolean
  ): OrderedCellRowEntry[] => {
    const headerInfo = headerMap.get(columnKey);
    if (!headerInfo) return [];
    return page.rows.flatMap((candidateRow) => {
      const cell = candidateRow.cells.find((current) => current.columnKey === columnKey);
      if (!cell) return [];
      const scope = cell.scopeRef ? scopesById.get(cell.scopeRef) : undefined;
      const text = financialCellText(cell, scopesById);
      if (!text) return [];
      const entry: OrderedCellEntry = {
        header: headerInfo.header,
        cell,
        scope,
        index: headerInfo.index,
        text,
      };
      if (!predicate(entry)) return [];
      return [{
        ...entry,
        rowId: candidateRow.rowId,
        rowOrder: rowOrderMap.get(candidateRow.rowId) ?? -1,
      }];
    }).filter((entry) => entry.rowOrder >= 0);
  };

  const coverageResolved = resolvePropagatedEntry(
    buildEntries('cobertura_pct_1', (entry) => isCoverageSignal(entry) || isLimitSignal(entry)),
    targetRowOrder
  );

  const eventResolved = resolvePropagatedEntry(
    [
      ...buildEntries('tope_evento_2', (entry) => isLimitSignal(entry)),
      ...buildEntries('cobertura_pct_1', (entry) => isLimitSignal(entry)),
    ].filter((entry, index, entries) =>
      entries.findIndex((current) => current.rowId === entry.rowId && current.header.columnKey === entry.header.columnKey) === index
    ),
    targetRowOrder
  );

  const annualResolved = resolvePropagatedEntry(
    buildEntries('tope_anual_3', (entry) => isAnnualSignal(entry) || isLimitSignal(entry)),
    targetRowOrder
  );

  const coverageEntry = coverageResolved?.entry || null;
  const eventEntry = eventResolved?.entry || (coverageEntry && isLimitSignal(coverageEntry) ? coverageEntry : null);
  const annualEntry = annualResolved?.entry || null;

  const coveragePct = coverageEntry ? parseNumeric(coverageEntry.text) : null;
  const topeEventoRaw = eventEntry ? buildFinancialTerm('TOPE_EVENTO', eventEntry.cell, eventEntry.scope) : null;
  const topeAnualRaw = annualEntry ? buildFinancialTerm('TOPE_ANUAL', annualEntry.cell, annualEntry.scope) : null;
  const topeEvento = isUsableFinancialTerm(topeEventoRaw) ? topeEventoRaw : null;
  const topeAnualBeneficiario = isUsableFinancialTerm(topeAnualRaw) ? topeAnualRaw : null;

  const hasMeaningfulData =
    coveragePct !== null ||
    isUsableFinancialTerm(topeEvento) ||
    isUsableFinancialTerm(topeAnualBeneficiario);

  if (!hasMeaningfulData) return null;

  const candidateTexts = [coverageEntry?.text, eventEntry?.text, annualEntry?.text]
    .map((text) => normalize(text || ''))
    .filter(Boolean);
  const literalEvidence = new Set(literalEvidenceBase);
  candidateTexts.forEach((text) => literalEvidence.add(text));
  const directLiteralBase = new Set(literalEvidenceBase);
  const directLiteral = new Set<string>();
  const propagatedLiteral = new Set<string>();

  const prestadores = Array.from(new Set([
    ...prestadoresBase,
    ...parsePrestadores(candidateTexts),
  ]));

  const directGeometry = [...geometryEvidenceBase];
  const propagatedGeometry: M12AuditGeometryRef[] = [];
  [
    { entry: coverageEntry, propagated: coverageResolved?.propagated ?? false },
    { entry: eventEntry, propagated: eventResolved?.propagated ?? false },
    { entry: annualEntry, propagated: annualResolved?.propagated ?? false },
  ]
    .filter((current) => current.entry)
    .forEach((current) => {
      normalize(current.entry!.text) && (current.propagated ? propagatedLiteral : directLiteral).add(current.entry!.text);
      const target = current.propagated ? propagatedGeometry : directGeometry;
      current.entry!.cell.evidence.forEach((literal) => target.push(...literal.geometry));
      current.entry!.scope?.evidence.forEach((literal) => target.push(...literal.geometry));
    });

  const geometryEvidence = dedupeGeometryEvidence([...directGeometry, ...propagatedGeometry]);
  const evidenceBreakdown = buildEvidenceBreakdown(
    [...directLiteralBase, ...directLiteral],
    propagatedLiteral,
    directGeometry,
    propagatedGeometry
  );

  const propagated =
    (coverageResolved?.propagated ?? false) ||
    (eventResolved?.propagated ?? false) ||
    (annualResolved?.propagated ?? false);

  return {
    ruleId: `${row.rowId}:single_mode_propagated`,
    sectionKey: page.sectionKey,
    itemId: row.rowId,
    itemLabel,
    domainHint: mapDomainHint(page.sectionTitle),
    modality: 'OFERTA_CERRADA',
    coveragePct,
    topeEvento,
    topeAnualBeneficiario,
    topeInternacional: null,
    ampliacionCobertura: null,
    restrictions,
    prestadores,
    footnoteMarkers: row.markers,
    literalEvidence: Array.from(literalEvidence),
    geometryEvidence,
    evidenceBreakdown,
    confidence: propagated ? 'PARTIAL' : 'CONFIRMED',
  };
}

function buildHeuristicRulesForRow(
  page: M12ContractCalcoPage,
  row: M12ContractCalcoPage['rows'][number],
  scopesById: Map<string, M12ContractCalcoScope>,
  itemLabel: string,
  restrictions: string[],
  prestadores: string[],
  literalEvidence: Set<string>,
  geometryEvidence: M12AuditGeometryRef[]
): M12CanonicalContractRule[] {
  const orderedEntries: OrderedCellEntry[] = page.headers.map((header, index) => {
    const cell = row.cells.find((current) => current.columnKey === header.columnKey);
    if (!cell) return null;
    const scope = cell.scopeRef ? scopesById.get(cell.scopeRef) : undefined;
    const text = financialCellText(cell, scopesById);
    return { header, cell, scope, index, text };
  }).filter(Boolean) as OrderedCellEntry[];

  if (!orderedEntries.length) return [];

  const prestationIndex = orderedEntries.findIndex((entry) => entry.header.semanticRole === 'PRESTACION')
    || 0;
  const financialEntries = orderedEntries.filter((entry, index) => index !== prestationIndex && entry.text);
  if (!financialEntries.length) return [];

  const firstLibreIndex = financialEntries.findIndex((entry) => modalityHintFromEntry(entry) === 'LIBRE_ELECCION');
  const hasDualPattern = firstLibreIndex > 0;

  if (hasDualPattern) {
    const primary = financialEntries.slice(0, firstLibreIndex);
    const secondary = financialEntries.slice(firstLibreIndex);
    const rules = [
      buildRuleFromEntries(page, row, itemLabel, 'heuristic_primary', modalityHintFromEntry(primary[0]) || 'PREFERENTE', primary, restrictions, prestadores, literalEvidence, geometryEvidence),
      buildRuleFromEntries(page, row, itemLabel, 'heuristic_secondary', 'LIBRE_ELECCION', secondary, restrictions, prestadores, literalEvidence, geometryEvidence),
    ].filter(Boolean) as M12CanonicalContractRule[];
    return rules.map((rule) => ({ ...rule, confidence: rowConfidence({ ...row, itemLabel }, rules) }));
  }

  const single = buildRuleFromEntries(
    page,
    row,
    itemLabel,
    'heuristic_single',
    modalityHintFromEntry(financialEntries[0]),
    financialEntries,
    restrictions,
    prestadores,
    literalEvidence,
    geometryEvidence
  );
  return single ? [{ ...single, confidence: rowConfidence({ ...row, itemLabel }, [single]) }] : [];
}

function rowConfidence(row: M12ContractCalcoPage['rows'][number], rules: M12CanonicalContractRule[]): M12AuditResolution {
  if (!normalize(row.itemLabel)) return 'UNKNOWN';
  const hasConfirmedRule = rules.some((rule) => rule.confidence === 'CONFIRMED');
  const hasPartialRule = rules.some((rule) => rule.confidence === 'PARTIAL');
  if (hasPartialRule && !hasConfirmedRule) return 'PARTIAL';
  if (rules.some((rule) => rule.coveragePct !== null || rule.topeEvento || rule.topeAnualBeneficiario || rule.topeInternacional)) {
    return 'CONFIRMED';
  }
  if (row.cells.some((cell) => normalize(cell.rawText || '') || cell.scopeRef)) return 'PARTIAL';
  return 'UNKNOWN';
}

function buildRulesForRow(page: M12ContractCalcoPage, row: M12ContractCalcoPage['rows'][number], doctrine: M12ContractDoctrine): M12CanonicalContractRule[] {
  const byKey = new Map(row.cells.map((cell) => [cell.columnKey, cell]));
  const scopesById = new Map(page.scopes.map((scope) => [scope.scopeId, scope]));
  const itemLabel = resolveRowItemLabel(row, scopesById);

  const literalEvidence = new Set<string>([
    itemLabel,
    ...row.cells.map((cell) => normalize(cell.rawText || '')).filter(Boolean),
  ]);
  const geometryEvidence: M12AuditGeometryRef[] = [];
  row.evidence.forEach((literal) => geometryEvidence.push(...literal.geometry));

  const restrictions = collectRestrictions(row, page.scopes, doctrine);
  const prestadores = parsePrestadores([
    ...row.cells.map((cell) => cell.scopeRef ? scopesById.get(cell.scopeRef)?.text || '' : ''),
    ...restrictions,
  ]);

  const buildRule = (
    suffix: string,
    modality: string | null,
    pctKey: string,
    eventKey: string,
    annualKey: string,
    intlKey?: string,
    extensionKey?: string
  ): M12CanonicalContractRule | null => {
    const pctCell = byKey.get(pctKey);
    const eventCell = byKey.get(eventKey);
    const annualCell = byKey.get(annualKey);
    const intlCell = intlKey ? byKey.get(intlKey) : undefined;
    const extensionCell = extensionKey ? byKey.get(extensionKey) : undefined;

    const eventScope = eventCell?.scopeRef ? scopesById.get(eventCell.scopeRef) : pctCell?.scopeRef ? scopesById.get(pctCell.scopeRef) : undefined;
    const annualScope = annualCell?.scopeRef ? scopesById.get(annualCell.scopeRef) : undefined;
    const intlScope = intlCell?.scopeRef ? scopesById.get(intlCell.scopeRef) : undefined;
    const extensionScope = extensionCell?.scopeRef ? scopesById.get(extensionCell.scopeRef) : undefined;

    const coveragePct = pctCell?.numericValue ?? parseNumeric(eventScope?.text) ?? null;
    const topeEventoRaw = buildFinancialTerm('TOPE_EVENTO', eventCell, eventScope);
    const topeAnualRaw = buildFinancialTerm('TOPE_ANUAL', annualCell, annualScope);
    const topeInternacionalRaw = intlKey ? buildFinancialTerm('TOPE_INTERNACIONAL', intlCell, intlScope) : null;
    const ampliacionCoberturaRaw = extensionKey ? buildFinancialTerm('AMPLIACION_COBERTURA', extensionCell, extensionScope) : null;
    const topeEvento = isUsableFinancialTerm(topeEventoRaw) ? topeEventoRaw : null;
    const topeAnualBeneficiario = isUsableFinancialTerm(topeAnualRaw) ? topeAnualRaw : null;
    const topeInternacional = isUsableFinancialTerm(topeInternacionalRaw) ? topeInternacionalRaw : null;
    const ampliacionCobertura = isUsableFinancialTerm(ampliacionCoberturaRaw) ? ampliacionCoberturaRaw : null;

    const hasMeaningfulData =
      coveragePct !== null ||
      isUsableFinancialTerm(topeEvento) ||
      isUsableFinancialTerm(topeAnualBeneficiario) ||
      isUsableFinancialTerm(topeInternacional) ||
      isUsableFinancialTerm(ampliacionCobertura);

    if (!hasMeaningfulData) return null;

    const evidenceTexts = [
      pctCell?.rawText,
      eventCell?.rawText,
      annualCell?.rawText,
      intlCell?.rawText,
      extensionCell?.rawText,
      eventScope?.text,
      annualScope?.text,
      intlScope?.text,
      extensionScope?.text,
    ].map((text) => normalize(text || '')).filter(Boolean);
    evidenceTexts.forEach((text) => literalEvidence.add(text));
    const evidenceBreakdown = buildEvidenceBreakdown(
      literalEvidence,
      [],
      geometryEvidence,
      []
    );

    return {
      ruleId: `${row.rowId}:${suffix}`,
      sectionKey: page.sectionKey,
      itemId: row.rowId,
      itemLabel,
      domainHint: mapDomainHint(page.sectionTitle),
      modality,
      coveragePct,
      topeEvento,
      topeAnualBeneficiario,
      topeInternacional,
      ampliacionCobertura,
      restrictions,
      prestadores,
      footnoteMarkers: row.markers,
      literalEvidence: Array.from(literalEvidence),
      geometryEvidence,
      evidenceBreakdown,
      confidence: 'CONFIRMED',
    };
  };

  if (page.headers.some((header) => header.columnKey === 'preferente_pct')) {
    const exactDualHeaders = new Set(['prestacion', 'preferente_pct', 'preferente_tope_evento', 'preferente_tope_anual', 'libre_pct', 'libre_tope_evento', 'libre_tope_anual']);
    const isExactDual = page.headers.length === 7 && page.headers.every((header) => exactDualHeaders.has(header.columnKey));
    if (isExactDual) {
    const rules = [
      buildRule('preferente', 'PREFERENTE', 'preferente_pct', 'preferente_tope_evento', 'preferente_tope_anual'),
      buildRule('libre_eleccion', 'LIBRE_ELECCION', 'libre_pct', 'libre_tope_evento', 'libre_tope_anual'),
    ].filter(Boolean) as M12CanonicalContractRule[];
    if (!rules.length) return [];
    const confidence = rowConfidence(row, rules);
    return rules.map((rule) => ({ ...rule, confidence }));
    }
  }

  const genericRule = buildRule(
    'plan_base',
    null,
    'cobertura_pct',
    'tope_bonificacion_1',
    'tope_anual_2',
    'tope_internacional_3',
    'ampliacion_4'
  );

  if (genericRule) {
    genericRule.confidence = rowConfidence(row, [genericRule]);
    return [genericRule];
  }

  const indexedRule = buildRule(
    'plan_indexed',
    null,
    'cobertura_pct_1',
    'tope_evento_2',
    'tope_anual_3',
    'tope_internacional_4',
    'ampliacion_5'
  );

  if (indexedRule) {
    indexedRule.confidence = rowConfidence(row, [indexedRule]);
    return [indexedRule];
  }

  const propagatedSingleModeRule = buildSingleModePropagatedRule(
    page,
    row,
    scopesById,
    itemLabel,
    restrictions,
    prestadores,
    literalEvidence,
    geometryEvidence
  );

  if (propagatedSingleModeRule) {
    propagatedSingleModeRule.confidence = rowConfidence(row, [propagatedSingleModeRule]);
    return [propagatedSingleModeRule];
  }

  return buildHeuristicRulesForRow(page, row, scopesById, itemLabel, restrictions, prestadores, literalEvidence, geometryEvidence);
}

function buildReconstructibility(calco: M12ContractCalco, doctrine: M12ContractDoctrine, sections: M12CanonicalContractSection[]): M12ContractReconstructibility {
  const unresolvedRows: string[] = [];
  const unresolvedColumns: string[] = [];
  let totalRows = 0;
  let resolvedRows = 0;
  const auditablePages = calco.pages.filter((page) => !isSupplementalSection(page));
  const usedColumnKeys = new Set(auditablePages.flatMap((page) => page.headers.map((header) => header.columnKey)));

  for (const page of auditablePages) {
    const scopesById = new Map(page.scopes.map((scope) => [scope.scopeId, scope]));
    for (const row of page.rows) {
      totalRows += 1;
      const canonicalRow = sections
        .flatMap((section) => section.items)
        .find((item) => item.itemId === row.rowId);
      if (!normalize(resolveRowItemLabel(row, scopesById)) || !canonicalRow || canonicalRow.rules.length === 0) {
        unresolvedRows.push(row.rowId);
      } else {
        resolvedRows += 1;
      }
    }
  }

  for (const column of doctrine.columns) {
    if (usedColumnKeys.has(column.columnKey) && column.semanticRole === 'UNKNOWN') unresolvedColumns.push(column.columnKey);
  }

  const score = totalRows === 0 ? 0 : Number((resolvedRows / totalRows).toFixed(2));
  let status: M12ContractReconstructibility['status'] = 'NO_VERIFICABLE';
  if (score >= 0.85 && unresolvedColumns.length === 0) status = 'VERIFIABLE';
  else if (score >= 0.45) status = 'PARCIAL';

  const reasons: string[] = [];
  if (unresolvedRows.length) reasons.push(`${unresolvedRows.length} fila(s) sin regla financiera utilizable.`);
  if (unresolvedColumns.length) reasons.push(`${unresolvedColumns.length} columna(s) con semantica no resuelta.`);
  if (!reasons.length) reasons.push('Contrato reconstruible a nivel de regla.');

  return {
    status,
    score,
    unresolvedRows,
    unresolvedColumns,
    reasons,
  };
}

export function isM12CanonicalContract(value: any): value is M12CanonicalContract {
  return !!value?.doctrine && !!value?.reconstructibility && Array.isArray(value?.sections);
}

export function buildCanonicalContractFromCalco(calco: M12ContractCalco): M12CanonicalContract {
  const doctrine = buildDoctrine(calco);
  const sections: M12CanonicalContractSection[] = [];
  const warnings: M12CanonicalContract['warnings'] = [];

  for (const page of calco.pages) {
    if (isSupplementalSection(page)) continue;
    const scopesById = new Map(page.scopes.map((scope) => [scope.scopeId, scope]));
    const items: M12CanonicalContractItem[] = [];
    for (const row of page.rows) {
      const rules = buildRulesForRow(page, row, doctrine);
      const itemLabel = resolveRowItemLabel(row, scopesById);
      if (!normalize(itemLabel)) {
        warnings.push({
          code: 'ROW_WITHOUT_LABEL',
          detail: 'Fila sin prestacion legible.',
          severity: 'warn',
          rowId: row.rowId,
        });
      }
      if (normalize(itemLabel) && !rules.length) {
        warnings.push({
          code: 'ROW_WITHOUT_RULES',
          detail: 'Fila con prestacion pero sin regla financiera reconstruida.',
          severity: 'warn',
          rowId: row.rowId,
        });
      }
      items.push({
        itemId: row.rowId,
        itemLabel,
        domainHint: mapDomainHint(page.sectionTitle),
        sourceRowIds: [row.rowId],
        rules,
      });
    }
    sections.push({
      sectionKey: page.sectionKey,
      title: page.sectionTitle,
      items,
    });
  }

  const reconstructibility = buildReconstructibility(calco, doctrine, sections);

  const sectionColumnKeys = new Set(calco.pages.filter((page) => !isSupplementalSection(page)).flatMap((page) => page.headers.map((header) => header.columnKey)));

  doctrine.columns
    .filter((column) => column.semanticRole === 'UNKNOWN')
    .filter((column) => sectionColumnKeys.has(column.columnKey))
    .forEach((column) => {
      warnings.push({
        code: 'UNKNOWN_COLUMN_ROLE',
        detail: `No se resolvio la semantica de la columna "${column.headerLabel}".`,
        severity: 'warn',
        columnKey: column.columnKey,
      });
    });

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      variant: calco.metadata.variant,
      derivedFromCalco: true,
      sourceFingerprint: calco.metadata.sourceFingerprint || null,
    },
    doctrine,
    reconstructibility,
    sections,
    warnings,
  };
}
