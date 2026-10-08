import prisma from "./prisma";
import { Prisma } from "@prisma/client";
type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

// Helper to get local date boundaries converted to UTC (assuming UTC-3 offset for Argentina / local user time)
function getLocalDateBoundary(year: number, month: number, day: number, hours: number, minutes: number, seconds: number, ms: number): Date {
  const utcTime = Date.UTC(year, month, day, hours, minutes, seconds, ms);
  const offsetMinutes = -180; // UTC-3
  return new Date(utcTime - (offsetMinutes * 60 * 1000));
}

export async function getProductCount() {
    try {
        return await prisma.product.count();
    } catch (error) {
        console.error("Error fetching product count:", error);
        return 0; // Devolver 0 en caso de error
    }
}

export async function getClientCount() {
    try {
        return await prisma.client.count();
    } catch (error) {
        console.error("Error fetching client count:", error);
        return 0;
    }
}

export async function getBrandCount() {
    try {
        return await prisma.brand.count();
    } catch (error) {
        console.error("Error fetching brand count:", error);
        return 0;
    }
}

export async function getCategoryCount() {
    try {
        return await prisma.category.count();
    } catch (error) {
        console.error("Error fetching category count:", error);
        return 0;
    }
}

// Podríamos añadir más aquí, como "productos con stock bajo", etc.
export async function getLowStockProductCount() {
    try {
        // Incluye stock bajo el mínimo configurado y stock 0 sin mínimo.
        // Los elaborados (isRecipe) tienen stock 0 por diseño, así que solo
        // entran por stockMinAlert si lo tienen configurado.
        const result = await prisma.$queryRaw<any[]>`
            SELECT COUNT(*) as count FROM Product
            WHERE (stockMinAlert IS NOT NULL AND quantityStock < stockMinAlert)
               OR (quantityStock <= 0 AND isRecipe = 0)
        `;
        const count = result[0]?.count;
        return typeof count === 'bigint' ? Number(count) : (Number(count) || 0);
    } catch (error) {
        console.error("Error fetching low stock product count:", error);
        return 0;
    }
}

export interface ProductsPerCategoryData {
    name: string; // Nombre de la categoría
    productCount: number; // Cantidad de productos en esa categoría
}

export async function getProductsPerCategory(): Promise<
    ProductsPerCategoryData[]
> {
    try {
        const categoriesWithProductCount = await prisma.category.findMany({
            include: {
                _count: {
                    // Prisma te permite contar relaciones así
                    select: { products: true }, // Cuenta los productos relacionados a esta categoría
                },
            },
            orderBy: {
                // Opcional: ordenar por nombre de categoría o por cantidad de productos
                name: "asc",
            },
        });

        // Transformamos los datos al formato que necesitamos para el gráfico
        const chartData = categoriesWithProductCount.map((category) => ({
            name: category.name,
            productCount: category._count.products,
        }));

        // Opcionalmente, podrías filtrar categorías sin productos si no quieres mostrarlas
        return chartData.filter((data) => data.productCount > 0);
        //return chartData;
    } catch (error) {
        console.error("Error fetching products per category for chart:", error);
        return []; // Devuelve un array vacío en caso de error
    }
}

export async function getTotalRevenueThisMonth(): Promise<number> {
    try {
        const now = new Date();
        const startOfMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endOfMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const sales = await prisma.sale.findMany({
            where: {
                status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
                saleDate: {
                    gte: startOfMonth,
                    lte: endOfMonth,
                },
            },
            select: {
                totalAmount: true,
            },
        });

        const totalRevenue = sales.reduce(
            (sum, sale) => sum.plus(sale.totalAmount),
            new Decimal(0)
        );
        return totalRevenue.toNumber(); // Convertir Decimal a número para el frontend
    } catch (error) {
        console.error("Error fetching total revenue this month:", error);
        return 0;
    }
}

export interface DailySalesData {
    date: string; // Formato YYYY-MM-DD o el que prefieras para el gráfico
    totalSales: number;
}

