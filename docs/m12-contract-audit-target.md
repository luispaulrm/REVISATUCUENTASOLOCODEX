# M12 Contract Audit Target

## Objetivo
M12 no debe auditar directo sobre Azure raw. Debe producir dos salidas intermedias auditables:

1. `contract_calco`
2. `canonical_contract`

La cadena objetivo es:

`Azure raw -> contract_calco -> contract_doctrine -> canonical_contract -> auditoria`

## `contract_calco`
`contract_calco` es el espejo fiel del contrato.

Debe conservar:

- pagina
- headers reales
- filas reales
- celdas reales
- rectangulos o cajas de alcance
- marcadores de notas
- texto literal
- evidencia geometrica

Reglas obligatorias:

- no inventar modalidad
- no convertir columnas `(1)(2)(3)(4)` a `preferente/libre_eleccion` si el contrato no lo dice
- no propagar valores por filas sin dejar `scopeRef`
- no perder `tope internacional` ni `ampliacion`
- no perder notas `(**)` `(***)`

## `contract_doctrine`
`contract_doctrine` interpreta la semantica del contrato sin romper el calco.

Debe resolver:

- que significa cada columna
- que nota modifica que fila o columna
- que caja aplica a que filas
- si el contrato es `PREFERENTE/LIBRE_ELECCION`, `GRID_1_2_3_4` o una variante distinta

## `canonical_contract`
`canonical_contract` es la salida util para auditoria.

Debe poder responder:

- cobertura %
- tope por evento
- tope anual
- tope internacional
- ampliacion de cobertura
- restricciones
- prestadores o clinicas
- evidencia literal y geometrica
- nivel de certeza

Campos minimos por regla:

- `itemLabel`
- `domainHint`
- `modality`
- `coveragePct`
- `topeEvento`
- `topeAnualBeneficiario`
- `topeInternacional`
- `ampliacionCobertura`
- `restrictions`
- `prestadores`
- `footnoteMarkers`
- `literalEvidence`
- `geometryEvidence`
- `evidenceBreakdown.directLiteralEvidence`
- `evidenceBreakdown.propagatedLiteralEvidence`
- `evidenceBreakdown.directGeometryEvidence`
- `evidenceBreakdown.propagatedGeometryEvidence`
- `evidenceBreakdown.mode`
- `confidence`

## Reconstructibility
La salida auditabile debe declarar si el contrato quedo:

- `VERIFIABLE`
- `PARCIAL`
- `NO_VERIFICABLE`

No toda opacidad invalida todo el contrato. La incertidumbre debe quedar localizada por fila, columna o regla.

## Criterios no negociables

- fidelidad al PDF
- trazabilidad por evidencia
- semantica contractual explicita
- manejo honesto de incertidumbre
- separacion entre calco y normalizacion

## Referencia de tipos
Los tipos formales de estas salidas quedaron en:

- `src/m12/contractAuditSchema.ts`
