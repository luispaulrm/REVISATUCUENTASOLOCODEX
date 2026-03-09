import React, { useState, useEffect, useRef } from 'react';
import { Brain, Database, FileText, Activity, Layers, Zap, CheckCircle2, AlertCircle, Play, Loader2, FileJson, Copy, Check, Info, Download, Sparkles } from 'lucide-react';
import html2pdf from 'html2pdf.js';
import { runSkill } from '../m11/engine';
import { SkillInput, SkillOutput, CanonicalContractRule, ContractDomain } from '../m11/types';
import ChatBox from './ChatBox';

const M12_CONTRACT_KEY = 'm12_audit_result';
type StoredContractSource = 'm12' | 'canonical' | 'legacy' | 'none';

function hasUsableContractPayload(obj: any): boolean {
    if (!obj || typeof obj !== 'object') return false;
    return Boolean(
        (Array.isArray(obj.sections) && obj.sections.length > 0) ||
        (Array.isArray(obj.items) && obj.items.length > 0) ||
        (Array.isArray(obj.rules) && obj.rules.length > 0) ||
        (Array.isArray(obj.coberturas) && obj.coberturas.length > 0) ||
        obj.page3_sections ||
        obj.oferta_preferente ||
        obj.libre_eleccion
    );
}

function getStoredContractSource(): { data: any; source: StoredContractSource } {
    try {
        const m12Raw = localStorage.getItem(M12_CONTRACT_KEY);
        if (m12Raw) {
            const parsed = JSON.parse(m12Raw);
            if (hasUsableContractPayload(parsed)) {
                return { data: parsed, source: 'm12' };
            }
        }
    } catch { }

    try {
        const canonicalRaw = localStorage.getItem('canonical_contract_result');
        if (canonicalRaw) {
            const parsed = JSON.parse(canonicalRaw);
            if (hasUsableContractPayload(parsed)) {
                return { data: parsed, source: 'canonical' };
            }
        }
    } catch { }

    try {
        const legacyRaw = localStorage.getItem('contract_audit_result');
        if (legacyRaw) {
            const parsed = JSON.parse(legacyRaw);
            if (hasUsableContractPayload(parsed)) {
                return { data: parsed, source: 'legacy' };
            }
        }
    } catch { }

    return { data: {}, source: 'none' };
}

