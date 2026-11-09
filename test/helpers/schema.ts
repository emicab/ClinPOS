// test/helpers/schema.ts
// Introspección de SQLite para comparar la forma REAL de una base contra el
// schema de Prisma. Es la base de los tests anti-drift.
import { Prisma, PrismaClient } from "@prisma/client";

export interface ColumnShape {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  default: string | null;
}

export interface IndexShape {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface TableShape {
  name: string;
  columns: ColumnShape[];
  indexes: IndexShape[];
}

export type SchemaShape = Map<string, TableShape>;

const IGNORED_TABLES = new Set(["_prisma_migrations"]);

/** Lee la forma completa de una base SQLite. */
export async function readSchema(db: PrismaClient): Promise<SchemaShape> {
  const tables = (await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  )).filter((t) => !IGNORED_TABLES.has(t.name));

  const schema: SchemaShape = new Map();

  for (const { name: table } of tables) {
    const rawColumns = await db.$queryRawUnsafe<
      Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>
    >(`PRAGMA table_info("${table}")`);

    const columns: ColumnShape[] = rawColumns
      .map((c) => ({
        name: c.name,
        type: (c.type || "").toUpperCase(),
        notNull: c.notnull === 1,
        pk: c.pk > 0,
        default: c.dflt_value,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const rawIndexes = await db.$queryRawUnsafe<
      Array<{ name: string; is_unique: number; origin: string }>
    >(`SELECT name, "unique" AS is_unique, origin FROM pragma_index_list('${table}')`);

    const indexes: IndexShape[] = [];
    for (const idx of rawIndexes) {
      // Los índices automáticos de PK/UNIQUE no los declara Prisma.
      if (idx.origin === "pk" || idx.name.startsWith("sqlite_autoindex")) continue;
      const cols = await db.$queryRawUnsafe<Array<{ name: string | null }>>(
        `SELECT name FROM pragma_index_info('${idx.name}') ORDER BY seqno`
      );
      indexes.push({
        name: idx.name,
        unique: idx.is_unique === 1,
        columns: cols.map((c) => c.name ?? "<expr>"),
      });
    }
    indexes.sort((a, b) => a.name.localeCompare(b.name));

    schema.set(table, { name: table, columns, indexes });
  }

  return schema;
}

export interface SchemaDiff {
  missingTables: string[];
  extraTables: string[];
  missingColumns: string[];
  extraColumns: string[];
  changedColumns: string[];
  missingIndexes: string[];
  extraIndexes: string[];
  changedIndexes: string[];
  get isEmpty(): boolean;
  format(): string;
}

export function diffSchemas(expected: SchemaShape, actual: SchemaShape): SchemaDiff {
  const missingTables: string[] = [];
  const extraTables: string[] = [];
  const missingColumns: string[] = [];
  const extraColumns: string[] = [];
  const changedColumns: string[] = [];
  const missingIndexes: string[] = [];
  const extraIndexes: string[] = [];
  const changedIndexes: string[] = [];

  for (const [name, table] of expected) {
    const other = actual.get(name);
    if (!other) {
      missingTables.push(name);
      continue;
    }

    const otherCols = new Map(other.columns.map((c) => [c.name, c]));
    for (const col of table.columns) {
      const match = otherCols.get(col.name);
      if (!match) {
        missingColumns.push(`${name}.${col.name}`);
        continue;
      }
      if (match.type !== col.type || match.notNull !== col.notNull || match.pk !== col.pk) {
        changedColumns.push(
          `${name}.${col.name} (esperado ${col.type}${col.notNull ? " NOT NULL" : ""}${col.pk ? " PK" : ""} / real ${match.type}${match.notNull ? " NOT NULL" : ""}${match.pk ? " PK" : ""})`
        );
      }
    }
    const expectedCols = new Set(table.columns.map((c) => c.name));
    for (const col of other.columns) {
      if (!expectedCols.has(col.name)) extraColumns.push(`${name}.${col.name}`);
    }

    const otherIdx = new Map(other.indexes.map((i) => [i.name, i]));
    for (const idx of table.indexes) {
      const match = otherIdx.get(idx.name);
      if (!match) {
        missingIndexes.push(`${name}.${idx.name} (${idx.columns.join(",")})`);
        continue;
      }
      if (match.unique !== idx.unique || match.columns.join(",") !== idx.columns.join(",")) {
        changedIndexes.push(
          `${name}.${idx.name} (esperado ${idx.columns.join(",")}${idx.unique ? " UNIQUE" : ""} / real ${match.columns.join(",")}${match.unique ? " UNIQUE" : ""})`
        );
      }
    }
    const expectedIdx = new Set(table.indexes.map((i) => i.name));
    for (const idx of other.indexes) {
      if (!expectedIdx.has(idx.name)) extraIndexes.push(`${name}.${idx.name} (${idx.columns.join(",")})`);
    }
  }

  for (const name of actual.keys()) {
    if (!expected.has(name)) extraTables.push(name);
  }

  const isEmpty =
    !missingTables.length &&
    !extraTables.length &&
    !missingColumns.length &&
    !extraColumns.length &&
    !changedColumns.length &&
    !missingIndexes.length &&
    !extraIndexes.length &&
    !changedIndexes.length;

  return {
    missingTables,
    extraTables,
    missingColumns,
    extraColumns,
    changedColumns,
    missingIndexes,
    extraIndexes,
    changedIndexes,
    get isEmpty() {
      return isEmpty;
    },
    format() {
      const sections: Array<[string, string[]]> = [
        ["Tablas ausentes", missingTables],
        ["Tablas de más", extraTables],
        ["Columnas ausentes", missingColumns],
        ["Columnas de más", extraColumns],
        ["Columnas distintas", changedColumns],
        ["Índices ausentes", missingIndexes],
        ["Índices de más", extraIndexes],
        ["Índices distintos", changedIndexes],
      ];
      return sections
        .filter(([, items]) => items.length > 0)
        .map(([title, items]) => `${title} (${items.length}):\n  - ${items.join("\n  - ")}`)
        .join("\n");
    },
  };
}

/**
 * Tablas que Prisma espera según schema.prisma.
 * Usa el DMMF generado, así que nunca se desincroniza del schema.
 */
export function schemaTables(): string[] {
  const models = (Prisma.dmmf as any)?.datamodel?.models ?? [];
  return models.map((m: any) => m.dbName ?? m.name).sort();
}

/** Columnas escalares por tabla, según el DMMF. */
export function schemaColumns(): Map<string, string[]> {
  const models = (Prisma.dmmf as any)?.datamodel?.models ?? [];
  const out = new Map<string, string[]>();
  for (const model of models) {
    const table = model.dbName ?? model.name;
    const cols = model.fields
      .filter((f: any) => f.kind === "scalar" || f.kind === "enum")
      .map((f: any) => f.dbName ?? f.name);
    out.set(table, cols);
  }
  return out;
}
