import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../helpers/paths";

// scripts/check-drift.js es el gate que corre en build:next. Si se rompe (o si
// alguien lo desactiva), el build publica con drift. Este test lo ejecuta
// exactamente como lo ejecuta el build.
describe("scripts/check-drift.js", () => {
  it("pasa sin drift", () => {
    try {
      const out = execFileSync(process.execPath, ["scripts/check-drift.js"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: "pipe",
      });
      expect(out).toContain("OK");
    } catch (error: any) {
      const stdout = error.stdout?.toString?.() ?? "";
      const stderr = error.stderr?.toString?.() ?? "";
      expect.fail(`check-drift falló:\n${stdout}\n${stderr}`);
    }
  });
});
