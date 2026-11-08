// lib/stockService.ts
// Fuente única de escritura de stock en modo local.
//
// Reglas:
//  - ProductBranchStock es la verdad por sucursal; Product.quantityStock es
//    SIEMPRE la suma de las filas por sucursal.
//  - Toda escritura deja un registro en StockMovement (ledger local) con el
//    motivo, la referencia y la cantidad resultante.
//  - No se permiten cantidades negativas salvo que el llamador lo pida
//    explícitamente (allowNegative), para que un bug se vea en vez de
//    esconderse como stock negativo.
//
// Las funciones aceptan un `db` que puede ser `prisma` o el `tx` de una
// transacción interactiva. Cuando el llamador ya está dentro de una
// transacción debe pasar `tx`; si no, use `withStockTransaction`.
import prisma from "./prisma";
import type { Prisma } from "@prisma/client";

export type StockDb = Prisma.TransactionClient | typeof prisma;

export interface StockMovementInput {
  productId: number;
  /** null/undefined = solo stock global (instalaciones sin sucursales). */
  branchId?: number | null;
  delta: number;
  reason: string;
  refType?: string | null;
  refId?: string | number | null;
  note?: string | null;
  allowNegative?: boolean;
}

export interface SetStockInput {
  productId: number;
  branchId?: number | null;
  quantity: number;
  reason: string;
  refType?: string | null;
  refId?: string | number | null;
  note?: string | null;
  allowNegative?: boolean;
}

export interface StockResult {
  productId: number;
  branchId: number | null;
  /** Stock de la sucursal luego del movimiento (null si no hay sucursal). */
  branchStock: number | null;
  /** Stock global (suma de sucursales) luego del movimiento. */
  productStock: number;
  /** Delta realmente aplicado. */
  applied: number;
}

const EPSILON = 1e-9;

function toDb(db?: StockDb): StockDb {
  return db ?? prisma;
}

