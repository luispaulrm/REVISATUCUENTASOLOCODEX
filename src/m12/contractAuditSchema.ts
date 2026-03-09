export type M12AuditResolution = 'CONFIRMED' | 'PARTIAL' | 'UNKNOWN';

export type M12AuditSourceKind =
  | 'AZURE_LAYOUT_WEB'
  | 'PDF_TEXT_LAYER'
  | 'MANUAL_INFERENCE'
  | 'M12_DERIVED';

export type M12AuditSemanticRole =
  | 'SECTION_TITLE'
  | 'PRESTACION'
  | 'COBERTURA_PCT'
  | 'TOPE_EVENTO'
  | 'TOPE_ANUAL'
  | 'TOPE_INTERNACIONAL'
  | 'AMPLIACION_COBERTURA'
  | 'FOOTNOTE_MARKER'
  | 'FOOTNOTE_TEXT'
  | 'SCOPE_BOX'
  | 'UNKNOWN';

export type M12AuditValueKind =
  | 'TEXT'
  | 'PERCENT'
  | 'NUMERIC_LIMIT'
  | 'CURRENCY'
  | 'UNIT_FACTOR'
  | 'EMPTY'
  | 'SCOPE_REF'
  | 'MARKER'
  | 'UNKNOWN';

export type M12AuditUnit =
  | 'UF'
  | 'VA'
  | 'VAM'
  | 'AC2'
  | 'CLP'
  | 'SIN_TOPE'
  | 'UNKNOWN';

export type M12AuditContractVariant =
  | 'PREFERENTE_LIBRE_ELECCION'
  | 'GRID_1_2_3_4'
  | 'SINGLE_MODE'
  | 'UNKNOWN';

export interface M12AuditGeometryRef {
  page: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number } | null;
  polygon?: number[] | null;
  rowIndex?: number | null;
  columnIndex?: number | null;
  spanOffset?: number | null;
  spanLength?: number | null;
  source: M12AuditSourceKind;
}

export interface M12AuditLiteralRef {
  text: string;
  normalized?: string | null;
  source: M12AuditSourceKind;
  geometry: M12AuditGeometryRef[];
}