export async function getSalesForLastXDays(
    days: number
): Promise<DailySalesData[]> {
    try {
        const now = new Date();
        const localNow = new Date(now.getTime() - (3 * 60 * 60 * 1000));
        const localTodayYear = localNow.getUTCFullYear();
        const localTodayMonth = localNow.getUTCMonth();
        const localTodayDate = localNow.getUTCDate();

        const startDate = getLocalDateBoundary(localTodayYear, localTodayMonth, localTodayDate - (days - 1), 0, 0, 0, 0);
        const today = getLocalDateBoundary(localTodayYear, localTodayMonth, localTodayDate, 23, 59, 59, 999);

        const sales = await prisma.sale.findMany({
            where: {
                status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
                saleDate: {
                    gte: startDate,
                    lte: today,
                },
            },
            orderBy: {
                saleDate: "asc",
            },
            select: {
                saleDate: true,
                totalAmount: true,
            },
        });

        // Agrupar ventas por día y sumar totales
        const dailySalesMap = new Map<string, Decimal>();

        for (let i = 0; i < days; i++) {
            const localStart = new Date(startDate.getTime() - (3 * 60 * 60 * 1000));
            const d = new Date(localStart);
            d.setDate(localStart.getDate() + i);
            const dateString = d.toISOString().split("T")[0]; // YYYY-MM-DD
            dailySalesMap.set(dateString, new Decimal(0)); // Inicializar todos los días del rango
        }

        sales.forEach((sale) => {
            const localSaleDate = new Date(sale.saleDate.getTime() - (3 * 60 * 60 * 1000));
            const dateString = localSaleDate.toISOString().split("T")[0]; // YYYY-MM-DD
            const currentTotal =
                dailySalesMap.get(dateString) || new Decimal(0);
            dailySalesMap.set(dateString, currentTotal.plus(sale.totalAmount));
        });

        const chartData: DailySalesData[] = [];
        dailySalesMap.forEach((total, date) => {
            chartData.push({ date, totalSales: total.toNumber() });
        });

        // Asegurar que el orden sea cronológico si el Map no lo garantiza
        chartData.sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        return chartData;
    } catch (error) {
        console.error(`Error fetching sales for last ${days} days:`, error);
        return [];
    }
}

export interface MonthlyRevenueComparison {
    currentMonthRevenue: number;
    previousMonthRevenue: number;
    differenceAmount: number;
    percentageChange: number | null; // null si el mes anterior fue 0
}

export async function getRevenueDataForCurrentAndPreviousMonth(): Promise<MonthlyRevenueComparison> {
    try {
        const now = new Date();

        // Mes Actual
        const startOfCurrentMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endOfCurrentMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // Mes Anterior
        const startOfPreviousMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
        const endOfPreviousMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

        const currentMonthSales = await prisma.sale.findMany({
            where: {
                status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
                saleDate: { gte: startOfCurrentMonth, lte: endOfCurrentMonth },
            },
            select: { totalAmount: true },
        });
        const currentMonthRevenueDecimal = currentMonthSales.reduce(
            (sum, sale) => sum.plus(sale.totalAmount),
            new Decimal(0)
        );
        const currentMonthRevenue = currentMonthRevenueDecimal.toNumber();

        const previousMonthSales = await prisma.sale.findMany({
            where: {
                status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
                saleDate: {
                    gte: startOfPreviousMonth,
                    lte: endOfPreviousMonth,
                },
            },
            select: { totalAmount: true },
        });
        const previousMonthRevenueDecimal = previousMonthSales.reduce(
            (sum, sale) => sum.plus(sale.totalAmount),
            new Decimal(0)
        );
        const previousMonthRevenue = previousMonthRevenueDecimal.toNumber();

        const differenceAmount = currentMonthRevenue - previousMonthRevenue;
        let percentageChange: number | null = null;
        if (previousMonthRevenue !== 0) {
            percentageChange = (differenceAmount / previousMonthRevenue) * 100;
        } else if (currentMonthRevenue > 0) {
            percentageChange = null; // Cambio porcentual no calculable (infinito) desde 0
        }

        return {
            currentMonthRevenue,
            previousMonthRevenue,
            differenceAmount,
            percentageChange,
        };
    } catch (error) {
        console.error("Error fetching monthly revenue comparison:", error);
        return {
            // Devolver valores por defecto en caso de error
            currentMonthRevenue: 0,
            previousMonthRevenue: 0,
            differenceAmount: 0,
            percentageChange: null,
        };
    }
}

