// scripts/check-drift.js
// Fail-fast anti-drift en dos niveles (preciso por tabla):
//
//   Nivel 1 (schema → health): todo campo escalar/enum de schema.prisma
//     (modelos foco) debe estar listado como ["Modelo","campo"] en
//     pages/api/health/db.ts. Si agregás un campo al schema y olvidás el
//     resto, el build falla acá.
//   Nivel 2 (health → lib.rs): toda columna listada en el health debe
//     aparecer entrecomillada en src-tauri/src/lib.rs (sea en una migración
//     versionada o en EXPECTED_COLUMNS del verificador declarativo).
//
// En runtime la cobertura es total aunque un campo se olvide:
//   - ensure_expected_columns() en lib.rs lo crea (idempotente)
//   - GET /api/health/db lo reporta
//
// Fuente de verdad: prisma/schema.prisma
// Uso: node scripts/check-drift.js (exit 1 si hay drift). Integrado al
// inicio de `build:next`.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const libRsPath = path.join(root, "src-tauri", "src", "lib.rs");
const healthPath = path.join(root, "pages", "api", "health", "db.ts");

// Modelos cuyo esquema local debe estar cubierto por el migrador Tauri.
const FOCUS_MODELS = new Set([
  "Setting",
  "StoreConfig",
  "Product",
  "WebOrder",
  "WebOrderItem",
  "Coupon",
  "Sale",
  "SaleItem",
]);

// Tablas internas del protocolo de sincronización: se validan desde health y
// el migrador Tauri, pero no forman parte del grupo de modelos funcionales
// que este script compara campo por campo contra el schema principal.
const INTERNAL_SYNC_MODELS = new Set([
  "SyncOutbox",
  "SyncTombstone",
  "SyncConflict",
]);

// Tipos que corresponden a una columna SQLite (los enums mapean a TEXT).
const COLUMN_TYPES = new Set([
  "String",
  "Boolean",
  "Int",
  "Float",
  "Decimal",
  "DateTime",
  "PaymentType",
  "SaleStatus",
  "WebOrderStatus",
]);

function parseSchemaPairs(src) {
  const pairs = new Set();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    const [, model, body] = m;
    if (!FOCUS_MODELS.has(model)) continue;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("@@")) continue;
      const parts = t.split(/\s+/);
      if (parts.length < 2) continue;
      const [field, rawType] = parts;
      const base = rawType.replace(/[\[\]?]+/g, "");
      if (!COLUMN_TYPES.has(base)) continue; // relación: no es columna
      pairs.add(`${model}.${field}`);
    }
  }
  return pairs;
}

function parseHealthPairs(src) {
  const pairs = new Set();
  const re = /\["(\w+)",\s*"(\w+)"\]/g;
  let m;
  while ((m = re.exec(src)) !== null) pairs.add(`${m[1]}.${m[2]}`);
  return pairs;
}

function main() {
  const schema = fs.readFileSync(schemaPath, "utf-8");
  const libRs = fs.readFileSync(libRsPath, "utf-8");
  let health;
  try {
    health = fs.readFileSync(healthPath, "utf-8");
  } catch {
    console.error("[check-drift] Falta pages/api/health/db.ts (health endpoint).");
    process.exit(1);
  }

  const schemaPairs = parseSchemaPairs(schema);
  const healthPairs = parseHealthPairs(health);
  if (schemaPairs.size === 0) {
    console.error("[check-drift] No se parseó ningún campo: revisá el regex contra schema.prisma.");
    process.exit(1);
  }
  if (healthPairs.size === 0) {
    console.error("[check-drift] No se parseó EXPECTED_COLUMNS en health/db.ts.");
    process.exit(1);
  }

  let failed = false;

  // Nivel 1: schema → health (preciso por tabla).
  const missingInHealth = [...schemaPairs].filter((p) => !healthPairs.has(p));
  if (missingInHealth.length > 0) {
    failed = true;
    console.error("[check-drift] Campos del schema AUSENTES en pages/api/health/db.ts:");
    for (const f of missingInHealth.sort()) console.error(`  - ${f}`);
    console.error("  → Agregalos a EXPECTED_COLUMNS del endpoint y de lib.rs.\n");
  }

  // Nivel 2: health → lib.rs (por nombre de columna entrecomillada).
  const missingInLib = [...healthPairs].filter((p) => {
    const col = p.split(".")[1];
    return !libRs.includes(`"${col}"`);
  });
  if (missingInLib.length > 0) {
    failed = true;
    console.error("[check-drift] Columnas del health AUSENTES en src-tauri/src/lib.rs:");
    for (const f of missingInLib.sort()) console.error(`  - ${f}`);
    console.error('  → Agregalas a MIGRATIONS (nueva versión) + EXPECTED_COLUMNS.\n');
  }

  // Aviso (no bloquea): entradas del health que ya no existen en el schema.
  const stale = [...healthPairs].filter((p) => {
    const model = p.split(".")[0];
    return !schemaPairs.has(p) && !INTERNAL_SYNC_MODELS.has(model);
  });
  if (stale.length > 0) {
    console.warn("[check-drift] Aviso: entradas obsoletas en health (no están en schema):");
    for (const f of stale.sort()) console.warn(`  - ${f}`);
  }

  if (failed) {
    console.error("[check-drift] DRIFT DETECTADO. Build bloqueado por seguridad.");
    process.exit(1);
  }
  console.log(
    `[check-drift] OK: ${schemaPairs.size} campos del schema cubiertos en health y lib.rs.`
  );
}

main();
