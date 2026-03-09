# Implementation Notes - Cuentas Clinicas

## Decisiones
- Se uso `pdfjs-dist` en frontend con worker por URL (`?url`) para compatibilidad directa con Vite.
- Se uso geometria pura del `textLayer` para filas/celdas, sin OCR ni IA en modo normal.
- Se define umbral `textItems < 20` para considerar PDF escaneado y evitar overlays falsos.
- Fallback OpenAI queda detras de flag `useOpenAIFallback` para poder apagarlo sin tocar codigo.

## Tradeoffs
- `yTolerancePx=4` y `xClusterTolerancePx=10` priorizan estabilidad en cuentas clinicas comunes; PDFs atipicos pueden requerir ajuste.
- El fallback backend consume `pdfUrl` remoto para mantener diff acotado y no agregar upload binario nuevo en este PR.
- Los overlays priorizan legibilidad del calco: semitransparentes y con borde liviano.

## Riesgos conocidos
- PDFs con CORS restringido pueden fallar al cargar por URL en frontend.
- Si OpenAI no esta configurado (`OPENAI_API_KEY`), el fallback retorna error controlado y el canvas sigue operativo.
