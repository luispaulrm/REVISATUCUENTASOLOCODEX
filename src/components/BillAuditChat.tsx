import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Image as ImageIcon, Loader2, Send, ToggleLeft, ToggleRight, X } from 'lucide-react';

interface BillAuditChatProps {
  billContext: any;
}

interface ChatItem {
  id: string;
  question: string;
  answer: string;
  images: string[];
}

export default function BillAuditChat({ billContext }: BillAuditChatProps) {
  const [question, setQuestion] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [forceOpenAI, setForceOpenAI] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const contextSnapshot = useMemo(() => billContext || {}, [billContext]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, streamingAnswer]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(160, textareaRef.current.scrollHeight)}px`;
  }, [question]);

  const processFile = (file: File): void => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      if (!result) return;
      setImages((prev) => [...prev, result]);
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.includes('image')) {
        e.preventDefault();
        const blob = items[i].getAsFile();
        if (blob) processFile(blob);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const removeImage = (index: number): void => {
    setImages((prev) => prev.filter((_, idx) => idx !== index));
  };

  const copyAnswer = async (id: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1200);
    } catch {
      // no-op
    }
  };

  const handleAsk = async (): Promise<void> => {
    if ((!question.trim() && images.length === 0) || isLoading) return;

    const askedQuestion = question.trim();
    const askedImages = [...images];
    const entryId = `${Date.now()}`;

    setQuestion('');
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setIsLoading(true);
    setStreamingAnswer('');

    try {
      const response = await fetch('/api/bill/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: askedQuestion,
          images: askedImages,
          preferredModel: 'gpt-4o',
          forceOpenAI,
          billJson: contextSnapshot
        })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Error ${response.status} en /api/bill/chat`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setStreamingAnswer(accumulated);
      }

      setHistory((prev) => [
        ...prev,
        { id: entryId, question: askedQuestion, answer: accumulated.trim(), images: askedImages }
      ]);
      setStreamingAnswer('');
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        {
          id: entryId,
          question: askedQuestion,
          answer: `Error consultando asistente: ${err?.message || 'desconocido'}`,
          images: askedImages
        }
      ]);
      setStreamingAnswer('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="mt-4 border border-slate-200 bg-white rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
          Asistente rapido de auditoria (OpenAI)
        </h3>
        <p className="text-[11px] text-slate-500 mt-1">
          Antes de M10/M11: pregunta por glosas, montos y consistencia visual de la cuenta.
        </p>
        <div className="mt-2">
          <button
            onClick={() => setForceOpenAI((v) => !v)}
            className={`px-2 py-1 rounded text-[11px] font-bold inline-flex items-center gap-1 ${forceOpenAI ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}
            title="Si está activo, la pregunta se responde con OpenAI aunque exista respuesta determinística."
          >
            {forceOpenAI ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
            {forceOpenAI ? 'Forzar OpenAI: ON' : 'Forzar OpenAI: OFF'}
          </button>
          <span className="ml-2 text-[11px] text-slate-500">
            Modo actual: {forceOpenAI ? 'OpenAI forzado' : 'Determinístico'}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="max-h-[320px] overflow-y-auto px-4 py-3 space-y-3 bg-slate-50/30">
        {history.length === 0 && !streamingAnswer && (
          <div className="text-xs text-slate-400">
            Puedes escribir, copiar/pegar texto o pegar imagenes con Ctrl+V.
          </div>
        )}

        {history.map((item) => (
          <div key={item.id} className="space-y-2">
            <div className="flex justify-end">
              <div className="max-w-[92%] bg-white border border-slate-200 rounded-xl rounded-tr-none px-3 py-2 text-sm text-slate-700 select-text">
                <p>{item.question}</p>
                {item.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.images.map((src, idx) => (
                      <img
                        key={`${item.id}-img-${idx}`}
                        src={src}
                        alt="Adjunto"
                        className="w-12 h-12 object-cover rounded border border-slate-200"
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[96%] bg-slate-100 border border-slate-200 rounded-xl rounded-tl-none px-3 py-2 text-sm text-slate-800 whitespace-pre-wrap select-text">
                {item.answer}
              </div>
            </div>
            <div className="flex justify-start">
              <button
                onClick={() => copyAnswer(item.id, item.answer)}
                className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              >
                <Copy size={12} /> {copiedId === item.id ? 'Copiado' : 'Copiar respuesta'}
              </button>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[96%] bg-white border border-slate-200 rounded-xl rounded-tl-none px-3 py-2 text-sm text-slate-700 whitespace-pre-wrap">
              {streamingAnswer || (
                <span className="inline-flex items-center gap-2 text-indigo-600">
                  <Loader2 size={14} className="animate-spin" />
                  Analizando...
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-3 border-t border-slate-200 bg-white">
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto mb-2">
            {images.map((src, idx) => (
              <div key={`pending-${idx}`} className="relative shrink-0">
                <img src={src} alt="Preview" className="w-14 h-14 object-cover rounded border border-slate-200" />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full p-0.5"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 border border-slate-200 rounded-xl px-2 py-2 bg-slate-50">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
            title="Adjuntar imagen"
          >
            <ImageIcon size={16} />
          </button>

          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleAsk();
              }
            }}
            placeholder="Pregunta sobre la cuenta. Puedes pegar imagenes con Ctrl+V."
            className="flex-1 bg-transparent border-none outline-none resize-none text-sm text-slate-800 placeholder:text-slate-400"
            rows={1}
          />
          <button
            onClick={() => void handleAsk()}
            disabled={isLoading || (!question.trim() && images.length === 0)}
            className="p-2 rounded-lg bg-indigo-600 text-white disabled:bg-slate-300"
            title="Enviar"
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </section>
  );
}
