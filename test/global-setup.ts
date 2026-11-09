// test/global-setup.ts
// Prepara una base SQLite "canónica" a partir de prisma/schema.prisma usando
// `prisma db push`. Es la referencia contra la que se comparan el template
// binario y las migraciones.
//
// Se ejecuta UNA vez por corrida de tests; cada test copia el archivo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TMP_DIR, BASE_DB, toFileUrl } from "./helpers/paths";

export default function setup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Siempre se regenera: si el schema cambió, la referencia cambia con él.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${BASE_DB}${suffix}`, { force: true });
  }

  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: toFileUrl(BASE_DB) },
      stdio: "pipe",
      shell: process.platform === "win32",
    }
  );

  if (!fs.existsSync(BASE_DB)) {
    throw new Error("[test] No se pudo generar la base canónica con prisma db push.");
  }
}
