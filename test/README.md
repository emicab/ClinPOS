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
5. Los tests no salen a la red. AFIP, Supabase, MercadoPago, GenAI y mail
   se mockean (fase 2).

## Estructura

```
test/
  helpers/        db, esquema (introspección SQLite), paths
  schema/         anti-drift: template vs schema, migraciones, Rust, health
  unit/           dominio (stock, ventas, caja, sync, lib/*)
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

## Deuda conocida

- `prisma/migrations` está incompleta: ninguna migración crea `WebOrder`, así que
  `prisma migrate deploy` falla en una base vacía. El test lo marca como
  `it.fails`; cuando se arregle, Vitest va a avisar "unexpected pass".
- `health/db.ts` cubre 10 de 44 tablas a propósito (`it.todo`). Ampliarlo
  requiere decidir qué pasa con DBs viejas en el arranque de Tauri.
- `src-tauri/src/lib.rs` no crea `StockMovement`: un cliente que actualice desde
  una versión sin esa tabla se queda sin ledger hasta que corra `db push`.
