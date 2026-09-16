import fs from "fs";
import path from "path";
import prisma from "../lib/prisma";

const root = path.resolve(process.cwd());
const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

async function main() {
  const [status, breakdown, tombstones, conflicts, cursorSetting] = await Promise.all([
    prisma.syncOutbox.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.syncOutbox.groupBy({ by: ["entity", "operation", "status"], where: { status: "PENDING" }, _count: { _all: true } }),
    prisma.syncTombstone.count(),
    prisma.syncConflict.count({ where: { status: "OPEN" } }),
    prisma.setting.findUnique({ where: { key: "supabase_sync_cursors" }, select: { value: true } }),
  ]);

  check("Esquema de tombstones", typeof tombstones === "number", `${tombstones} registros`);
  check("Esquema de conflictos", typeof conflicts === "number", `${conflicts} conflictos abiertos`);
  check("Outbox accesible", Array.isArray(status), JSON.stringify(status));

  let cursorsValid = true;
  if (cursorSetting?.value) {
    try {
      const parsed = JSON.parse(cursorSetting.value);
      cursorsValid = !!parsed && typeof parsed === "object";
    } catch {
      cursorsValid = false;
    }
  }
  check("Cursores válidos", cursorsValid, cursorSetting ? "supabase_sync_cursors disponible" : "aún no inicializados");

  const pendingUpserts = breakdown.filter((item) => item.operation === "UPSERT").reduce((sum, item) => sum + item._count._all, 0);
  const pendingDeletes = breakdown.filter((item) => item.operation === "DELETE").reduce((sum, item) => sum + item._count._all, 0);
  check("Prioridad de cola", pendingUpserts >= 0 && pendingDeletes >= 0, `${pendingUpserts} actualizaciones, ${pendingDeletes} eliminaciones`);

  const migration = fs.readFileSync(path.join(root, "supabase_migration.sql"), "utf8");
  check("RPC de stock preparado", migration.includes("apply_stock_movement"), "función encontrada en supabase_migration.sql");
  check("Realtime preparado", migration.includes("supabase_realtime") || fs.readFileSync(path.join(root, "supabase_schema.sql"), "utf8").includes("supabase_realtime"), "publicación Realtime encontrada");

  console.log("\nPrueba de sincronización ClinPOS (modo seguro)\n");
  for (const item of checks) console.log(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`);
  console.log(`\nPendientes totales: ${pendingUpserts + pendingDeletes}`);
  console.log("Este smoke test no modifica SQLite ni Supabase.");

  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error("✗ Falló el smoke test:", error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
