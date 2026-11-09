import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/syncOutbox", () => ({
  enqueueOutbox: vi.fn(async () => undefined),
}));

import {
  checkOrderFulfillable,
  markWebOrdersForReview,
  revalidateOrder,
} from "../../../lib/stockReview";
import * as syncOutbox from "../../../lib/syncOutbox";
import { setupApi, teardownApi, type TestDb } from "../../helpers/api";
import {
  makeBranch,
  makeBranchStock,
  makeProduct,
  makeRecipe,
  makeWebOrder,
} from "../../helpers/factories";

// Regla de Oro: si el stock local no alcanza para un pedido web, el pedido no
// se pierde ni se cobra a ciegas: pasa a PENDING_REVIEW con una nota que dice
// exactamente qué falta. Un falso "alcanza" termina en un pedido incumplido.
describe("checkOrderFulfillable", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("stock-review-check");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await teardownApi(t);
  });

  it("un pedido inexistente no reporta faltantes", async () => {
    expect(await checkOrderFulfillable(999_999)).toEqual([]);
  });

  it("un pedido sin ítems no reporta faltantes", async () => {
    const order = await makeWebOrder(t.db, { items: [] });

    expect(await checkOrderFulfillable(order.id)).toEqual([]);
  });

  it("un producto simple con stock global suficiente está cubierto", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 10 });
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 4 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([]);
  });

  it("un producto simple sin stock suficiente se reporta con lo disponible", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 2 });
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 5 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([
      { productId: product.id, name: "Harina", required: 5, available: 2 },
    ]);
  });

  it("con sucursal en el pedido usa el stock de ESA sucursal", async () => {
    const branch = await makeBranch(t.db, { isMain: true });
    const other = await makeBranch(t.db);
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 100 });
    await makeBranchStock(t.db, product.id, branch.id, 1);
    await makeBranchStock(t.db, product.id, other.id, 50);
    const order = await makeWebOrder(t.db, {
      branchId: branch.id,
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(await checkOrderFulfillable(order.id)).toEqual([
      { productId: product.id, name: "Harina", required: 2, available: 1 },
    ]);
  });

  it("sin sucursal en el pedido usa la Casa Central", async () => {
    const main = await makeBranch(t.db, { isMain: true });
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 0 });
    await makeBranchStock(t.db, product.id, main.id, 3);
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 4 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([
      { productId: product.id, name: "Harina", required: 4, available: 3 },
    ]);
  });

  it("sin sucursales usa el stock global", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 6 });
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 4 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([]);
  });

  it("ignora ítems con cantidad <= 0", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 0 });
    const order = await makeWebOrder(t.db, {
      items: [
        { productId: product.id, quantity: 0 },
        { productId: product.id, quantity: -3 },
      ],
    });

    expect(await checkOrderFulfillable(order.id)).toEqual([]);
  });

  it("un elaborado se valida contra sus ingredientes", async () => {
    const flour = await makeProduct(t.db, {
      name: "Harina",
      unitType: "WEIGHT",
      quantityStock: 3,
    });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 2, unitType: "WEIGHT" }]);
    const order = await makeWebOrder(t.db, { items: [{ productId: pizza.id, quantity: 2 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([
      { productId: flour.id, name: "Harina", required: 4, available: 3, unitType: "WEIGHT" },
    ]);
  });

  it("un elaborado con ingredientes suficientes está cubierto", async () => {
    const flour = await makeProduct(t.db, { name: "Harina", quantityStock: 10 });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 2 }]);
    const order = await makeWebOrder(t.db, { items: [{ productId: pizza.id, quantity: 2 }] });

    expect(await checkOrderFulfillable(order.id)).toEqual([]);
  });

  it("suma el ingrediente compartido entre dos elaborados", async () => {
    const flour = await makeProduct(t.db, { name: "Harina", quantityStock: 1.5 });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    const empanada = await makeProduct(t.db, { name: "Empanada", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1 }]);
    await makeRecipe(t.db, empanada.id, [{ ingredientId: flour.id, quantity: 1 }]);
    const order = await makeWebOrder(t.db, {
      items: [
        { productId: pizza.id, quantity: 1 },
        { productId: empanada.id, quantity: 1 },
      ],
    });

    // 1 + 1 = 2 requeridas contra 1.5 disponibles: falta 0.5, no "0 y 0".
    expect(await checkOrderFulfillable(order.id)).toEqual([
      { productId: flour.id, name: "Harina", required: 2, available: 1.5, unitType: "UNIT" },
    ]);
  });

  it("mezcla faltantes de simples y de elaborados", async () => {
    const flour = await makeProduct(t.db, { name: "Harina", quantityStock: 0 });
    const drink = await makeProduct(t.db, { name: "Gaseosa", quantityStock: 0 });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1 }]);
    const order = await makeWebOrder(t.db, {
      items: [
        { productId: pizza.id, quantity: 1 },
        { productId: drink.id, quantity: 2 },
      ],
    });

    const missing = await checkOrderFulfillable(order.id);
    expect(missing).toHaveLength(2);
    expect(missing).toEqual(
      expect.arrayContaining([
        { productId: flour.id, name: "Harina", required: 1, available: 0, unitType: "UNIT" },
        { productId: drink.id, name: "Gaseosa", required: 2, available: 0 },
      ]),
    );
  });
});

