# Implementacion Nuevo Modulo Cuentas Clinicas

## Objetivo
Crear un visor PDF tipo calco para auditoria con overlays interactivos y fallback opcional por OpenAI cuando el PDF no tiene text layer.

## Milestones

### M1 - Visor Calco (Canvas PDF.js)
- Crear `PdfCalcoPage` para renderizar una pagina PDF a `canvas`.
- Configurar worker de `pdfjs-dist` para Vite.
- Exponer `onPageReady({ width, height, hasTextLayer })`.

### M2 - Overlays Text Layer
- Construir overlays por item de texto con bbox.
- Hacer overlays clickeables con `onOverlayClick`.
- Condicion de escaneado: si `textContent.items.length < 20`, no pintar overlays de texto.

### M3 - Overlays por Filas para Auditoria
- Agregar helper geometrico `buildRowsFromTextItems(items, viewport)`.
- Soportar `overlayMode = "text" | "rows" | "cells"` (default `rows`).
- Implementar `rowText`, `tokens` y `row.type = "header" | "data"` con heuristica simple.
- Exponer `onRowClick(row)`.

### M4 - Fallback OpenAI (Opcional)
- Crear endpoint `GET /api/pdf-layout?pdfUrl=...&page=...`.
- Usar Structured Outputs JSON Schema y bboxes normalizados `0..1`.
- En frontend, al no haber text layer y si `useOpenAIFallback=true`, consultar endpoint.
- Cache simple por `(pdfUrl,page,scale)`.

## Validacion por hito
- Tras cada hito: correr `npm run build`.
- Corregir errores de tipado/build antes del siguiente hito.
