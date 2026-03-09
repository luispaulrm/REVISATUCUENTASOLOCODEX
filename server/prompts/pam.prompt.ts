import { SchemaType } from "@google/generative-ai";

export const PAM_ANALYSIS_SCHEMA = {
   type: SchemaType.ARRAY,
   description: 'Una lista de cada Folio PAM encontrado en los documentos.',
   items: {
      type: SchemaType.OBJECT,
      properties: {
         folioPAM: { type: SchemaType.STRING, description: 'El numero de folio exacto del PAM.' },
         prestadorPrincipal: { type: SchemaType.STRING, description: 'Nombre y RUT del prestador principal en ese PAM.' },
         periodoCobro: { type: SchemaType.STRING, description: 'Fechas de inicio y fin de cobro de ese PAM.' },
         desglosePorPrestador: {
            type: SchemaType.ARRAY,
            description: 'Una lista de tablas de desglose, una por cada prestador dentro de este Folio PAM.',
            items: {
               type: SchemaType.OBJECT,
               properties: {
                  nombrePrestador: { type: SchemaType.STRING, description: 'El nombre del prestador para esta tabla de desglose.' },
                  items: {
                     type: SchemaType.ARRAY,
                     description: 'La lista de prestaciones para este prestador.',
                     items: {
                        type: SchemaType.OBJECT,
                        properties: {
                           codigoGC: { type: SchemaType.STRING, description: 'Codigo/G/C.' },
                           descripcion: { type: SchemaType.STRING, description: 'Descripcion Prestacion.' },
                           cantidad: { type: SchemaType.STRING, description: 'Cant. / N.' },
                           valorTotal: { type: SchemaType.STRING, description: 'Valor Total del item ($).' },
                           bonificacion: { type: SchemaType.STRING, description: 'Bonificacion del item ($).' },
                           copago: { type: SchemaType.STRING, description: 'Copago del item ($).' },
                        },
                        required: ['codigoGC', 'descripcion', 'cantidad', 'valorTotal', 'bonificacion', 'copago']
                     }
                  }
               },
               required: ['nombrePrestador', 'items']
            }
         },
         resumen: {
            type: SchemaType.OBJECT,
            description: 'Resumen y totales para este Folio PAM.',
            properties: {
               totalCopago: { type: SchemaType.STRING, description: 'Monto total de copago en prestador/clinica.' },
               totalCopagoDeclarado: { type: SchemaType.STRING, description: 'Valor literal del total copago o total a pagar impreso en el documento.' },
               revisionCobrosDuplicados: { type: SchemaType.STRING, description: 'Observaciones sobre cobros duplicados o anexos de norma.' },
            }
         }
      },
      required: ['folioPAM', 'prestadorPrincipal', 'periodoCobro', 'desglosePorPrestador', 'resumen']
   }
};

