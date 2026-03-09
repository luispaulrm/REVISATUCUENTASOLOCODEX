import React from 'react';
import { PamDocument, FolioPAM } from '../pamService';
import {
    User,
    Calendar,
    Receipt,
    CheckCircle2,
    AlertCircle,
    TrendingDown,
    Layers,
    FileDigit,
    Files
} from 'lucide-react';

interface PAMResultsProps {
    data: PamDocument;
}

export function PAMResults({ data }: PAMResultsProps) {
    if (!data || !data.folios || data.folios.length === 0) {
        return (
            <div className="p-8 text-center bg-white rounded-3xl border border-slate-200">
                <AlertCircle size={48} className="mx-auto text-slate-300 mb-4" />
                <p className="text-slate-500 font-bold">No se encontraron folios PAM en el documento.</p>
            </div>
        );
    }

    return (
        <div className="pam-results-container space-y-12 pb-20">
            <div className="global-dashboard bg-indigo-950 text-white rounded-[2.5rem] p-8 shadow-2xl border border-white/10 overflow-hidden relative">
                <div className="absolute top-0 right-0 p-12 opacity-5">
                    <Layers size={200} />
                </div>

                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-8">
                        <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                            <TrendingDown size={24} />
                        </div>
                        <div>
                            <h2 className="text-2xl font-black tracking-tight">Dashboard Consolidado de PAM</h2>
                            <p className="text-indigo-300 text-xs font-bold uppercase tracking-widest">Resumen General de Coberturas</p>
                        </div>
                    </div>

                    <div className="grid md:grid-cols-5 gap-6">
                        <div className="stat-card bg-white/5 p-5 rounded-3xl border border-white/10">
                            <p className="text-[10px] font-black text-indigo-300 uppercase mb-2">Total Valor</p>
                            <p className="text-2xl font-mono font-black">${data.global.totalValor.toLocaleString()}</p>
                        </div>
                        <div className="stat-card bg-white/5 p-5 rounded-3xl border border-white/10">
                            <p className="text-[10px] font-black text-emerald-400 uppercase mb-2">Bonificacion Total</p>
                            <p className="text-2xl font-mono font-black text-emerald-400">-${data.global.totalBonif.toLocaleString()}</p>
                        </div>
                        <div className="stat-card bg-indigo-600 p-5 rounded-3xl shadow-xl shadow-indigo-950/50">
                            <p className="text-[10px] font-black text-white/70 uppercase mb-2">Copago Consolidado</p>
                            <p className="text-2xl font-mono font-black text-white">${data.global.totalCopago.toLocaleString()}</p>
                        </div>
                        <div className="stat-card bg-white/5 p-5 rounded-3xl border border-white/10">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Items Auditados</p>
                            <p className="text-2xl font-mono font-black text-white">{data.global.totalItems || 0}</p>
                        </div>
                        <div className={`stat-card p-5 rounded-3xl border ${data.global.cuadra ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-rose-500/20 border-rose-500/40'}`}>
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Estado de Auditoria</p>
                            <p className={`text-sm font-black tracking-tight ${data.global.cuadra ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {data.global.auditoriaStatus}
                            </p>
                        </div>
                    </div>

                    {!data.global.cuadra && (
                        <div className="mt-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-4 animate-pulse">
                            <AlertCircle className="text-rose-400" />
                            <p className="text-xs font-bold text-rose-300">
                                Atencion: Se detecto una diferencia de <span className="text-white text-sm font-black">${data.global.discrepancia.toLocaleString()}</span> en el copago total consolidado. Revise los folios individuales.
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-8">
                {data.folios.map((folio, fIdx) => (
                    <FolioCard key={fIdx} folio={folio} index={fIdx + 1} />
                ))}
            </div>
        </div>
    );
}

interface FolioCardProps {
    folio: FolioPAM;
    index: number;
}

function FolioCard({ folio, index }: FolioCardProps) {
    return (
        <div className="folio-card bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white font-black shadow-lg shadow-indigo-100">
                        #{index}
                    </div>
                    <div>
                        <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                            Folio PAM: {folio.folioPAM}
                            {!folio.resumen.cuadra && (
                                <span className="bg-rose-100 text-rose-600 text-[10px] px-2 py-0.5 rounded-full border border-rose-200 uppercase font-black">Inconsistente</span>
                            )}
                        </h3>
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                            <Calendar size={12} /> {folio.periodoCobro}
                        </p>
                        {folio.bonosAsociados && folio.bonosAsociados.length > 0 && (
                            <p className="mt-2 text-[11px] font-bold text-slate-500 flex items-start gap-1.5">
                                <Files size={12} className="mt-0.5 shrink-0" />
                                Bonos asociados: {folio.bonosAsociados.join(', ')}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex flex-col md:flex-row gap-3">
                    <div className="bg-white px-4 py-2 rounded-xl border border-slate-200 flex items-center gap-3">
                        <User size={18} className="text-indigo-500" />
                        <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase leading-none mb-1">Prestador Principal</p>
                            <p className="text-sm font-bold text-slate-800 leading-none">{folio.prestadorPrincipal}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-6 space-y-8">
                {folio.desglosePorPrestador.map((prestador, pIdx) => (
                    <div key={pIdx} className="prestador-section">
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="flex items-center gap-2 text-sm font-black text-slate-800 uppercase tracking-tight">
                                <Receipt size={16} className="text-slate-400" />
                                Prestador: <span className="text-indigo-600">{prestador.nombrePrestador}</span>
                            </h4>
                        </div>

                        <div className="overflow-x-auto rounded-2xl border border-slate-100 print:overflow-visible">
                            <table className="w-full text-left border-collapse min-w-[800px] print:min-w-0">
                                <thead>
                                    <tr className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                                        <th className="px-4 py-3 w-10">#</th>
                                        <th className="px-4 py-3">Codigo/G/C</th>
                                        <th className="px-4 py-3">Descripcion</th>
                                        <th className="px-4 py-3 text-center">Cant</th>
                                        <th className="px-4 py-3 text-right">Valor Total ($)</th>
                                        <th className="px-4 py-3 text-right">Bonif. ($)</th>
                                        <th className="px-4 py-3 text-right font-black">Copago ($)</th>
                                        <th className="px-4 py-3 text-center">Audit</th>
                                    </tr>
                                </thead>
                                <tbody className="text-sm">
                                    {(prestador.items || []).map((item, iIdx) => (
                                        <tr key={iIdx} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                                            <td className="px-4 py-2.5 text-slate-400 font-mono text-[10px] font-bold">{iIdx + 1}</td>
                                            <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{item.codigoGC}</td>
                                            <td className="px-4 py-2.5 font-bold text-slate-700">{item.descripcion}</td>
                                            <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.cantidad}</td>
                                            <td className="px-4 py-2.5 text-right font-mono text-slate-600">{item.valorTotal}</td>
                                            <td className="px-4 py-2.5 text-right font-mono text-emerald-600">{item.bonificacion}</td>
                                            <td className="px-4 py-2.5 text-right font-mono font-black text-slate-900">{item.copago}</td>
                                            <td className="px-4 py-2.5 text-center">
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${item._audit === 'OK' || item._audit === '? OK' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                                                    {item._audit || '-'}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ))}
            </div>

            <div className="p-6 bg-slate-50 border-t border-slate-100 grid md:grid-cols-4 gap-6">
                <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Valor Declarado</p>
                    <p className="text-xl font-mono font-black text-slate-900">${Number(folio.resumen.totalValorDeclarado || 0).toLocaleString()}</p>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Bonificacion Declarada</p>
                    <p className="text-xl font-mono font-black text-emerald-700">${Number(folio.resumen.totalBonificacionDeclarada || 0).toLocaleString()}</p>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Copago Calculado</p>
                    <p className="text-xl font-mono font-black text-slate-900">${folio.resumen.totalCopagoCalculado?.toLocaleString()}</p>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Copago Declarado</p>
                    <p className="text-xl font-mono font-black text-slate-900">${folio.resumen.totalCopagoDeclarado}</p>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Revision Duplicados</p>
                    <p className="text-xs font-bold text-slate-700">{folio.resumen.revisionCobrosDuplicados || 'Sin observaciones'}</p>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-200 md:col-span-2">
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1 flex items-center gap-1.5">
                        <FileDigit size={12} /> Fuente Total Declarado
                    </p>
                    <p className="text-xs font-bold text-slate-700 break-words">
                        {folio.resumen.fuenteTotalDeclarado || 'No capturada'}
                    </p>
                </div>
                <div className={`p-4 rounded-2xl border ${folio.resumen.cuadra ? 'bg-emerald-50 border-emerald-100' : 'bg-rose-50 border-rose-100'}`}>
                    <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Auditoria de Folio</p>
                    <div className="flex items-center gap-2">
                        {folio.resumen.cuadra ? <CheckCircle2 size={16} className="text-emerald-500" /> : <AlertCircle size={16} className="text-rose-500" />}
                        <p className={`text-xs font-bold ${folio.resumen.cuadra ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {folio.resumen.auditoriaStatus}
                        </p>
                    </div>
                    <p className={`mt-2 text-[11px] font-bold ${folio.resumen.cuadra ? 'text-emerald-700' : 'text-rose-700'}`}>
                        Discrepancia: ${Number(folio.resumen.discrepancia || 0).toLocaleString()}
                    </p>
                </div>
            </div>
        </div>
    );
}
