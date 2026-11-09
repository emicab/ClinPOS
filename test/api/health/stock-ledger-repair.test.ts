import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupApi, teardownApi, type TestDb } from "../../helpers/api";
import { ensureLocalSyncSchema } from "../../../lib/ensureLocalSyncSchema";

// En producción standalone no siempre corre Tauri, así que el health endpoint
// repara el esquema antes de responder. StockMovement también tiene que estar
// ahí: es el ledger que escribe lib/stockService.ts en cada movimiento.
//
// El módulo cachea la promesa, por eso este archivo hace una sola llamada real.
describe("ensureLocalSyncSchema repara el ledger de stock", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await setupApi("stock-ledger-repair");
    await t.db.$executeRawUnsafe(`DROP TABLE IF EXISTS "StockMovement"`);
  });

  afterAll(async () => {
    await teardownApi(t);
  });

  it("crea StockMovement con sus columnas e índices", async () => {
    expect(
      await t.db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type='table' AND name='StockMovement'`),
    ).toEqual([]);

    await ensureLocalSyncSchema();

    const columns = (await t.db.$queryRawUnsafe(
      `PRAGMA table_info("StockMovement")`,
    )) as Array<{ name: string }>;
    expect(columns.map((c) => c.name).sort()).toEqual([
      "branchId",
      "createdAt",
      "delta",
      "id",
      "note",
      "productId",
      "quantityAfter",
      "reason",
      "refId",
      "refType",
    ]);

    const indexes = (await t.db.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='StockMovement' AND name NOT LIKE 'sqlite_%'`,
    )) as Array<{ name: string }>;
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "StockMovement_createdAt_idx",
      "StockMovement_productId_branchId_idx",
      "StockMovement_refType_refId_idx",
    ]);
  });
});