export const PAM_PROMPT = `
**INSTRUCCION CRITICA: ANALISIS DE PROGRAMAS DE ATENCION MEDICA (PAM)**
ACTUA COMO UN AUDITOR DE SEGUROS, BONOS MEDICOS Y LIQUIDACIONES DE CUENTA POR PARTE DE UNA ISAPRE.

**OBJETIVO:** Extraer el detalle completo de documentos PAM en formato **TEXTO ESTRUCTURADO (NO JSON)**.

**VARIANTES REALES QUE DEBES SOPORTAR:**
1. **PAM clasico / Programa de Atencion Medica**
   - Encabezados como: "PROGRAMA DE ATENCION MEDICA", "Folio Pam.", "Periodo de Cobro", "Prestador", "Sub total por prestador", "Total PAM", "Copago en Clinica".
2. **Bono PAM moderno**
   - Encabezados como: "Folio P.A.M", "Codigo Prestacion", "Valor", "Bonificacion", "Convenio", "Copago", "Copago Prestador", "Totales".
   - Puede venir repetido en la misma pagina como "COPIA PRESTADOR" y "COPIA AFILIADO". EXTRAE SOLO UNA VEZ el mismo folio y NO dupliques filas identicas.
3. **Liquidacion de Cuenta Medica / valorizacion Isapre**
   - Encabezados como: "Formulario Liquidacion Cuenta Medica Emitida", "Numero PAM", "Tipo Liquidacion", "Plan Complementario", "Prestacion Principal", "SUB TOTAL", "TOTAL INTERVENCION", "TOTAL GENERAL".
   - Usa como copago el valor de la columna final "Copago", aunque existan columnas intermedias de cobertura.
4. **Anexo de cobros duplicados**
   - Encabezados como: "DETALLE DE COBROS DUPLICADOS DE ACUERDO A NORMA", "Totales: 0 $0".
   - Si no hay items, NO inventes prestaciones. Registra la observacion en revision de duplicados.

**REGLAS DE NORMALIZACION ENTRE VARIANTES:**
- "Folio PAM", "Folio P.A.M", "Numero PAM", "Pam asoc. Hospitalizacion" deben mapear al mismo identificador de folio.
- "Prestador", "Institucion", "Sociedad" o "Prestador principal" deben normalizarse a PROVIDER.
- "Copago en Clinica", "Copago Prestador", "Copago en Prestador", "TOTAL GENERAL" (columna final de copago) pueden ser fuente de TOTAL_COPAGO_DECLARADO.
- "Sub total por prestador", "SUB TOTAL", "Totales", "Total PAM", "TOTAL INTERVENCION", "TOTAL GENERAL" son referencias de control, no reemplazan el detalle por linea salvo que el documento no tenga mayor granularidad.

**REGLA DE FORMATO VISUAL (IMPORTANTE):**
1. **FOLIO:** Identifica cada bono nuevo con "FOLIO: [Numero]"
2. **PRESTADOR:** Identifica el prestador con "PROVIDER: [Nombre]"
3. **PERIODO:** Si existen fechas de inicio/fin o periodo de cobro, emite:
   - "DATE_START: [dd/mm/yyyy o literal]"
   - "DATE_END: [dd/mm/yyyy o literal]"
4. **TABLA:** Extrae los items linea por linea usando el simbolo "|" como separador.
   Formato: [Codigo]|[Descripcion]|[Cantidad]|[ValorTotal]|[Bonificacion]|[Copago]
5. **TOTALES:** Si ves un total declarado, usa "TOTAL_COPAGO_DECLARADO: [Monto]"
6. **OBSERVACIONES:** Si el documento dice que hay cobros duplicados, usa:
   - "DUPLICATE_REVIEW: [texto breve]"
7. **SECCIONES OPCIONALES:** Si el documento tiene bloques como HOTELERIA, EXAMENES, NO BONIFICABLES, puedes marcarlos con:
   - "SECTION: [nombre]"
   Esto NO reemplaza las filas.

**ESTRUCTURA DE SALIDA ESPERADA:**
FOLIO: 12345678
PROVIDER: CLINICA ALEMANA
DATE_START: 12/05/2024
DATE_END: 13/05/2024
SECTION: DETALLE PRESTACIONES
[Codigo]|[Descripcion]|[Cantidad]|[ValorTotal]|[Bonificacion]|[Copago]
303030|CONSULTA MEDICA|1|40000|32000|8000
... (todas las filas) ...
TOTAL_COPAGO_DECLARADO: 8000

FOLIO: 87654321
...

**MANDATOS DE EXTRACCION:**
1. **EXHAUSTIVIDAD:** Extrae TODAS las lineas. Si hay 50 items, extrae 50 lineas.
2. **VALORES:** Usa solo numeros enteros. Si es $0, escribe "0".
3. **LIMPIEZA:** Elimina puntos de mil en la salida (ej: 40000, no 40.000).
4. **CONTINUIDAD:** No te detengas. Si el documento es largo, continua hasta el final.
5. **SIN DUPLICADOS DE COPIA:** Si el mismo bono aparece dos veces por copia prestador/afiliado, conserva una sola version.
6. **SIN INVENTAR:** Si un bloque no trae items o tiene total cero, respetalo como cero.
`;
