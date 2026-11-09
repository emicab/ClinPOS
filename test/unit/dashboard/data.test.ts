import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrandCount,
  getCategoryCount,
  getClientCount,
  getDailySalesCountForCurrentWeek,
  getFinancialSummary,
  getLowStockProductCount,
  getMonthlyFinancialSummaries,
  getPaymentTypeDistribution,
  getProductCount,
  getProductsPerCategory,
  getRevenueDataForCurrentAndPreviousMonth,
  getSalesForLastXDays,
  getTopSellingProducts,
  getTotalRevenueThisMonth,
} from "../../../lib/data";
import { setupApi, teardownApi, type TestDb } from "../../helpers/api";
import {
  makeBranch,
  makeBranchStock,
  makeBrand,
  makeCategory,
  makeClient,
  makeExpense,
  makeProduct,
  makeSale,
  makeSaleItem,
  makeSeller,
  setSetting,
} from "../../helpers/factories";

/** Fecha local (Argentina) en formato YYYY-MM-DD, desplazada N días. */
function localDayString(offsetDays = 0): string {
  const local = new Date(Date.now() - 3 * 60 * 60 * 1000);
  local.setUTCDate(local.getUTCDate() + offsetDays);
  return local.toISOString().slice(0, 10);
}

/** Mediodía local de un mes desplazado (0 = mes actual). */
function monthDate(offsetMonths: number, day = 15): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - offsetMonths, day, 12, 0, 0, 0);
}

function monthLabel(offsetMonths: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - offsetMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// lib/data.ts alimenta el dashboard: ingresos, COGS, gastos, ranking y stock
// bajo. Un error de fecha o incluir ventas PENDING infla la facturación que ve
// el dueño; por eso cada agregado se prueba con ventas fuera de rango.
describe("conteos simples", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("data-counts");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("cuenta productos, clientes, marcas y categorías", async () => {
    await makeProduct(t.db);
    await makeProduct(t.db);
    await makeClient(t.db);
    await makeBrand(t.db);
    await makeCategory(t.db);

    expect(await getProductCount()).toBe(2);
    expect(await getClientCount()).toBe(1);
    expect(await getBrandCount()).toBe(1);
    expect(await getCategoryCount()).toBe(1);
  });
});

describe("getProductsPerCategory", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("data-categories");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("cuenta productos por categoría y descarta las vacías", async () => {
    const bebidas = await makeCategory(t.db, "Bebidas");
    const comidas = await makeCategory(t.db, "Comidas");
    await makeCategory(t.db, "Vacía");
    await makeProduct(t.db, { categoryId: bebidas.id });
    await makeProduct(t.db, { categoryId: bebidas.id });
    await makeProduct(t.db, { categoryId: comidas.id });

    expect(await getProductsPerCategory()).toEqual([
      { name: "Bebidas", productCount: 2 },
      { name: "Comidas", productCount: 1 },
    ]);
  });
});

describe("getLowStockProductCount", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("data-low-stock");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("sin sucursales usa el stock global", async () => {
    await makeProduct(t.db, { quantityStock: 0 }); // sin stock
    await makeProduct(t.db, { quantityStock: 3, stockMinAlert: 5 }); // bajo mínimo
    await makeProduct(t.db, { quantityStock: 10, stockMinAlert: 5 }); // ok
    await makeProduct(t.db, { quantityStock: 0, isRecipe: true }); // elaborado: no cuenta
    await makeProduct(t.db, { quantityStock: 0, isRecipe: true, stockMinAlert: 5 }); // elaborado con mínimo

    expect(await getLowStockProductCount()).toBe(3);
  });

  it("con sucursal usa el stock de ESA sucursal, no el global", async () => {
    const main = await makeBranch(t.db, { isMain: true });
    const okGlobal = await makeProduct(t.db, { quantityStock: 100 });
    const lowInBranch = await makeProduct(t.db, { quantityStock: 100 });
    const missingRow = await makeProduct(t.db, { quantityStock: 0 });
    await makeBranchStock(t.db, okGlobal.id, main.id, 10);
    await makeBranchStock(t.db, lowInBranch.id, main.id, 0);
    // missingRow no tiene fila por sucursal: el JOIN la excluye.

    expect(await getLowStockProductCount()).toBe(1);
    expect(missingRow.id).toBeTruthy();
  });

  it("respeta el stock mínimo configurado por sucursal", async () => {
    const main = await makeBranch(t.db, { isMain: true });
    const product = await makeProduct(t.db, { stockMinAlert: 5 });
    await makeBranchStock(t.db, product.id, main.id, 3);

    expect(await getLowStockProductCount()).toBe(1);
  });

  it("la sucursal del equipo tiene prioridad sobre la Casa Central", async () => {
    await makeBranch(t.db, { isMain: true });
    const secondary = await makeBranch(t.db);
    const product = await makeProduct(t.db);
    await makeBranchStock(t.db, product.id, secondary.id, 0);
    await setSetting(t.db, "device_branch_id", String(secondary.id));

    expect(await getLowStockProductCount()).toBe(1);
  });
});