export interface TopSellingProductData {
    productName: string;
    totalSold: number;
}

export async function getTopSellingProducts(
    limit: number = 5,
    daysAgo: number = 30
): Promise<TopSellingProductData[]> {
    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysAgo);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        const topProducts = await prisma.saleItem.groupBy({
            by: ["productId"],
            _sum: {
                quantity: true,
            },
            where: {
                sale: {
                    status: 'COMPLETED',
                    saleDate: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
                productId: { not: null },
            },
            orderBy: {
                _sum: {
                    quantity: "desc",
                },
            },
            take: limit,
        });

        if (topProducts.length === 0) return [];

        // Obtener los nombres de los productos
        const productIds = topProducts
          .filter((p) => p.productId != null)
          .map((p) => p.productId as number);
        const products = await prisma.product.findMany({
            where: {
                id: { in: productIds },
            },
            select: {
                id: true,
                name: true,
            },
        });

        const productMap = new Map(products.map((p) => [p.id, p.name]));

        return topProducts
          .filter((p) => p.productId != null)
          .map((p) => ({
              productName: productMap.get(p.productId as number) || "Producto Desconocido",
              totalSold: p._sum.quantity || 0,
          }));
    } catch (error) {
        console.error("Error fetching top selling products:", error);
        return [];
    }
}

export interface FinancialSummary {
    totalRevenue: number;
    totalCOGS: number; // Cost of Goods Sold (Costo de Mercadería Vendida)
    totalExpenses: number; // Otros gastos
    grossProfit: number; // Ganancia Bruta (Ingresos - COGS)
    netProfit: number; // Ganancia Neta (Ganancia Bruta - Gastos)
}

/**
 * Calcula un resumen financiero (Ingresos, Costos, Gastos, Ganancias) para un período.
 * Por defecto, calcula para el mes actual.
 */