export interface M12ContractCalcoHeader {
  columnKey: string;
  label: string;
  marker?: string | null;
  semanticRole: M12AuditSemanticRole;
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractCalcoCell {
  cellId: string;
  rowId: string;
  columnKey: string;
  semanticRole: M12AuditSemanticRole;
  valueKind: M12AuditValueKind;
  rawText: string | null;
  normalizedText?: string | null;
  numericValue?: number | null;
  unit?: M12AuditUnit | null;
  scopeRef?: string | null;
  confidence: M12AuditResolution;
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractCalcoRow {
  rowId: string;
  sectionKey: string;
  itemLabel: string;
  markers: string[];
  cells: M12ContractCalcoCell[];
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractCalcoScope {
  scopeId: string;
  columnKey: string;
  rowStartId: string;
  rowEndId: string;
  text: string;
  markers: string[];
  confidence: M12AuditResolution;
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractCalcoFootnote {
  footnoteId: string;
  marker: string;
  text: string;
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractCalcoPage {
  pageNumber: number;
  sectionKey: string;
  sectionTitle: string;
  headers: M12ContractCalcoHeader[];
  rows: M12ContractCalcoRow[];
  scopes: M12ContractCalcoScope[];
  footnotes: M12ContractCalcoFootnote[];
}

export interface M12ContractCalco {
  metadata: {
    generatedAt: string;
    variant: M12AuditContractVariant;
    traceId?: string;
    sourceFingerprint?: string | null;
    stringIndexType?: string | null;
    modelId?: string | null;
  };
  source: {
    kind: M12AuditSourceKind;
    pageCount: number;
    rawStatus?: string | null;
    warnings: string[];
  };
  pages: M12ContractCalcoPage[];
}

export interface M12ContractDoctrineColumn {
  columnKey: string;
  headerLabel: string;
  semanticRole:
    | 'PRESTACION'
    | 'COBERTURA_PCT'
    | 'TOPE_EVENTO'
    | 'TOPE_ANUAL'
    | 'TOPE_INTERNACIONAL'
    | 'AMPLIACION_COBERTURA'
    | 'UNKNOWN';
  marker?: string | null;
  literalMeaning: string;
  confidence: M12AuditResolution;
  evidence: M12AuditLiteralRef[];
}

export interface M12ContractDoctrineFootnoteLink {
  footnoteId: string;
  marker: string;
  text: string;
  rowIds: string[];
  columnKeys: string[];
  scopeIds: string[];
  confidence: M12AuditResolution;
}

export interface M12ContractDoctrineScopeAssignment {
  scopeId: string;
  columnKey: string;
  appliesToRowIds: string[];
  semanticMeaning: string;
  confidence: M12AuditResolution;
}

export interface M12ContractDoctrine {
  columns: M12ContractDoctrineColumn[];
  footnotes: M12ContractDoctrineFootnoteLink[];
  scopes: M12ContractDoctrineScopeAssignment[];
}

export interface M12ContractReconstructibility {
  status: 'VERIFIABLE' | 'PARCIAL' | 'NO_VERIFICABLE';
  score: number;
  unresolvedRows: string[];
  unresolvedColumns: string[];
  reasons: string[];
}

export interface M12CanonicalFinancialTerm {
  role: 'TOPE_EVENTO' | 'TOPE_ANUAL' | 'TOPE_INTERNACIONAL' | 'AMPLIACION_COBERTURA';
  state: 'NUMERIC' | 'SIN_TOPE' | 'EMPTY' | 'UNKNOWN';
  amount: number | null;
  unit: M12AuditUnit | null;
  literalText: string | null;
  sourceCellIds: string[];
  sourceScopeIds: string[];
}

export interface M12CanonicalEvidenceBreakdown {
  mode: 'DIRECT' | 'PROPAGATED' | 'MIXED' | 'NONE';
  directLiteralEvidence: string[];
  propagatedLiteralEvidence: string[];
  directGeometryEvidence: M12AuditGeometryRef[];
  propagatedGeometryEvidence: M12AuditGeometryRef[];
}

export interface M12CanonicalContractRule {
  ruleId: string;
  sectionKey: string;
  itemId: string;
  itemLabel: string;
  domainHint: string | null;
  modality: string | null;
  coveragePct: number | null;
  topeEvento: M12CanonicalFinancialTerm | null;
  topeAnualBeneficiario: M12CanonicalFinancialTerm | null;
  topeInternacional: M12CanonicalFinancialTerm | null;
  ampliacionCobertura: M12CanonicalFinancialTerm | null;
  restrictions: string[];
  prestadores: string[];
  footnoteMarkers: string[];
  literalEvidence: string[];
  geometryEvidence: M12AuditGeometryRef[];
  evidenceBreakdown: M12CanonicalEvidenceBreakdown;
  confidence: M12AuditResolution;
}

export interface M12CanonicalContractItem {
  itemId: string;
  itemLabel: string;
  domainHint: string | null;
  sourceRowIds: string[];
  rules: M12CanonicalContractRule[];
}

export interface M12CanonicalContractSection {
  sectionKey: string;
  title: string;
  items: M12CanonicalContractItem[];
}

export interface M12CanonicalContract {
  metadata: {
    generatedAt: string;
    variant: M12AuditContractVariant;
    derivedFromCalco: boolean;
    sourceFingerprint?: string | null;
  };
  doctrine: M12ContractDoctrine;
  reconstructibility: M12ContractReconstructibility;
  sections: M12CanonicalContractSection[];
  warnings: Array<{
    code: string;
    detail: string;
    severity: 'info' | 'warn' | 'error';
    rowId?: string;
    columnKey?: string;
  }>;
}
