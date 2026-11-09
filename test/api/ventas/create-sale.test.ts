import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La facturación electrónica habla con ARCA (red). Se mockea SOLO la llamada
// externa: getArcaConfig sigue leyendo la base real para que el test valide la
// condición que dispara la factura.
vi.mock("../../../lib/arcaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/arcaService")>();
  return { ...actual, createElectronicInvoice: vi.fn() };
});

import handler from "../../../pages/api/ventas/index";
import { createElectronicInvoice } from "../../../lib/arcaService";
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
  makeCashRegister,
  makeClient,
  makeDiscountCode,
  makeProduct,
  makePromotion,
  makePurchase,
  makeRecipe,
  makeSale,
  makeSeller,
  makeSupplier,
} from "../../helpers/factories";

// pages/api/ventas/index.ts es el endpoint que mueve plata, stock, caja y
// cuenta corriente en una sola transacción. Cada rama de ese handler tiene
// consecuencias contables, así que se prueba el contrato completo.
describe("POST /api/ventas", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("ventas");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    await teardownApi(t);
  });

  function post(body: unknown) {
    return callHandler(handler, mockReq(body));
  }

  /** Escenario base: vendedor + sucursal principal + producto con stock. */
  async function seed(options: { stock?: number; priceSale?: string } = {}) {
    const seller = await makeSeller(t.db);
    const branch = await makeBranch(t.db, { isMain: true });
    const stock = options.stock ?? 10;
    const product = await makeProduct(t.db, {
      priceSale: options.priceSale ?? "100",
      quantityStock: stock,
    });
    await makeBranchStock(t.db, product.id, branch.id, stock);
    return { seller, branch, product };
  }

  function saleBody(
    sellerId: number,
    productId: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      sellerId,
      paymentType: "CASH",
      items: [{ productId, quantity: 2, priceAtSale: 100 }],
      ...overrides,
    };
  }

  describe("validaciones de entrada", () => {
    it("400 si falta el vendedor", async () => {
      const { product } = await seed();
      const res = await post({ paymentType: "CASH", items: [{ productId: product.id, quantity: 1, priceAtSale: 100 }] });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Faltan datos obligatorios/);
    });

    it("400 si no hay ítems", async () => {
      const { seller } = await seed();
      const res = await post({ sellerId: seller.id, paymentType: "CASH", items: [] });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Faltan datos obligatorios/);
    });

    it("400 con un tipo de pago inválido", async () => {
      const { seller, product } = await seed();
      const res = await post(saleBody(seller.id, product.id, { paymentType: "BITCOIN" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Tipo de pago inválido/);
    });

    it("400 si es cuenta corriente sin cliente", async () => {
      const { seller, product } = await seed();
      const res = await post(saleBody(seller.id, product.id, { paymentType: "ON_ACCOUNT" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/requiere seleccionar un cliente/);
    });

    it("400 con cantidad <= 0", async () => {
      const { seller, product } = await seed();
      const res = await post(
        saleBody(seller.id, product.id, { items: [{ productId: product.id, quantity: 0, priceAtSale: 100 }] }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Cantidad o precio inválido/);
    });

    it("400 con precio negativo", async () => {
      const { seller, product } = await seed();
      const res = await post(
        saleBody(seller.id, product.id, { items: [{ productId: product.id, quantity: 1, priceAtSale: -5 }] }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Cantidad o precio inválido/);
    });

    it("400 si el vendedor ya no existe", async () => {
      const { product } = await seed();
      const res = await post(saleBody(999_999, product.id));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/vendedor seleccionado ya no existe/);
    });

    it("409 si el producto no existe", async () => {
      const { seller } = await seed();
      const res = await post(
        saleBody(seller.id, 999_999, {
          items: [{ productId: 999_999, quantity: 1, priceAtSale: 100 }],
        }),
      );

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toMatch(/Producto con ID 999999 no encontrado/);
      expect(await t.db.sale.count()).toBe(0);
    });

    it("404 si el cliente no existe (handleApiError)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { seller, product } = await seed();
      const res = await post(saleBody(seller.id, product.id, { clientId: 999_999 }));

      expect(res.statusCode).toBe(404);
      expect(await t.db.sale.count()).toBe(0);
    });

    it("405 para métodos no soportados", async () => {
      const res = await callHandler(handler, mockReq(undefined, { method: "PUT" }));
      expect(res.statusCode).toBe(405);
    });
  });

  describe("totales y descuentos", () => {
    it("calcula el total como precio × cantidad", async () => {
      const { seller, product } = await seed();

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("200");
    });

    it("aplica un código de descuento porcentual y consume un uso", async () => {
      const { seller, product } = await seed();
      const code = await makeDiscountCode(t.db, {
        code: "PROMO10",
        discountPercent: "10",
        discountType: "PERCENTAGE",
      });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "promo10" }));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("180");
      const after = await t.db.discountCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(after.currentUses).toBe(1);
    });

    it("aplica un código de monto fijo", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, {
        code: "FIJO50",
        discountPercent: "0",
        discountType: "FIXED_AMOUNT",
        discountValue: "50",
      });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "FIJO50" }));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("150");
    });

    it("un descuento fijo mayor al total deja 0, nunca negativo", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, {
        code: "FIJO500",
        discountPercent: "0",
        discountType: "FIXED_AMOUNT",
        discountValue: "500",
      });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "FIJO500" }));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("0");
    });

    it("400 si el código no existe", async () => {
      const { seller, product } = await seed();
      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "NOEXISTE" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/no existe/);
    });

    it("400 si el código está inactivo", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, { code: "OFF", isActive: false });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "OFF" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/inactivo/);
    });

    it("400 si el código expiró", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, { code: "VIEJO", validUntil: new Date("2020-01-01T00:00:00Z") });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "VIEJO" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/expirado/);
    });

    it("400 si el código agotó sus usos", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, { code: "AGOTADO", maxUses: 1, currentUses: 1 });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "AGOTADO" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/límite de usos/);
    });

    it("400 si no alcanza la compra mínima", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, { code: "MINIMO", minPurchase: "500" });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "MINIMO" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/compra mínima/);
    });

    it("400 si el código aún no es válido", async () => {
      const { seller, product } = await seed();
      await makeDiscountCode(t.db, { code: "FUTURO", validFrom: new Date("2099-01-01T00:00:00Z") });

      const res = await post(saleBody(seller.id, product.id, { discountCodeApplied: "FUTURO" }));

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/aún no es válido/);
    });

    it("400 si la promoción aún no empezó", async () => {
      const { seller, product } = await seed();
      const promo = await makePromotion(t.db, { startDate: new Date("2099-01-01T00:00:00Z") });

      const res = await post(
        saleBody(seller.id, product.id, {
          promotionsApplied: [
            { promotionId: promo.id, name: promo.name, type: "THRESHOLD", discountAmount: 10 },
          ],
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/aún no es válida/);
    });

    it("400 si la promoción expiró", async () => {
      const { seller, product } = await seed();
      const promo = await makePromotion(t.db, { endDate: new Date("2020-01-01T00:00:00Z") });

      const res = await post(
        saleBody(seller.id, product.id, {
          promotionsApplied: [
            { promotionId: promo.id, name: promo.name, type: "THRESHOLD", discountAmount: 10 },
          ],
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/ha expirado/);
    });

    it("resta el descuento por medio de pago", async () => {
      const { seller, product } = await seed();

      const res = await post(saleBody(seller.id, product.id, { paymentMethodDiscount: 20 }));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("180");
    });

    it("el descuento por medio de pago no deja el total negativo", async () => {
      const { seller, product } = await seed();

      const res = await post(saleBody(seller.id, product.id, { paymentMethodDiscount: 999 }));

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("0");
    });

    it("resta las promociones activas y guarda el detalle", async () => {
      const { seller, product } = await seed();
      const promo = await makePromotion(t.db, { name: "Promo 30", discountValue: "30" });

      const res = await post(
        saleBody(seller.id, product.id, {
          promotionsApplied: [
            { promotionId: promo.id, name: "Promo 30", type: "THRESHOLD", discountAmount: 30 },
          ],
        }),
      );

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("170");
      expect(JSON.parse(res.body.promotionsApplied)).toEqual([
        { promotionId: promo.id, name: "Promo 30", type: "THRESHOLD", discountAmount: 30 },
      ]);
    });

    it("400 si la promoción no está activa", async () => {
      const { seller, product } = await seed();
      const promo = await makePromotion(t.db, { name: "Vieja", status: "INACTIVE" });

      const res = await post(
        saleBody(seller.id, product.id, {
          promotionsApplied: [
            { promotionId: promo.id, name: "Vieja", type: "THRESHOLD", discountAmount: 10 },
          ],
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/no está activa o no existe/);
    });

    it("una promoción mayor al total no deja el total negativo", async () => {
      const { seller, product } = await seed();
      const promo = await makePromotion(t.db, { name: "Exagerada", discountValue: "500" });

      const res = await post(
        saleBody(seller.id, product.id, {
          promotionsApplied: [
            { promotionId: promo.id, name: "Exagerada", type: "THRESHOLD", discountAmount: 500 },
          ],
        }),
      );

      expect(res.statusCode).toBe(201);
      expect(String(res.body.totalAmount)).toBe("0");
    });
  });

  describe("stock", () => {
    it("descuenta la sucursal y deja el movimiento en el ledger", async () => {
      const { seller, branch, product } = await seed({ stock: 10 });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);

      const branchStock = await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: branch.id } },
      });
      expect(branchStock.quantityStock).toBe(8);

      const movements = await t.db.stockMovement.findMany();
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        productId: product.id,
        branchId: branch.id,
        delta: -2,
        quantityAfter: 8,
        reason: "SALE",
        refType: "Sale",
        refId: String(res.body.id),
      });
    });

    it("mantiene Product.quantityStock igual a la suma de las sucursales", async () => {
      const { seller, product } = await seed({ stock: 10 });

      await post(saleBody(seller.id, product.id));

      const rows = await t.db.productBranchStock.findMany({ where: { productId: product.id } });
      const sum = rows.reduce((acc, r) => acc + r.quantityStock, 0);
      const after = await t.db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(after.quantityStock).toBe(sum);
      expect(after.quantityStock).toBe(8);
    });

    it("409 con stock insuficiente y revierte toda la venta", async () => {
      const { seller, branch, product } = await seed({ stock: 10 });

      const res = await post(
        saleBody(seller.id, product.id, {
          items: [{ productId: product.id, quantity: 50, priceAtSale: 100 }],
        }),
      );

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toMatch(/Stock insuficiente/);
      expect(await t.db.sale.count()).toBe(0);
      expect(await t.db.stockMovement.count()).toBe(0);
      const branchStock = await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: branch.id } },
      });
      expect(branchStock.quantityStock).toBe(10);
    });

    it("sin sucursales descuenta el stock global (instalación legacy)", async () => {
      const seller = await makeSeller(t.db);
      const product = await makeProduct(t.db, { quantityStock: 10, priceSale: "100" });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      const after = await t.db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(after.quantityStock).toBe(8);
      const movement = await t.db.stockMovement.findFirstOrThrow();
      expect(movement.branchId).toBeNull();
    });

    it("usa la sucursal del equipo (device_branch_id) si no se pide otra", async () => {
      const seller = await makeSeller(t.db);
      const main = await makeBranch(t.db, { isMain: true });
      const secondary = await makeBranch(t.db);
      const product = await makeProduct(t.db, { quantityStock: 20, priceSale: "100" });
      await makeBranchStock(t.db, product.id, main.id, 10);
      await makeBranchStock(t.db, product.id, secondary.id, 10);
      await t.db.setting.create({ data: { key: "device_branch_id", value: String(secondary.id) } });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: secondary.id } },
      })).quantityStock).toBe(8);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: main.id } },
      })).quantityStock).toBe(10);
    });

    it("la sucursal pedida en el body gana sobre la principal", async () => {
      const seller = await makeSeller(t.db);
      const main = await makeBranch(t.db, { isMain: true });
      const secondary = await makeBranch(t.db);
      const product = await makeProduct(t.db, { quantityStock: 20, priceSale: "100" });
      await makeBranchStock(t.db, product.id, main.id, 10);
      await makeBranchStock(t.db, product.id, secondary.id, 10);

      const res = await post(saleBody(seller.id, product.id, { branchId: secondary.id }));

      expect(res.statusCode).toBe(201);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: secondary.id } },
      })).quantityStock).toBe(8);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: main.id } },
      })).quantityStock).toBe(10);
    });

    it("toma el costo de la última compra si el producto no tiene pricePurchase", async () => {
      const seller = await makeSeller(t.db);
      const supplier = await makeSupplier(t.db);
      const product = await makeProduct(t.db, { quantityStock: 10, priceSale: "100", pricePurchase: "0" });
      await makePurchase(t.db, {
        supplierId: supplier.id,
        status: "RECEIVED",
        items: [{ productId: product.id, quantity: 2, purchasePrice: "7.25" }],
      });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      const item = await t.db.saleItem.findFirstOrThrow();
      expect(String(item.purchasePriceAtSale)).toBe("7.25");
    });

    it("avisa cuando un producto simple queda bajo el mínimo", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { seller, product } = await seed({ stock: 10 });
      await t.db.product.update({ where: { id: product.id }, data: { stockMinAlert: 9 } });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("STOCK ALERT"));
    });

    it("avisa cuando un elaborado queda bajo su mínimo de disponibilidad", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const seller = await makeSeller(t.db);
      const branch = await makeBranch(t.db, { isMain: true });
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 10 });
      const pizza = await makeProduct(t.db, {
        name: "Pizza",
        isRecipe: true,
        priceSale: "100",
        stockMinAlert: 100,
      });
      await makeBranchStock(t.db, flour.id, branch.id, 10);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.5, unitType: "WEIGHT" }]);

      const res = await post(
        saleBody(seller.id, pizza.id, {
          items: [{ productId: pizza.id, quantity: 2, priceAtSale: 100 }],
        }),
      );

      expect(res.statusCode).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("STOCK ALERT"));
    });

    it("avisa el mínimo también en modo global (sin sucursales)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const seller = await makeSeller(t.db);
      const product = await makeProduct(t.db, {
        quantityStock: 10,
        priceSale: "100",
        stockMinAlert: 9,
      });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("STOCK ALERT"));
    });

    it("una venta PENDING no descuenta stock ni mueve caja", async () => {
      const { seller, branch, product } = await seed({ stock: 10 });
      await makeCashRegister(t.db, { status: "OPEN" });

      const res = await post(saleBody(seller.id, product.id, { status: "PENDING" }));

      expect(res.statusCode).toBe(201);
      expect(res.body.status).toBe("PENDING");
      expect(await t.db.stockMovement.count()).toBe(0);
      expect(await t.db.cashMovement.count()).toBe(0);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: product.id, branchId: branch.id } },
      })).quantityStock).toBe(10);
    });

    it("un elaborado descuenta ingredientes y no su propio stock", async () => {
      const seller = await makeSeller(t.db);
      const branch = await makeBranch(t.db, { isMain: true });
      const flour = await makeProduct(t.db, {
        name: "Harina",
        unitType: "WEIGHT",
        pricePurchase: "2",
        quantityStock: 10,
      });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true, priceSale: "100" });
      await makeBranchStock(t.db, flour.id, branch.id, 10);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.5, unitType: "WEIGHT" }]);

      const res = await post(
        saleBody(seller.id, pizza.id, {
          items: [{ productId: pizza.id, quantity: 2, priceAtSale: 100 }],
        }),
      );

      expect(res.statusCode).toBe(201);
      expect((await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: flour.id, branchId: branch.id } },
      })).quantityStock).toBeCloseTo(9, 10);
      expect((await t.db.product.findUniqueOrThrow({ where: { id: pizza.id } })).quantityStock).toBe(0);

      const movements = await t.db.stockMovement.findMany();
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ productId: flour.id, reason: "SALE_RECIPE", delta: -1 });
    });

    it("409 si faltan ingredientes para el elaborado", async () => {
      const seller = await makeSeller(t.db);
      const branch = await makeBranch(t.db, { isMain: true });
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 0.2 });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true, priceSale: "100" });
      await makeBranchStock(t.db, flour.id, branch.id, 0.2);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.5, unitType: "WEIGHT" }]);

      const res = await post(
        saleBody(seller.id, pizza.id, {
          items: [{ productId: pizza.id, quantity: 2, priceAtSale: 100 }],
        }),
      );

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toMatch(/Stock insuficiente de ingredientes/);
      expect(await t.db.sale.count()).toBe(0);
      expect(await t.db.stockMovement.count()).toBe(0);
    });
  });

  describe("cuenta corriente", () => {
    it("carga la deuda al cliente y registra el movimiento", async () => {
      const { seller, product } = await seed();
      const client = await makeClient(t.db);

      const res = await post(
        saleBody(seller.id, product.id, { paymentType: "ON_ACCOUNT", clientId: client.id }),
      );

      expect(res.statusCode).toBe(201);
      expect(res.body.onAccount).toBe(true);
      expect(res.body.paymentType).toBe("ON_ACCOUNT");

      const balance = await t.db.accountBalance.findUniqueOrThrow({ where: { clientId: client.id } });
      expect(String(balance.balance)).toBe("200");

      const movements = await t.db.accountMovement.findMany({ where: { accountBalanceId: balance.id } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        type: "SALE_ON_ACCOUNT",
        saleId: res.body.id,
      });
      expect(String(movements[0].amount)).toBe("200");
    });
  });

  describe("facturación electrónica", () => {
    it("adjunta la factura cuando ARCA está habilitado", async () => {
      const { seller, product } = await seed();
      await t.db.setting.create({ data: { key: "arcaEnabled", value: "true" } });
      vi.mocked(createElectronicInvoice).mockResolvedValueOnce({ id: 1, invoiceNumber: "B-1" } as any);

      const res = await post(saleBody(seller.id, product.id, { invoiceType: "B" }));

      expect(res.statusCode).toBe(201);
      expect(res.body.invoice).toEqual({ id: 1, invoiceNumber: "B-1" });
      expect(res.body.arcaError).toBeNull();
      expect(createElectronicInvoice).toHaveBeenCalledTimes(1);
    });

    it("si ARCA falla, la venta igual queda registrada", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { seller, product } = await seed();
      await t.db.setting.create({ data: { key: "arcaEnabled", value: "true" } });
      vi.mocked(createElectronicInvoice).mockRejectedValueOnce(new Error("ARCA caído"));

      const res = await post(saleBody(seller.id, product.id, { invoiceType: "B" }));

      expect(res.statusCode).toBe(201);
      expect(res.body.invoice).toBeNull();
      expect(res.body.arcaError).toBe("ARCA caído");
      expect(await t.db.sale.count()).toBe(1);
      expect(error).toHaveBeenCalled();
    });
  });

  describe("caja", () => {
    it("registra el ingreso en efectivo cuando la caja está abierta", async () => {
      const { seller, product } = await seed();
      const register = await makeCashRegister(t.db, { status: "OPEN" });

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect(res.body.cashRegisterId).toBe(register.id);

      const movements = await t.db.cashMovement.findMany();
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        cashRegisterId: register.id,
        type: "SALE",
        paymentType: "CASH",
        sourceId: res.body.id,
      });
      expect(String(movements[0].amount)).toBe("200");
    });

    it("registra los pagos que no son efectivo con su medio de pago", async () => {
      const { seller, product } = await seed();
      await makeCashRegister(t.db, { status: "OPEN" });

      const res = await post(saleBody(seller.id, product.id, { paymentType: "TRANSFER" }));

      expect(res.statusCode).toBe(201);
      const movements = await t.db.cashMovement.findMany();
      expect(movements).toHaveLength(1);
      expect(movements[0].paymentType).toBe("TRANSFER");
      expect(String(movements[0].amount)).toBe("200");
    });

    it("no registra caja si no hay una caja abierta", async () => {
      const { seller, product } = await seed();

      const res = await post(saleBody(seller.id, product.id));

      expect(res.statusCode).toBe(201);
      expect(await t.db.cashMovement.count()).toBe(0);
    });
  });
});

