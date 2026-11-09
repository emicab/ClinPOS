import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/db";
import {
  makeBranch,
  makeBranchStock,
  makeProduct,
} from "../../helpers/factories";
import {
  addStock,
  applyMovement,
  getBranchStock,
  recalcProductTotal,
  setStock,
  withStockTransaction,
} from "../../../lib/stockService";
import { setupApi, teardownApi } from "../../helpers/api";

// lib/stockService.ts es la ÚNICA vía de escritura de stock. Si se rompe el
// invariante "Product.quantityStock = Σ ProductBranchStock", los reportes, la
// tienda web y los traspasos muestran cantidades distintas para el mismo
// producto. Estos tests fijan ese contrato.
describe("stockService", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb("stock");
  });

  afterEach(async () => {
    await t.cleanup();
  });

  describe("applyMovement", () => {
    it("deja Product.quantityStock igual a la suma de las sucursales", async () => {
      const b1 = await makeBranch(t.db);
      const b2 = await makeBranch(t.db);
      // quantityStock arranca desincronizado a propósito: el primer movimiento
      // debe recalcularlo, no confiar en el valor previo.
      const p = await makeProduct(t.db, { quantityStock: 999 });

      await applyMovement(t.db, { productId: p.id, branchId: b1.id, delta: 10, reason: "TEST" });
      await applyMovement(t.db, { productId: p.id, branchId: b2.id, delta: 5, reason: "TEST" });

      const rows = await t.db.productBranchStock.findMany({ where: { productId: p.id } });
      expect(rows.map((r) => r.quantityStock).sort((a, b) => a - b)).toEqual([5, 10]);

      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(15);
    });

    it("aísla el stock entre sucursales", async () => {
      const b1 = await makeBranch(t.db);
      const b2 = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b1.id, 10);
      await makeBranchStock(t.db, p.id, b2.id, 4);

      await applyMovement(t.db, { productId: p.id, branchId: b1.id, delta: -3, reason: "SALE" });

      expect(await getBranchStock(t.db, p.id, b1.id)).toBe(7);
      expect(await getBranchStock(t.db, p.id, b2.id)).toBe(4);
    });

    it("rechaza dejar el stock negativo", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 5);

      await expect(
        applyMovement(t.db, { productId: p.id, branchId: b.id, delta: -6, reason: "SALE" }),
      ).rejects.toThrow(/Stock insuficiente/);

      expect(await getBranchStock(t.db, p.id, b.id)).toBe(5);
      expect(await t.db.stockMovement.count()).toBe(0);
    });

    it("permite el negativo cuando el llamador lo pide (reservas web)", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 5);

      const res = await applyMovement(t.db, {
        productId: p.id,
        branchId: b.id,
        delta: -8,
        reason: "WEB_RESERVE",
        allowNegative: true,
      });

      expect(res.branchStock).toBe(-3);
      expect(res.productStock).toBe(-3);
      const movement = await t.db.stockMovement.findFirstOrThrow();
      expect(movement.quantityAfter).toBe(-3);
    });

    it("normaliza a 0 el negativo por error de coma flotante", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 1);

      // 1 - 1.0000000000001 = -1e-13: es ruido, no stock negativo real.
      const res = await applyMovement(t.db, {
        productId: p.id,
        branchId: b.id,
        delta: -1.0000000000001,
        reason: "SALE",
      });

      expect(res.branchStock).toBe(0);
      expect(await getBranchStock(t.db, p.id, b.id)).toBe(0);
    });

    it("un delta 0 no escribe ledger ni toca el stock", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 5);

      const res = await applyMovement(t.db, { productId: p.id, branchId: b.id, delta: 0, reason: "TEST" });

      expect(res.applied).toBe(0);
      expect(await t.db.stockMovement.count()).toBe(0);
      expect(await getBranchStock(t.db, p.id, b.id)).toBe(5);
    });

    it("registra motivo, referencia y cantidad resultante en el ledger", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 10);

      await applyMovement(t.db, {
        productId: p.id,
        branchId: b.id,
        delta: -2,
        reason: "SALE",
        refType: "Sale",
        refId: 77,
        note: "Producto de prueba",
      });

      const movement = await t.db.stockMovement.findFirstOrThrow();
      expect(movement).toMatchObject({
        productId: p.id,
        branchId: b.id,
        delta: -2,
        quantityAfter: 8,
        reason: "SALE",
        refType: "Sale",
        refId: "77",
        note: "Producto de prueba",
      });
    });

    it("sin sucursal escribe solo el stock global (instalación legacy)", async () => {
      const p = await makeProduct(t.db, { quantityStock: 10 });

      const res = await applyMovement(t.db, { productId: p.id, delta: -3, reason: "SALE" });

      expect(res.branchId).toBeNull();
      expect(res.branchStock).toBeNull();
      expect(res.productStock).toBe(7);
      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(7);
      const movement = await t.db.stockMovement.findFirstOrThrow();
      expect(movement.branchId).toBeNull();
      expect(movement.quantityAfter).toBe(7);
    });

    it("en modo global también rechaza dejar el stock negativo", async () => {
      const p = await makeProduct(t.db, { quantityStock: 3 });

      await expect(
        applyMovement(t.db, { productId: p.id, delta: -4, reason: "SALE" }),
      ).rejects.toThrow(/Stock insuficiente/);

      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(3);
      expect(await t.db.stockMovement.count()).toBe(0);
    });

    it("falla si el producto no existe", async () => {
      await expect(
        applyMovement(t.db, { productId: 999_999, delta: 1, reason: "TEST" }),
      ).rejects.toThrow(/no encontrado/);
    });

    it("falla si la sucursal no existe", async () => {
      const p = await makeProduct(t.db);
      await expect(
        applyMovement(t.db, { productId: p.id, branchId: 999_999, delta: 1, reason: "TEST" }),
      ).rejects.toThrow(/no existe/);
    });

    it("rechaza cantidades no finitas", async () => {
      const p = await makeProduct(t.db);
      await expect(
        applyMovement(t.db, { productId: p.id, delta: Number.NaN, reason: "TEST" }),
      ).rejects.toThrow(/inválida/);
    });
  });

  describe("addStock", () => {
    it("suma stock con delta positivo", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 4);

      const res = await addStock(t.db, { productId: p.id, branchId: b.id, quantity: 6, reason: "PURCHASE" });

      expect(res.applied).toBe(6);
      expect(res.branchStock).toBe(10);
      expect(await getBranchStock(t.db, p.id, b.id)).toBe(10);
    });
  });

  describe("setStock", () => {
    it("fija el absoluto y registra la diferencia contra el valor anterior", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 5);

      const res = await setStock(t.db, { productId: p.id, branchId: b.id, quantity: 12, reason: "INVENTORY" });

      expect(res.applied).toBe(7);
      expect(res.branchStock).toBe(12);
      expect(res.productStock).toBe(12);
      const movement = await t.db.stockMovement.findFirstOrThrow();
      expect(movement).toMatchObject({ delta: 7, quantityAfter: 12, reason: "INVENTORY" });
    });

    it("registra un delta negativo al bajar el stock", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);
      await makeBranchStock(t.db, p.id, b.id, 5);

      const res = await setStock(t.db, { productId: p.id, branchId: b.id, quantity: 2, reason: "INVENTORY" });

      expect(res.applied).toBe(-3);
      expect(await getBranchStock(t.db, p.id, b.id)).toBe(2);
    });

    it("rechaza cantidades negativas sin allowNegative", async () => {
      const p = await makeProduct(t.db);
      await expect(
        setStock(t.db, { productId: p.id, quantity: -1, reason: "INVENTORY" }),
      ).rejects.toThrow(/no puede ser negativo/);
    });

    it("acepta negativo con allowNegative", async () => {
      const b = await makeBranch(t.db);
      const p = await makeProduct(t.db);

      const res = await setStock(t.db, {
        productId: p.id,
        branchId: b.id,
        quantity: -4,
        reason: "ADJUSTMENT",
        allowNegative: true,
      });

      expect(res.branchStock).toBe(-4);
      expect(await getBranchStock(t.db, p.id, b.id)).toBe(-4);
    });

    it("en modo global actualiza Product.quantityStock", async () => {
      const p = await makeProduct(t.db, { quantityStock: 3 });

      const res = await setStock(t.db, { productId: p.id, quantity: 9, reason: "INVENTORY" });

      expect(res.productStock).toBe(9);
      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(9);
    });
  });

  describe("recalcProductTotal", () => {
    it("no toca el global si el producto no tiene filas por sucursal", async () => {
      const p = await makeProduct(t.db, { quantityStock: 7 });

      const total = await recalcProductTotal(t.db, p.id);

      expect(total).toBe(7);
      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(7);
    });
  });
});

// withStockTransaction usa el cliente global (lib/prisma), así que este bloque
// necesita el harness de API para redirigirlo a una base de test.
describe("withStockTransaction", () => {
  it("revierte todos los movimientos si el callback lanza", async () => {
    const t = await setupApi("stock-tx");
    try {
      const p = await makeProduct(t.db, { quantityStock: 10 });

      await expect(
        withStockTransaction(async (tx) => {
          await applyMovement(tx, { productId: p.id, delta: -3, reason: "TEST" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const after = await t.db.product.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.quantityStock).toBe(10);
      expect(await t.db.stockMovement.count()).toBe(0);
    } finally {
      await teardownApi(t);
    }
  });
});
