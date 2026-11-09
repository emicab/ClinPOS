import path from "node:path";

/** Carpeta de artefactos efímeros de los tests (gitignored). */
export const TMP_DIR = path.resolve(__dirname, "..", ".tmp");

/** Base canónica: salida de `prisma db push` sobre prisma/schema.prisma. */
export const BASE_DB = path.join(TMP_DIR, "base.db");

/** Template que se empaqueta en el instalador. */
export const TEMPLATE_DB = path.resolve(__dirname, "..", "..", "prisma", "crm_template.db");

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** SQLite/Prisma espera URLs con barras normales, incluso en Windows. */
export function toFileUrl(file: string): string {
  return `file:${file.replace(/\\/g, "/")}`;
}
