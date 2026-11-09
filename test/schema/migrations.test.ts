import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, TMP_DIR, toFileUrl } from "../helpers/paths";

// La cadena de migraciones de Prisma debería poder reconstruir la base desde
// cero. Hoy NO puede: `prisma migrate deploy` falla en la migración
// 20260808_add_weborder_discount porque ninguna migración crea "WebOrder"
// (esa tabla se agregó con `db push` sobre el template).
//
// `it.fails` documenta el estado real: el día que alguien arregle la cadena,
// este test va a fallar avisando "unexpected pass" y hay que convertirlo a
// `it` normal. Es a propósito.
describe("prisma/migrations", () => {
  it.fails("reconstruye el esquema desde cero con `prisma migrate deploy`", () => {
    const dbFile = path.join(TMP_DIR, `migrate-${Date.now()}.db`);
    fs.rmSync(dbFile, { force: true });

    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "migrate", "deploy"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: toFileUrl(dbFile) },
        stdio: "pipe",
        shell: process.platform === "win32",
      }
    );

    expect(fs.existsSync(dbFile)).toBe(true);
  });
});
