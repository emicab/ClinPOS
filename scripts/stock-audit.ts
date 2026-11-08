// scripts/stock-audit.ts
// Auditoría de stock SOLO LECTURA. No repara nada: detecta inconsistencias y
// las reporta en consola + un CSV.
//
// Uso:
//   npx tsx scripts/stock-audit.ts
//   npx tsx scripts/stock-audit.ts --db prisma/business_xxx.db
//   npx tsx scripts/stock-audit.ts --csv C:\ruta\auditoria.csv
//   npx tsx scripts/stock-audit.ts --fail-on-issues
//
// Por defecto resuelve la base activa desde prisma/store.json (activeProfileId),
// nunca usa el DATABASE_URL de .env para no auditar la base equivocada.
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";

type Finding = {
  severity: "ERROR" | "WARN" | "INFO";
  code: string;
  productId: number | null;
  productName: string;
  branchId: number | null;
  message: string;
  expected: number | null;
  actual: number | null;
  delta: number | null;
};

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}
const failOnIssues = args.includes("--fail-on-issues");

function resolveDbPath(): string {
  const explicit = argValue("--db");
  if (explicit) {
    const abs = path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(abs)) throw new Error(`No existe la base indicada: ${abs}`);
    return abs;
  }

  const prismaDir = path.join(process.cwd(), "prisma");
  const storePath = path.join(prismaDir, "store.json");
  if (fs.existsSync(storePath)) {
    try {
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const profiles: Array<{ id: string; dbFile: string }> = Array.isArray(store.profiles) ? store.profiles : [];
      const active = profiles.find((p) => p.id === store.activeProfileId) ?? profiles[0];
      if (active?.dbFile) {
        const abs = path.isAbsolute(active.dbFile) ? active.dbFile : path.join(prismaDir, active.dbFile);
        if (fs.existsSync(abs)) return abs;
      }
    } catch {
      // cae al mensaje de error de abajo
    }
  }

  const envUrl = process.env.DATABASE_URL || "";
  const match = envUrl.match(/^file:(.*)$/i);
  if (match) {
    const p = match[1].replace(/^\/\//, "");
    const abs = path.isAbsolute(p) ? p : path.join(prismaDir, p);
    if (fs.existsSync(abs)) return abs;
  }

  throw new Error(
    "No se pudo resolver la base activa. Indicá una con --db <ruta> " +
      "(se esperaba prisma/store.json con activeProfileId).",
  );
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const dbPath = resolveDbPath();
  const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath.replace(/\\/g, "/")}` });
  const findings: Finding[] = [];

  const print = (line = "") => console.log(line);

  try {
    print("============================================================");
    print(" AUDITORÍA DE STOCK (solo lectura)");
    print("============================================================");
    print(`Base: ${dbPath}`);
    print(`Fecha: ${new Date().toISOString()}`);
    print("");

    const [products, branchStocks, branches] = await Promise.all([
      prisma.product.findMany({
        select: {
          id: true,
          name: true,
          quantityStock: true,
          stockMinAlert: true,
          isRecipe: true,
          isIngredient: true,
        },
        orderBy: { id: "asc" },
      }),
      prisma.productBranchStock.findMany({
        select: { productId: true, branchId: true, quantityStock: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true, isMain: true } }),
    ]);

    const branchById = new Map(branches.map((b) => [b.id, b]));
    const rowsByProduct = new Map<number, Array<{ branchId: number; quantityStock: number }>>();
    for (const row of branchStocks) {
      const list = rowsByProduct.get(row.productId) ?? [];
      list.push({ branchId: row.branchId, quantityStock: Number(row.quantityStock) || 0 });
      rowsByProduct.set(row.productId, list);
    }

    if (branches.length === 0) {
      findings.push({
        severity: "WARN",
        code: "NO_BRANCHES",
        productId: null,
        productName: "",
        branchId: null,
        message: "No hay sucursales: el stock se maneja solo en Product.quantityStock.",
        expected: null,
        actual: null,
        delta: null,
      });
    }

    // 1. Global != suma de sucursales
    for (const p of products) {
      const rows = rowsByProduct.get(p.id);
      if (!rows || rows.length === 0) continue;
      const sum = rows.reduce((acc, r) => acc + r.quantityStock, 0);
      const total = Number(p.quantityStock) || 0;
      if (Math.abs(sum - total) > 1e-6) {
        findings.push({
          severity: "ERROR",
          code: "GLOBAL_MISMATCH",
          productId: p.id,
          productName: p.name,
          branchId: null,
          message: `Product.quantityStock (${total}) != suma por sucursal (${sum}).`,
          expected: sum,
          actual: total,
          delta: total - sum,
        });
      }
      if (p.isRecipe && Math.abs(total) > 1e-6) {
        findings.push({
          severity: "WARN",
          code: "RECIPE_HAS_STOCK",
          productId: p.id,
          productName: p.name,
          branchId: null,
          message: `Elaborado con stock físico propio (${total}); su stock se deriva de ingredientes.`,
          expected: 0,
          actual: total,
          delta: total,
        });
      }
    }

    // 2. Productos simples sin fila por sucursal (no aparecen en pantallas por sucursal)
    if (branches.length > 0) {
      for (const p of products) {
        if (p.isRecipe) continue;
        const rows = rowsByProduct.get(p.id);
        if (!rows || rows.length === 0) {
          findings.push({
            severity: "WARN",
            code: "NO_BRANCH_ROW",
            productId: p.id,
            productName: p.name,
            branchId: null,
            message: "Producto sin fila en ProductBranchStock: no se puede vender por sucursal.",
            expected: Number(p.quantityStock) || 0,
            actual: 0,
            delta: -(Number(p.quantityStock) || 0),
          });
        }
      }
    }

    // 3. Stock negativo por sucursal
    for (const row of branchStocks) {
      const qty = Number(row.quantityStock) || 0;
      if (qty < -1e-6) {
        const p = products.find((x) => x.id === row.productId);
        findings.push({
          severity: "ERROR",
          code: "NEGATIVE_BRANCH_STOCK",
          productId: row.productId,
          productName: p?.name ?? "",
          branchId: row.branchId,
          message: `Stock negativo (${qty}) en sucursal ${branchById.get(row.branchId)?.name ?? row.branchId}.`,
          expected: 0,
          actual: qty,
          delta: qty,
        });
      }
    }

    // 4. Elaborados con filas de stock no nulo (solo informativo)
    for (const p of products) {
      if (!p.isRecipe) continue;
      const rows = rowsByProduct.get(p.id) ?? [];
      const nonZero = rows.filter((r) => Math.abs(r.quantityStock) > 1e-6);
      if (nonZero.length > 0) {
        findings.push({
          severity: "INFO",
          code: "RECIPE_BRANCH_ROWS",
          productId: p.id,
          productName: p.name,
          branchId: null,
          message: `Elaborado con ${nonZero.length} fila(s) de sucursal con stock distinto de 0 (no se usa para vender).`,
          expected: 0,
          actual: nonZero.reduce((a, r) => a + r.quantityStock, 0),
          delta: null,
        });
      }
    }

    // 5. Ledger: conteo y últimos movimientos
    let movementCount = 0;
    let recentMovements: any[] = [];
    try {
      movementCount = await prisma.stockMovement.count();
      recentMovements = await prisma.stockMovement.findMany({
        orderBy: { id: "desc" },
        take: 10,
        select: {
          id: true,
          productId: true,
          branchId: true,
          delta: true,
          quantityAfter: true,
          reason: true,
          refType: true,
          refId: true,
          createdAt: true,
        },
      });
    } catch {
      findings.push({
        severity: "INFO",
        code: "NO_LEDGER_TABLE",
        productId: null,
        productName: "",
        branchId: null,
        message: "La tabla StockMovement no existe todavía en esta base.",
        expected: null,
        actual: null,
        delta: null,
      });
    }

    // ---- Reporte ----
    const errors = findings.filter((f) => f.severity === "ERROR");
    const warnings = findings.filter((f) => f.severity === "WARN");
    const infos = findings.filter((f) => f.severity === "INFO");

    print(`Productos: ${products.length} (elaborados: ${products.filter((p) => p.isRecipe).length})`);
    print(`Sucursales: ${branches.length}`);
    print(`Filas ProductBranchStock: ${branchStocks.length}`);
    print(`Movimientos en el ledger: ${movementCount}`);
    print("");
    print(`Hallazgos: ${errors.length} error(es), ${warnings.length} aviso(s), ${infos.length} info.`);
    print("");

    for (const f of findings) {
      const where = f.branchId !== null ? ` [sucursal ${f.branchId}]` : "";
      print(`[${f.severity}] ${f.code} — ${f.productName || "(general)"}${where}`);
      print(`         ${f.message}`);
    }
    if (findings.length === 0) {
      print("Sin inconsistencias detectadas. ✅");
    }

    if (recentMovements.length > 0) {
      print("");
      print("Últimos movimientos:");
      for (const m of recentMovements) {
        print(
          `  #${m.id} producto=${m.productId} sucursal=${m.branchId ?? "-"} delta=${m.delta} ` +
            `queda=${m.quantityAfter} motivo=${m.reason} ref=${m.refType ?? "-"}:${m.refId ?? "-"} ` +
            `${new Date(m.createdAt).toISOString()}`,
        );
      }
    }

    // ---- CSV ----
    const csvPath =
      argValue("--csv") ??
      path.join(os.tmpdir(), `clinpos-stock-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    const header =
      "severity,code,productId,productName,branchId,expected,actual,delta,message\r\n";
    const body = findings
      .map((f) =>
        [
          f.severity,
          f.code,
          f.productId,
          f.productName,
          f.branchId,
          f.expected,
          f.actual,
          f.delta,
          f.message,
        ]
          .map(csvEscape)
          .join(","),
      )
      .join("\r\n");
    fs.writeFileSync(csvPath, header + body, "utf-8");
    print("");
    print(`CSV: ${csvPath}`);

    if (failOnIssues && errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Error ejecutando la auditoría:", err);
  process.exit(1);
});
