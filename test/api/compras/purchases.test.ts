import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHandler from "../../../pages/api/compras/index";
import purchaseHandler from "../../../pages/api/compras/[id]";
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
  makeCashMovement,
  makeCashRegister,
  makeExpense,
  makeProduct,
  makePurchase,
  makeRecipe,
  makeSupplier,
  setSetting,
} from "../../helpers/factories";

// Una compra toca cuatro cosas a la vez: stock (por sucursal y global), costo
// del producto, gasto y caja. Si una de esas se desincroniza, el margen miente
// o el arqueo no cierra. Estos tests fijan el contrato de las tres transiciones
// (alta, recepción/edición y borrado).
describe("POST /api/compras", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("compras");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function post(body: unknown) {
    return callHandler(indexHandler, mockReq(body));
  }

  async function seed() {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db, { pricePurchase: "1", quantityStock: 0 });
    return { supplier, product };
  }

  it("400 si falta el proveedor", async () => {
    const { product } = await seed();

    const res = await post({ items: [{ productId: product.id, quantity: 1, purchasePrice: 10 }] });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Faltan datos obligatorios/);
  });

  it("400 si no hay ítems", async () => {
    const { supplier } = await seed();

    const res = await post({ supplierId: supplier.id, items: [] });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Faltan datos obligatorios/);
  });

  it("400 con cantidad <= 0", async () => {
    const { supplier, product } = await seed();

    const res = await post({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 0, purchasePrice: 10 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Cantidad o precio de compra inválido/);
  });

  it("400 con precio de compra negativo", async () => {
    const { supplier, product } = await seed();

    const res = await post({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, purchasePrice: -1 }],
    });

    expect(res.statusCode).toBe(400);
  });

  it("no permite comprar un producto elaborado", async () => {
    const { supplier } = await seed();
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });

    const res = await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: pizza.id, quantity: 1, purchasePrice: 100 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/No se puede comprar un producto elaborado/);
    expect(await t.db.purchase.count()).toBe(0);
  });

  it("calcula el total con Decimal, no con float", async () => {
    const { supplier, product } = await seed();

    const res = await post({
      supplierId: supplier.id,
      items: [
        { productId: product.id, quantity: 3, purchasePrice: 10.1 },
        { productId: product.id, quantity: 2, purchasePrice: 0.2 },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(String(res.body.totalAmount)).toBe("30.7");
  });

  it("por defecto deja la compra PENDING y no toca el stock", async () => {
    const { supplier, product } = await seed();
    const branch = await makeBranch(t.db, { isMain: true });
    await makeBranchStock(t.db, product.id, branch.id, 5);

    const res = await post({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, purchasePrice: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(await t.db.stockMovement.count()).toBe(0);
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(5);
    expect((await t.db.purchaseItem.findFirstOrThrow()).quantityReceived).toBeNull();
  });

  it("al recibir suma el stock y actualiza el costo del producto", async () => {
    const { supplier, product } = await seed();
    const branch = await makeBranch(t.db, { isMain: true });

    const res = await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 10, purchasePrice: "2.50" }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe("RECEIVED");

    const row = await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    });
    expect(row.quantityStock).toBe(10);
    const after = await t.db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.quantityStock).toBe(10);
    expect(String(after.pricePurchase)).toBe("2.5");

    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement).toMatchObject({
      productId: product.id,
      branchId: branch.id,
      delta: 10,
      reason: "PURCHASE_RECEIVE",
      refType: "Purchase",
      refId: String(res.body.id),
    });
  });

  it("usa quantityReceived si la mercadería llegó incompleta", async () => {
    const { supplier, product } = await seed();
    const branch = await makeBranch(t.db, { isMain: true });

    const res = await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 10, quantityReceived: 7, purchasePrice: 2 }],
    });

    expect(res.statusCode).toBe(201);
    const item = await t.db.purchaseItem.findFirstOrThrow();
    expect(item.quantity).toBe(10);
    expect(item.quantityReceived).toBe(7);
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(7);
  });

  it("recibe en la sucursal pedida en el body", async () => {
    const { supplier, product } = await seed();
    await makeBranch(t.db, { isMain: true });
    const secondary = await makeBranch(t.db);

    await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      branchId: secondary.id,
      items: [{ productId: product.id, quantity: 4, purchasePrice: 2 }],
    });

    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: secondary.id } },
    })).quantityStock).toBe(4);
  });

  it("sin sucursal explícita usa la del equipo", async () => {
    const { supplier, product } = await seed();
    await makeBranch(t.db, { isMain: true });
    const secondary = await makeBranch(t.db);
    await setSetting(t.db, "device_branch_id", String(secondary.id));

    await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 3, purchasePrice: 2 }],
    });

    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: secondary.id } },
    })).quantityStock).toBe(3);
  });

  it("sin sucursales carga el stock global (instalación legacy)", async () => {
    const { supplier, product } = await seed();

    await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 6, purchasePrice: 2 }],
    });

    const after = await t.db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.quantityStock).toBe(6);
    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement.branchId).toBeNull();
  });

  it("registra gasto y movimiento de caja negativo cuando hay medio de pago", async () => {
    const { supplier, product } = await seed();
    const register = await makeCashRegister(t.db, { status: "OPEN" });

    const res = await post({
      supplierId: supplier.id,
      paymentType: "TRANSFER",
      items: [{ productId: product.id, quantity: 2, purchasePrice: 50 }],
    });

    expect(res.statusCode).toBe(201);

    const expense = await t.db.expense.findFirstOrThrow();
    expect(expense).toMatchObject({
      category: "Mercadería",
      paymentType: "TRANSFER",
    });
    expect(String(expense.amount)).toBe("100");
    expect(expense.description).toBe(`Compra #${res.body.id} - ${supplier.name}`);

    const movement = await t.db.cashMovement.findFirstOrThrow();
    expect(movement).toMatchObject({
      cashRegisterId: register.id,
      type: "EXPENSE",
      paymentType: "TRANSFER",
      sourceId: res.body.id,
    });
    expect(String(movement.amount)).toBe("-100");
  });

  it("sin caja abierta registra el gasto pero no el movimiento", async () => {
    const { supplier, product } = await seed();

    await post({
      supplierId: supplier.id,
      paymentType: "CASH",
      items: [{ productId: product.id, quantity: 1, purchasePrice: 10 }],
    });

    expect(await t.db.expense.count()).toBe(1);
    expect(await t.db.cashMovement.count()).toBe(0);
  });

  it("no registra gasto si no se indica medio de pago", async () => {
    const { supplier, product } = await seed();

    await post({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, purchasePrice: 10 }],
    });

    expect(await t.db.expense.count()).toBe(0);
    expect(await t.db.cashMovement.count()).toBe(0);
  });

  it("al recibir un ingrediente registra el snapshot de costo del elaborado", async () => {
    const { supplier } = await seed();
    const flour = await makeProduct(t.db, {
      name: "Harina",
      unitType: "WEIGHT",
      pricePurchase: "1",
      quantityStock: 0,
    });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 2, unitType: "WEIGHT" }]);

    await post({
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: flour.id, quantity: 10, purchasePrice: "3" }],
    });

    const snapshot = await t.db.recipeCostHistory.findFirstOrThrow({ where: { productId: pizza.id } });
    expect(snapshot.source).toBe("purchase");
    expect(Number(snapshot.cost.toString())).toBeCloseTo(6, 10); // 2 × 3
  });

  it("una compra PENDING no genera snapshot de costo", async () => {
    const { supplier } = await seed();
    const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT" });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);

    await post({
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: flour.id, quantity: 10, purchasePrice: "3" }],
    });

    expect(await t.db.recipeCostHistory.count()).toBe(0);
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(indexHandler, mockReq(undefined, { method: "PUT" }));
    expect(res.statusCode).toBe(405);
  });
});

