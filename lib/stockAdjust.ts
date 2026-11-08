// lib/stockAdjust.ts
// Compatibilidad: estas funciones delegan en lib/stockService, la única
// fuente de escritura de stock. Se mantienen porque varios endpoints ya las
// usan y porque `resolveTargetBranch` resuelve la sucursal activa del equipo.
import prisma from './prisma';
import { getDeviceBranchId } from './branchIdentity';
import { applyMovement, setStock, type StockDb } from './stockService';

type Db = StockDb;

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
    const exists = await (db as any).branch.findUnique({ where: { id: requested }, select: { id: true } });
    return exists
      ? { branchId: exists.id, requestedInvalid: false }
      : { branchId: null, requestedInvalid: true };
  }
  const deviceBranch = await getDeviceBranchId();
  if (deviceBranch) {
    const exists = await (db as any).branch.findUnique({ where: { id: deviceBranch }, select: { id: true } });
    if (exists) return { branchId: exists.id, requestedInvalid: false };
  }
  const main = await (db as any).branch.findFirst({ where: { isMain: true }, select: { id: true } });
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
  reason = 'MANUAL_SET',
): Promise<number> {
  const result = await setStock(db, { productId, branchId, quantity, reason });
  return result.productStock;
}

/**
 * Suma `delta` al stock de `productId` en `branchId` de forma atómica y
 * recalcula el global como suma de sucursales. Devuelve el nuevo total global.
 */
export async function addBranchStock(
  db: Db,
  productId: number,
  branchId: number,
  delta: number,
  reason = 'MANUAL_ADD',
): Promise<number> {
  const result = await applyMovement(db, { productId, branchId, delta, reason });
  return result.productStock;
}

/**
 * Suma o resta `delta` al stock de un producto: global y fila de la sucursal.
 * Debe llamarse dentro de una transacción (recibe el `tx`).
 */
export async function incrementStock(
  tx: Db,
  productId: number,
  delta: number,
  branchId: number | null,
  reason = 'ADJUST',
): Promise<void> {
  await applyMovement(tx, { productId, delta, branchId, reason });
}
