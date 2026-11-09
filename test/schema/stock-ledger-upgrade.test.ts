import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { copyDb, openDb, removeDb } from "../helpers/db";
import { diffSchemas, readSchema, type TableShape } from "../helpers/schema";
import { REPO_ROOT, TEMPLATE_DB } from "../helpers/paths";

// StockMovement es el ledger que lib/stockService.ts escribe en CADA venta,
// compra, traspaso y receta. Es una tabla nueva (v28). Una instalación que
// actualiza desde 1.18.4 no la tiene: el template no se copia sobre la base
// existente y `prisma db push` no corre en la app empaquetada. Si MIGRATIONS
// no la crea, la primera operación de stock falla con P2021.
//
// Este test simula exactamente ese upgrade: toma el template, borra la tabla
// y aplica el SQL que realmente viaja en src-tauri/src/lib.rs.
const LIB_RS = path.join(REPO_ROOT, "src-tauri", "src", "lib.rs");

function migrationSql(source: string, version: number): string {
  const re = new RegExp(
    `Migration \\{\\s*version: ${version},[\\s\\S]*?sql: r#"([\\s\\S]*?)"#,`,
  );
  const match = source.match(re);
  if (!match) throw new Error(`No se encontró la migración v${version} en lib.rs`);
  return match[1];
}

function statements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("upgrade desde 1.18.4: la base recibe StockMovement", () => {
  const source = fs.readFileSync(LIB_RS, "utf-8");
  let db: PrismaClient;
  let file: string;
  let canonical: TableShape;

  beforeAll(async () => {
    file = copyDb(TEMPLATE_DB, "stock-ledger-upgrade");
    db = openDb(file);
    canonical = (await readSchema(db)).get("StockMovement")!;
    expect(canonical, "el template debe tener StockMovement").toBeDefined();

    // Base "vieja": sin el ledger.
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "StockMovement"`);
    expect((await readSchema(db)).has("StockMovement")).toBe(false);
  });

  afterAll(async () => {
    await db?.$disconnect();
    removeDb(file);
  });

  it("la migración v28 crea la tabla idéntica al schema", async () => {
    for (const statement of statements(migrationSql(source, 28))) {
      await db.$executeRawUnsafe(statement);
    }

    const upgraded = (await readSchema(db)).get("StockMovement");
    expect(upgraded, "la migración no creó StockMovement").toBeDefined();

    const diff = diffSchemas(
      new Map([["StockMovement", canonical]]),
      new Map([["StockMovement", upgraded!]]),
    );
    expect(diff.format()).toBe("");
  });

  it("es idempotente: correrla de nuevo no rompe", async () => {
    for (const statement of statements(migrationSql(source, 28))) {
      await db.$executeRawUnsafe(statement);
    }
    expect((await readSchema(db)).has("StockMovement")).toBe(true);
  });

  it("acepta un movimiento real con FK a Product", async () => {
    const product = await db.product.findFirstOrThrow();

    await db.stockMovement.create({
      data: {
        productId: product.id,
        delta: -2,
        quantityAfter: 8,
        reason: "SALE",
        refType: "Sale",
        refId: "1",
      },
    });

    const movement = await db.stockMovement.findFirstOrThrow();
    expect(Number(movement.delta)).toBe(-2);
    expect(Number(movement.quantityAfter)).toBe(8);
    expect(movement.reason).toBe("SALE");
  });
});