describe("GET /api/ventas", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("ventas-get");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("devuelve las ventas con el total serializado como string", async () => {
    const seller = await makeSeller(t.db);
    await makeSale(t.db, { sellerId: seller.id, totalAmount: "150.75" });

    const res = await callHandler(handler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalAmount).toBe("150.75");
  });

  it("pagina y devuelve el total de páginas", async () => {
    const seller = await makeSeller(t.db);
    for (let i = 0; i < 3; i++) await makeSale(t.db, { sellerId: seller.id });

    const res = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { page: "1", limit: "2" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it("filtra por estado", async () => {
    const seller = await makeSeller(t.db);
    await makeSale(t.db, { sellerId: seller.id, status: "COMPLETED" });
    await makeSale(t.db, { sellerId: seller.id, status: "PENDING" });

    const res = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { status: "PENDING" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("PENDING");
  });

  it("400 si clientId no es numérico", async () => {
    const res = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { clientId: "abc" } }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/clientId inválido/);
  });

  it("400 si sellerId no es numérico", async () => {
    const res = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { sellerId: "abc" } }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/sellerId inválido/);
  });

  it("serializa los ítems con su producto y precios como string", async () => {
    const seller = await makeSeller(t.db);
    const product = await makeProduct(t.db, { priceSale: "25.50", pricePurchase: "10" });
    const sale = await makeSale(t.db, { sellerId: seller.id });
    await t.db.saleItem.create({
      data: {
        saleId: sale.id,
        productId: product.id,
        quantity: 2,
        priceAtSale: "25.50",
        purchasePriceAtSale: "10",
      },
    });

    const res = await callHandler(handler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body[0].items[0].priceAtSale).toBe("25.5");
    expect(res.body[0].items[0].product.priceSale).toBe("25.5");
    expect(res.body[0].items[0].product.pricePurchase).toBe("10");
  });

  it("filtra por clientId y sellerId", async () => {
    const seller1 = await makeSeller(t.db);
    const seller2 = await makeSeller(t.db);
    const client = await makeClient(t.db);
    const mine = await makeSale(t.db, { sellerId: seller1.id, clientId: client.id });
    await makeSale(t.db, { sellerId: seller2.id });

    const byClient = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { clientId: String(client.id) } }),
    );
    expect(byClient.statusCode).toBe(200);
    expect(byClient.body).toHaveLength(1);
    expect(byClient.body[0].id).toBe(mine.id);

    const bySeller = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { sellerId: String(seller2.id) } }),
    );
    expect(bySeller.statusCode).toBe(200);
    expect(bySeller.body).toHaveLength(1);
    expect(bySeller.body[0].sellerId).toBe(seller2.id);
  });

  it("interpreta from/to como días argentinos (UTC-3)", async () => {
    const seller = await makeSeller(t.db);
    const previousDay = await makeSale(t.db, { sellerId: seller.id });
    const sameDay = await makeSale(t.db, { sellerId: seller.id });
    // 02:00Z = 23:00 del día anterior en Argentina.
    await t.db.sale.update({
      where: { id: previousDay.id },
      data: { saleDate: new Date("2026-01-01T02:00:00Z") },
    });
    // 04:00Z = 01:00 del 1/1 en Argentina.
    await t.db.sale.update({
      where: { id: sameDay.id },
      data: { saleDate: new Date("2026-01-01T04:00:00Z") },
    });

    const res = await callHandler(
      handler,
      mockReq(undefined, { method: "GET", query: { from: "2026-01-01", to: "2026-01-01" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(sameDay.id);
  });
});