describe("ingresos y ventas", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-revenue");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("suma solo las ventas COMPLETED del mes actual", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "100.50" });
    await makeSale(t.db, { sellerId, totalAmount: "49.50" });
    await makeSale(t.db, { sellerId, totalAmount: "999", status: "PENDING" });
    await makeSale(t.db, { sellerId, totalAmount: "999", status: "CANCELLED" });
    await makeSale(t.db, { sellerId, totalAmount: "999", saleDate: monthDate(1) });

    expect(await getTotalRevenueThisMonth()).toBe(150);
  });

  it("getSalesForLastXDays rellena los días sin ventas con 0", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "100" });
    await makeSale(t.db, { sellerId, totalAmount: "50", saleDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    await makeSale(t.db, { sellerId, totalAmount: "999", status: "PENDING" });

    const data = await getSalesForLastXDays(4);

    expect(data).toHaveLength(4);
    expect(data.map((d) => d.date)).toEqual([
      localDayString(-3),
      localDayString(-2),
      localDayString(-1),
      localDayString(0),
    ]);
    expect(data[3].totalSales).toBe(100);
    expect(data[1].totalSales).toBe(50);
    expect(data[0].totalSales).toBe(0);
    expect(data[2].totalSales).toBe(0);
  });

  it("getSalesForLastXDays agrupa varias ventas del mismo día", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "10" });
    await makeSale(t.db, { sellerId, totalAmount: "15.5" });

    const data = await getSalesForLastXDays(1);

    expect(data).toEqual([{ date: localDayString(0), totalSales: 25.5 }]);
  });

  it("compara el mes actual contra el anterior", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "150" });
    await makeSale(t.db, { sellerId, totalAmount: "100", saleDate: monthDate(1) });

    expect(await getRevenueDataForCurrentAndPreviousMonth()).toEqual({
      currentMonthRevenue: 150,
      previousMonthRevenue: 100,
      differenceAmount: 50,
      percentageChange: 50,
    });
  });

  it("con mes anterior en 0 el cambio porcentual es null", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "100" });

    const data = await getRevenueDataForCurrentAndPreviousMonth();

    expect(data.previousMonthRevenue).toBe(0);
    expect(data.percentageChange).toBeNull();
  });

  it("sin ventas en ninguno de los dos meses devuelve todo en 0", async () => {
    expect(await getRevenueDataForCurrentAndPreviousMonth()).toEqual({
      currentMonthRevenue: 0,
      previousMonthRevenue: 0,
      differenceAmount: 0,
      percentageChange: null,
    });
  });

  it("calcula una caída negativa", async () => {
    await makeSale(t.db, { sellerId, totalAmount: "50" });
    await makeSale(t.db, { sellerId, totalAmount: "100", saleDate: monthDate(1) });

    const data = await getRevenueDataForCurrentAndPreviousMonth();

    expect(data.differenceAmount).toBe(-50);
    expect(data.percentageChange).toBe(-50);
  });
});

describe("getTopSellingProducts", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-top-products");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("ordena por cantidad vendida y respeta el límite", async () => {
    const a = await makeProduct(t.db, { name: "A" });
    const b = await makeProduct(t.db, { name: "B" });
    const c = await makeProduct(t.db, { name: "C" });
    const sale = await makeSale(t.db, { sellerId });
    await makeSaleItem(t.db, sale.id, { productId: a.id, quantity: 5 });
    await makeSaleItem(t.db, sale.id, { productId: b.id, quantity: 3 });
    await makeSaleItem(t.db, sale.id, { productId: c.id, quantity: 1 });

    expect(await getTopSellingProducts(2)).toEqual([
      { productName: "A", totalSold: 5 },
      { productName: "B", totalSold: 3 },
    ]);
  });

  it("solo cuenta ventas COMPLETED dentro de la ventana", async () => {
    const product = await makeProduct(t.db, { name: "A" });
    const completed = await makeSale(t.db, { sellerId });
    await makeSaleItem(t.db, completed.id, { productId: product.id, quantity: 2 });
    const pending = await makeSale(t.db, { sellerId, status: "PENDING" });
    await makeSaleItem(t.db, pending.id, { productId: product.id, quantity: 100 });
    const old = await makeSale(t.db, { sellerId, saleDate: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
    await makeSaleItem(t.db, old.id, { productId: product.id, quantity: 100 });

    expect(await getTopSellingProducts(5, 30)).toEqual([{ productName: "A", totalSold: 2 }]);
  });

  it("ignora ítems sin producto", async () => {
    const sale = await makeSale(t.db, { sellerId });
    await makeSaleItem(t.db, sale.id, { productId: null, quantity: 10 });

    expect(await getTopSellingProducts()).toEqual([]);
  });
});

