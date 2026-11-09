# Tests

Runner: **Vitest**. Los E2E (Playwright) se agregan en una fase posterior.

```bash
npm test            # toda la suite
npm run test:schema # solo anti-drift de esquema
npm run test:cov    # con cobertura
npm run test:rust   # tests de src-tauri/src/lib.rs
```

## Reglas

1. **Nunca** tocar `prisma/dev.db`, `prisma/crm_template.db` ni la base de un cliente.
   Cada test abre una copia aislada con `createTestDb()` (ver `helpers/db.ts`).
2. La base canónica se genera en `global-setup.ts` con `prisma db push` sobre
   `prisma/schema.prisma`. Es la referencia contra la que se compara todo.
3. Dinero: `Decimal` y comparación por string. Nunca `float`.
4. Zona horaria fija: `America/Argentina/Buenos_Aires` (`test/setup.ts`).
5. Los tests no salen a la red. AFIP/ARCA, Supabase, MercadoPago, GenAI y mail
   se mockean. La única llamada externa mockeada hoy es `createElectronicInvoice`.
6. Los tests de `pages/api` usan `setupApi()` (`helpers/api.ts`), que redirige el
   Proxy de `lib/prisma` a la base del test y limpia el cache entre archivos.
7. Los tests de `lib/syncOutbox.ts` mockean el módulo `lib/syncService` completo
   (nunca salen a Supabase) y usan `vi.clearAllMocks()` en el `afterEach`.
   `restoreAllMocks()` borraría las implementaciones de la fábrica y los tests
   siguientes quedarían sin mock.
8. Para probar el outbox hay que habilitar **las dos** condiciones de
   `enqueueOutbox`: `cloud_sync_enabled=true` y plan Pro (`app_plan=pro`).
   Después de escribir las `Setting`, llamar a `invalidateCloudPolicyCache()`
   porque el flag se cachea 5 s. `drainOutbox` solo exige la nube encendida.

## Estructura

```
test/
  helpers/        db aislada, introspección SQLite, paths, factories, harness de API
  schema/         anti-drift: template vs schema, migraciones, Rust, health
  unit/           dominio (stock, recetas, ...)
  api/            contratos de los handlers de pages/api
  e2e/            Playwright
  .tmp/           bases efímeras (gitignored)
```

## Qué cubre hoy

| Archivo | Qué garantiza |
|---|---|
| `schema/template-db.test.ts` | `crm_template.db` = instalación limpia (tablas, columnas, índices, seed) |
| `schema/health-contract.test.ts` | `health/db.ts` no lista tablas/columnas inexistentes |
| `schema/rust-migrator.test.ts` | el DDL de `lib.rs` no tiene typos, columnas fantasma ni `CREATE TABLE` no idempotentes |
| `schema/check-drift.test.ts` | el gate de `build:next` sigue pasando |
| `schema/migrations.test.ts` | documenta (con `it.fails`) que la cadena de migraciones **no** puede reconstruir la base |
| `unit/db-harness.test.ts` | el aislamiento de DB funciona |
| `unit/stock/stockService.test.ts` | `Product.quantityStock = Σ ProductBranchStock`, aislamiento por sucursal, rechazo de negativos, `setStock`, rollback de `withStockTransaction` |
| `unit/stock/recipeStock.test.ts` | expansión de recetas (anidadas, compartidas, ciclos, profundidad), disponibilidad derivada, faltantes combinados, descuento/reposición atómicos, costo y snapshots |
| `api/ventas/create-sale.test.ts` | totales y descuentos (porcentaje/fijo/tope/promo/medio de pago), stock por sucursal y global, elaborados, cuenta corriente, caja, factura ARCA y GET (filtros, paginación, TZ) |
| `api/caja/cash-register.test.ts` | apertura/cierre de caja, una sola caja abierta, historial (últimas 10), esperado = saldo inicial + **solo** movimientos `CASH`, diferencias positiva/negativa |
| `api/compras/purchases.test.ts` | alta/edición/borrado de compras, `Decimal`, PENDING vs RECEIVED, `quantityReceived`, sucursal (body → equipo → central → global), costo, gasto + caja, snapshots de receta y reversión atómica |
| `api/stock-transfers/transfers.test.ts` | gate Pro, envío (`TRANSFER_OUT`), aceptar/rechazar/parcial, conservación `enviado = recibido + devuelto`, sobre-recepción, doble respuesta y cancelación |
| `unit/sync/outbox.test.ts` | gating local/Pro, dedupe por entidad+clave, tombstones UPSERT↔DELETE, rutas por entidad, prioridad, backoff, error de red vs rechazo, purga/reactivación |
| `unit/pricing/priceAdjuster.test.ts` | redondeos (2 decimales/entero/decena/centena), aumento/descuento porcentual y fijo, set, piso en 0, markup vs margen sobre venta |
| `unit/licensing/licenseStatus.test.ts` | clave Pro por prefijo (BASICO con "PRO" no escala), plan local por 4 marcas, revalidación online/offline, clave inexistente/desactivada/vencida/otro hardware |
| `unit/stock/stockReview.test.ts` | Regla de Oro: faltantes por sucursal y global, elaborados combinados, nota con unidades, marcado PENDING_REVIEW y revalidación |
| `unit/security/encryption.test.ts` | AES-256-GCM ida y vuelta, IV distinto, formato `ENC::`, lectura de claves legacy v1/v2, dato manipulado → vacío |
| `unit/sync/syncConflict.test.ts` | `isCloudNewer` estricto (empate no pisa), registro/dedupe de conflictos OPEN, fallo silencioso |
| `unit/dashboard/data.test.ts` | conteos, stock bajo por sucursal/global, ingresos del mes, series diarias, comparación mensual, top productos, COGS/gastos/ganancia y medios de pago |

