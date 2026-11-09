import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { copyDb, openDb, removeDb } from "../helpers/db";
import { diffSchemas, readSchema, schemaTables, type SchemaShape } from "../helpers/schema";
import { BASE_DB, TEMPLATE_DB } from "../helpers/paths";

// prisma/crm_template.db es lo que se empaqueta en el instalador: es la base
// que recibe un cliente nuevo. Si se atrasa respecto de schema.prisma, una
// instalación limpia arranca con tablas/columnas faltantes y falla en runtime.
//
// Este test es el que habría detectado que StockMovement no estaba en el
// template mientras lib/stockService.ts lo escribe en cada venta.
describe("prisma/crm_template.db (base del instalador)", () => {
  let canonical: SchemaShape;
  let template: SchemaShape;
  let canonicalDb: PrismaClient;
  let templateDb: PrismaClient;
  const files: string[] = [];

  beforeAll(async () => {
    const canonicalFile = copyDb(BASE_DB, "canonical");
    const templateFile = copyDb(TEMPLATE_DB, "template");
    files.push(canonicalFile, templateFile);

    canonicalDb = openDb(canonicalFile);
    templateDb = openDb(templateFile);

    canonical = await readSchema(canonicalDb);
    template = await readSchema(templateDb);
  });

  afterAll(async () => {
    await canonicalDb?.$disconnect();
    await templateDb?.$disconnect();
    for (const f of files) removeDb(f);
  });

  it("existe y es un archivo SQLite válido", () => {
    expect(fs.existsSync(TEMPLATE_DB), `Falta ${TEMPLATE_DB}`).toBe(true);
    expect(template.size).toBeGreaterThan(0);
  });

  it("tiene todas las tablas que declara schema.prisma", () => {
    const expected = schemaTables();
    const missing = expected.filter((t) => !template.has(t));
    expect(
      missing,
      `El template no tiene estas tablas del schema: ${missing.join(", ")}. ` +
        `Regeneralo con: npm run build:next (scripts/migrate-template.js)`
    ).toEqual([]);
  });

  it("no tiene tablas huérfanas que ya no existen en el schema", () => {
    const expected = new Set(schemaTables());
    const orphans = [...template.keys()].filter((t) => !expected.has(t));
    expect(orphans, `Tablas en el template sin modelo en schema.prisma: ${orphans.join(", ")}`).toEqual([]);
  });

  it("coincide exactamente con una instalación limpia (tablas, columnas e índices)", () => {
    const diff = diffSchemas(canonical, template);
    expect(diff.isEmpty, `\n${diff.format()}\n`).toBe(true);
  });

  it("trae los datos semilla mínimos para arrancar", async () => {
    const [branches, storeConfigs, settings] = await Promise.all([
      templateDb.$queryRawUnsafe<Array<{ c: number }>>(`SELECT count(*) AS c FROM "Branch"`),
      templateDb.$queryRawUnsafe<Array<{ c: number }>>(`SELECT count(*) AS c FROM "StoreConfig"`),
      templateDb.$queryRawUnsafe<Array<{ c: number }>>(`SELECT count(*) AS c FROM "Setting"`),
    ]);

    expect(Number(branches[0].c), "El template necesita al menos una sucursal").toBeGreaterThan(0);
    expect(Number(storeConfigs[0].c), "El template necesita StoreConfig para la tienda web").toBeGreaterThan(0);
    expect(Number(settings[0].c), "El template necesita Settings (licencia, sync, etc.)").toBeGreaterThan(0);
  });
});