describe("getFinancialSummary", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-financial");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("calcula ingresos, COGS, gastos y ganancias del mes", async () => {
    const sale = await makeSale(t.db, { sellerId, totalAmount: "100" });
    await makeSaleItem(t.db, sale.id, { quantity: 2, purchasePriceAtSale: "10" });
    await makeExpense(t.db, { amount: "30" });

    expect(await getFinancialSummary()).toEqual({
      totalRevenue: 100,
      totalCOGS: 20,
      totalExpenses: 30,
      grossProfit: 80,
      netProfit: 50,
    });
  });

  it("excluye ventas no completadas y movimientos fuera del período", async () => {
    const completed = await makeSale(t.db, { sellerId, totalAmount: "100" });
    await makeSaleItem(t.db, completed.id, { quantity: 1, purchasePriceAtSale: "10" });
    const pending = await makeSale(t.db, { sellerId, totalAmount: "999", status: "PENDING" });
    await makeSaleItem(t.db, pending.id, { quantity: 100, purchasePriceAtSale: "10" });
    await makeExpense(t.db, { amount: "999", expenseDate: monthDate(2) });

    const summary = await getFinancialSummary();

    expect(summary.totalRevenue).toBe(100);
    expect(summary.totalCOGS).toBe(10);
    expect(summary.totalExpenses).toBe(0);
  });

  it("acepta un período explícito", async () => {
    const sale = await makeSale(t.db, { sellerId, totalAmount: "80", saleDate: monthDate(1) });
    await makeSaleItem(t.db, sale.id, { quantity: 4, purchasePriceAtSale: "5" });
    await makeExpense(t.db, { amount: "12", expenseDate: monthDate(1) });

    const start = monthDate(1, 1);
    start.setHours(0, 0, 0, 0);
    const end = monthDate(1, 28);
    end.setHours(23, 59, 59, 999);

    const summary = await getFinancialSummary({ startDate: start, endDate: end });

    expect(summary).toMatchObject({ totalRevenue: 80, totalCOGS: 20, totalExpenses: 12, netProfit: 48 });
  });
});

describe("getMonthlyFinancialSummaries", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-monthly");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("devuelve los meses en orden cronológico con sus totales", async () => {
    const current = await makeSale(t.db, { sellerId, totalAmount: "100" });
    await makeSaleItem(t.db, current.id, { quantity: 1, purchasePriceAtSale: "10" });
    await makeExpense(t.db, { amount: "5" });
    const previous = await makeSale(t.db, { sellerId, totalAmount: "200", saleDate: monthDate(1) });
    await makeSaleItem(t.db, previous.id, { quantity: 2, purchasePriceAtSale: "20" });
    await makeExpense(t.db, { amount: "15", expenseDate: monthDate(1) });

    const summaries = await getMonthlyFinancialSummaries(3);

    expect(summaries.map((s) => s.month)).toEqual([
      monthLabel(2),
      monthLabel(1),
      monthLabel(0),
    ]);
    expect(summaries[2]).toMatchObject({
      totalRevenue: 100,
      totalCOGS: 10,
      totalExpenses: 5,
      grossProfit: 90,
      netProfit: 85,
    });
    expect(summaries[1]).toMatchObject({
      totalRevenue: 200,
      totalCOGS: 40,
      totalExpenses: 15,
      netProfit: 145,
    });
    expect(summaries[0]).toMatchObject({
      totalRevenue: 0,
      totalCOGS: 0,
      totalExpenses: 0,
      netProfit: 0,
    });
  });
});

describe("getDailySalesCountForCurrentWeek", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-week");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("devuelve los 7 días de lunes a domingo", async () => {
    const result = await getDailySalesCountForCurrentWeek();

    expect(result.map((d) => d.day)).toEqual([
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
      "Domingo",
    ]);
    expect(result.every((d) => d.sales === 0)).toBe(true);
  });

  it("cuenta las ventas en el día local correcto", async () => {
    await makeSale(t.db, { sellerId });
    await makeSale(t.db, { sellerId });
    await makeSale(t.db, { sellerId, status: "PENDING" });

    const result = await getDailySalesCountForCurrentWeek();

    const local = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const names = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const todayName = names[local.getUTCDay()];

    expect(result.find((d) => d.day === todayName)!.sales).toBe(2);
    expect(result.reduce((sum, d) => sum + d.sales, 0)).toBe(2);
  });
});

describe("getPaymentTypeDistribution", () => {
  let t: TestDb;
  let sellerId: number;

  beforeEach(async () => {
    t = await setupApi("data-payments");
    sellerId = (await makeSeller(t.db)).id;
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("suma por medio de pago y ordena de mayor a menor", async () => {
    await makeSale(t.db, { sellerId, paymentType: "CASH", totalAmount: "100" });
    await makeSale(t.db, { sellerId, paymentType: "CASH", totalAmount: "25" });
    await makeSale(t.db, { sellerId, paymentType: "CARD", totalAmount: "50" });
    await makeSale(t.db, { sellerId, paymentType: "CARD", totalAmount: "999", status: "PENDING" });
    await makeSale(t.db, { sellerId, paymentType: "TRANSFER", totalAmount: "999", saleDate: monthDate(1) });

    expect(await getPaymentTypeDistribution()).toEqual([
      { paymentType: "CASH", total: 125 },
      { paymentType: "CARD", total: 50 },
    ]);
  });
});
