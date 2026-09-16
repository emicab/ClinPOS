const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dbFiles = new Set(["dev.db", "crm_template.db"]);
const storePath = path.join(root, "prisma", "store.json");

try {
  if (fs.existsSync(storePath)) {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    for (const profile of store.profiles || []) {
      if (profile.dbFile) dbFiles.add(profile.dbFile);
    }
  }
} catch (error) {
  console.warn("[migrate-local] No se pudo leer store.json:", error.message);
}

for (const dbFile of dbFiles) {
  const databaseUrl = `file:${path.resolve(root, "prisma", dbFile).replace(/\\/g, "/")}`;
  console.log(`[migrate-local] Actualizando ${dbFile}...`);
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "prisma", "db", "push", "--skip-generate",
  ], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

console.log("[migrate-local] Bases locales actualizadas.");
