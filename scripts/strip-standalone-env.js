// scripts/strip-standalone-env.js
// `next build` copia los archivos .env del proyecto a .next/standalone, y de ahi
// pasan a app_standalone y al instalador. Eso empaquetaba SUPABASE_SERVICE_ROLE_KEY
// (acceso total a la base de todos los comercios) dentro de cada instalador compilado
// localmente. Este paso los elimina del bundle. (cloudinary.env, generado aparte con
// solo las credenciales de Cloudinary, NO se toca.)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dirs = [path.join(root, ".next", "standalone"), path.join(root, "app_standalone")];
let removed = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (/^\.env(\..+)?$/.test(name)) {
      fs.rmSync(path.join(dir, name), { force: true });
      console.log(`[strip-env] Eliminado ${path.relative(root, path.join(dir, name))} del bundle.`);
      removed++;
    }
  }
}

if (removed === 0) console.log("[strip-env] Sin archivos .env en el bundle. OK.");
