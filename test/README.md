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
