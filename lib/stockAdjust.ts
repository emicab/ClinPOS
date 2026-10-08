// lib/stockAdjust.ts
// Carga de stock "absoluta" (fijar la cantidad de un producto en una sucursal).
//
// El stock global (Product.quantityStock) es la SUMA de las filas por sucursal
// (ProductBranchStock). Escribir solo el global dejaba las pantallas por
// sucursal (venta, productos, combos) con el valor viejo, por eso toda carga
// manual o masiva debe pasar por acá.
import prisma from './prisma';
import { getDeviceBranchId } from './branchIdentity';

type Db = typeof prisma;

/**
 * Sucursal sobre la que se carga el stock: la pedida (si existe), la de este
 * equipo o la Principal. Devuelve null si no hay sucursales (instalación vieja).
 * `requestedInvalid` es true cuando se pidió una sucursal que no existe.
 */
export async function resolveTargetBranch(
  requested?: number | null,
  db: Db = prisma,
): Promise<{ branchId: number | null; requestedInvalid: boolean }> {
  if (requested !== undefined && requested !== null && !Number.isNaN(requested)) {
    const exists = await db.branch.findUnique({ where: { id: requested }, select: { id: true } });
    return exists
      ? { branchId: exists.id, requestedInvalid: false }
      : { branchId: null, requestedInvalid: true };
  }
  const deviceBranch = await getDeviceBranchId();
  if (deviceBranch) {
    const exists = await db.branch.findUnique({ where: { id: deviceBranch }, select: { id: true } });
    if (exists) return { branchId: exists.id, requestedInvalid: false };
  }
  const main = await db.branch.findFirst({ where: { isMain: true }, select: { id: true } });
  return { branchId: main?.id ?? null, requestedInvalid: false };
}

/**
 * Fija el stock de `productId` en `branchId` y recalcula el global como suma de
 * todas las sucursales. Devuelve el nuevo total global.
 */
export async function setBranchStock(
  db: Db,
  productId: number,
  branchId: number,
  quantity: number,
): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.productBranchStock.upsert({
      where: { productId_branchId: { productId, branchId } },
      update: { quantityStock: quantity },
      create: { productId, branchId, quantityStock: quantity },
    });
    const agg = await tx.productBranchStock.aggregate({
      where: { productId },
      _sum: { quantityStock: true },
    });
    const total = agg._sum.quantityStock ?? 0;
    await tx.product.update({ where: { id: productId }, data: { quantityStock: total } });
    return total;
  });
}

/**
 * Suma o resta `delta` al stock de un producto: global y fila de la sucursal.
 * Para flujos que mueven stock de forma relativa (consignaciones, etc.) dentro
 * de una transacción; mantiene global = suma de sucursales sin recalcular.
 */
export async function incrementStock(
  tx: Pick<Db, 'product' | 'productBranchStock'>,
  productId: number,
  delta: number,
  branchId: number | null,
): Promise<void> {
  await tx.product.update({
    where: { id: productId },
    data: { quantityStock: { increment: delta } },
  });
  if (branchId !== null) {
    await tx.productBranchStock.upsert({
      where: { productId_branchId: { productId, branchId } },
      update: { quantityStock: { increment: delta } },
      create: { productId, branchId, quantityStock: delta },
    });
  }
}