describe("GET /api/compras", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("compras-get");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("serializa importes como string", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db, { priceSale: "15.50", pricePurchase: "9" });
    await makePurchase(t.db, {
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, purchasePrice: "9" }],
    });

    const res = await callHandler(indexHandler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalAmount).toBe("18");
    expect(res.body[0].items[0].purchasePrice).toBe("9");
    expect(res.body[0].items[0].product.priceSale).toBe("15.5");
  });

  it("pagina cuando se pide page", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    for (let i = 0; i < 3; i++) {
      await makePurchase(t.db, {
        supplierId: supplier.id,
        items: [{ productId: product.id, quantity: 1, purchasePrice: "1" }],
      });
    }

    const res = await callHandler(
      indexHandler,
      mockReq(undefined, { method: "GET", query: { page: "1", limit: "2" } }),
    );

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it("no devuelve más de 100 registros por página", async () => {
    const res = await callHandler(
      indexHandler,
      mockReq(undefined, { method: "GET", query: { page: "1", limit: "500" } }),
    );

    expect(res.body.pagination.limit).toBe(100);
  });
});

describe("GET /api/compras/[id]", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("compras-detalle");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  function get(id: string | number) {
    return callHandler(purchaseHandler, mockReq(undefined, { method: "GET", query: { id: String(id) } }));
  }

  it("400 con id inválido", async () => {
    const res = await get("abc");
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ID de compra inválido/);
  });

  it("404 si no existe", async () => {
    const res = await get(999_999);
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/no encontrada/);
  });

  it("serializa el detalle", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, purchasePrice: "3.25" }],
    });

    const res = await get(purchase.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.totalAmount).toBe("6.5");
    expect(res.body.items[0].purchasePrice).toBe("3.25");
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(
      purchaseHandler,
      mockReq(undefined, { method: "PATCH", query: { id: "1" } }),
    );
    expect(res.statusCode).toBe(405);
  });
});