export default function AuditorM11App() {
    const [dataStatus, setDataStatus] = useState({
        canonical: false,
        pam: false,
        account: false
    });
    const [auditResult, setAuditResult] = useState<SkillOutput | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [copied, setCopied] = useState(false);
    const adaptedInputRef = useRef<SkillInput | null>(null);

    useEffect(() => {
        const checkData = () => {
            const contract = getStoredContractSource();
            const pam = localStorage.getItem('pam_audit_result');
            const account = localStorage.getItem('clinic_audit_result');

            setDataStatus({
                canonical: contract.source !== 'none',
                pam: !!pam,
                account: !!account
            });
        };

        checkData();
        const interval = setInterval(checkData, 2000);
        return () => clearInterval(interval);
    }, []);

    const handleRunAudit = async () => {
        setIsProcessing(true);
        try {
            const { data: rawContract, source: contractSource } = getStoredContractSource();
            const pamStr = localStorage.getItem('pam_audit_result');
            const accountStr = localStorage.getItem('clinic_audit_result');

            if (contractSource === 'none' || !pamStr || !accountStr) {
                alert('Faltan datos para ejecutar la auditoría (Contrato M12/Canónico, PAM y Cuenta).');
                setIsProcessing(false);
                return;
            }

            const rawPam = JSON.parse(pamStr);
            const rawBill = JSON.parse(accountStr);

            const input = adaptToM11Input(rawContract, rawPam, rawBill);
            console.log(`[M11] Fuente contractual activa: ${contractSource.toUpperCase()}`);

            // Pre-resolve UF value for M5 tope calculations
            const ufResult = await resolveUFValueCLP();
            if (ufResult) {
                input.config = {
                    ...input.config,
                    ufValueCLP: ufResult.valueCLP,
                    ufDateUsed: ufResult.date,
                    ufSource: ufResult.source
                };
                console.log(`[M11 UF] ✅ UF = $${ufResult.valueCLP.toLocaleString()} (${ufResult.date}, fuente: ${ufResult.source})`);
            } else {
                console.warn(`[M11 UF] ⚠️ No se pudo resolver UF — M5 topes serán NO_VERIFICABLE`);
            }

            // DIAGNOSTIC: warn if rules=0 but there were coberturas (mapping bug vs missing contract)
            const rawCoberturasCount = Array.isArray(rawContract.coberturas) ? rawContract.coberturas.length
                : Array.isArray(rawContract.rules) ? rawContract.rules.length
                    : Array.isArray(rawContract.sections) ? rawContract.sections.reduce((acc: number, s: any) => acc + (s?.items?.length || 0), 0)
                    : 0;

            if (input.pam.folios.length === 0 || input.bill.items.length === 0) {
                const missing = [];
                if (input.pam.folios.length === 0) missing.push("PAM (Folios=0)");
                if (input.bill.items.length === 0) missing.push("Cuenta (Items=0)");

                const debugMsg = `SC-1 ERROR DIAGNÓSTICO:\n${missing.join(', ')}\n\nKeys RAW:\nPAM: ${Object.keys(rawPam).join(',')}\nBill: ${Object.keys(rawBill).join(',')}`;

                setAuditResult({
                    summary: { totalCopagoAnalizado: 0, totalImpactoFragmentacion: 0, opacidadGlobal: { applies: false, maxIOP: 0 }, patternSystemic: { m1Count: 0, m2Count: 0, m3CopagoPct: 0, m5Count: 0, m5ExcessCopago: 0, m5OverchargePct: 0, isSystemic: false } },
                    eventModel: { notes: "Error de Datos", paquetesDetectados: [] },
                    matrix: [],
                    pamRows: [],
                    reportText: debugMsg,
                    complaintText: ''
                });
                setIsProcessing(false);
                return;
            }

            // Warn in console if rules are 0 but contract had coberturas (domain mapping failure)
            if (input.contract.rules.length === 0 && rawCoberturasCount > 0) {
                console.warn(`[M11 ADAPTER] ⚠️ Contrato tiene ${rawCoberturasCount} coberturas pero se mapearon 0 reglas. Revisar mapCategoryToDomain.`);
            } else if (input.contract.rules.length === 0) {
                console.warn(`[M11 ADAPTER] Sin contrato canonizado — auditoría por inferencia estructural.`);
            } else {
                console.log(`[M11 ADAPTER] ✅ ${input.contract.rules.length} reglas contractuales cargadas.`);
            }

            adaptedInputRef.current = input; // Store for ChatBox context
            const result = runSkill(input);
            setAuditResult(result);
        } catch (error: any) {
            console.error("Error executing M11 Audit:", error);
            alert(`Error al ejecutar el motor M11: ${error.message}`);
            setAuditResult({
                summary: { totalCopagoAnalizado: 0, totalImpactoFragmentacion: 0, opacidadGlobal: { applies: false, maxIOP: 0 }, patternSystemic: { m1Count: 0, m2Count: 0, m3CopagoPct: 0, m5Count: 0, m5ExcessCopago: 0, m5OverchargePct: 0, isSystemic: false } },
                eventModel: { notes: `Error Critico: ${error.message}`, paquetesDetectados: [] },
                matrix: [],
                pamRows: [],
                reportText: `ERROR CRÍTICO DEL SISTEMA:\n${error.message}`,
                complaintText: ''
            });
        } finally {
            setIsProcessing(false);
        }
    };

    const loadDemoData = () => {
        // 1. Mock Contract (Mas Vida - Plan Pleno 847)
        // Based on the user's request and the "Plan Pleno" file found
        const mockContract = {
            rules: [
                { id: 'R1', /* Use a robust fallback ID */ domain: 'PABELLON', coberturaPct: 100, tope: { value: null, kind: 'SIN_TOPE_EXPRESO' }, textLiteral: 'Derecho Pabellón 100% Sin Tope' },
                { id: 'R2', domain: 'MATERIALES_CLINICOS', coberturaPct: 100, tope: { value: 6000000, kind: 'TOPE_MONTO' }, textLiteral: 'Materiales e Insumos 100% Sin Tope (Simulado)' }, // Hight cap for testing
                { id: 'R3', domain: 'HONORARIOS', coberturaPct: 100, tope: { value: 13.26, kind: 'VAM' }, textLiteral: 'Honorarios Médicos 100% Tope 13.26 VAM' },
                { id: 'R4', domain: 'DIA_CAMA', coberturaPct: 100, tope: { value: null, kind: 'SIN_TOPE_EXPRESO' }, textLiteral: 'Día Cama 100% Sin Tope' }
            ]
        };

        // 2. Mock PAM (Payment) - Appendicitis Case
        // Simulating a standard Appendicitis PAM with some "Traps" for M10 to find
        const mockPam = {
            folios: [{
                folioPAM: 'PAM-APENDICITIS-001',
                items: [
                    // HMQ: Apendicectomía (Correcto)
                    { codigoGC: '1701001', descripcion: 'APENDICECTOMIA', valorTotal: 450000, bonificacion: 450000, copago: 0 },
                    // Pavilion: Right
                    { codigoGC: '1101001', descripcion: 'DERECHO PABELLON QUIRURGICO', valorTotal: 300000, bonificacion: 300000, copago: 0 },
                    // Day Bed: Right
                    { codigoGC: '1201001', descripcion: 'DIA CAMA DE HOSPITALIZACION', valorTotal: 200000, bonificacion: 200000, copago: 0 },

                    // --- M10 v1.4 TRAPS ---
                    // M3 Trap: "Insumos Generales" (Generic/Opaque) -> IOP High
                    { codigoGC: '3101001', descripcion: 'INSUMOS GENERALES VARIOS', valorTotal: 25000, bonificacion: 0, copago: 25000 },
                    // M4 Trap: "Alimentación Acompañante" (Should be Hotelery but sometimes argued) -> Discusión Técnica
                    { codigoGC: '6001001', descripcion: 'ALIMENTACION ACOMPAÑANTE', valorTotal: 5000, bonificacion: 0, copago: 5000 }
                ]
            }]
        };

        // 3. Mock Bill (Charge)
        const mockBill = {
            items: [
                { description: 'Honorario Medico Apendicectomia', total: 450000 },
                { description: 'Pabellon Central', total: 300000 },
                { description: 'Habitación Individual (2 dias)', total: 200000 },
                { description: 'Sala Recuperacion Post-Op', total: 120000 },
                { description: 'Sutura Vicryl', total: 15000 },
                { description: 'Sutura Seda', total: 20000 }, // Total 35000 matches PAM
                { description: 'Gasto Insumos Varios', total: 25000 },
                { description: 'Caldos y Sopas', total: 5000 }
            ]
        };

        localStorage.setItem('canonical_contract_result', JSON.stringify(mockContract));
        localStorage.setItem('pam_audit_result', JSON.stringify(mockPam));
        localStorage.setItem('clinic_audit_result', JSON.stringify(mockBill));

        alert("Datos de prueba v1.4 (Caso Apendicitis c/ Opacidad) cargados. Ejecute el Módulo 10.");
    };

    const copyComplaint = () => {
        if (!auditResult) return;
        navigator.clipboard.writeText(auditResult.complaintText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleDownloadJSON = () => {
        if (!auditResult) return;
        const jsonString = JSON.stringify(auditResult, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const patientName = auditResult.metadata?.patientName?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'unknown';
        const date = new Date().toISOString().split('T')[0];
        a.download = `audit_m10_${patientName}_${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDownloadPDF = () => {
        const element = document.getElementById('m10-audit-results');
        if (!element) return;

        const patientName = auditResult?.metadata?.patientName?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'audit';
        const date = new Date().toISOString().split('T')[0];
        const opt = {
            margin: [10, 10, 10, 10] as any, // top, left, bottom, right
            filename: `audit_m10_${patientName}_${date}.pdf`,
            image: { type: 'jpeg' as 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as 'portrait' },
            pagebreak: { mode: 'avoid-all', before: '#page-break-before' }
        };

        html2pdf().set(opt).from(element).save();
    };

    const handleNewAudit = () => {
        if (confirm("¿Estás seguro de que deseas iniciar una NUEVA AUDITORÍA?\n\nEsto borrará todos los datos cargados (Contrato, PAM, Cuenta) y tendrás que subirlos nuevamente.")) {
            // 1. Clear State
            setAuditResult(null);
            setDataStatus({ canonical: false, pam: false, account: false });

            // 2. Clear LocalStorage Logic
            localStorage.removeItem('canonical_contract_result');
            localStorage.removeItem(M12_CONTRACT_KEY);
            localStorage.removeItem('pam_audit_result');
            localStorage.removeItem('clinic_audit_result');
            localStorage.removeItem('audit_m10_demo_mode'); // If any

            // 3. Optional: Reload to force clean state? 
            // window.location.reload(); // Might be too aggressive.
            // Just updating state is enough because of useEffect interval or local check.
        }
    };

    const allDataReady = dataStatus.canonical && dataStatus.pam && dataStatus.account;

    return (
        <div className="min-h-[calc(100vh-64px)] bg-[#f8fafc] p-8 animate-in fade-in duration-700 pb-32">
            <div className="max-w-7xl mx-auto space-y-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-200 pb-8">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-200">
                                <Brain className="text-white" size={24} />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Advanced Forensic Layer v1.3</span>
                        </div>
                        <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight">
                            Módulo 11 <span className="text-indigo-600">Auditor (Sandbox)</span>
                        </h1>
                        <p className="mt-2 text-slate-500 max-w-2xl text-lg">
                            Motor Maestro: Triple Cruce + Fragmentación M1/M2/M3 + Opacidad IOP.
                        </p>
                    </div>

                    <div className="flex gap-4">
                        <div className="px-6 py-3 bg-white rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full ${allDataReady ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
                            <span className="text-sm font-semibold text-slate-700">
                                {allDataReady ? 'Fuentes Listas' : 'Esperando Conexiones'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Connection Status Grid - Valid for both states */}
                {!auditResult && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {[
                            { title: 'JSON Canónico', icon: <Database className={dataStatus.canonical ? "text-blue-500" : "text-slate-400"} />, label: 'Contrato Estructurado', ready: dataStatus.canonical },
                            { title: 'PAM Data', icon: <FileText className={dataStatus.pam ? "text-purple-500" : "text-slate-400"} />, label: 'Coberturas Reales', ready: dataStatus.pam },
                            { title: 'Cuenta Clínica', icon: <Activity className={dataStatus.account ? "text-rose-500" : "text-slate-400"} />, label: 'Gastos Médicos', ready: dataStatus.account }
                        ].map((card, idx) => (
                            <div key={idx} className={`group relative bg-white p-6 rounded-3xl border transition-all duration-500 ${card.ready ? 'border-indigo-100 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5' : 'border-slate-200 opacity-70'}`}>
                                <div className="flex items-start justify-between mb-4">
                                    <div className={`p-3 rounded-2xl transition-all duration-500 ${card.ready ? 'bg-slate-50 group-hover:bg-white group-hover:scale-110' : 'bg-slate-100'}`}>
                                        {card.icon}
                                    </div>
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Source Connection</div>
                                </div>
                                <h3 className="text-lg font-bold text-slate-900 mb-1">{card.title}</h3>
                                <div className="flex items-center gap-2">
                                    <span className={`w-1.5 h-1.5 rounded-full ${card.ready ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                    <span className={`text-xs font-medium ${card.ready ? 'text-emerald-600' : 'text-slate-400'}`}>{card.ready ? 'Linked' : 'Disconnected'}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {!allDataReady && !auditResult && (
                    <div className="flex justify-center">
                        <button onClick={loadDemoData} className="text-xs font-bold text-slate-400 hover:text-indigo-600 underline">
                            CARGAR DATOS DE PRUEBA (DEMO CONSALUD)
                        </button>
                    </div>
                )}

                {/* Action Area */}
                {!auditResult && (
                    <div className="relative overflow-hidden bg-slate-900 rounded-[2.5rem] p-12 text-center shadow-2xl">
                        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 to-purple-600" />
                            <div className="absolute top-0 left-0 w-full h-full bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                        </div>
                        <div className="relative z-10 flex flex-col items-center">
                            <div className="p-4 bg-white/10 rounded-full backdrop-blur-xl mb-6">
                                <Zap className={allDataReady ? "text-indigo-400" : "text-slate-500"} size={48} />
                            </div>
                            <h2 className="text-3xl font-bold text-white mb-4">
                                {allDataReady ? 'Listo para Auditoría M11 v2.0' : 'Fuentes Incompletas'}
                            </h2>

                            {/* NEW: Forensic Source Checklist */}
                            <div className="w-full max-w-xl bg-white/5 backdrop-blur-md rounded-2xl p-6 mb-8 border border-white/10 text-left">
                                <h3 className="text-sm font-bold text-indigo-300 uppercase tracking-widest mb-4 flex items-center gap-2">
                                    <Activity size={14} /> Validación de Capacidad Forense
                                </h3>
                                <div className="space-y-4">
                                    {[
                                        {
                                            title: 'Contrato (M12/Canónico)',
                                            check: dataStatus.canonical,
                                            desc: 'Habilita validación de Topes (M5-T) y Coberturas Contractuales.'
                                        },
                                        {
                                            title: 'Plan de Atención (PAM)',
                                            check: dataStatus.pam,
                                            desc: 'Provee montos de Bonificación Isapre y códigos de prestación.'
                                        },
                                        {
                                            title: 'Cuenta Clínica (Bill)',
                                            check: dataStatus.account,
                                            desc: 'Aporta el desglose unitario para detección de fragmentación (M1/M2).'
                                        }
                                    ].map((item, i) => (
                                        <div key={i} className="flex items-start gap-4">
                                            <div className={`mt-1 p-1 rounded-full ${item.check ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                                                {item.check ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                                            </div>
                                            <div>
                                                <div className="text-sm font-bold text-white">{item.title}</div>
                                                <div className="text-xs text-slate-400 leading-relaxed">{item.desc}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <button
                                onClick={handleRunAudit}
                                disabled={!allDataReady || isProcessing}
                                className={`px-10 py-4 font-bold rounded-2xl shadow-lg transition-all duration-300 flex items-center gap-3 ${allDataReady && !isProcessing ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/30 hover:scale-105 active:scale-95' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
                            >
                                {isProcessing ? <Loader2 className="animate-spin" size={20} /> : <Play size={20} />}
                                {isProcessing ? 'Ejecutando Pipeline Maestro...' : 'Iniciar Procesamiento M11'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Gate 0 Error Display */}
                {auditResult && auditResult.reportText.startsWith("ERROR CRÍTICO GATE 0") && (
                    <div className="bg-rose-50 border-2 border-rose-200 rounded-3xl p-8 text-center animate-in fade-in zoom-in duration-300">
                        <div className="flex justify-center mb-4">
                            <div className="p-4 bg-rose-100 rounded-full text-rose-600">
                                <AlertCircle size={48} />
                            </div>
                        </div>
                        <h2 className="text-2xl font-black text-rose-700 mb-2">FALLO CRÍTICO DE INTEGRIDAD (GATE 0)</h2>
                        <p className="text-rose-600 font-medium max-w-2xl mx-auto">{auditResult.eventModel.notes}</p>
                        <button onClick={() => setAuditResult(null)} className="mt-6 px-6 py-2 bg-rose-600 text-white font-bold rounded-xl hover:bg-rose-700 transition-colors">
                            REVISAR DATOS FUENTE
                        </button>
                    </div>
                )}

                {/* Results View */}
                {auditResult && !auditResult.reportText.startsWith("ERROR CRÍTICO GATE 0") && (
                    <div id="m10-audit-results" className="animate-in fade-in slide-in-from-bottom-8 duration-700 space-y-8">

                        {/* Toolbar Actions */}
                        <div className="flex justify-end gap-3 no-print">
                            <button
                                onClick={handleDownloadJSON}
                                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-50 hover:text-indigo-600 transition-colors shadow-sm"
                            >
                                <FileJson size={16} />
                                JSON Completo
                            </button>
                            <button
                                onClick={handleDownloadPDF}
                                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 border border-indigo-600 rounded-lg text-white text-sm font-bold hover:bg-indigo-700 transition-colors shadow-sm shadow-indigo-200"
                            >
                                <Download size={16} />
                                Descargar PDF
                            </button>
                            <button onClick={handleNewAudit} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-slate-600 text-sm font-bold hover:bg-red-50 hover:text-red-600 transition-colors shadow-sm">
                                Nueva Auditoría
                            </button>
                        </div>

                        {/* Phase 0: Context Header (New Metadata Integration) */}
                        {auditResult.metadata && (
                            <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-6 text-white shadow-lg border border-slate-700 relative overflow-hidden">
                                {/* NEW: Triple Cruce Badge */}
                                <div className="absolute -top-1 -right-1 bg-indigo-600 px-4 py-1.5 rounded-bl-xl flex items-center gap-2 shadow-lg z-10">
                                    <Sparkles size={14} className="text-white" />
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-white">Triple Cruce Verificado</span>
                                </div>

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 relative z-10">
                                    <div>
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Paciente</div>
                                        <div className="font-bold text-lg truncate">{auditResult.metadata.patientName}</div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Prestador</div>
                                        <div className="font-bold text-lg truncate">{auditResult.metadata.clinicName}</div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Financiamiento</div>
                                        <div className="font-bold text-lg truncate">{auditResult.metadata.isapre}</div>
                                        <div className="text-xs text-slate-400">{auditResult.metadata.plan}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Corte Financiero</div>
                                        <div className="font-bold text-lg">{auditResult.metadata.financialDate}</div>
                                        {auditResult.metadata.executionTimestamp && (
                                            <div className="mt-2 text-right">
                                                <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">AUDITORIA REALIZADA</div>
                                                <div className="text-xl font-bold text-white font-mono leading-none">
                                                    {new Date(auditResult.metadata.executionTimestamp).toLocaleString()}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Summary Metrics */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Evento Inferido</div>
                                <div className="text-xl font-black text-slate-900 truncate">{auditResult.eventModel.actoPrincipal}</div>
                                <div className="text-xs text-slate-500 mt-1">{auditResult.eventModel.paquetesDetectados.join(', ') || 'Sin paquetes'}</div>
                            </div>
                            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Copago Analizado</div>
                                <div className="text-2xl font-black text-slate-900">${auditResult.summary.totalCopagoAnalizado.toLocaleString()}</div>
                            </div>
                            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Impacto Fragmentación</div>
                                <div className="text-2xl font-black text-rose-600">${auditResult.summary.totalImpactoFragmentacion.toLocaleString()}</div>
                                {auditResult.summary.patternSystemic.isSystemic && <div className="text-xs font-bold text-rose-500 mt-1 uppercase">Patrón Sistémico Detectado</div>}
                            </div>
                            <div className={`p-6 rounded-2xl border shadow-sm ${auditResult.summary.opacidadGlobal.applies ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200'}`}>
                                <div className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${auditResult.summary.opacidadGlobal.applies ? 'text-rose-500' : 'text-emerald-600'}`}>Opacidad Liquidatoria</div>
                                <div className={`text-2xl font-black ${auditResult.summary.opacidadGlobal.applies ? 'text-rose-700' : 'text-emerald-700'}`}>
                                    {auditResult.summary.opacidadGlobal.applies ? 'DETECTADA' : 'NORMAL'}
                                </div>
                                {auditResult.summary.opacidadGlobal.applies && (
                                    <div className="text-xs text-rose-600 mt-1 font-bold">Max IOP: {auditResult.summary.opacidadGlobal.maxIOP} / 100</div>
                                )}
                            </div>
                        </div>

                        {/* Findings Matrix */}
                        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                                    <Layers className="text-indigo-600" size={20} />
                                    Matriz de Hallazgos (Maestro v1.4)
                                </h3>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                                        <tr>
                                            <th className="px-8 py-4">Item Evaluado</th>
                                            <th className="px-8 py-4">Clasificación</th>
                                            <th className="px-8 py-4">Motor</th>
                                            <th className="px-8 py-4">Fundamento Técnico & IOP</th>
                                            <th className="px-8 py-4 text-right">Impacto ($)</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {auditResult.matrix.length === 0 ? (
                                            <tr><td colSpan={5} className="px-8 py-12 text-center text-slate-400 italic">No se detectaron irregularidades estructurales.</td></tr>
                                        ) : (
                                            auditResult.matrix.map((row, idx) => (
                                                <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                                                    <td className="px-8 py-4 font-medium text-slate-900">{row.itemLabel}</td>
                                                    <td className="px-8 py-4">
                                                        <span className={`inline-flex px-2 py-1 rounded text-[10px] font-bold uppercase ${row.classification === 'CORRECTO' ? 'bg-emerald-100 text-emerald-700' :
                                                            row.classification === 'FRAGMENTACION_ESTRUCTURAL' ? 'bg-rose-100 text-rose-700' :
                                                                row.classification === 'INFRA_BONIFICACION' ? 'bg-orange-100 text-orange-700' :
                                                                    row.classification === 'DISCUSION_TECNICA' ? 'bg-blue-100 text-blue-700' :
                                                                        'bg-amber-100 text-amber-700'
                                                            }`}>{row.classification.replace(/_/g, ' ')}</span>
                                                    </td>
                                                    <td className="px-8 py-4 font-mono text-xs font-bold text-slate-500">{row.motor}</td>
                                                    <td className="px-8 py-4 text-slate-600 max-w-md whitespace-pre-wrap">
                                                        <div>{row.fundamento.split('[OPACIDAD')[0]}</div>
                                                        {row.iop && row.iop >= 40 && (
                                                            <div className="mt-1 flex items-center gap-1 text-[10px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full w-fit border border-rose-100">
                                                                <AlertCircle size={10} /> OPACIDAD IOP: {row.iop}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-8 py-4 text-right font-mono font-bold text-slate-900">${row.impacto.toLocaleString()}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* === NEW: Forensic Evidence Breakdown (Desglose Forense) === */}
                        {auditResult.pamRows && auditResult.pamRows.length > 0 && (
                            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                                <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                                    <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                                        <CheckCircle2 className="text-emerald-600" size={20} />
                                        Desglose Forense por Línea PAM
                                    </h3>
                                    <span className="text-xs text-slate-400 font-medium">Reconstrucción matemática exacta (Δ=$0)</span>
                                </div>
                                <div className="divide-y divide-slate-100">
                                    {auditResult.pamRows.map((row: any, idx: number) => {
                                        const isOk = row.trace.status === 'OK';
                                        const isPartial = row.trace.status === 'PARTIAL';
                                        const method = row.trace.attempts?.find((a: any) => a.status === 'OK')?.step || row.trace.attempts?.[0]?.step || 'N/A';
                                        const matchedItems: any[] = row.trace.attempts
                                            ?.flatMap((a: any) => a.candidates?.[0]?.items || [])
                                            ?.filter((v: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.id === v.id) === i)
                                            || [];
                                        const itemSum = matchedItems.reduce((s: number, i: any) => s + (i.total || 0), 0);
                                        const delta = Math.round(row.montoCopago) - Math.round(itemSum);

                                        return (
                                            <details key={idx} className="group" open={isOk || isPartial}>
                                                <summary className="flex items-center justify-between px-8 py-4 cursor-pointer hover:bg-slate-50 transition-colors list-none">
                                                    <div className="flex items-center gap-4">
                                                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isOk ? 'bg-emerald-500' : isPartial ? 'bg-amber-500' : 'bg-rose-500'}`} />
                                                        <div>
                                                            <div className="font-bold text-slate-900 text-sm">{row.codigoGC}</div>
                                                            <div className="text-xs text-slate-500 truncate max-w-xs">{row.descripcion}</div>
                                                        </div>
                                                        <span className={`ml-2 inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isOk ? 'bg-emerald-100 text-emerald-700' :
                                                            isPartial ? 'bg-amber-100 text-amber-700' :
                                                                'bg-rose-100 text-rose-700'
                                                            }`}>{row.trace.status}</span>
                                                        <span className="ml-1 inline-flex px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-100">
                                                            {method}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-6 text-right flex-shrink-0">
                                                        <div>
                                                            <div className="text-[10px] font-bold text-slate-400 uppercase">Objetivo PAM</div>
                                                            <div className="text-sm font-mono font-bold text-slate-900">${(row.montoCopago + row.bonificacion).toLocaleString()}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-[10px] font-bold text-slate-400 uppercase">Δ Diferencia</div>
                                                            <div className={`text-sm font-mono font-bold ${delta === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                                {delta === 0 ? '$0 ✅' : `$${delta.toLocaleString()}`}
                                                            </div>
                                                        </div>
                                                        <div className="text-slate-300 group-open:rotate-180 transition-transform text-lg">▼</div>
                                                    </div>
                                                </summary>

                                                {/* Expanded: Item breakdown */}
                                                <div className="px-8 pb-6 pt-2 bg-slate-50/30">
                                                    {matchedItems.length > 0 ? (
                                                        <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                                                            <table className="w-full text-xs">
                                                                <thead className="bg-slate-100 text-[10px] uppercase font-bold text-slate-500">
                                                                    <tr>
                                                                        <th className="px-4 py-2 text-left">#</th>
                                                                        <th className="px-4 py-2 text-left">Descripción del Ítem (Cuenta Clínica)</th>
                                                                        <th className="px-4 py-2 text-left">Sección</th>
                                                                        <th className="px-4 py-2 text-right">Total</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-slate-100">
                                                                    {matchedItems.map((item: any, iIdx: number) => (
                                                                        <tr key={iIdx} className="hover:bg-indigo-50/30 transition-colors">
                                                                            <td className="px-4 py-2 text-slate-400 font-mono">{String(iIdx + 1).padStart(2, '0')}</td>
                                                                            <td className="px-4 py-2 font-medium text-slate-800">{item.description}</td>
                                                                            <td className="px-4 py-2 text-slate-500">
                                                                                <span className="px-2 py-0.5 bg-slate-100 rounded text-[10px] font-mono">
                                                                                    {item.section || 'N/A'}
                                                                                </span>
                                                                            </td>
                                                                            <td className="px-4 py-2 text-right font-mono font-bold text-slate-900">
                                                                                ${(item.total || 0).toLocaleString()}
                                                                            </td>
                                                                        </tr>
                                                                    ))}
                                                                    {/* Running total row */}
                                                                    <tr className={`font-bold border-t-2 ${delta === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                                                                        <td colSpan={3} className={`px-4 py-3 text-xs uppercase tracking-wider ${delta === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                                                                            SUMA TOTAL → {matchedItems.length} ítem{matchedItems.length !== 1 ? 's' : ''}
                                                                            {delta === 0 && ' · CUADRATURA EXACTA ✅'}
                                                                        </td>
                                                                        <td className={`px-4 py-3 text-right font-mono text-sm ${delta === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                                                                            ${Math.round(itemSum).toLocaleString()}
                                                                        </td>
                                                                    </tr>
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    ) : (
                                                        <div className="text-slate-400 text-xs italic py-4 text-center">
                                                            {row.trace.status === 'FAIL' ? 'No se encontraron ítems que cuadren este monto.' : 'Desglose no disponible para este método de calce.'}
                                                        </div>
                                                    )}

                                                    {/* Classification badge */}
                                                    <div className="mt-3 flex items-center gap-2 text-xs">
                                                        <span className={`px-2 py-1 rounded font-bold uppercase ${row.fragmentacion.motor === 'M2' ? 'bg-purple-100 text-purple-700' :
                                                            row.fragmentacion.motor === 'M3' ? 'bg-rose-100 text-rose-700' :
                                                                row.fragmentacion.motor === 'M1' ? 'bg-blue-100 text-blue-700' :
                                                                    'bg-slate-100 text-slate-600'
                                                            }`}>{row.fragmentacion.motor || 'N/A'}</span>
                                                        <span className="text-slate-500 flex-1 truncate">{row.fragmentacion.rationale}</span>
                                                        {row.opacidad.applies && (
                                                            <span className="flex items-center gap-1 text-rose-600 font-bold bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
                                                                <AlertCircle size={10} /> IOP: {row.opacidad.iopScore}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </details>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Report & Complaint Tabs */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col h-[500px]">
                                <div className="flex items-center gap-2 mb-4">
                                    <FileText className="text-slate-400" size={18} />
                                    <h4 className="font-bold text-slate-900 text-sm uppercase tracking-wide">Informe Forense Estructurado</h4>
                                </div>
                                <div className="bg-slate-50 rounded-xl p-4 font-mono text-xs text-slate-700 whitespace-pre-wrap flex-grow overflow-y-auto border border-slate-100">
                                    {auditResult.reportText}
                                </div>
                            </div>

                            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col h-[500px]">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <AlertCircle className="text-rose-500" size={18} />
                                        <h4 className="font-bold text-slate-900 text-sm uppercase tracking-wide">Texto de Reclamo (Automático)</h4>
                                    </div>
                                    <button onClick={copyComplaint} className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 border border-indigo-100 rounded-lg text-indigo-600 text-xs font-bold hover:bg-indigo-100 transition-colors">
                                        {copied ? <Check size={14} /> : <Copy size={14} />}
                                        {copied ? 'COPIADO' : 'COPIAR TEXTO'}
                                    </button>
                                </div>
                                <div className="bg-slate-50 rounded-xl p-4 font-mono text-xs text-slate-700 whitespace-pre-wrap flex-grow overflow-y-auto border border-slate-100">
                                    {auditResult.complaintText || "No hay hallazgos que generen reclamo."}
                                </div>
                            </div>
                        </div>
                        {/* Chat Box Integration */}
                        <div className="mt-8 no-print">
                            <ChatBox
                                contextData={{
                                    result: auditResult,
                                    contract: adaptedInputRef.current?.contract,
                                    rawContract: getStoredContractSource().data,
                                    pam: adaptedInputRef.current?.pam || JSON.parse(localStorage.getItem('pam_audit_result') || '{}'),
                                    bill: adaptedInputRef.current?.bill || JSON.parse(localStorage.getItem('clinic_audit_result') || '{}')
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------- UF VALUE RESOLVER (M5) ----------

const UF_CACHE_KEY = 'm11_uf_cache'; // localStorage key

interface UFResolveResult {
    valueCLP: number;
    date: string;       // ISO date
    source: string;     // "mindicador.cl" | "cache" | "fallback"
}

/**
 * Resolve current UF value from mindicador.cl API.
 * Uses localStorage cache with 24h TTL.
 * Returns null if API is unreachable (engine will use TOPE_NO_VERIFICABLE).
 */
async function resolveUFValueCLP(): Promise<UFResolveResult | null> {
    const today = new Date().toISOString().split('T')[0]; // "2026-02-21"

    // 1. Check localStorage cache (24h TTL)
    try {
        const cached = localStorage.getItem(UF_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.date === today && parsed.valueCLP > 0) {
                return { ...parsed, source: 'cache (mindicador.cl)' };
            }
        }
    } catch { /* cache miss */ }

    // 2. Fetch from mindicador.cl API (free, no key required, official BCCh data)
    try {
        const response = await fetch('https://mindicador.cl/api/uf', {
            signal: AbortSignal.timeout(5000) // 5s timeout
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const serie = data.serie;

        if (Array.isArray(serie) && serie.length > 0) {
            const latest = serie[0]; // Most recent value
            const result: UFResolveResult = {
                valueCLP: latest.valor,
                date: latest.fecha.split('T')[0],
                source: 'mindicador.cl (BCCh)'
            };

            // Cache for today
            localStorage.setItem(UF_CACHE_KEY, JSON.stringify(result));
            return result;
        }
    } catch (err) {
        console.warn('[M11 UF] API fetch failed:', err);
    }

    // 3. Fallback: return null → engine uses UF_FALLBACK_CLP and marks TOPE_NO_VERIFICABLE
    return null;
}

// ---------- ADAPTER LOGIC ----------

function adaptToM11Input(rawContract: any, rawPam: any, rawBill: any): SkillInput {
    // console.log("Adapting M10 Input...", { contractKeys: Object.keys(rawContract), pamKeys: Object.keys(rawPam), billKeys: Object.keys(rawBill) });

    // 1. Adapt CONTRACT
    let rules: CanonicalContractRule[] = [];
    let sourceArray: any[] = [];
    let contractSource = rawContract;

    // Unwrap if wrapped in { content: "..." } or { data: ... }
    if (rawContract.content && typeof rawContract.content === 'string') {
        try { contractSource = JSON.parse(rawContract.content); } catch { }
    } else if (rawContract.data) {
        contractSource = rawContract.data;
    }

    // Fallback: If canonical_contract_result is empty, try legacy contract_audit_result
    if (!contractSource || Object.keys(contractSource).length === 0) {
        try {
            const legacy = localStorage.getItem('contract_audit_result');
            if (legacy) contractSource = JSON.parse(legacy);
        } catch (e) { console.error("Error reading legacy contract", e); }
    }

    // Try to find the array of rules/coverages
    // v2.3: Combine multiple possible sources within the canonical JSON

    const parsePct = (raw: any): number | null => {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (raw && typeof raw === 'object' && typeof raw.valor === 'number' && Number.isFinite(raw.valor)) return raw.valor;
        if (typeof raw === 'string') {
            const n = Number(raw.replace(/[^\d.,-]/g, '').replace(',', '.'));
            return Number.isFinite(n) ? n : null;
        }
        return null;
    };

    const toM12Tope = (raw: any) => {
        if (!raw) return { estado: 'UNKNOWN', valor: null, unidad: 'UNKNOWN' };
        if (typeof raw === 'string') {
            const token = raw.toUpperCase();
            if (token.includes('SIN_TOPE')) return { estado: 'SIN_TOPE_ITEM', valor: null, unidad: 'SIN_TOPE' };
            return { estado: 'UNKNOWN', valor: null, unidad: 'UNKNOWN' };
        }
        const estado = String(raw.estado || ((raw.valor ?? null) === null ? 'UNKNOWN' : 'CON_TOPE'));
        const unidad = String(raw.unidad || 'UNKNOWN');
        const valor = typeof raw.valor === 'number' && Number.isFinite(raw.valor) ? raw.valor : null;
        return { estado, valor, unidad };
    };

    const mapM12SectionToAmbito = (sectionName: string) => {
        const s = normalizeStr(sectionName).toUpperCase();
        if (s.includes('HOSPITALARIAS')) return 'HOSPITALARIO';
        if (s.includes('AMBULATORIAS')) return 'AMBULATORIO';
        if (s.includes('URGENCIA')) return 'URGENCIA';
        return 'OTROS';
    };

    // M12 structured output: sections -> items -> rules
    const isM12Structured = Array.isArray(contractSource.sections)
        && contractSource.sections.length > 0
        && Array.isArray(contractSource.sections[0]?.items)
        && Array.isArray(contractSource.sections[0]?.items?.[0]?.rules);

    if (isM12Structured) {
        console.log(`[M11 ADAPTER] Detected M12 structured format with ${contractSource.sections.length} sections.`);
        sourceArray = contractSource.sections.flatMap((section: any) =>
            (section.items || []).flatMap((it: any) =>
                (it.rules || []).map((r: any, idx: number) => ({
                    id: `${it.item || 'ITEM'}_${String(r.modality || '').toLowerCase()}_${idx}`,
                    item: it.item,
                    ambito: it.ambito || section.section || 'OTROS',
                    porcentaje: r.porcentaje,
                    tope_evento_obj: r.tope_evento,
                    tope_anual_obj: r.tope_anual,
                    copago_fijo: r.copago_fijo,
                    tipo_modalidad: String(r.modality || '').toUpperCase().includes('LIBRE') ? 'libre_eleccion' : 'preferente',
                    subred_id: r.subred_id,
                    condiciones: r.condiciones || [],
                    categoria: it.ambito || section.section || 'OTROS',
                    clinicas: r.clinicas || [],
                    descripcion_textual: it.item,
                    _isM12: true
                }))
            )
        );
    }

    // M12 visual output: oferta_preferente/libre_eleccion (+ optional page3_sections)
    if (
        sourceArray.length === 0 &&
        (contractSource.page3_sections || contractSource.oferta_preferente || contractSource.libre_eleccion)
    ) {
        console.log('[M11 ADAPTER] Detected M12 visual grid format.');
        const visualSections: any[] = [];
        if (contractSource.page3_sections) {
            const p3 = contractSource.page3_sections;
            if (p3.hospitalarias) visualSections.push({ key: 'HOSPITALARIAS', data: p3.hospitalarias });
            if (p3.ambulatorias) visualSections.push({ key: 'AMBULATORIAS', data: p3.ambulatorias });
            if (p3.atenciones_urgencia) visualSections.push({ key: 'ATENCIONES_DE_URGENCIA', data: p3.atenciones_urgencia });
            if (p3.prestaciones_restringidas) visualSections.push({ key: 'PRESTACIONES_RESTRINGIDAS', data: p3.prestaciones_restringidas });
            if (p3.otras_prestaciones) visualSections.push({ key: 'OTRAS_PRESTACIONES', data: p3.otras_prestaciones });
        } else {
            visualSections.push({ key: contractSource.section || 'HOSPITALARIAS', data: contractSource });
        }

        for (const sec of visualSections) {
            const secData = sec.data || {};
            const ambito = mapM12SectionToAmbito(sec.key || secData.section || '');
            const oferta = secData.oferta_preferente || {};
            const libre = secData.libre_eleccion || {};
            const itemNames = Array.from(new Set([...Object.keys(oferta), ...Object.keys(libre)]));

            for (const itemName of itemNames) {
                const prefRules = Array.isArray(oferta[itemName]) ? oferta[itemName] : [];
                for (let i = 0; i < prefRules.length; i++) {
                    const r = prefRules[i] || {};
                    sourceArray.push({
                        id: `${itemName}_pref_${i}`,
                        item: itemName,
                        ambito,
                        porcentaje: parsePct(r.bonificacion_pct),
                        tope_evento_obj: toM12Tope(r.tope_evento),
                        tope_anual_obj: toM12Tope('SIN_TOPE_ITEM'),
                        tipo_modalidad: 'preferente',
                        subred_id: r.subred_id || 'PREF_TIER_1',
                        condiciones: r.restricciones || r.condiciones || [],
                        categoria: ambito,
                        clinicas: r.clinicas || r.prestadores || [],
                        descripcion_textual: itemName,
                        _isM12: true
                    });
                }

                const le = libre[itemName];
                if (le) {
                    sourceArray.push({
                        id: `${itemName}_libre_0`,
                        item: itemName,
                        ambito,
                        porcentaje: parsePct(le.bonificacion_pct),
                        tope_evento_obj: toM12Tope(le.tope_evento),
                        tope_anual_obj: toM12Tope(le.tope_anual),
                        tipo_modalidad: 'libre_eleccion',
                        subred_id: 'LIBRE_ELECCION',
                        condiciones: [],
                        categoria: ambito,
                        clinicas: [],
                        descripcion_textual: itemName,
                        _isM12: true
                    });
                }
            }
        }
    }

    // v2.4: DETECT AUDITOR B FORMAT NATIVELY
    // AuditorB produces: { items: [{ ambito, item, preferente: { rules: [...] }, libre_eleccion: { rules: [...] } }] }
    const isAuditorB = contractSource.items && Array.isArray(contractSource.items)
        && contractSource.items.length > 0
        && contractSource.items[0]?.preferente?.rules !== undefined;

    if (sourceArray.length === 0 && isAuditorB) {
        console.log(`[M11 ADAPTER] 🔍 Detected AuditorB format with ${contractSource.items.length} items.`);
        sourceArray = contractSource.items.flatMap((bItem: any) => {
            const results: any[] = [];
            // Preferente rules
            (bItem.preferente?.rules || []).forEach((r: any, idx: number) => {
                results.push({
                    id: `${bItem.item}_pref_${idx}`,
                    item: bItem.item,
                    ambito: bItem.ambito,
                    porcentaje: r.porcentaje,
                    tope_evento_obj: r.tope_evento, // Pass structured object directly
                    tope_anual_obj: r.tope_anual,
                    copago_fijo: r.copago_fijo,
                    tipo_modalidad: 'preferente',
                    subred_id: r.subred_id,       // v1.3
                    condiciones: r.condiciones,   // v1.3
                    categoria: bItem.ambito,
                    clinicas: r.clinicas || [],
                    descripcion_textual: bItem.item,
                    _isAuditorB: true
                });
            });
            // Libre Elección rules
            (bItem.libre_eleccion?.rules || []).forEach((r: any, idx: number) => {
                results.push({
                    id: `${bItem.item}_libre_${idx}`,
                    item: bItem.item,
                    ambito: bItem.ambito,
                    porcentaje: r.porcentaje,
                    tope_evento_obj: r.tope_evento,
                    tope_anual_obj: r.tope_anual,
                    copago_fijo: r.copago_fijo,
                    tipo_modalidad: 'libre_eleccion',
                    subred_id: r.subred_id,       // v1.3
                    condiciones: r.condiciones,   // v1.3
                    categoria: bItem.ambito,
                    clinicas: r.clinicas || [],
                    descripcion_textual: bItem.item,
                    _isAuditorB: true
                });
            });
            return results;
        });
    } else if (sourceArray.length === 0 && Array.isArray(contractSource)) {
        sourceArray = contractSource;
    } else if (sourceArray.length === 0 && contractSource.rules && Array.isArray(contractSource.rules)) {
        sourceArray = contractSource.rules;
    } else if (sourceArray.length === 0) {
        // Collect from all standard canonical buckets
        if (contractSource.coberturas && Array.isArray(contractSource.coberturas)) {
            sourceArray = [...sourceArray, ...contractSource.coberturas];
        }
        if (contractSource.topes && Array.isArray(contractSource.topes)) {
            // Map topes to rules for conceptually broader coverage
            const topeRules = contractSource.topes.map((t: any) => ({
                ...t,
                item: t.item || t.descripcion_textual || "Tope",
                categoria: t.categoria || t.ambito || "TOPE"
            }));
            sourceArray = [...sourceArray, ...topeRules];
        }
        if (contractSource.reglas_aplicacion && Array.isArray(contractSource.reglas_aplicacion)) {
            const extraRules = contractSource.reglas_aplicacion.map((r: any) => ({
                item: r.condicion || "Regla",
                descripcion_textual: r.efecto,
                categoria: "REGLA_GENERAL"
            }));
            sourceArray = [...sourceArray, ...extraRules];
        }
        if (contractSource.data && Array.isArray(contractSource.data.coberturas)) {
            sourceArray = [...sourceArray, ...contractSource.data.coberturas];
        }
    }

    // Final Fallback: Mental Model (Recursive)
    if (sourceArray.length === 0 && contractSource.root && contractSource.root.children) {
        const traverse = (nodes: any[]): any[] => {
            let found: any[] = [];
            for (const node of nodes) {
                // More lenient criteria for mental model nodes
                const hasCobertura = node.cobertura && (node.cobertura.includes('%') || !isNaN(parseInt(node.cobertura)));
                const hasTopes = node.detalle && (node.detalle.includes('UF') || node.detalle.includes('UTM') || node.detalle.includes('$'));

                if (hasCobertura || hasTopes) {
                    found.push({
                        item: node.titulo,
                        descripcion_textual: node.titulo + " " + (node.detalle || ""),
                        porcentaje: parseInt(node.cobertura?.replace('%', '')) || 100,
                        tope: node.detalle,
                        categoria: node.categoria || 'UNKNOWN'
                    });
                }
                if (node.children) found = found.concat(traverse(node.children));
            }
            return found;
        };
        sourceArray = traverse(contractSource.root.children);
    }

    rules = sourceArray.map((c: any) => {
        // v2.4: AuditorB items have a direct ambito field → use mapAmbitoToDomain
        let domain: ContractDomain;
        if ((c._isAuditorB || c._isM12) && c.ambito) {
            domain = mapAmbitoToDomain(c.ambito);
        } else {
            // Legacy: Use ALL available text fields for domain detection
            const catText = [
                c.categoria, c.seccion, c.ambito, c.item,
                c.descripcion_textual, c.fuente_textual,
                c.red_especifica, c.tipo_modalidad
            ].filter(Boolean).join(' ');
            domain = mapCategoryToDomain(catText);
        }

        // Parse tope value: structured objects (AuditorB) or string parsing (legacy)
        let parsedTope: { kind: "UF" | "UTM" | "CLP" | "VAM" | "AC2" | "SIN_TOPE_EXPRESO" | "VARIABLE"; value: number | null };

        if ((c._isAuditorB || c._isM12) && c.tope_evento_obj) {
            // Direct structured tope from AuditorB (v1.3)
            const te = c.tope_evento_obj;
            const kindMap: Record<string, typeof parsedTope.kind> = {
                'UF': 'UF', 'UTM': 'UTM', 'VA': 'VAM', 'VAM': 'VAM', 'AC2': 'AC2',
                'SIN_TOPE': 'SIN_TOPE_EXPRESO', 'SIN_TOPE_ITEM': 'SIN_TOPE_EXPRESO',
                'UNKNOWN': 'VARIABLE', 'CLP': 'CLP', 'PESOS': 'CLP'
            };

            // v1.3: if estado is SIN_TOPE_ITEM, force the kind
            let kind: typeof parsedTope.kind = kindMap[te.unidad] || 'VARIABLE';
            if (te.estado === 'SIN_TOPE_ITEM') kind = 'SIN_TOPE_EXPRESO';

            parsedTope = { kind, value: te.valor ?? null };
        } else {
            let topeStr = c.tope || (c.modalidades?.[0]?.tope) || '';
            parsedTope = parseTopeValue(topeStr);

            // If canonical tope object fields exist (from topes[] bucket), use them directly
            if (c.unidad && c.unidad !== 'DESCONOCIDO') {
                const kindMap: Record<string, typeof parsedTope.kind> = {
                    'UF': 'UF', 'UTM': 'UTM', 'VAM': 'VAM', 'AC2': 'AC2', 'PESOS': 'CLP'
                };
                parsedTope = { kind: kindMap[c.unidad] || 'VARIABLE', value: c.valor ?? null };
            }
        }

        const modalidad = c.tipo_modalidad || (c.modalidades?.[0]?.tipo ? (String(c.modalidades?.[0]?.tipo).toLowerCase().includes('pref') ? 'preferente' : 'libre_eleccion') : 'desconocido');

        // Build textLiteral with clinic names and conditions for transparency
        const clinicStr = (c.clinicas && c.clinicas.length > 0) ? ` [${c.clinicas.join(', ')}]` : '';
        const condStr = (c.condiciones && c.condiciones.length > 0) ? ` (${c.condiciones.join(', ')})` : '';

        return {
            id: c.id || c.item || 'rule_' + Math.random().toString(36).substr(2, 9),
            domain,
            modalidad,
            subredId: c.subred_id, // v1.3
            condiciones: c.condiciones, // v1.3
            clinicas: c.clinicas, // v1.3
            coberturaPct: c.porcentaje || (c.modalidades?.[0]?.porcentaje) || null,
            tope: {
                kind: parsedTope.kind,
                value: parsedTope.value,
                currency: (c._isAuditorB || c._isM12) ? `${parsedTope.value ?? ''} ${parsedTope.kind}` : (c.tope || undefined),
            },
            textLiteral: `${c.item || ''} ${c.descripcion_textual || ''}${clinicStr}${condStr}`.trim()
        };
    });

    // Deduplicate: keep best rule per domain AND modality
    const domainBest = new Map<string, CanonicalContractRule>();
    for (const rule of rules) {
        const key = `${rule.domain}_${(rule as any).modalidad || 'preferente'}`;
        const existing = domainBest.get(key);
        if (!existing) {
            domainBest.set(key, rule);
        } else {
            // Prefer rule with higher coverage or with a tope value
            const existingPct = existing.coberturaPct ?? 0;
            const newPct = rule.coberturaPct ?? 0;
            const existingHasTope = existing.tope?.value !== null && existing.tope?.value !== undefined;
            const newHasTope = rule.tope?.value !== null && rule.tope?.value !== undefined;
            const existingIsSinTope = existing.tope?.kind === 'SIN_TOPE_EXPRESO';
            const newIsSinTope = rule.tope?.kind === 'SIN_TOPE_EXPRESO';

            // If new rule has EXACTLY a tope (but no percentage) and existing has a percentage (but no solid tope), merge them!
            if (rule.coberturaPct === null && existing.coberturaPct !== null && (newHasTope || newIsSinTope) && !(existingHasTope || existingIsSinTope)) {
                existing.tope = rule.tope;
            }
            // Otherwise, standard replacement logic
            else if ((newHasTope || newIsSinTope) && !(existingHasTope || existingIsSinTope)) {
                domainBest.set(key, rule);
            } else if (newPct > existingPct && !(existingHasTope || existingIsSinTope)) {
                domainBest.set(key, rule);
            }
        }
    }
    const deduplicatedRules = Array.from(domainBest.values());

    console.log(`[M11 ADAPTER] Contract source: ${sourceArray.length} entries → ${rules.length} raw rules → ${deduplicatedRules.length} unique domain rules.`);
    console.log(`[M11 ADAPTER] Domains: ${deduplicatedRules.map(r => `${r.domain}(${r.coberturaPct}%)`).join(', ')}`);

    rules = deduplicatedRules;

    // 2. Adapt PAM
    let pamFolios: any[] = [];
    let pamSource = rawPam;

    // Unwrap if wrapped in { content: "..." } or { data: ... }
    if (rawPam.content && typeof rawPam.content === 'string') {
        try { pamSource = JSON.parse(rawPam.content); } catch { }
    } else if (rawPam.data) {
        pamSource = rawPam.data;
    }

    if (pamSource.folios && Array.isArray(pamSource.folios)) {
        // Handle nested DesglosePorPrestador (Real PAM App structure)
        pamFolios = pamSource.folios.map((f: any) => {
            let items = f.items || [];
            if (f.desglosePorPrestador && Array.isArray(f.desglosePorPrestador)) {
                // Flatten items from all providers in this folio
                const nestedItems = f.desglosePorPrestador.flatMap((p: any) => p.items || []);
                items = [...items, ...nestedItems];
            }
            return { ...f, items };
        });
    } else if (Array.isArray(pamSource)) {
        // If it's a flat array of lines, wrap it in a dummy folio
        pamFolios = [{ folioPAM: 'UNKNOWN_FOLIO', items: pamSource }];
    }

    // 3. Adapt BILL (Cuenta)
    let billItems: any[] = [];
    let billSource = rawBill;

    // Unwrap if wrapped (AccountProjectorV7 saves { content: string, ... })
    if (rawBill.content) {
        if (typeof rawBill.content === 'string') {
            if (rawBill.content.trim().startsWith('<')) {
                console.warn("Account content appears to be HTML. M10 requires JSON.");
                // Attempt to continue, but likely empty items
            } else {
                try {
                    billSource = JSON.parse(rawBill.content);
                } catch (e) {
                    console.error("Failed to parse Bill content JSON", e);
                }
            }
        } else {
            billSource = rawBill.content;
        }
    } else if (rawBill.data) {
        billSource = rawBill.data;
    }

    if (billSource.items && Array.isArray(billSource.items)) {
        billItems = billSource.items;
    } else if (Array.isArray(billSource)) {
        billItems = billSource;
    } else if (billSource.rows && Array.isArray(billSource.rows)) {
        // Some CSV parsers output 'rows'
        billItems = billSource.rows;
    } else if (billSource.sections && Array.isArray(billSource.sections)) {
        billItems = billSource.sections.flatMap((s: any) =>
            (s.items || []).map((item: any) => ({ ...item, section: s.name || s.section || s.titulo || '' }))
        );
    }

    // Ensure PAM items have numeric values
    pamFolios = pamFolios.map((folio: any) => ({
        ...folio,
        folioPAM: folio.folioPAM || folio.folio || 'UNKNOWN',
        items: (folio.items || []).map((item: any) => ({
            ...item,
            codigoGC: item.codigoGC || item.codigo || item.code || 'UNKNOWN',
            descripcion: item.descripcion || item.glosa || item.description || '',
            valorTotal: Number(item.valorTotal || item.montoTotal || 0),
            bonificacion: Number(item.bonificacion || 0),
            copago: Number(item.copago || item.copago_calculado || 0)
        }))
    }));

    billItems = billItems.map((item: any, idx: number) => ({
        // STRICT MAPPING: DO NOT SPREAD ...item (Removes useless vectors/embeddings/raw text)
        id: item.id || item.codigo || item.codeInternal || `bill_${idx}`,
        section: item.section || item.seccion || item.categoria || item.Category || '',
        sectionPath: item.originalSection ? [item.originalSection] : (item.section ? [item.section] : (item.seccion ? [item.seccion] : [])),
        sectionKey: item.originalSection ? `SEC_${item.originalSection.replace(/\s+/g, '_').toUpperCase()}` : undefined,
        description: item.description || item.glosa || item.descripcion || item.Item || '',
        total: Number(item.total || item.valor || item.monto || item.Total || 0),
        unitPrice: Number(item.unitPrice || item.precioUnitario || item.Precio || 0),
        qty: Number(item.qty || item.cantidad || item.Cantidad || 1),
        originalIndex: item.originalIndex ?? idx // Persist original index for physical sort
    }));

    // 4. Extract Metadata
    const metadata = {
        patientName: billSource.patientName || rawBill.patientName || billSource.paciente?.nombre || 'Paciente Desconocido',
        clinicName: billSource.clinicName || rawBill.clinicName || billSource.prestador?.nombre || 'Clínica Desconocida',
        isapre: contractSource.diseno_ux?.nombre_isapre || contractSource.metadata?.fuente || billSource.isapre || 'Isapre Desconocida',
        plan: contractSource.diseno_ux?.titulo_plan || contractSource.metadata?.fuente || billSource.plan || 'Plan Desconocido',
        financialDate: billSource.date || rawBill.date || billSource.fecha || new Date().toLocaleDateString()
    };

    // console.log(`Adapter Result: Rules=${rules.length}, Folios=${pamFolios.length}, BillItems=${billItems.length}`);

    return {
        contract: { rules },
        pam: { folios: pamFolios },
        bill: { items: billItems },
        metadata
    };
}

/** Normalize a string: lowercase, remove accents, remove non-alphanumeric */
function normalizeStr(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip accent marks
        .replace(/[^a-z0-9 ]/g, ' ')      // remove punctuation
        .replace(/\s+/g, ' ')             // collapse spaces
        .trim();
}

/**
 * v2.4: Direct mapping from AuditorB expanded ambito enum to ContractDomain.
 * No regex needed — uses the structured classification from the LLM prompt.
 */
function mapAmbitoToDomain(ambito: string): ContractDomain {
    const map: Record<string, ContractDomain> = {
        'DIA_CAMA': 'HOSPITALIZACION',
        'HOSPITALARIO': 'HOSPITALIZACION',
        'PABELLON': 'PABELLON',
        'HONORARIOS': 'HONORARIOS',
        'MEDICAMENTOS': 'MEDICAMENTOS_HOSP',
        'MATERIALES': 'MATERIALES_CLINICOS',
        'EXAMENES': 'EXAMENES',
        'PROTESIS': 'PROTESIS_ORTESIS',
        'QUIMIOTERAPIA': 'MEDICAMENTOS_HOSP', // Chemo is a subset of medications for M11
        'URGENCIA': 'OTROS', // Urgencia not a separate M11 domain; map to OTROS
        'AMBULATORIO': 'CONSULTA',
        'OTROS': 'OTROS'
    };
    return map[ambito] || mapCategoryToDomain(ambito); // Fallback to regex for unrecognized values
}

/**
 * Map canonical contract text to M11 ContractDomain.
 * Accepts any combination of category/item/description text.
 * Uses accent-normalized matching to handle real PDF-extracted strings.
 */
function mapCategoryToDomain(text: string): ContractDomain {
    const n = normalizeStr(text);

    // HOSPITALIZACION: días cama, UTI, UCI, UPC, internación, hospitalización, sala cuna, incubadora
    if (/hospitali|dia(s)? cama|dia cama|uti|uci|upc|unidad (de )?cuidado|internac|incubadora|sala cuna/.test(n)) return 'HOSPITALIZACION';

    // PABELLON: pabellón, quirófano, cirugía, acto quirúrgico, sala de operaciones, anestesia, recuperación
    if (/pabellon|quirofano|cirugi|acto quirurgico|sala de operacion|sala operacion|anestesi|recuperac/.test(n)) return 'PABELLON';

    // HONORARIOS: honorarios médicos, médicos, cirujano, anestesiólogo, especialista, matrona, tratante, interconsultor
    if (/honorario|medico|cirujano|anaestesiol|anestesiol|especialista|profesional medic|matrona|tratante|interconsultor/.test(n)) return 'HONORARIOS';

    // MEDICAMENTOS: medicamentos, fármacos, farmacia, medicación, drogas, quimioterapia
    if (/medicament|farmac|medicacion|droga|quimioterapia/.test(n)) return 'MEDICAMENTOS_HOSP';

    // MATERIALES: materiales, insumos, material clínico, dispositivo médico, mallas, suturas, cateter, stent
    if (/material|insumo|implan|dispositivo medic|malla|sutura|cateter|stent/.test(n)) return 'MATERIALES_CLINICOS';

    // PROTESIS / ORTESIS
    if (/protesis|ortesis|protesis|implante ortopedic/.test(n)) return 'PROTESIS_ORTESIS';

    // EXAMENES: exámenes, laboratorio, imágenes, radiología, ecografía, scanner, TAC, resonancia
    if (/examen|laborat|imagen|radiolog|ecograf|scanner|tomograf|resonan/.test(n)) return 'EXAMENES';

    // CONSULTA: consulta, policlínico, atención ambulatoria
    if (/consulta|policlinic|ambulatori/.test(n)) return 'CONSULTA';

    // KINESIOLOGIA
    if (/kinesi|rehabilit|fisioterapia/.test(n)) return 'KINESIOLOGIA';

    // TRASLADOS
    if (/traslado|ambulancia|transporte medic/.test(n)) return 'TRASLADOS';

    return 'OTROS';
}

/** Parse tope strings like '2.5 UF', '50 UTM', '$1.000.000' into a numeric value */
function parseTopeValue(topeStr: string): { kind: "UF" | "UTM" | "CLP" | "VAM" | "AC2" | "SIN_TOPE_EXPRESO" | "VARIABLE"; value: number | null } {
    if (!topeStr) return { kind: 'SIN_TOPE_EXPRESO', value: null };
    const n = topeStr.trim().toUpperCase();

    // Patterns: '2.5 UF', '50 UTM', '13.26 VAM'
    const unitMatch = n.match(/([\d.,]+)\s*(UF|UTM|VAM|USD)/);
    if (unitMatch) {
        const val = parseFloat(unitMatch[1].replace(/\./g, '').replace(',', '.'));
        const k = unitMatch[2] as "UF" | "UTM" | "VAM";
        return { kind: k, value: isNaN(val) ? null : val };
    }

    // Patterns: '$1.000.000', '1000000'
    const moneyMatch = n.match(/\$?([\d.,]+)/);
    if (moneyMatch) {
        const val = parseInt(moneyMatch[1].replace(/[.,]/g, ''), 10);
        return { kind: 'CLP', value: isNaN(val) ? null : val };
    }

    return { kind: 'VARIABLE', value: null };
}