export async function getFinancialSummary(period?: {
    startDate: Date;
    endDate: Date;
}): Promise<FinancialSummary> {
    try {
        // Definir el rango de fechas. Si no se provee, usamos el mes actual.
        const now = new Date();
        const startDate =
            period?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
        const endDate =
            period?.endDate ||
            new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // 1. Calcular Ingresos Totales (Suma de todas las ventas)
        const revenuePromise = prisma.sale.aggregate({
            _sum: {
                totalAmount: true,
            },
            where: {
                status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
                saleDate: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        });

        // 2. Calcular Costo de Mercadería Vendida (COGS)
        // Esto requiere sumar (cantidad * costo_de_compra) de cada ítem vendido.
        // Lo hacemos obteniendo todos los ítems y sumando en JS.
        const cogsPromise = prisma.saleItem.findMany({
            where: {
                sale: {
                    status: 'COMPLETED',
                    saleDate: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
            },
            select: {
                quantity: true,
                purchasePriceAtSale: true, // Usamos nuestro nuevo campo para precisión
            },
        });

        // 3. Calcular Otros Gastos Totales
        const expensesPromise = prisma.expense.aggregate({
            _sum: {
                amount: true,
            },
            where: {
                expenseDate: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        });

        // Ejecutamos todas las consultas en paralelo para mayor eficiencia
        const [revenueResult, saleItemsForCogs, expensesResult] =
            await Promise.all([revenuePromise, cogsPromise, expensesPromise]);

        // Procesamos los resultados
        const totalRevenue = revenueResult._sum.totalAmount?.toNumber() || 0;
        const totalExpenses = expensesResult._sum.amount?.toNumber() || 0;

        // Calculamos el COGS sumando el costo de cada ítem
        const totalCOGS = saleItemsForCogs
            .reduce((sum, item) => {
                const itemCost = new Decimal(
                    item.purchasePriceAtSale || 0
                ).times(item.quantity);
                return sum.plus(itemCost);
            }, new Decimal(0))
            .toNumber();

        // 4. Calcular Ganancias
        const grossProfit = totalRevenue - totalCOGS;
        const netProfit = grossProfit - totalExpenses;

        return {
            totalRevenue,
            totalCOGS,
            totalExpenses,
            grossProfit,
            netProfit,
        };
    } catch (error) {
        console.error("Error al calcular el resumen financiero:", error);
        // Devolver un objeto con ceros en caso de error
        return {
            totalRevenue: 0,
            totalCOGS: 0,
            totalExpenses: 0,
            grossProfit: 0,
            netProfit: 0,
        };
    }
}

export interface MonthlyFinancialSummary {
  month: string; // Formato "YYYY-MM", ej: "2025-06"
  totalRevenue: number;
  totalCOGS: number;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
}

export async function getMonthlyFinancialSummaries(numberOfMonths: number = 6): Promise<MonthlyFinancialSummary[]> {
  console.log(`Calculando resumen financiero para los últimos ${numberOfMonths} meses...`);
  const summaries: MonthlyFinancialSummary[] = [];
  const now = new Date();

  try {
    const startDateBound = getLocalDateBoundary(now.getFullYear(), now.getMonth() - numberOfMonths + 1, 1, 0, 0, 0, 0);
    const endDateBound = getLocalDateBoundary(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Ejecutamos consultas agregadas generales en paralelo (3 consultas en total)
    const [sales, saleItems, expenses] = await Promise.all([
      prisma.sale.findMany({
        where: { status: 'COMPLETED', saleDate: { gte: startDateBound, lte: endDateBound } },
        select: { saleDate: true, totalAmount: true }
      }),
      prisma.saleItem.findMany({
        where: { sale: { status: 'COMPLETED', saleDate: { gte: startDateBound, lte: endDateBound } } },
        select: { quantity: true, purchasePriceAtSale: true, sale: { select: { saleDate: true } } }
      }),
      prisma.expense.findMany({
        where: { expenseDate: { gte: startDateBound, lte: endDateBound } },
        select: { expenseDate: true, amount: true }
      })
    ]);

    const localDate = new Date(now.getTime() - (3 * 60 * 60 * 1000));

    for (let i = 0; i < numberOfMonths; i++) {
      const date = new Date(localDate.getUTCFullYear(), localDate.getUTCMonth() - i, 1);
      const year = date.getFullYear();
      const month = date.getMonth();

      const startDate = getLocalDateBoundary(year, month, 1, 0, 0, 0, 0);
      const endDate = getLocalDateBoundary(year, month + 1, 0, 23, 59, 59, 999);
      
      const monthLabel = `${year}-${(month + 1).toString().padStart(2, '0')}`;

      // Sumar ingresos para el mes actual del bucle
      const monthSales = sales.filter(s => s.saleDate >= startDate && s.saleDate <= endDate);
      const totalRevenue = monthSales.reduce((sum, s) => sum.plus(s.totalAmount), new Decimal(0)).toNumber();

      // Sumar gastos para el mes actual del bucle
      const monthExpenses = expenses.filter(e => e.expenseDate >= startDate && e.expenseDate <= endDate);
      const totalExpenses = monthExpenses.reduce((sum, e) => sum.plus(e.amount), new Decimal(0)).toNumber();

      // Sumar costo de mercadería vendida para el mes actual del bucle
      const monthSaleItems = saleItems.filter(item => item.sale.saleDate >= startDate && item.sale.saleDate <= endDate);
      const totalCOGS = monthSaleItems.reduce((sum, item) => {
        const itemCost = new Decimal(item.purchasePriceAtSale || 0).times(item.quantity);
        return sum.plus(itemCost);
      }, new Decimal(0)).toNumber();

      const grossProfit = totalRevenue - totalCOGS;
      const netProfit = grossProfit - totalExpenses;

      summaries.push({
        month: monthLabel,
        totalRevenue,
        totalCOGS,
        totalExpenses,
        grossProfit,
        netProfit,
      });
    }

    // Devolvemos los resultados en orden cronológico (el mes más antiguo primero)
    return summaries.reverse();

  } catch (error) {
    console.error("Error al calcular los resúmenes financieros mensuales:", error);
    return []; // Devolver array vacío en caso de error
  }
}

export interface DailySalesCount {
  day: string; // "Lunes", "Martes", etc.
  sales: number;
}

export async function getDailySalesCountForCurrentWeek(): Promise<DailySalesCount[]> {
  try {
    const now = new Date();
    const localNow = new Date(now.getTime() - (3 * 60 * 60 * 1000));
    
    // Ajuste para que la semana comience en Lunes (getDay() devuelve 0 para Domingo, 1 para Lunes...)
    const dayOfWeek = localNow.getUTCDay(); // 0 (Sun) to 6 (Sat)
    const diff = localNow.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Calcula el Lunes de esta semana
    
    const localMondayYear = localNow.getUTCFullYear();
    const localMondayMonth = localNow.getUTCMonth();

    const startOfWeek = getLocalDateBoundary(localMondayYear, localMondayMonth, diff, 0, 0, 0, 0);
    const endOfWeek = getLocalDateBoundary(localMondayYear, localMondayMonth, diff + 6, 23, 59, 59, 999);
    
    // Obtener las ventas de la semana
    const sales = await prisma.sale.findMany({
      where: {
        status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
        saleDate: {
          gte: startOfWeek,
          lte: endOfWeek,
        },
      },
      select: {
        saleDate: true,
      },
    });

    // Crear un mapa para acceder fácilmente a los resultados
    const salesMap = new Map<number, number>(); // <Día de la semana (0-6), Cantidad>
    sales.forEach(sale => {
      const localSaleDate = new Date(sale.saleDate.getTime() - (3 * 60 * 60 * 1000));
      const dayIndex = localSaleDate.getUTCDay(); // 0 para Domingo, etc.
      salesMap.set(dayIndex, (salesMap.get(dayIndex) || 0) + 1);
    });

    const result: DailySalesCount[] = [];

    // Reordenamos para que empiece en Lunes y termine en Domingo
    const orderedDayNames = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
    const dayNameToIndexMap = { "Domingo": 0, "Lunes": 1, "Martes": 2, "Miércoles": 3, "Jueves": 4, "Viernes": 5, "Sábado": 6 };

    for (const dayName of orderedDayNames) {
        const dayIndex = dayNameToIndexMap[dayName as keyof typeof dayNameToIndexMap];
        result.push({
            day: dayName,
            sales: salesMap.get(dayIndex) || 0,
        });
    }

    return result;

  } catch (error) {
    console.error("Error al obtener el conteo de ventas diarias:", error);
    return [];
  }
}

export interface PaymentTypeDistribution {
  paymentType: string;
  total: number;
}

export async function getPaymentTypeDistribution(): Promise<PaymentTypeDistribution[]> {
  try {
    const now = new Date();
    const startOfMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = getLocalDateBoundary(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const sales = await prisma.sale.findMany({
      where: {
        status: 'COMPLETED', // solo ventas cobradas (sin pendientes ni canceladas)
        saleDate: { gte: startOfMonth, lte: endOfMonth },
      },
      select: { paymentType: true, totalAmount: true },
    });

    const map = new Map<string, Decimal>();
    for (const sale of sales) {
      const key = sale.paymentType;
      const current = map.get(key) || new Decimal(0);
      map.set(key, current.plus(sale.totalAmount));
    }

    return Array.from(map.entries())
      .map(([paymentType, total]) => ({ paymentType, total: total.toNumber() }))
      .sort((a, b) => b.total - a.total);
  } catch (error) {
    console.error("Error fetching payment type distribution:", error);
    return [];
  }
}