describe("PUT /api/compras/[id]", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("compras-put");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function put(id: string | number, body: unknown) {
    return callHandler(
      purchaseHandler,
      mockReq(body, { method: "PUT", query: { id: String(id) } }),
    );
  }

  it("400 si la compra no existe", async () => {
    const res = await put(999_999, { status: "RECEIVED" });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Compra no encontrada/);
  });

  it("400 con un estado inválido", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 1, purchasePrice: "1" }],
    });

    const res = await put(purchase.id, { status: "INVENTED" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Estado de compra inválido/);
  });

  it("PENDING → RECEIVED suma stock y actualiza el costo", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db, { pricePurchase: "1" });
    const branch = await makeBranch(t.db, { isMain: true });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 5, purchasePrice: "4" }],
    });

    const res = await put(purchase.id, { status: "RECEIVED" });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("RECEIVED");
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(5);
    expect(String((await t.db.product.findUniqueOrThrow({ where: { id: product.id } })).pricePurchase)).toBe("4");
    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement.reason).toBe("PURCHASE_RECEIVE");
  });

  it("RECEIVED → CANCELLED revierte el stock", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const branch = await makeBranch(t.db, { isMain: true });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 5, purchasePrice: "2" }],
    });
    await makeBranchStock(t.db, product.id, branch.id, 5);

    const res = await put(purchase.id, { status: "CANCELLED" });

    expect(res.statusCode).toBe(200);
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(0);
    const movement = await t.db.stockMovement.findFirstOrThrow();
    expect(movement).toMatchObject({ delta: -5, reason: "PURCHASE_STATUS_REVERT" });
  });

  it("si revertir deja stock negativo, no cambia nada", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const branch = await makeBranch(t.db, { isMain: true });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 10, purchasePrice: "2" }],
    });
    // Ya se vendieron 8 de las 10 unidades recibidas.
    await makeBranchStock(t.db, product.id, branch.id, 2);

    const res = await put(purchase.id, { status: "CANCELLED" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Stock insuficiente/);
    expect((await t.db.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe("RECEIVED");
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(2);
  });

  it("reemplazar los ítems revierte lo viejo y aplica lo nuevo", async () => {
    const supplier = await makeSupplier(t.db);
    const oldProduct = await makeProduct(t.db, { name: "Viejo" });
    const newProduct = await makeProduct(t.db, { name: "Nuevo" });
    const branch = await makeBranch(t.db, { isMain: true });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: oldProduct.id, quantity: 4, purchasePrice: "2" }],
    });
    await makeBranchStock(t.db, oldProduct.id, branch.id, 4);

    const res = await put(purchase.id, {
      status: "RECEIVED",
      items: [{ productId: newProduct.id, quantity: 3, purchasePrice: "5" }],
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.body.totalAmount)).toBe("15");

    const oldRow = await t.db.productBranchStock.findFirst({
      where: { productId: oldProduct.id, branchId: branch.id },
    });
    expect(oldRow?.quantityStock ?? 0).toBe(0);
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: newProduct.id, branchId: branch.id } },
    })).quantityStock).toBe(3);

    const reasons = (await t.db.stockMovement.findMany({ orderBy: { id: "asc" } })).map((m) => m.reason);
    expect(reasons).toEqual(["PURCHASE_EDIT_REVERT", "PURCHASE_RECEIVE"]);
  });

  it("reemplazar ítems sin recibir no mueve stock", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 1, purchasePrice: "1" }],
    });

    const res = await put(purchase.id, {
      status: "PENDING",
      items: [{ productId: product.id, quantity: 9, purchasePrice: "2" }],
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.body.totalAmount)).toBe("18");
    expect(await t.db.stockMovement.count()).toBe(0);
    expect((await t.db.purchaseItem.findFirstOrThrow()).quantityReceived).toBeNull();
  });

  it("no permite recibir un elaborado", async () => {
    const supplier = await makeSupplier(t.db);
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: pizza.id, quantity: 1, purchasePrice: "1" }],
    });

    const res = await put(purchase.id, { status: "RECEIVED" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/No se puede recibir un producto elaborado/);
    expect(await t.db.stockMovement.count()).toBe(0);
  });

  it("crea el gasto y el movimiento de caja al asignar medio de pago", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const register = await makeCashRegister(t.db, { status: "OPEN" });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 2, purchasePrice: "10" }],
    });

    const res = await put(purchase.id, { paymentType: "CASH" });

    expect(res.statusCode).toBe(200);
    const expense = await t.db.expense.findFirstOrThrow();
    expect(String(expense.amount)).toBe("20");
    const movement = await t.db.cashMovement.findFirstOrThrow();
    expect(movement).toMatchObject({ cashRegisterId: register.id, type: "EXPENSE", sourceId: purchase.id });
    expect(String(movement.amount)).toBe("-20");
  });

  it("actualiza el gasto existente en vez de duplicarlo", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    await makeCashRegister(t.db, { status: "OPEN" });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 2, purchasePrice: "10" }],
    });
    await put(purchase.id, { paymentType: "CASH" });

    await put(purchase.id, {
      paymentType: "TRANSFER",
      items: [{ productId: product.id, quantity: 3, purchasePrice: "10" }],
    });

    expect(await t.db.expense.count()).toBe(1);
    expect(await t.db.cashMovement.count()).toBe(1);
    const expense = await t.db.expense.findFirstOrThrow();
    expect(String(expense.amount)).toBe("30");
    expect(expense.paymentType).toBe("TRANSFER");
    const movement = await t.db.cashMovement.findFirstOrThrow();
    expect(String(movement.amount)).toBe("-30");
    expect(movement.paymentType).toBe("TRANSFER");
  });
});

