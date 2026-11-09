import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHandler from "../../../pages/api/stock-transfers/index";
import respondHandler from "../../../pages/api/stock-transfers/[id]/respond";
import cancelHandler from "../../../pages/api/stock-transfers/[id]/cancel";
import {
  callHandler,
  mockReq,
  setupApi,
  teardownApi,
  type TestDb,
} from "../../helpers/api";
import {
  makeBranch,
  makeBranchStock,
  makeProduct,
  makeRecipe,
  makeStockTransfer,
  setSetting,
} from "../../helpers/factories";

// Un traspaso mueve stock entre dos locales con un tercer estado en el medio
// (enviado, todavía no recibido). Las cantidades tienen que conservarse: lo
// enviado = lo recibido + lo devuelto al origen. Si se acredita dos veces o se
// pierde la diferencia, un local queda con stock fantasma.
describe("POST /api/stock-transfers", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("traspasos");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function post(body: unknown) {
    return callHandler(indexHandler, mockReq(body));
  }

  async function seed(options: { pro?: boolean; deviceBranch?: number | null; stock?: number } = {}) {
    const source = await makeBranch(t.db, { name: "Origen", isMain: true });
    const target = await makeBranch(t.db, { name: "Destino" });
    const product = await makeProduct(t.db, { name: "Harina", quantityStock: options.stock ?? 10 });
    await makeBranchStock(t.db, product.id, source.id, options.stock ?? 10);
    if (options.pro !== false) await setSetting(t.db, "app_plan", "pro");
    if (options.deviceBranch !== null) {
      await setSetting(t.db, "device_branch_id", String(options.deviceBranch ?? source.id));
    }
    return { source, target, product };
  }

  it("403 si el plan no es Pro", async () => {
    const { source, target, product } = await seed({ pro: false });

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/plan Pro/);
  });

  it("400 si origen y destino son iguales", async () => {
    const { source, product } = await seed();

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: source.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/deben ser diferentes/);
  });

  it("400 sin sucursales", async () => {
    await setSetting(t.db, "app_plan", "pro");

    const res = await post({ items: [{ productId: 1, quantity: 1 }] });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/deben ser diferentes/);
  });

  it("400 sin ítems", async () => {
    const { source, target } = await seed();

    const res = await post({ sourceBranchId: source.id, targetBranchId: target.id, items: [] });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/al menos un producto/);
  });

  it("400 si se intenta transferir un elaborado", async () => {
    const { source, target } = await seed();
    const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT" });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: pizza.id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/No se puede transferir un producto elaborado/);
  });

  it("403 si el origen no es el local de este equipo", async () => {
    const { source, target, product } = await seed();
    await setSetting(t.db, "device_branch_id", String(target.id));

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/desde tu propio local/);
  });

  it("envía el stock: descuenta el origen y deja el traspaso en SENT", async () => {
    const { source, target, product } = await seed({ stock: 10 });

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      notes: "<b>urgente</b>",
      createdByName: "Ana",
      items: [{ productId: product.id, productName: "Harina", quantity: 4 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe("SENT");
    expect(res.body.notes).toBe("&lt;b&gt;urgente&lt;&#x2F;b&gt;");
    expect(res.body.items[0]).toMatchObject({ productId: product.id, quantity: 4 });

    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: source.id } },
    })).quantityStock).toBe(6);
    // El destino todavía no recibió nada.
    expect(await t.db.productBranchStock.findFirst({
      where: { productId: product.id, branchId: target.id },
    })).toBeNull();

    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement).toMatchObject({
      productId: product.id,
      branchId: source.id,
      delta: -4,
      reason: "TRANSFER_OUT",
      refType: "StockTransfer",
    });
  });

  it("409 con stock insuficiente y no crea el traspaso", async () => {
    const { source, target, product } = await seed({ stock: 2 });

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 5 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/Stock insuficiente/);
    expect(await t.db.stockTransfer.count()).toBe(0);
    expect(await t.db.stockMovement.count()).toBe(0);
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: source.id } },
    })).quantityStock).toBe(2);
  });

  it("una cantidad <= 0 revierte todo (hoy responde 500)", async () => {
    // Deuda conocida: el error de validación no se mapea a 400 y cae en el
    // handler genérico. Lo importante es que la transacción no deje basura.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, target, product } = await seed({ stock: 10 });

    const res = await post({
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 0 }],
    });

    expect(res.statusCode).toBe(500);
    expect(await t.db.stockTransfer.count()).toBe(0);
    expect(await t.db.stockMovement.count()).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(indexHandler, mockReq(undefined, { method: "DELETE" }));
    expect(res.statusCode).toBe(405);
  });
});

