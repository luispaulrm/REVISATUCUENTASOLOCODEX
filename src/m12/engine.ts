import { M12AuditResult, M12Rule, M12Section, M12SectionItem, M12Tope } from './types';

function asNumber(v: any): number | null {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\./g, '').replace(',', '.'));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function normalizeUnit(unit: any): string {
  const raw = String(unit || '').trim().toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw === 'VAM' || raw === 'V.A.' || raw === 'VA') return 'VA';
  if (raw === 'UF') return 'UF';
  if (raw.includes('SIN') && raw.includes('TOPE')) return 'SIN_TOPE';
  return raw;
}

function toTope(obj: any): M12Tope {
  const estado = String(obj?.estado || 'UNKNOWN');
  const valor = asNumber(obj?.valor);
  const unidad = normalizeUnit(obj?.unidad);
  const tipo = obj?.tipo ? String(obj.tipo) : undefined;
  return { estado, valor, unidad, tipo };
}

function sectionFromAmbito(ambito: string): string {
  const a = String(ambito || '').toUpperCase();
  if (['DIA_CAMA', 'PABELLON', 'HONORARIOS', 'MEDICAMENTOS', 'MATERIALES', 'PROTESIS', 'EXAMENES'].includes(a)) {
    return 'HOSPITALARIAS_Y_CIRUGIA_MAYOR_AMBULATORIA';
  }
  if (a === 'AMBULATORIO') return 'AMBULATORIAS';
  if (a === 'URGENCIA') return 'ATENCIONES_DE_URGENCIA';
  return 'OTRAS_PRESTACIONES';
}

function pushRule(target: M12SectionItem, rawRule: any, modality: 'PREFERENTE' | 'LIBRE_ELECCION') {
  const rule: M12Rule = {
    modality,
    subred_id: String(rawRule?.subred_id || (modality === 'LIBRE_ELECCION' ? 'LIBRE_ELECCION' : 'PREF_TIER_1')),
    porcentaje: asNumber(rawRule?.porcentaje),
    tope_evento: toTope(rawRule?.tope_evento),
    tope_anual: toTope(rawRule?.tope_anual),
    copago_fijo: rawRule?.copago_fijo ? {
      valor: asNumber(rawRule.copago_fijo.valor) ?? 0,
      unidad: normalizeUnit(rawRule.copago_fijo.unidad || 'UF')
    } : null,
    condiciones: Array.isArray(rawRule?.condiciones) ? rawRule.condiciones.map((x: any) => String(x)) : [],
    clinicas: Array.isArray(rawRule?.clinicas) ? rawRule.clinicas.map((x: any) => String(x)) : [],
    evidence: rawRule?.evidence ? {
      page: Number.isFinite(rawRule.evidence.page) ? Number(rawRule.evidence.page) : null,
      cells: Array.isArray(rawRule.evidence.cells)
        ? rawRule.evidence.cells.map((c: any) => ({ cellId: String(c?.cellId || ''), text: String(c?.text || '') }))
        : []
    } : undefined
  };
  target.rules.push(rule);
}

function parseAuditorBItems(source: any[]): M12Section[] {
  const sectionMap = new Map<string, M12Section>();

  for (const item of source) {
    const sectionName = sectionFromAmbito(item?.ambito);
    const section = sectionMap.get(sectionName) || { section: sectionName, items: [] };
    const outItem: M12SectionItem = {
      ambito: String(item?.ambito || 'OTROS'),
      item: String(item?.item || 'UNKNOWN_ITEM'),
      rules: []
    };

    for (const r of (item?.preferente?.rules || [])) pushRule(outItem, r, 'PREFERENTE');
    for (const r of (item?.libre_eleccion?.rules || [])) pushRule(outItem, r, 'LIBRE_ELECCION');

    if (outItem.rules.length > 0) section.items.push(outItem);
    sectionMap.set(sectionName, section);
  }

  return Array.from(sectionMap.values()).filter((s) => s.items.length > 0);
}

function parseGenericRules(source: any[]): M12Section[] {
  const section: M12Section = { section: 'REGLAS_GENERICAS', items: [] };
  for (const r of source) {
    const item: M12SectionItem = {
      ambito: String(r?.ambito || r?.categoria || 'OTROS'),
      item: String(r?.item || r?.descripcion_textual || 'UNKNOWN_ITEM'),
      rules: []
    };
    pushRule(item, {
      ...r,
      tope_evento: r?.tope_evento || (r?.tope ? { estado: 'CON_TOPE', valor: asNumber(r.tope?.value), unidad: r.tope?.kind || 'UNKNOWN' } : undefined),
      tope_anual: r?.tope_anual
    }, String(r?.tipo_modalidad || '').toLowerCase().includes('libre') ? 'LIBRE_ELECCION' : 'PREFERENTE');
    section.items.push(item);
  }
  return section.items.length > 0 ? [section] : [];
}

export function runM12Audit(contractSource: any): M12AuditResult {
  let sections: M12Section[] = [];
  const warnings = Array.isArray(contractSource?.warnings)
    ? contractSource.warnings.map((w: any) => ({ type: String(w?.type || 'WARNING'), detail: String(w?.detail || '') }))
    : [];

  if (Array.isArray(contractSource?.items)) {
    sections = parseAuditorBItems(contractSource.items);
  } else if (Array.isArray(contractSource?.rules)) {
    sections = parseGenericRules(contractSource.rules);
  } else if (Array.isArray(contractSource)) {
    sections = parseGenericRules(contractSource);
  }

  let items = 0;
  let rules = 0;
  for (const s of sections) {
    items += s.items.length;
    for (const it of s.items) rules += it.rules.length;
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'M12_VISUAL_STRUCTURAL_AUDITOR',
      cached: false
    },
    diagnostics: {
      sections: sections.length,
      items,
      rules,
      warnings: warnings.length
    },
    warnings,
    sections
  };
}