## Cobertura (Fase 3)

| Archivo | Stmts | Branch |
|---|---|---|
| `lib/syncOutbox.ts` | 93.71% | 82.75% |
| `pages/api/caja/index.ts` | 91.11% | 88.88% |
| `pages/api/caja/[id].ts` | 93.75% | 81.48% |
| `pages/api/compras/index.ts` | 97.08% | 88.57% |
| `pages/api/compras/[id].ts` | 95.78% | 79.41% |
| `pages/api/stock-transfers/index.ts` | 96.52% | 94.73% |
| `pages/api/stock-transfers/[id]/respond.ts` | 94.83% | 84.21% |
| `pages/api/stock-transfers/[id]/cancel.ts` | 86.41% | 77.77% |

Todas las funciones de esos archivos están cubiertas (100%). El gate real es el
contrato, no el número: cada fase se validó rompiendo a propósito la regla
central (p. ej. sumar tarjeta al arqueo, saltear la reversión de stock, no
escribir el tombstone, aceptar de más) y comprobando que la suite falla.

## Cobertura (Fase 4)

| Archivo | Stmts | Branch |
|---|---|---|
| `lib/priceAdjuster.ts` | 100% | 100% |
| `lib/syncConflict.ts` | 100% | 100% |
| `lib/licenseStatus.ts` | 96.17% | 80.95% |
| `lib/stockReview.ts` | 95.80% | 87.50% |
| `lib/encryption.ts` | 94.62% | 68.96% |
| `lib/data.ts` | 89.07% | 73.56% |

En esta fase también se rompieron 6 reglas a propósito (piso en 0 del precio,
plan intacto sin red, faltante por cantidad, empate de fechas, secreto ilegible
y ventas PENDING en ingresos): las 6 fueron detectadas.

## Deuda conocida

- `prisma/migrations` está incompleta: ninguna migración crea `WebOrder`, así que
  `prisma migrate deploy` falla en una base vacía. El test lo marca como
  `it.fails`; cuando se arregle, Vitest va a avisar "unexpected pass".
- `health/db.ts` cubre 10 de 44 tablas a propósito (`it.todo`). Ampliarlo
  requiere decidir qué pasa con DBs viejas en el arranque de Tauri.
- `src-tauri/src/lib.rs` no crea `StockMovement`: un cliente que actualice desde
  una versión sin esa tabla se queda sin ledger hasta que corra `db push`.
- `lib/recipeStock.ts` comenta que el redondeo de disponibilidad se agregó por
  `0.9 / 0.3`, pero ese cociente da 3 exacto en JS. El caso que realmente rompe
  es `0.3 / 0.1` (2.9999999999999996 → floor 2); el test cubre el par real.
- `POST /api/stock-transfers` con `quantity <= 0` devuelve **500**, no 400: el
  error de validación cae en el handler genérico. La transacción sí revierte
  todo (no quedan traspaso ni movimientos); el test fija el comportamiento
  actual y queda pendiente mapear el error a 400.
- En el outbox, solo los errores de **red** conservan los intentos y cortan la
  cola. Un rechazo no-red (p. ej. RPC de stock con 500) se marca `FAILED` de
  inmediato con `attempts=1`; el ciclo de housekeeping lo vuelve a `PENDING`
  recién a las 6 horas. El test fija ese contrato.
- `lib/data.ts` mezcla dos formas de calcular el día local: `getLocalDateBoundary`
  usa un offset UTC-3 fijo y varias funciones restan 3 horas a mano. Hoy Argentina
  no tiene horario de verano, pero el offset está hardcodeado: cambiar de zona o
  país corre los cortes de día/mes.
- `lib/licenseStatus.ts` trata un HTTP no-ok (o una respuesta que no sea array)
  como **offline** y conserva el plan Pro. Es deliberado para no castigar al local
  por un backend caído, pero una clave revocada no baja hasta que el endpoint
  vuelva a responder.
- `lib/encryption.ts`: si se pierde `CLINPOS_ENCRYPTION_SECRET` o cambia el
  hardware/usuario, el dato es irrecuperable por diseño y `decryptText` devuelve
  `""`. Los fallbacks v1/v2 solo sirven para datos cifrados con esas versiones.
- `lib/stockReview.ts` no puede recibir un `productId` inexistente: la FK de
  `WebOrderItem` lo impide antes. La rama defensiva `if (!product) continue`
  queda sin test por ese motivo.
