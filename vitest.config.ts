import { defineConfig } from "vitest/config";
import path from "node:path";

// La app asume hora argentina en caja, vencimientos y reportes.
// Se fija antes de que cualquier test toque Date.
process.env.TZ = "America/Argentina/Buenos_Aires";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Las pruebas de esquema levantan el CLI de Prisma.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Un archivo a la vez: cada uno abre SQLite y el cache de Prisma es global.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "app_standalone/**", "dist_tauri/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./test/.coverage",
      include: ["lib/**/*.ts", "pages/api/**/*.ts", "app/api/**/*.ts"],
      exclude: ["**/*.d.ts", "lib/prisma.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