describe("GET /api/stock-transfers", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("traspasos-get");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("devuelve los traspasos con origen, destino e ítems", async () => {
    const source = await makeBranch(t.db);
    const target = await makeBranch(t.db);
    const product = await makeProduct(t.db);
    await makeStockTransfer(t.db, {
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 2 }],
    });

    const res = await callHandler(indexHandler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sourceBranch.id).toBe(source.id);
    expect(res.body[0].targetBranch.id).toBe(target.id);
    expect(res.body[0].items).toHaveLength(1);
  });
});

describe("POST /api/stock-transfers/[id]/respond", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("traspasos-respond");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function respond(id: string | number, body: unknown) {
    return callHandler(
      respondHandler,
      mockReq(body, { method: "POST", query: { id: String(id) } }),
    );
  }

  /** Escenario: origen envió 4 y quedó con 6; destino tiene 0. */
  async function seedSent(options: { sent?: number; sourceLeft?: number } = {}) {
    const source = await makeBranch(t.db, { name: "Origen" });
    const target = await makeBranch(t.db, { name: "Destino" });
    const product = await makeProduct(t.db, { name: "Harina" });
    await makeBranchStock(t.db, product.id, source.id, options.sourceLeft ?? 6);
    const transfer = await makeStockTransfer(t.db, {
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: options.sent ?? 4, productName: "Harina" }],
    });
    await setSetting(t.db, "device_branch_id", String(target.id));
    return { source, target, product, transfer };
  }

  async function stockOf(productId: number, branchId: number): Promise<number> {
    const row = await t.db.productBranchStock.findUnique({
      where: { productId_branchId: { productId, branchId } },
    });
    return row?.quantityStock ?? 0;
  }

  it("400 con id inválido", async () => {
    const res = await respond("abc", { action: "accept" });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ID de traspaso inválido/);
  });

  it("403 si el equipo no tiene local identificable", async () => {
    const source = await makeBranch(t.db, { isMain: false });
    const target = await makeBranch(t.db, { isMain: false });
    const product = await makeProduct(t.db);
    const transfer = await makeStockTransfer(t.db, {
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const res = await respond(transfer.id, { action: "accept" });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/No se pudo determinar tu local/);
  });

  it("404 si el traspaso no existe", async () => {
    const source = await makeBranch(t.db);
    await setSetting(t.db, "device_branch_id", String(source.id));

    const res = await respond(999_999, { action: "accept" });

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/no encontrado/);
  });

  it("403 si el equipo no es el destino", async () => {
    const { source, transfer } = await seedSent();
    await setSetting(t.db, "device_branch_id", String(source.id));

    const res = await respond(transfer.id, { action: "accept" });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/Solo el local destino/);
  });

  it("409 si el traspaso ya fue respondido", async () => {
    const { target, transfer } = await seedSent();
    await t.db.stockTransfer.update({ where: { id: transfer.id }, data: { status: "COMPLETED" } });
    await setSetting(t.db, "device_branch_id", String(target.id));

    const res = await respond(transfer.id, { action: "accept" });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/ya fue respondido o cancelado/);
  });

  it("400 con una acción inválida", async () => {
    const { transfer } = await seedSent();

    const res = await respond(transfer.id, { action: "maybe" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Acción inválida/);
  });

  it("reject repone todo al origen y deja el traspaso REJECTED", async () => {
    const { source, target, product, transfer } = await seedSent();

    const res = await respond(transfer.id, { action: "reject" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, status: "REJECTED" });
    expect(await stockOf(product.id, source.id)).toBe(10);
    expect(await stockOf(product.id, target.id)).toBe(0);
    expect((await t.db.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe("REJECTED");
    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement).toMatchObject({ delta: 4, reason: "TRANSFER_REJECT", branchId: source.id });
  });

  it("accept acredita todo al destino y completa el traspaso", async () => {
    const { source, target, product, transfer } = await seedSent();

    const res = await respond(transfer.id, { action: "accept" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, status: "COMPLETED" });
    expect(await stockOf(product.id, target.id)).toBe(4);
    expect(await stockOf(product.id, source.id)).toBe(6);

    const item = await t.db.stockTransferItem.findFirstOrThrow({ where: { transferId: transfer.id } });
    expect(item.receivedQuantity).toBe(4);
    const movements = await t.db.stockMovement.findMany({ orderBy: { id: "asc" } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ reason: "TRANSFER_IN", delta: 4, branchId: target.id });
  });

  it("accept parcial acredita lo recibido y devuelve la diferencia al origen", async () => {
    const { source, target, product, transfer } = await seedSent();

    const res = await respond(transfer.id, {
      action: "accept",
      items: [{ productId: product.id, quantityReceived: 3 }],
    });

    expect(res.statusCode).toBe(200);
    expect(await stockOf(product.id, target.id)).toBe(3);
    expect(await stockOf(product.id, source.id)).toBe(7);

    const item = await t.db.stockTransferItem.findFirstOrThrow({ where: { transferId: transfer.id } });
    expect(item.receivedQuantity).toBe(3);

    const movements = await t.db.stockMovement.findMany({ orderBy: { id: "asc" } });
    expect(movements.map((m) => [m.reason, m.delta, m.branchId])).toEqual([
      ["TRANSFER_IN", 3, target.id],
      ["TRANSFER_RETURN", 1, source.id],
    ]);
  });

  it("accept con 0 recibido devuelve todo al origen", async () => {
    const { source, target, product, transfer } = await seedSent();

    const res = await respond(transfer.id, {
      action: "accept",
      items: [{ productId: product.id, quantityReceived: 0 }],
    });

    expect(res.statusCode).toBe(200);
    expect(await stockOf(product.id, target.id)).toBe(0);
    expect(await stockOf(product.id, source.id)).toBe(10);
    const movements = await t.db.stockMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ reason: "TRANSFER_RETURN", delta: 4 });
  });

  it("400 si se recibe más de lo enviado", async () => {
    const { source, target, product, transfer } = await seedSent();

    const res = await respond(transfer.id, {
      action: "accept",
      items: [{ productId: product.id, quantityReceived: 5 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no puede ser mayor a lo enviado/);
    expect(await stockOf(product.id, target.id)).toBe(0);
    expect(await stockOf(product.id, source.id)).toBe(6);
    expect((await t.db.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe("SENT");
  });

  it("400 si se recibe una cantidad negativa", async () => {
    const { product, transfer } = await seedSent();

    const res = await respond(transfer.id, {
      action: "accept",
      items: [{ productId: product.id, quantityReceived: -1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no puede ser mayor a lo enviado/);
  });

  it("un segundo accept no vuelve a acreditar stock", async () => {
    const { target, product, transfer } = await seedSent();
    await respond(transfer.id, { action: "accept" });

    const res = await respond(transfer.id, { action: "accept" });

    expect(res.statusCode).toBe(409);
    expect(await stockOf(product.id, target.id)).toBe(4);
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(
      respondHandler,
      mockReq(undefined, { method: "GET", query: { id: "1" } }),
    );
    expect(res.statusCode).toBe(405);
  });
});

describe("POST /api/stock-transfers/[id]/cancel", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("traspasos-cancel");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function cancel(id: string | number) {
    return callHandler(
      cancelHandler,
      mockReq(undefined, { method: "POST", query: { id: String(id) } }),
    );
  }

  async function seedSent() {
    const source = await makeBranch(t.db, { name: "Origen" });
    const target = await makeBranch(t.db, { name: "Destino" });
    const product = await makeProduct(t.db);
    await makeBranchStock(t.db, product.id, source.id, 6);
    const transfer = await makeStockTransfer(t.db, {
      sourceBranchId: source.id,
      targetBranchId: target.id,
      items: [{ productId: product.id, quantity: 4 }],
    });
    await setSetting(t.db, "device_branch_id", String(source.id));
    return { source, target, product, transfer };
  }

  async function stockOf(productId: number, branchId: number): Promise<number> {
    const row = await t.db.productBranchStock.findUnique({
      where: { productId_branchId: { productId, branchId } },
    });
    return row?.quantityStock ?? 0;
  }

  it("400 con id inválido", async () => {
    const res = await cancel("abc");
    expect(res.statusCode).toBe(400);
  });

  it("404 si el traspaso no existe", async () => {
    const branch = await makeBranch(t.db);
    await setSetting(t.db, "device_branch_id", String(branch.id));

    const res = await cancel(999_999);
    expect(res.statusCode).toBe(404);
  });

  it("403 si el equipo no es el emisor", async () => {
    const { target, transfer } = await seedSent();
    await setSetting(t.db, "device_branch_id", String(target.id));

    const res = await cancel(transfer.id);

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/Solo el local emisor/);
  });

  it("409 si el traspaso ya no está pendiente", async () => {
    const { transfer } = await seedSent();
    await t.db.stockTransfer.update({ where: { id: transfer.id }, data: { status: "REJECTED" } });

    const res = await cancel(transfer.id);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/ya fue respondido o cancelado/);
  });

  it("cancela, repone el stock al origen y deja el traspaso CANCELLED", async () => {
    const { source, product, transfer } = await seedSent();

    const res = await cancel(transfer.id);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, status: "CANCELLED" });
    expect(await stockOf(product.id, source.id)).toBe(10);
    expect((await t.db.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe("CANCELLED");
    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement).toMatchObject({ delta: 4, reason: "TRANSFER_CANCEL", branchId: source.id });
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(
      cancelHandler,
      mockReq(undefined, { method: "GET", query: { id: "1" } }),
    );
    expect(res.statusCode).toBe(405);
  });
});