describe("DELETE /api/compras/[id]", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("compras-delete");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function del(id: string | number) {
    return callHandler(purchaseHandler, mockReq(undefined, { method: "DELETE", query: { id: String(id) } }));
  }

  it("400 si la compra no existe", async () => {
    const res = await del(999_999);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Compra no encontrada/);
  });

  it("revierte el stock, borra gasto, movimiento y la compra", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db);
    const branch = await makeBranch(t.db, { isMain: true });
    await makeCashRegister(t.db, { status: "OPEN" });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "RECEIVED",
      items: [{ productId: product.id, quantity: 5, purchasePrice: "2" }],
    });
    await makeBranchStock(t.db, product.id, branch.id, 5);
    await makeExpense(t.db, { description: `Compra #${purchase.id} - ${supplier.name}`, amount: "10" });
    await makeCashMovement(t.db, (await t.db.cashRegister.findFirstOrThrow()).id, {
      type: "EXPENSE",
      sourceId: purchase.id,
      amount: "-10",
    });
    // Movimiento de una venta que casualmente comparte sourceId: no se toca.
    await makeCashMovement(t.db, (await t.db.cashRegister.findFirstOrThrow()).id, {
      type: "SALE",
      sourceId: purchase.id,
      amount: "10",
    });

    const res = await del(purchase.id);

    expect(res.statusCode).toBe(200);
    expect(await t.db.purchase.count()).toBe(0);
    expect(await t.db.purchaseItem.count()).toBe(0);
    expect(await t.db.expense.count()).toBe(0);
    const movements = await t.db.cashMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("SALE");
    expect((await t.db.productBranchStock.findUniqueOrThrow({
      where: { productId_branchId: { productId: product.id, branchId: branch.id } },
    })).quantityStock).toBe(0);
    const revert = await t.db.stockMovement.findFirstOrThrow();
    expect(revert).toMatchObject({ delta: -5, reason: "PURCHASE_DELETE_REVERT" });
  });

  it("una compra pendiente se borra sin tocar stock", async () => {
    const supplier = await makeSupplier(t.db);
    const product = await makeProduct(t.db, { quantityStock: 3 });
    const purchase = await makePurchase(t.db, {
      supplierId: supplier.id,
      status: "PENDING",
      items: [{ productId: product.id, quantity: 5, purchasePrice: "2" }],
    });

    const res = await del(purchase.id);

    expect(res.statusCode).toBe(200);
    expect(await t.db.purchase.count()).toBe(0);
    expect(await t.db.stockMovement.count()).toBe(0);
    expect((await t.db.product.findUniqueOrThrow({ where: { id: product.id } })).quantityStock).toBe(3);
  });
});
