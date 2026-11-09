import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";

// Valida el harness que usa el resto de la suite: base aislada por test,
// Prisma apuntando a esa base, y dinero leído como Decimal (nunca float).
describe("harness de base de datos", () => {
  it("crea una base aislada y permite escribir/leer", async () => {
    const t = await createTestDb("harness");
    try {
      const category = await t.db.category.create({ data: { name: "Categoría test" } });
      const product = await t.db.product.create({
        data: {
          name: "Producto test",
          pricePurchase: "10.50",
          priceSale: "20.00",
          quantityStock: 5,
          categoryId: category.id,
        },
      });

      expect(await t.db.product.count()).toBe(1);
      expect(product.priceSale.toString()).toMatch(/^20(\.0+)?$/);
    } finally {
      await t.cleanup();
    }
  });

  it("aísla cada test en su propio archivo", async () => {
    const a = await createTestDb("aislamiento-a");
    const b = await createTestDb("aislamiento-b");
    try {
      await a.db.category.create({ data: { name: "Solo en A" } });

      expect(await a.db.category.count()).toBe(1);
      expect(await b.db.category.count()).toBe(0);
      expect(a.file).not.toBe(b.file);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