describe("markWebOrdersForReview", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("stock-review-mark");
    vi.mocked(syncOutbox.enqueueOutbox).mockClear();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await teardownApi(t);
  });

  async function shortProduct(name = "Harina") {
    return makeProduct(t.db, { name, quantityStock: 0 });
  }

  it("marca solo pedidos activos con faltantes", async () => {
    const product = await shortProduct();
    const active = await makeWebOrder(t.db, {
      status: "PENDING_PREPARATION",
      items: [{ productId: product.id, quantity: 1 }],
    });
    const delivered = await makeWebOrder(t.db, {
      status: "DELIVERED",
      items: [{ productId: product.id, quantity: 1 }],
    });
    const cancelled = await makeWebOrder(t.db, {
      status: "CANCELLED",
      items: [{ productId: product.id, quantity: 1 }],
    });

    const flagged = await markWebOrdersForReview();

    expect(flagged).toBe(1);
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: active.id } })).status).toBe("PENDING_REVIEW");
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: delivered.id } })).status).toBe("DELIVERED");
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe("CANCELLED");
  });

  it("marca los cuatro estados activos", async () => {
    const product = await shortProduct();
    const statuses = ["PENDING_PAYMENT", "PENDING_PREPARATION", "READY_FOR_PICKUP", "SHIPPED"] as const;
    for (const status of statuses) {
      await makeWebOrder(t.db, {
        status,
        items: [{ productId: product.id, quantity: 1 }],
      });
    }

    expect(await markWebOrdersForReview()).toBe(4);
  });

  it("no marca un pedido que sí se puede cumplir", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 10 });
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 1 }] });

    expect(await markWebOrdersForReview()).toBe(0);
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PREPARATION");
    expect(syncOutbox.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("escribe la nota con lo que falta y la fecha de revisión", async () => {
    const product = await shortProduct("Harina");
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 5 }] });

    await markWebOrdersForReview();

    const after = await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.stockReviewNote).toBe("Harina: faltan 5 (disponible 0)");
    expect(after.stockReviewAt).not.toBeNull();
  });

  it("formatea los faltantes de ingredientes con su unidad amigable", async () => {
    const flour = await makeProduct(t.db, {
      name: "Harina",
      unitType: "WEIGHT",
      quantityStock: 0.5,
    });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);
    const order = await makeWebOrder(t.db, { items: [{ productId: pizza.id, quantity: 2 }] });

    await markWebOrdersForReview();

    const after = await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } });
    // 2 kg requeridos - 0.5 kg disponibles = 1.5 kg → 1500 g
    expect(after.stockReviewNote).toBe("Harina: faltan 1500 g (disponible 500 g)");
  });

  it("limita la nota a 5 faltantes", async () => {
    const items = [];
    for (let i = 0; i < 7; i++) {
      const product = await shortProduct(`Producto ${i}`);
      items.push({ productId: product.id, quantity: 1 });
    }
    const order = await makeWebOrder(t.db, { items });

    await markWebOrdersForReview();

    const note = (await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } })).stockReviewNote!;
    expect(note.split("; ")).toHaveLength(5);
  });

  it("no vuelve a marcar un pedido ya revisado", async () => {
    const product = await shortProduct();
    const order = await makeWebOrder(t.db, {
      items: [{ productId: product.id, quantity: 1 }],
      stockReviewAt: new Date(),
    });

    expect(await markWebOrdersForReview()).toBe(0);
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PREPARATION");
  });

  it("encola cada pedido marcado para subirlo a la nube", async () => {
    const product = await shortProduct();
    const first = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 1 }] });
    const second = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 1 }] });

    await markWebOrdersForReview();

    expect(syncOutbox.enqueueOutbox).toHaveBeenCalledTimes(2);
    expect(syncOutbox.enqueueOutbox).toHaveBeenCalledWith("WebOrder", "UPSERT", String(first.id));
    expect(syncOutbox.enqueueOutbox).toHaveBeenCalledWith("WebOrder", "UPSERT", String(second.id));
  });

  it("si falla el encolado, el pedido igual queda marcado", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const product = await shortProduct();
    const order = await makeWebOrder(t.db, { items: [{ productId: product.id, quantity: 1 }] });
    vi.mocked(syncOutbox.enqueueOutbox).mockRejectedValueOnce(new Error("outbox roto"));

    expect(await markWebOrdersForReview()).toBe(1);
    expect((await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_REVIEW");
    expect(warn).toHaveBeenCalled();
  });
});

describe("revalidateOrder", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("stock-review-revalidate");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("un pedido inexistente sigue faltando", async () => {
    expect(await revalidateOrder(999_999)).toBe("STILL_MISSING");
  });

  it("si repusieron el stock, vuelve a preparación y limpia la marca", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 0 });
    const order = await makeWebOrder(t.db, {
      status: "PENDING_REVIEW",
      items: [{ productId: product.id, quantity: 2 }],
      stockReviewNote: "Harina: faltan 2 (disponible 0)",
      stockReviewAt: new Date(),
    });
    await t.db.product.update({ where: { id: product.id }, data: { quantityStock: 2 } });

    expect(await revalidateOrder(order.id)).toBe("READY");

    const after = await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING_PREPARATION");
    expect(after.stockReviewNote).toBeNull();
    expect(after.stockReviewAt).toBeNull();
  });

  it("si todavía falta stock, sigue en revisión y actualiza la nota", async () => {
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: 0 });
    const order = await makeWebOrder(t.db, {
      status: "PENDING_REVIEW",
      items: [{ productId: product.id, quantity: 3 }],
      stockReviewNote: "vieja",
      stockReviewAt: new Date(0),
    });
    await t.db.product.update({ where: { id: product.id }, data: { quantityStock: 1 } });

    expect(await revalidateOrder(order.id)).toBe("STILL_MISSING");

    const after = await t.db.webOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PENDING_REVIEW");
    expect(after.stockReviewNote).toBe("Harina: faltan 2 (disponible 1)");
    expect(after.stockReviewAt).not.toBeNull();
  });
});
