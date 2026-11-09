import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { copyDb, openDb, removeDb } from "../helpers/db";
import { readSchema, schemaColumns, schemaTables, type SchemaShape } from "../helpers/schema";
import { REPO_ROOT, TEMPLATE_DB } from "../helpers/paths";

// src-tauri/src/lib.rs tiene DDL escrito a mano. Es la única vía por la que un
// cliente que actualiza desde una versión vieja recibe tablas/columnas nuevas.
// Un typo o un modelo olvidado acá rompe solo en las máquinas actualizadas.
const LIB_RS = path.join(REPO_ROOT, "src-tauri", "src", "lib.rs");

function createdTables(source: string): string[] {
  const names = [...source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(names)].filter((n) => !n.endsWith("_new"));
}

function expectedColumns(source: string): Array<[string, string]> {
  const block = source.match(/const EXPECTED_COLUMNS[^=]*=\s*&\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("No se encontró EXPECTED_COLUMNS en lib.rs");
  return [...block[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"[^"]*"\s*\)/g)].map(
    (m) => [m[1], m[2]] as [string, string]
  );
}

describe("src-tauri/src/lib.rs (migrador de upgrades)", () => {
  const source = fs.readFileSync(LIB_RS, "utf-8");
  const tables = schemaTables();
  const columns = schemaColumns();

  let template: SchemaShape;
  let db: PrismaClient;
  let file: string;

  beforeAll(async () => {
    file = copyDb(TEMPLATE_DB, "rust");
    db = openDb(file);
    template = await readSchema(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
    removeDb(file);
  });

  it("solo crea tablas que existen en schema.prisma", () => {
    const known = new Set(tables);
    const unknown = createdTables(source).filter((t) => !known.has(t));
    expect(unknown, `lib.rs crea tablas que no son modelos de Prisma: ${unknown.join(", ")}`).toEqual([]);
  });

  it("EXPECTED_COLUMNS solo referencia columnas reales del schema", () => {
    const invalid = expectedColumns(source)
      .filter(([table, column]) => {
        const cols = columns.get(table);
        return !cols || !cols.includes(column);
      })
      .map(([t, c]) => `${t}.${c}`);

    expect(invalid, `lib.rs espera columnas inexistentes en schema.prisma: ${invalid.join(", ")}`).toEqual([]);
  });

  it("cada tabla de EXPECTED_COLUMNS existe en el template o la crea MIGRATIONS", () => {
    const creatable = new Set(createdTables(source));
    const orphans = [...new Set(expectedColumns(source).map(([t]) => t))].filter(
      (t) => !template.has(t) && !creatable.has(t)
    );

    expect(
      orphans,
      `ensure_expected_columns las saltearía en silencio (tabla ausente y sin DDL): ${orphans.join(", ")}`
    ).toEqual([]);
  });

  it("todo CREATE TABLE es idempotente (IF NOT EXISTS) salvo las tablas de rebuild", () => {
    const unsafe = [...source.matchAll(/CREATE TABLE (?!IF NOT EXISTS)(?:"([^"]+)")/g)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith("_new"));

    expect(
      unsafe,
      `Estas tablas se crean sin IF NOT EXISTS y rompen en el segundo arranque: ${unsafe.join(", ")}`
    ).toEqual([]);
  });
});