function normalizeQty(value: number, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Cantidad de stock inválida (${label}).`);
  }
  return n;
}

async function getProductName(db: StockDb, productId: number): Promise<string> {
  const product = await (db as any).product.findUnique({
    where: { id: productId },
    select: { name: true },
  });
  if (!product) throw new Error(`Producto con ID ${productId} no encontrado.`);
  return product.name as string;
}

async function assertBranchExists(db: StockDb, branchId: number): Promise<void> {
  const branch = await (db as any).branch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) throw new Error(`La sucursal ${branchId} no existe.`);
}

/**
 * Recalcula Product.quantityStock como la suma de las filas por sucursal.
 * Si el producto no tiene ninguna fila, no toca el global (instalación vieja).
 */
export async function recalcProductTotal(db: StockDb, productId: number): Promise<number> {
  const agg = await (db as any).productBranchStock.aggregate({
    where: { productId },
    _sum: { quantityStock: true },
    _count: { _all: true },
  });
  if (!agg || !agg._count || agg._count._all === 0) {
    const current = await (db as any).product.findUnique({
      where: { id: productId },
      select: { quantityStock: true },
    });
    return Number(current?.quantityStock) || 0;
  }
  const total = Number(agg._sum.quantityStock) || 0;
  await (db as any).product.update({
    where: { id: productId },
    data: { quantityStock: total },
  });
  return total;
}

/** Stock actual de una sucursal; null si todavía no tiene fila. */
export async function getBranchStock(
  db: StockDb,
  productId: number,
  branchId: number,
): Promise<number | null> {
  const row = await (db as any).productBranchStock.findUnique({
    where: { productId_branchId: { productId, branchId } },
    select: { quantityStock: true },
  });
  if (!row) return null;
  return Number(row.quantityStock) || 0;
}

async function writeMovement(
  db: StockDb,
  input: StockMovementInput,
  quantityAfter: number,
): Promise<void> {
  await (db as any).stockMovement.create({
    data: {
      productId: input.productId,
      branchId: input.branchId ?? null,
      delta: input.delta,
      quantityAfter,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId !== undefined && input.refId !== null ? String(input.refId) : null,
      note: input.note ?? null,
    },
  });
}

/**
 * Aplica un movimiento relativo (delta puede ser negativo). Es la operación
 * base para ventas, compras, traspasos, consignaciones y recetas.
 */
export async function applyMovement(
  db: StockDb | undefined,
  input: StockMovementInput,
): Promise<StockResult> {
  const d = toDb(db);
  const delta = normalizeQty(input.delta, "delta");
  if (Math.abs(delta) < EPSILON) {
    return {
      productId: input.productId,
      branchId: input.branchId ?? null,
      branchStock: null,
      productStock: 0,
      applied: 0,
    };
  }

  const branchId = input.branchId ?? null;
  if (branchId !== null) await assertBranchExists(d, branchId);

  const productName = await getProductName(d, input.productId);

  let branchStock: number | null = null;
  if (branchId !== null) {
    const current = (await getBranchStock(d, input.productId, branchId)) ?? 0;
    const next = current + delta;
    if (next < -EPSILON && !input.allowNegative) {
      throw new Error(
        `Stock insuficiente para el producto "${productName}". Disponible: ${current}, Solicitado: ${Math.abs(delta)}.`,
      );
    }
    // Con allowNegative se conserva el negativo (reservas web). Sin él, el
    // único negativo tolerado es el error de coma flotante, que se normaliza.
    const safeNext = next < 0 && !input.allowNegative ? 0 : next;
    await (d as any).productBranchStock.upsert({
      where: { productId_branchId: { productId: input.productId, branchId } },
      update: { quantityStock: safeNext },
      create: { productId: input.productId, branchId, quantityStock: safeNext },
    });
    branchStock = safeNext;
  }

  let productStock: number;
  if (branchId !== null) {
    productStock = await recalcProductTotal(d, input.productId);
  } else {
    const product = await (d as any).product.findUnique({
      where: { id: input.productId },
      select: { quantityStock: true },
    });
    const current = Number(product?.quantityStock) || 0;
    const next = current + delta;
    if (next < -EPSILON && !input.allowNegative) {
      throw new Error(
        `Stock insuficiente para el producto "${productName}". Disponible: ${current}, Solicitado: ${Math.abs(delta)}.`,
      );
    }
    productStock = next < 0 && !input.allowNegative ? 0 : next;
    await (d as any).product.update({
      where: { id: input.productId },
      data: { quantityStock: productStock },
    });
  }

  await writeMovement(d, { ...input, branchId }, branchStock ?? productStock);

  return {
    productId: input.productId,
    branchId,
    branchStock,
    productStock,
    applied: delta,
  };
}

/** Alias semántico usado por flujos de sincronización/ventas. */
export const applyStockMovement = applyMovement;

/** Suma stock (delta positivo). */
export async function addStock(
  db: StockDb | undefined,
  input: Omit<StockMovementInput, "delta"> & { delta?: number; quantity: number },
): Promise<StockResult> {
  return applyMovement(db, { ...input, delta: input.quantity });
}

/**
 * Fija el stock absoluto de una sucursal (o del global si branchId es null).
 * Registra en el ledger la diferencia contra el valor anterior.
 */
export async function setStock(
  db: StockDb | undefined,
  input: SetStockInput,
): Promise<StockResult> {
  const d = toDb(db);
  const quantity = normalizeQty(input.quantity, "quantity");
  if (quantity < -EPSILON && !input.allowNegative) {
    throw new Error("El stock no puede ser negativo.");
  }
  const safeQuantity = quantity < 0 && !input.allowNegative ? 0 : quantity;

  const branchId = input.branchId ?? null;
  if (branchId !== null) await assertBranchExists(d, branchId);

  let previous: number;
  if (branchId !== null) {
    previous = (await getBranchStock(d, input.productId, branchId)) ?? 0;
    await (d as any).productBranchStock.upsert({
      where: { productId_branchId: { productId: input.productId, branchId } },
      update: { quantityStock: safeQuantity },
      create: { productId: input.productId, branchId, quantityStock: safeQuantity },
    });
  } else {
    const product = await (d as any).product.findUnique({
      where: { id: input.productId },
      select: { quantityStock: true },
    });
    previous = Number(product?.quantityStock) || 0;
  }

  const delta = safeQuantity - previous;
  let productStock: number;
  if (branchId !== null) {
    productStock = await recalcProductTotal(d, input.productId);
  } else {
    productStock = safeQuantity;
    await (d as any).product.update({
      where: { id: input.productId },
      data: { quantityStock: productStock },
    });
  }

  await writeMovement(
    d,
    {
      productId: input.productId,
      branchId,
      delta,
      reason: input.reason,
      refType: input.refType,
      refId: input.refId,
      note: input.note,
      allowNegative: input.allowNegative,
    },
    branchId !== null ? safeQuantity : productStock,
  );

  return {
    productId: input.productId,
    branchId,
    branchStock: branchId !== null ? safeQuantity : null,
    productStock,
    applied: delta,
  };
}

/** Ejecuta un bloque de trabajo dentro de una transacción de stock. */
export function withStockTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn);
}
