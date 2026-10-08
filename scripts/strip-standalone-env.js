// scripts/strip-standalone-env.js
// `next build` copia los archivos .env del proyecto a .next/standalone, y de ahi
// pasan a app_standalone y al instalador.
//
// IMPORTANTE: hoy ese .env ES el mecanismo con el que el POS recibe su clave de
// Supabase (lib/syncService.ts y lib/licenseStatus.ts leen process.env). Si contiene
// SUPABASE_SERVICE_ROLE_KEY, cada instalador compilado localmente lleva una clave con
// acceso total a la base de TODOS los comercios.
//
// Por eso, por defecto SOLO ADVIERTE (no rompe el sync de los instaladores actuales).
// Para eliminar los .env del bundle: CLINPOS_STRIP_ENV=1 npm run build:tauri
// (el POS debera recibir la clave por otro medio: Setting supabase_service_role_key a
// nivel maquina). cloudinary.env, generado aparte, NO se toca.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dirs = [path.join(root, ".next", "standalone"), path.join(root, "app_standalone")];
const strip = process.env.CLINPOS_STRIP_ENV === "1";
let found = 0;
let hasServiceRole = false;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.env(\..+)?$/.test(name)) continue;
    const file = path.join(dir, name);
    found++;
    try {
      if (/SUPABASE_SERVICE(_ROLE)?_KEY\s*=\s*\S+/.test(fs.readFileSync(file, "utf8"))) hasServiceRole = true;
    } catch {
      // ignorar
    }
    if (strip) {
      fs.rmSync(file, { force: true });
      console.log(`[strip-env] Eliminado ${path.relative(root, file)} del bundle.`);
    }
  }
}

if (found === 0) {
  console.log("[strip-env] Sin archivos .env en el bundle. OK.");
} else if (!strip && hasServiceRole) {
  console.warn(
    "\n[strip-env] ADVERTENCIA DE SEGURIDAD: el bundle incluye un .env con SUPABASE_SERVICE_ROLE_KEY.\n" +
      "            Ese instalador llevara una clave con acceso total a la base de todos los comercios.\n" +
      "            Para excluirlo: CLINPOS_STRIP_ENV=1 (y entregar la clave por otro medio).\n",
  );
}
