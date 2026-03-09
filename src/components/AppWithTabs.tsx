import React, { useState } from 'react';
import PAMApp from './PAMApp';
import ContractApp from './ContractApp';
import ForensicApp from './ForensicApp';
import PdfProjector from './PdfProjector';
import PdfViewerDemo from './PdfViewerDemo';

import AuditorM10App from './AuditorM10App';
import AuditorM11App from './AuditorM11App';
import AuditorM12App from './AuditorM12App';
import CanonicalGeneratorApp from './CanonicalGeneratorApp';
import { ShieldCheck, Scale, Gavel, Eye, FileJson, Brain, Receipt } from 'lucide-react';

type DocumentType = 'bill' | 'pam' | 'contract' | 'audit' | 'view' | 'canonizar' | 'm10' | 'm11' | 'm12';

export function AppWithTabs() {
    const [activeTab, setActiveTab] = useState<DocumentType>('bill');

    React.useEffect(() => {
        localStorage.removeItem('forensic_active_case_id');
        localStorage.removeItem('clinic_audit_result');
        localStorage.removeItem('pam_audit_result');
        localStorage.removeItem('contract_audit_result');
        localStorage.removeItem('html_projection_result');
        localStorage.removeItem('clinic_audit_file_fingerprint');
        localStorage.removeItem('pam_audit_file_fingerprint');
        localStorage.removeItem('contract_audit_file_fingerprint');

        console.log('[System] Session activa reseteada para inicio limpio. Historial preservado en Memoria Forense.');
    }, []);

    const handleTabChange = (tab: DocumentType) => {
        setActiveTab(tab);
    };

    return (
        <div className="min-h-screen bg-white text-slate-900 selection:bg-indigo-100 selection:text-indigo-900">
            <div className="sticky top-0 z-[100] bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm">
                <div className="w-full px-4 xl:px-6 h-16 flex items-center justify-between">
                    <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                        <button
                            onClick={() => handleTabChange('bill')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'bill'
                                ? 'bg-slate-900 text-white shadow-lg shadow-slate-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Receipt size={16} />
                            Cuentas Clinicas
                        </button>

                        <button
                            onClick={() => handleTabChange('pam')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'pam'
                                ? 'bg-slate-900 text-white shadow-lg shadow-slate-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <ShieldCheck size={16} />
                            PAM (Coberturas)
                        </button>

                        <button
                            onClick={() => handleTabChange('contract')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'contract'
                                ? 'bg-slate-900 text-white shadow-lg shadow-slate-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Scale size={16} />
                            Contratos
                        </button>

                        <button
                            onClick={() => handleTabChange('audit')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'audit'
                                ? 'bg-slate-900 text-emerald-400 shadow-lg shadow-emerald-900/20'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Gavel size={16} />
                            Auditoria Forense
                        </button>

                        <button
                            onClick={() => handleTabChange('view')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'view'
                                ? 'bg-slate-900 text-indigo-400 shadow-lg shadow-indigo-900/20'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Eye size={16} />
                            Contrato Proyector
                        </button>

                        <button
                            onClick={() => handleTabChange('canonizar')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'canonizar'
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <FileJson size={16} />
                            JSON Canonico
                        </button>

                        <button
                            onClick={() => handleTabChange('m10')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'm10'
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Brain size={16} />
                            M10 Auditor
                        </button>

                        <button
                            onClick={() => handleTabChange('m11')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'm11'
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Brain size={16} />
                            M11 Auditor
                        </button>

                        <button
                            onClick={() => handleTabChange('m12')}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all duration-300 ${activeTab === 'm12'
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                                }`}
                        >
                            <Brain size={16} />
                            M12 Contrato
                        </button>
                    </div>
                </div>
            </div>

            <div>
                <div style={{ display: activeTab === 'bill' ? 'block' : 'none' }}>
                    <PdfViewerDemo />
                </div>
                <div style={{ display: activeTab === 'pam' ? 'block' : 'none' }}>
                    <PAMApp />
                </div>
                <div style={{ display: activeTab === 'contract' ? 'block' : 'none' }}>
                    <ContractApp />
                </div>
                <div style={{ display: activeTab === 'audit' ? 'block' : 'none' }}>
                    <ForensicApp />
                </div>
                <div style={{ display: activeTab === 'view' ? 'block' : 'none' }}>
                    <PdfProjector />
                </div>

                <div style={{ display: activeTab === 'canonizar' ? 'block' : 'none' }}>
                    <CanonicalGeneratorApp />
                </div>

                <div style={{ display: activeTab === 'm10' ? 'block' : 'none' }}>
                    <AuditorM10App />
                </div>

                <div style={{ display: activeTab === 'm11' ? 'block' : 'none' }}>
                    <AuditorM11App />
                </div>

                <div style={{ display: activeTab === 'm12' ? 'block' : 'none' }}>
                    <AuditorM12App />
                </div>
            </div>
        </div>
    );
}
