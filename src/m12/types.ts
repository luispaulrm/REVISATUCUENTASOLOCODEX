export type M12Modality = 'PREFERENTE' | 'LIBRE_ELECCION';

export interface M12Tope {
  estado: string;
  valor: number | null;
  unidad: string;
  tipo?: string;
}

export interface M12Rule {
  modality: M12Modality;
  subred_id: string;
  porcentaje: number | null;
  tope_evento: M12Tope;
  tope_anual: M12Tope;
  copago_fijo?: { valor: number; unidad: string } | null;
  condiciones: string[];
  clinicas: string[];
  evidence?: { page: number | null; cells: Array<{ cellId: string; text: string }> };
}

export interface M12SectionItem {
  ambito: string;
  item: string;
  rules: M12Rule[];
}

export interface M12Section {
  section: string;
  items: M12SectionItem[];
}

export interface M12AuditResult {
  metadata: {
    generatedAt: string;
    source: string;
    cached: boolean;
  };
  diagnostics: {
    sections: number;
    items: number;
    rules: number;
    warnings: number;
  };
  warnings: Array<{ type: string; detail: string }>;
  sections: M12Section[];
}

export type {
  M12AuditContractVariant,
  M12AuditGeometryRef,
  M12AuditLiteralRef,
  M12AuditResolution,
  M12AuditSemanticRole,
  M12AuditSourceKind,
  M12AuditUnit,
  M12AuditValueKind,
  M12CanonicalContract,
  M12CanonicalContractItem,
  M12CanonicalContractRule,
  M12CanonicalContractSection,
  M12CanonicalFinancialTerm,
  M12ContractCalco,
  M12ContractCalcoCell,
  M12ContractCalcoFootnote,
  M12ContractCalcoHeader,
  M12ContractCalcoPage,
  M12ContractCalcoRow,
  M12ContractCalcoScope,
  M12ContractDoctrine,
  M12ContractDoctrineColumn,
  M12ContractDoctrineFootnoteLink,
  M12ContractDoctrineScopeAssignment,
  M12ContractReconstructibility,
} from './contractAuditSchema';
