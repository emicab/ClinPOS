import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { BASE_DB, TMP_DIR, toFileUrl } from "./paths";

export interface TestDb {
  db: PrismaClient;
  file: string;
  cleanup: () => Promise<void>;
}

/** Copia una DB a un archivo único para aislar cada test. */
export function copyDb(source: string, label = "test"): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dest = path.join(TMP_DIR, `${label}-${crypto.randomUUID()}.db`);
  fs.copyFileSync(source, dest);
  return dest;
}

export function openDb(file: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: toFileUrl(file) });
}

export function removeDb(file: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

/**
 * Abre una copia limpia de la base canónica (schema.prisma).
 * Usar SIEMPRE esto en vez de dev.db o crm_template.db.
 */
export async function createTestDb(label = "test"): Promise<TestDb> {
  const file = copyDb(BASE_DB, label);
  const db = openDb(file);
  return {
    db,
    file,
    cleanup: async () => {
      await db.$disconnect();
      removeDb(file);
    },
  };
}
