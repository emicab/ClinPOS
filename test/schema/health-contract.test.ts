import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { copyDb, openDb, removeDb } from "../helpers/db";
import { readSchema, type SchemaShape } from "../helpers/schema";
import { REPO_ROOT, TEMPLATE_DB } from "../helpers/paths";

// pages/api/health/db.ts es lo que consulta el arranque de Tauri antes de
// mostrar la app. Si lista una tabla/columna que no existe, o deja de listar
// una que sí existe, el health miente.
const HEALTH_FILE = path.join(REPO_ROOT, "pages", "api", "health", "db.ts");

function parseExpectedTables(source: string): string[] {
  const block = source.match(/const EXPECTED_TABLES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("No se encontró EXPECTED_TABLES en health/db.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function parseExpectedColumns(source: string): Array<[string, string]> {
  const block = source.match(/const EXPECTED_COLUMNS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("No se encontró EXPECTED_COLUMNS en health/db.ts");
  return [...block[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => [m[1], m[2]]);
}

describe("pages/api/health/db.ts vs el template real", () => {
  let schema: SchemaShape;
  let db: PrismaClient;
  let file: string;
  const source = fs.readFileSync(HEALTH_FILE, "utf-8");

  beforeAll(async () => {
    file = copyDb(TEMPLATE_DB, "health");
    db = openDb(file);
    schema = await readSchema(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
    removeDb(file);
  });

  it("lista solo tablas que existen", () => {
    const missing = parseExpectedTables(source).filter((t) => !schema.has(t));
    expect(missing, `health/db.ts espera tablas inexistentes: ${missing.join(", ")}`).toEqual([]);
  });

  it("lista solo columnas que existen", () => {
    const missing = parseExpectedColumns(source)
      .filter(([table, column]) => {
        const shape = schema.get(table);
        return !shape || !shape.columns.some((c) => c.name === column);
      })
      .map(([t, c]) => `${t}.${c}`);

    expect(missing, `health/db.ts espera columnas inexistentes: ${missing.join(", ")}`).toEqual([]);
  });

  // TODO (decisión de producto): hoy el health cubre 10 tablas de 44 a
  // propósito. Expandirlo hace que una DB vieja sin esas tablas bloquee el
  // arranque de Tauri, así que se decide junto con la estrategia de upgrades.
  it.todo("cubre todas las tablas del schema (requiere ampliar EXPECTED_TABLES)");
});
