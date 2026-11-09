import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/db";
import {
  makeBranch,
  makeBranchStock,
  makeProduct,
  makeRecipe,
  makeSupplier,
} from "../../helpers/factories";
import {
  MAX_RECIPE_DEPTH,
  computeDerivedStock,
  computeOrderIngredientShortfall,
  computeRecipeCost,
  deductRecipeStock,
  expandRecipeToLeaves,
  findRecipesAffectedByIngredient,
  getRecipeAvailability,
  recordCostSnapshot,
  replaceRecipeItems,
  restoreRecipeStock,
} from "../../../lib/recipeStock";

// El recetario define el stock derivado de los elaborados: no se descuenta el
// producto vendido, se descuentan sus ingredientes hoja. Un error acá deja
// stock fantasma (o negativo) y costos mal calculados en el margen.
describe("recipeStock", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb("recipe");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  /** Pizza = 0,3 kg de harina + 0,2 kg de queso. */
  async function makePizza(stock = 10) {
    const flour = await makeProduct(t.db, {
      name: "Harina",
      unitType: "WEIGHT",
      pricePurchase: "2",
      quantityStock: stock,
    });
    const cheese = await makeProduct(t.db, {
      name: "Queso",
      unitType: "WEIGHT",
      pricePurchase: "5",
      quantityStock: stock,
    });
    const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true, priceSale: "100" });
    await makeRecipe(t.db, pizza.id, [
      { ingredientId: flour.id, quantity: 0.3, unitType: "WEIGHT" },
      { ingredientId: cheese.id, quantity: 0.2, unitType: "WEIGHT" },
    ]);
    return { flour, cheese, pizza };
  }

  describe("expandRecipeToLeaves", () => {
    it("devuelve el propio producto cuando no tiene receta", async () => {
      const p = await makeProduct(t.db, { name: "Gaseosa", quantityStock: 5 });

      const leaves = await expandRecipeToLeaves(t.db, p.id, 2);

      expect(leaves).toHaveLength(1);
      expect(leaves[0]).toMatchObject({ productId: p.id, name: "Gaseosa", quantity: 2, isRecipe: false });
    });

    it("multiplica las cantidades por la cantidad vendida", async () => {
      const { flour, cheese, pizza } = await makePizza();

      const leaves = await expandRecipeToLeaves(t.db, pizza.id, 3);

      const byId = new Map(leaves.map((l) => [l.productId, l]));
      expect(byId.get(flour.id)!.quantity).toBeCloseTo(0.9, 10);
      expect(byId.get(cheese.id)!.quantity).toBeCloseTo(0.6, 10);
    });

    it("acumula un ingrediente que aparece por más de un camino", async () => {
      const salt = await makeProduct(t.db, { name: "Sal", unitType: "WEIGHT", quantityStock: 100 });
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      const combo = await makeProduct(t.db, { name: "Combo", isRecipe: true });

      await makeRecipe(t.db, a.id, [{ ingredientId: salt.id, quantity: 1, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: salt.id, quantity: 2, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, combo.id, [
        { ingredientId: a.id, quantity: 1 },
        { ingredientId: b.id, quantity: 1 },
      ]);

      const leaves = await expandRecipeToLeaves(t.db, combo.id, 2);

      expect(leaves).toHaveLength(1);
      expect(leaves[0]).toMatchObject({ productId: salt.id });
      // (1 + 2) por unidad × 2 unidades
      expect(leaves[0].quantity).toBeCloseTo(6, 10);
    });

    it("expande recetas anidadas", async () => {
      const tomato = await makeProduct(t.db, { name: "Tomate", unitType: "WEIGHT", quantityStock: 10 });
      const sauce = await makeProduct(t.db, { name: "Salsa", isRecipe: true });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });

      await makeRecipe(t.db, sauce.id, [{ ingredientId: tomato.id, quantity: 2, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: sauce.id, quantity: 1 }]);

      const leaves = await expandRecipeToLeaves(t.db, pizza.id, 3);

      expect(leaves).toHaveLength(1);
      expect(leaves[0].productId).toBe(tomato.id);
      expect(leaves[0].quantity).toBeCloseTo(6, 10);
    });

    it("detecta un ciclo directo", async () => {
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: a.id, quantity: 1 }]);

      await expect(expandRecipeToLeaves(t.db, a.id, 1)).rejects.toThrow(/Ciclo detectado/);
    });

    it("corta una cadena más profunda que el máximo", async () => {
      // Cadena lineal de MAX_RECIPE_DEPTH + 3 elaborados.
      const chain = [];
      for (let i = 0; i < MAX_RECIPE_DEPTH + 3; i++) {
        chain.push(await makeProduct(t.db, { name: `Nivel ${i}`, isRecipe: true }));
      }
      for (let i = 0; i < chain.length - 1; i++) {
        await makeRecipe(t.db, chain[i].id, [{ ingredientId: chain[i + 1].id, quantity: 1 }]);
      }

      await expect(expandRecipeToLeaves(t.db, chain[0].id, 1)).rejects.toThrow(/profundidad máxima/);
    });
  });

  describe("getRecipeAvailability", () => {
    it("para un producto simple devuelve su stock", async () => {
      const p = await makeProduct(t.db, { quantityStock: 7 });

      const res = await getRecipeAvailability(t.db, p.id);

      expect(res.available).toBe(7);
      expect(res.limiting).toEqual([]);
    });

    it("devuelve el mínimo entre los ingredientes y marca el limitante", async () => {
      const { flour } = await makePizza(10);

      const res = await getRecipeAvailability(t.db, (await t.db.product.findFirstOrThrow({ where: { name: "Pizza" } })).id);

      // harina: floor(10 / 0,3) = 33 ; queso: floor(10 / 0,2) = 50
      expect(res.available).toBe(33);
      expect(res.limiting).toHaveLength(1);
      expect(res.limiting[0]).toMatchObject({ ingredientId: flour.id, name: "Harina" });
    });

    it("no se equivoca con 0,3 / 0,1 (regresión de coma flotante)", async () => {
      // 0.3 / 0.1 da 2.9999999999999996: sin el redondeo previo, floor = 2.
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 0.3 });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.1, unitType: "WEIGHT" }]);

      const res = await getRecipeAvailability(t.db, pizza.id);

      expect(res.available).toBe(3);
    });

    it("un ingrediente con cantidad 0 no limita", async () => {
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 0.9 });
      const salt = await makeProduct(t.db, { name: "Sal", unitType: "WEIGHT", quantityStock: 0 });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, pizza.id, [
        { ingredientId: flour.id, quantity: 0.3, unitType: "WEIGHT" },
        { ingredientId: salt.id, quantity: 0, unitType: "WEIGHT" },
      ]);

      const res = await getRecipeAvailability(t.db, pizza.id);

      expect(res.available).toBe(3);
      expect(res.limiting.map((l) => l.name)).toEqual(["Harina"]);
    });

    it("en una sucursal sin fila de stock asume 0 (no cae al global)", async () => {
      const branch = await makeBranch(t.db);
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 100 });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.5, unitType: "WEIGHT" }]);

      const global = await getRecipeAvailability(t.db, pizza.id);
      const perBranch = await getRecipeAvailability(t.db, pizza.id, branch.id);

      expect(global.available).toBe(200);
      expect(perBranch.available).toBe(0);
    });

    it("soporta recetas anidadas", async () => {
      const tomato = await makeProduct(t.db, { name: "Tomate", unitType: "WEIGHT", quantityStock: 10 });
      const sauce = await makeProduct(t.db, { name: "Salsa", isRecipe: true });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, sauce.id, [{ ingredientId: tomato.id, quantity: 2, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: sauce.id, quantity: 1 }]);

      const res = await getRecipeAvailability(t.db, pizza.id);

      expect(res.available).toBe(5); // 10 / (2 × 1)
    });

    it("marca todos los ingredientes empatados como limitantes", async () => {
      const a = await makeProduct(t.db, { name: "A", quantityStock: 10 });
      const b = await makeProduct(t.db, { name: "B", quantityStock: 10 });
      const combo = await makeProduct(t.db, { name: "Combo", isRecipe: true });
      await makeRecipe(t.db, combo.id, [
        { ingredientId: a.id, quantity: 1 },
        { ingredientId: b.id, quantity: 1 },
      ]);

      const res = await getRecipeAvailability(t.db, combo.id);

      expect(res.available).toBe(10);
      expect(res.limiting.map((l) => l.name).sort()).toEqual(["A", "B"]);
    });

    it("computeDerivedStock devuelve la disponibilidad del elaborado", async () => {
      const { pizza } = await makePizza(10);

      expect(await computeDerivedStock(t.db, pizza.id)).toBe(33);
    });

    it("detecta ciclos", async () => {
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: a.id, quantity: 1 }]);

      await expect(getRecipeAvailability(t.db, a.id)).rejects.toThrow(/Ciclo detectado/);
    });
  });

  describe("computeOrderIngredientShortfall", () => {
    it("suma el requerimiento de varios elaborados que comparten ingrediente", async () => {
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 3 });
      const pizzaA = await makeProduct(t.db, { name: "Pizza A", isRecipe: true });
      const pizzaB = await makeProduct(t.db, { name: "Pizza B", isRecipe: true });
      await makeRecipe(t.db, pizzaA.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, pizzaB.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);

      // 2 de A + 2 de B = 4 kg; hay 3 → faltan 1.
      const shortfalls = await computeOrderIngredientShortfall(t.db, [
        { productId: pizzaA.id, quantity: 2 },
        { productId: pizzaB.id, quantity: 2 },
      ]);

      expect(shortfalls).toHaveLength(1);
      expect(shortfalls[0]).toMatchObject({
        ingredientId: flour.id,
        required: 4,
        available: 3,
        shortfall: 1,
        unitType: "WEIGHT",
      });
      expect(shortfalls[0].usedBy.sort()).toEqual(["Pizza A", "Pizza B"]);
    });

    it("no devuelve nada si alcanza el stock", async () => {
      const { pizza } = await makePizza(10);

      const shortfalls = await computeOrderIngredientShortfall(t.db, [{ productId: pizza.id, quantity: 2 }]);

      expect(shortfalls).toEqual([]);
    });

    it("ignora productos simples y cantidades no positivas", async () => {
      const simple = await makeProduct(t.db, { name: "Gaseosa", quantityStock: 0 });

      const shortfalls = await computeOrderIngredientShortfall(t.db, [
        { productId: simple.id, quantity: 5 },
        { productId: simple.id, quantity: 0 },
      ]);

      expect(shortfalls).toEqual([]);
    });

    it("no se cae si un elaborado tiene un ciclo", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: a.id, quantity: 1 }]);

      const shortfalls = await computeOrderIngredientShortfall(t.db, [{ productId: a.id, quantity: 1 }]);

      expect(shortfalls).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe("deductRecipeStock", () => {
    it("descuenta los ingredientes y no toca el stock del elaborado", async () => {
      const { flour, cheese, pizza } = await makePizza(10);

      const affected = await deductRecipeStock(t.db, pizza.id, 2);

      expect(affected.sort()).toEqual([flour.id, cheese.id].sort());
      const afterFlour = await t.db.product.findUniqueOrThrow({ where: { id: flour.id } });
      const afterCheese = await t.db.product.findUniqueOrThrow({ where: { id: cheese.id } });
      const afterPizza = await t.db.product.findUniqueOrThrow({ where: { id: pizza.id } });
      expect(afterFlour.quantityStock).toBeCloseTo(9.4, 10);
      expect(afterCheese.quantityStock).toBeCloseTo(9.6, 10);
      expect(afterPizza.quantityStock).toBe(0);
    });

    it("deja un movimiento por ingrediente con motivo SALE_RECIPE", async () => {
      const { pizza } = await makePizza(10);

      await deductRecipeStock(t.db, pizza.id, 1);

      const movements = await t.db.stockMovement.findMany({ orderBy: { id: "asc" } });
      expect(movements).toHaveLength(2);
      for (const m of movements) {
        expect(m).toMatchObject({ reason: "SALE_RECIPE", refType: "Recipe", refId: String(pizza.id) });
      }
    });

    it("descuenta de la sucursal indicada, no del global", async () => {
      const branch = await makeBranch(t.db);
      const { flour, cheese, pizza } = await makePizza(0);
      await makeBranchStock(t.db, flour.id, branch.id, 10);
      await makeBranchStock(t.db, cheese.id, branch.id, 10);

      await deductRecipeStock(t.db, pizza.id, 1, branch.id);

      expect(await t.db.productBranchStock.findUniqueOrThrow({
        where: { productId_branchId: { productId: flour.id, branchId: branch.id } },
      })).toMatchObject({ quantityStock: 9.7 });
      // El global se recalcula desde las sucursales.
      expect((await t.db.product.findUniqueOrThrow({ where: { id: flour.id } })).quantityStock).toBeCloseTo(9.7, 10);
    });

    it("devuelve [] y no descuenta nada si el producto no es elaborado", async () => {
      const p = await makeProduct(t.db, { quantityStock: 5 });

      const affected = await deductRecipeStock(t.db, p.id, 2);

      expect(affected).toEqual([]);
      expect(await t.db.stockMovement.count()).toBe(0);
      expect((await t.db.product.findUniqueOrThrow({ where: { id: p.id } })).quantityStock).toBe(5);
    });

    it("falla si falta stock de un ingrediente", async () => {
      const { pizza } = await makePizza(0.1);

      await expect(deductRecipeStock(t.db, pizza.id, 1)).rejects.toThrow(/Stock insuficiente del ingrediente/);
    });

    it("dentro de una transacción, el faltante revierte lo ya descontado", async () => {
      // Queso alcanza, harina no: el orden importa para probar el rollback.
      const cheese = await makeProduct(t.db, { name: "Queso", unitType: "WEIGHT", quantityStock: 100 });
      const flour = await makeProduct(t.db, { name: "Harina", unitType: "WEIGHT", quantityStock: 0.1 });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, pizza.id, [
        { ingredientId: cheese.id, quantity: 0.2, unitType: "WEIGHT" },
        { ingredientId: flour.id, quantity: 0.3, unitType: "WEIGHT" },
      ]);

      await expect(
        t.db.$transaction(async (tx) => deductRecipeStock(tx, pizza.id, 1)),
      ).rejects.toThrow(/Stock insuficiente del ingrediente/);

      const afterCheese = await t.db.product.findUniqueOrThrow({ where: { id: cheese.id } });
      const afterFlour = await t.db.product.findUniqueOrThrow({ where: { id: flour.id } });
      expect(afterCheese.quantityStock).toBe(100);
      expect(afterFlour.quantityStock).toBeCloseTo(0.1, 10);
      expect(await t.db.stockMovement.count()).toBe(0);
    });
  });

  describe("restoreRecipeStock", () => {
    it("devuelve los ingredientes al anular una venta", async () => {
      const { flour, cheese, pizza } = await makePizza(10);
      await deductRecipeStock(t.db, pizza.id, 2);

      const affected = await restoreRecipeStock(t.db, pizza.id, 2);

      expect(affected.sort()).toEqual([flour.id, cheese.id].sort());
      expect((await t.db.product.findUniqueOrThrow({ where: { id: flour.id } })).quantityStock).toBeCloseTo(10, 10);
      expect((await t.db.product.findUniqueOrThrow({ where: { id: cheese.id } })).quantityStock).toBeCloseTo(10, 10);
      const restoreMovements = await t.db.stockMovement.findMany({ where: { reason: "SALE_CANCEL_RECIPE" } });
      expect(restoreMovements).toHaveLength(2);
    });

    it("devuelve [] si el producto no es elaborado", async () => {
      const p = await makeProduct(t.db, { quantityStock: 5 });
      expect(await restoreRecipeStock(t.db, p.id, 1)).toEqual([]);
    });
  });

  describe("computeRecipeCost", () => {
    it("para un ingrediente simple usa su costo de compra", async () => {
      const p = await makeProduct(t.db, { name: "Harina", pricePurchase: "2.50" });

      const res = await computeRecipeCost(t.db, p.id);

      expect(res.cost.toString()).toBe("2.5");
      expect(res.hasFullCost).toBe(true);
    });

    it("suma costo × cantidad de cada ingrediente", async () => {
      const { pizza } = await makePizza();

      const res = await computeRecipeCost(t.db, pizza.id);

      // 0,3 × 2 + 0,2 × 5 = 1,6
      expect(Number(res.cost.toString())).toBeCloseTo(1.6, 10);
      expect(res.hasFullCost).toBe(true);
    });

    it("calcula recetas anidadas", async () => {
      const tomato = await makeProduct(t.db, { name: "Tomate", pricePurchase: "1.50", unitType: "WEIGHT" });
      const sauce = await makeProduct(t.db, { name: "Salsa", isRecipe: true });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, sauce.id, [{ ingredientId: tomato.id, quantity: 2, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: sauce.id, quantity: 1 }]);

      const res = await computeRecipeCost(t.db, pizza.id);

      expect(Number(res.cost.toString())).toBeCloseTo(3, 10);
      expect(res.hasFullCost).toBe(true);
    });

    it("marca hasFullCost=false si un ingrediente no tiene costo", async () => {
      const flour = await makeProduct(t.db, { name: "Harina", pricePurchase: "0", unitType: "WEIGHT" });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1, unitType: "WEIGHT" }]);

      const res = await computeRecipeCost(t.db, pizza.id);

      expect(res.cost.toString()).toBe("0");
      expect(res.hasFullCost).toBe(false);
    });

    it("cae al precio de la última compra RECIBIDA, ignorando las pendientes", async () => {
      const supplier = await makeSupplier(t.db);
      const flour = await makeProduct(t.db, { name: "Harina", pricePurchase: "0", unitType: "WEIGHT" });

      const received = await t.db.purchase.create({
        data: { supplierId: supplier.id, totalAmount: "45", status: "RECEIVED" },
      });
      await t.db.purchaseItem.create({
        data: { purchaseId: received.id, productId: flour.id, quantity: 10, purchasePrice: "4.50" },
      });
      const pending = await t.db.purchase.create({
        data: { supplierId: supplier.id, totalAmount: "990", status: "PENDING" },
      });
      await t.db.purchaseItem.create({
        data: { purchaseId: pending.id, productId: flour.id, quantity: 10, purchasePrice: "99" },
      });

      const res = await computeRecipeCost(t.db, flour.id);

      expect(res.cost.toString()).toBe("4.5");
      expect(res.hasFullCost).toBe(true);
    });

    it("no entra en loop con un ciclo defensivo", async () => {
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: a.id, quantity: 1 }]);

      const res = await computeRecipeCost(t.db, a.id);

      expect(res.hasFullCost).toBe(false);
    });
  });

  describe("replaceRecipeItems", () => {
    it("reemplaza la lista completa de ingredientes", async () => {
      const { flour, pizza } = await makePizza();

      await replaceRecipeItems(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0.5 }]);

      const items = await t.db.recipeItem.findMany({ where: { productId: pizza.id } });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ ingredientId: flour.id, quantity: 0.5 });
    });

    it("hereda la unidad del ingrediente", async () => {
      const { flour, pizza } = await makePizza();

      await replaceRecipeItems(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 1, unitType: "UNIT" }]);

      const item = await t.db.recipeItem.findFirstOrThrow({ where: { productId: pizza.id } });
      expect(item.unitType).toBe("WEIGHT");
    });

    it("ignora ingredientes repetidos (se queda con el primero)", async () => {
      const { flour, pizza } = await makePizza();

      await replaceRecipeItems(t.db, pizza.id, [
        { ingredientId: flour.id, quantity: 0.3 },
        { ingredientId: flour.id, quantity: 0.9 },
      ]);

      const items = await t.db.recipeItem.findMany({ where: { productId: pizza.id } });
      expect(items).toHaveLength(1);
      expect(items[0].quantity).toBe(0.3);
    });

    it("rechaza que el producto sea su propio ingrediente", async () => {
      const { pizza } = await makePizza();
      await expect(
        replaceRecipeItems(t.db, pizza.id, [{ ingredientId: pizza.id, quantity: 1 }]),
      ).rejects.toThrow(/no puede ser su propio ingrediente/);
    });

    it("rechaza cantidades <= 0", async () => {
      const { flour, pizza } = await makePizza();
      await expect(
        replaceRecipeItems(t.db, pizza.id, [{ ingredientId: flour.id, quantity: 0 }]),
      ).rejects.toThrow(/cantidad mayor a 0/);
    });

    it("rechaza ingredientes inexistentes", async () => {
      const { pizza } = await makePizza();
      await expect(
        replaceRecipeItems(t.db, pizza.id, [{ ingredientId: 999_999, quantity: 1 }]),
      ).rejects.toThrow(/no encontrado/);
    });

    it("usa la unidad indicada si el ingrediente no tiene una válida", async () => {
      const { pizza } = await makePizza();
      const loose = await makeProduct(t.db, { name: "Suelto", unitType: null });

      await replaceRecipeItems(t.db, pizza.id, [
        { ingredientId: loose.id, quantity: 1, unitType: "VOLUME" },
      ]);

      const item = await t.db.recipeItem.findFirstOrThrow({ where: { productId: pizza.id } });
      expect(item.unitType).toBe("VOLUME");
    });

    it("rechaza crear un ciclo transitivo", async () => {
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);

      // B ← A crearía A → B → A.
      await expect(
        replaceRecipeItems(t.db, b.id, [{ ingredientId: a.id, quantity: 1 }]),
      ).rejects.toThrow(/ciclo/);
    });

    it("rechaza un ciclo de tres niveles", async () => {
      const a = await makeProduct(t.db, { name: "A", isRecipe: true });
      const b = await makeProduct(t.db, { name: "B", isRecipe: true });
      const c = await makeProduct(t.db, { name: "C", isRecipe: true });
      await makeRecipe(t.db, a.id, [{ ingredientId: b.id, quantity: 1 }]);
      await makeRecipe(t.db, b.id, [{ ingredientId: c.id, quantity: 1 }]);

      // C ← A crearía A → B → C → A.
      await expect(
        replaceRecipeItems(t.db, c.id, [{ ingredientId: a.id, quantity: 1 }]),
      ).rejects.toThrow(/ciclo/);
    });

    it("con lista vacía borra todos los ingredientes", async () => {
      const { pizza } = await makePizza();
      await replaceRecipeItems(t.db, pizza.id, []);
      expect(await t.db.recipeItem.count({ where: { productId: pizza.id } })).toBe(0);
    });
  });

  describe("findRecipesAffectedByIngredient", () => {
    it("encuentra dependencias directas y transitivas", async () => {
      const tomato = await makeProduct(t.db, { name: "Tomate", unitType: "WEIGHT" });
      const sauce = await makeProduct(t.db, { name: "Salsa", isRecipe: true });
      const pizza = await makeProduct(t.db, { name: "Pizza", isRecipe: true });
      await makeRecipe(t.db, sauce.id, [{ ingredientId: tomato.id, quantity: 2, unitType: "WEIGHT" }]);
      await makeRecipe(t.db, pizza.id, [{ ingredientId: sauce.id, quantity: 1 }]);

      const affected = await findRecipesAffectedByIngredient(t.db, [tomato.id]);

      expect(affected.sort()).toEqual([sauce.id, pizza.id].sort());
    });

    it("devuelve [] para un ingrediente que nadie usa", async () => {
      const p = await makeProduct(t.db, { name: "Suelto" });
      expect(await findRecipesAffectedByIngredient(t.db, [p.id])).toEqual([]);
    });
  });

  describe("recordCostSnapshot", () => {
    it("no registra nada para un producto simple", async () => {
      const p = await makeProduct(t.db, { pricePurchase: "2" });
      await recordCostSnapshot(t.db, p.id, "manual");
      expect(await t.db.recipeCostHistory.count()).toBe(0);
    });

    it("registra el primer snapshot y evita duplicados si el costo no cambió", async () => {
      const { pizza } = await makePizza();

      await recordCostSnapshot(t.db, pizza.id, "recipe_save");
      await recordCostSnapshot(t.db, pizza.id, "recipe_save");

      const rows = await t.db.recipeCostHistory.findMany({ where: { productId: pizza.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe("recipe_save");
      expect(Number(rows[0].cost.toString())).toBeCloseTo(1.6, 10);
    });

    it("registra uno nuevo cuando cambia el costo de un ingrediente", async () => {
      const { flour, pizza } = await makePizza();
      await recordCostSnapshot(t.db, pizza.id, "recipe_save");

      await t.db.product.update({ where: { id: flour.id }, data: { pricePurchase: "4" } });
      await recordCostSnapshot(t.db, pizza.id, "purchase");

      const rows = await t.db.recipeCostHistory.findMany({
        where: { productId: pizza.id },
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(2);
      // 0,3 × 4 + 0,2 × 5 = 2,2
      expect(Number(rows[1].cost.toString())).toBeCloseTo(2.2, 10);
      expect(rows[1].source).toBe("purchase");
    });
  });
});
