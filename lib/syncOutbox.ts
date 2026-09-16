// lib/syncOutbox.ts
// Outbox transaccional: registra operaciones pendientes de subir a la nube.
// Permite trabajar offline y sincronizar después sin perder datos (borrados,
// pedidos web locales, ventas/compras/traspasos, etc.).
import prisma from "./prisma";
import { isProDevice } from "./branchIdentity";

export type OutboxOperation = "UPSERT" | "DELETE";

const OUTBOX_ENTITY_PRIORITY: Record<string, number> = {
  StockMovement: 5,
  Sale: 10,
  Purchase: 20,
  StockTransfer: 30,
  WebOrder: 40,
  Product: 50,
  ProductBranchStock: 60,
  ProductModifierGroup: 70,
};

const fmtDec = (val: any, fallback: string | null = "0.00") => (val !== undefined && val !== null ? val.toString() : fallback);

export async function enqueueOutbox(
  entity: string,
  operation: OutboxOperation,
  entityKey: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    // En planes sin nube no se acumulan operaciones pendientes: evita el aviso
    // "X pendientes de sincronizar" en configuraciones puramente locales.
    if (!(await isProDevice())) return;

    if (operation === "DELETE") {
      // El tombstone se escribe antes de intentar la nube. Así, un pull que
      // ocurra mientras estamos offline no puede reimportar el registro.
      await prisma.syncTombstone.upsert({
        where: { entity_entityKey: { entity, entityKey } },
        update: { deletedAt: new Date() },
        create: { entity, entityKey, deletedAt: new Date() },
      });
    } else {
      // Un registro recreado/modificado vuelve a estar vigente localmente.
      await prisma.syncTombstone.deleteMany({ where: { entity, entityKey } });
    }

    // Una misma operación puede ser generada por varios efectos del mismo
    // cambio (por ejemplo venta + actualización de stock). Conservamos una
    // sola operación pendiente por entidad/clave y dejamos que el drenador
    // relea el estado actual desde SQLite.
    const existing = await prisma.syncOutbox.findFirst({
      where: { entity, entityKey, operation, status: "PENDING" },
      select: { id: true },
    });
    if (existing) {
      if (payload) {
        await prisma.syncOutbox.update({
          where: { id: existing.id },
          data: { payloadJson: JSON.stringify(payload), updatedAt: new Date() },
        });
      }
      return;
    }

    // Si cambió la intención para la misma entidad (UPSERT -> DELETE o
    // DELETE -> UPSERT), la operación nueva reemplaza a la anterior.
    await prisma.syncOutbox.updateMany({
      where: {
        entity,
        entityKey,
        status: { in: ["PENDING", "FAILED"] },
        operation: { not: operation },
      },
      data: { status: "DONE", updatedAt: new Date(), lastError: null },
    });

    // Si se elimina un producto, cualquier subida de stock de ese mismo
    // producto queda obsoleta: el borrado remoto elimina sus stocks por
    // cascada. Evita que una operación imposible bloquee toda la cola.
    if (operation === "DELETE" && entity === "Product") {
      await prisma.syncOutbox.updateMany({
        where: {
          entity: "ProductBranchStock",
          entityKey,
          status: "PENDING",
          operation: "UPSERT",
        },
        data: { status: "DONE", updatedAt: new Date(), lastError: null },
      });
    }

    await prisma.syncOutbox.create({
      data: {
        entity,
        operation,
        entityKey,
        status: "PENDING",
        attempts: 0,
        payloadJson: payload ? JSON.stringify(payload) : null,
      },
    });
  } catch (err) {
    console.error(`[Outbox] Error al encolar ${entity} ${entityKey}:`, err);
  }
}

export async function getPendingCount(): Promise<number> {
  try {
    return await prisma.syncOutbox.count({ where: { status: "PENDING" } });
  } catch {
    return 0;
  }
}

// True si existe una operación DELETE pendiente para esa entidad+clave.
// Se usa en el PULL para no re-importar datos que se marcaron para borrar.
export async function isOutboxDeletePending(entity: string, entityKey: string): Promise<boolean> {
  try {
    const [pending, tombstone] = await Promise.all([
      prisma.syncOutbox.findFirst({
        where: { entity, entityKey, operation: "DELETE", status: "PENDING" },
        select: { id: true },
      }),
      prisma.syncTombstone.findUnique({
        where: { entity_entityKey: { entity, entityKey } },
        select: { id: true },
      }),
    ]);
    return !!pending || !!tombstone;
  } catch {
    return false;
  }
}

export async function enqueueStockMovement(input: {
  operationId: string;
  productId: number;
  delta: number;
  branchId?: number | null;
}): Promise<void> {
  await enqueueOutbox("StockMovement", "UPSERT", input.operationId, input);
}

async function markDone(id: number): Promise<void> {
  await prisma.syncOutbox.update({
    where: { id },
    data: { status: "DONE", lockedAt: null, nextAttemptAt: null, updatedAt: new Date() },
  });
}

async function markFailed(id: number, error: string, retryable: boolean, maxAttempts = 5): Promise<void> {
  const record = await prisma.syncOutbox.findUnique({ where: { id }, select: { attempts: true } });
  const attempts = (record?.attempts || 0) + 1;
  const shouldRetry = retryable && attempts < maxAttempts;
  const nextAttemptAt = shouldRetry
    ? new Date(Date.now() + Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1)))
    : null;
  await prisma.syncOutbox.update({
    where: { id },
    data: {
      status: shouldRetry ? "PENDING" : "FAILED",
      attempts,
      lastError: error.slice(0, 500),
      nextAttemptAt,
      lockedAt: null,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

async function pushSale(saleId: number, tenantId: string): Promise<boolean> {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { items: true },
  });
  if (!sale) return false;

  const payload: Record<string, any[]> = {
    Sale: [{
      id: sale.id, saleDate: sale.saleDate.toISOString(), totalAmount: fmtDec(sale.totalAmount), tenant_id: tenantId,
      paymentType: sale.paymentType, notes: sale.notes, clientId: sale.clientId, sellerId: sale.sellerId ?? 1,
      cashRegisterId: sale.cashRegisterId, discountCodeApplied: sale.discountCodeApplied,
      createdAt: sale.createdAt.toISOString(), updatedAt: sale.updatedAt.toISOString()
    }],
    SaleItem: sale.items.map(si => ({
      id: si.id, quantity: si.quantity, priceAtSale: fmtDec(si.priceAtSale), tenant_id: tenantId,
      purchasePriceAtSale: fmtDec(si.purchasePriceAtSale), saleId: si.saleId, productId: si.productId,
      productName: si.productName || null
    })),
  };

  return await pushRecords(payload);
}

async function pushPurchase(purchaseId: number, tenantId: string): Promise<boolean> {
  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId },
    include: { items: true },
  });
  if (!purchase) return false;

  const payload: Record<string, any[]> = {
    Purchase: [{
      id: purchase.id, purchaseDate: purchase.purchaseDate.toISOString(), totalAmount: fmtDec(purchase.totalAmount), tenant_id: tenantId,
      status: purchase.status, paymentType: purchase.paymentType || 'CASH', invoiceNumber: purchase.invoiceNumber, notes: purchase.notes,
      supplierId: purchase.supplierId, createdAt: purchase.createdAt.toISOString(), updatedAt: purchase.updatedAt.toISOString()
    }],
    PurchaseItem: purchase.items.map(pi => ({
      id: pi.id, quantity: pi.quantity, quantityReceived: pi.quantityReceived ?? pi.quantity ?? 0, tenant_id: tenantId,
      purchasePrice: fmtDec(pi.purchasePrice), purchaseId: pi.purchaseId, productId: pi.productId
    })),
  };

  return await pushRecords(payload);
}

async function pushRecords(payload: Record<string, any[]>): Promise<boolean> {
  const { getSelectiveSyncCredentials, pushEntitiesToSupabase } = await import("./syncService");
  const { supabaseUrl, supabaseKey } = await getSelectiveSyncCredentials();
  try {
    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);
    return true;
  } catch {
    return false;
  }
}

// Procesa los PENDING del outbox. Devuelve { drained, remaining, networkError }.
// Si hay error de red (networkError=true), detiene el procesamiento y el resto
// queda PENDING para el próximo intento.
export async function drainOutbox(limit = 1000): Promise<{ drained: number; remaining: number; networkError: boolean }> {
  let drained = 0;
  let networkError = false;

  // Primero se suben altas/actualizaciones y después borrados. Esto mantiene
  // referencias válidas y evita que un delete antiguo bloquee cambios nuevos.
  const pendingUpserts = await prisma.syncOutbox.findMany({
    where: { status: "PENDING", operation: "UPSERT", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { id: "asc" },
    take: limit,
  });
  const pendingDeletes = pendingUpserts.length >= limit
    ? []
    : await prisma.syncOutbox.findMany({
        where: { status: "PENDING", operation: "DELETE", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        orderBy: { id: "asc" },
        take: limit - pendingUpserts.length,
      });
  const pending = [...pendingUpserts, ...pendingDeletes].sort((a, b) => {
    if (a.operation !== b.operation) return a.operation === "UPSERT" ? -1 : 1;
    const entityDiff = (OUTBOX_ENTITY_PRIORITY[a.entity] ?? 999) - (OUTBOX_ENTITY_PRIORITY[b.entity] ?? 999);
    return entityDiff || a.id - b.id;
  });

  for (const record of pending) {
    try {
      await prisma.syncOutbox.update({
        where: { id: record.id },
        data: { lockedAt: new Date(), lastAttemptAt: new Date() },
      });
      let ok = false;

      if (record.operation === "DELETE") {
        const { deleteProductFromSupabase, deleteSaleFromSupabase, deleteWebOrdersFromSupabase, deleteComboFromSupabase, deletePromotionFromSupabase } = await import("./syncService");
        if (record.entity === "Product") {
          ok = await deleteProductFromSupabase(Number(record.entityKey));
        } else if (record.entity === "Sale") {
          ok = await deleteSaleFromSupabase(Number(record.entityKey));
        } else if (record.entity === "WebOrder") {
          ok = await deleteWebOrdersFromSupabase([record.entityKey]);
        } else if (record.entity === "Combo") {
          ok = await deleteComboFromSupabase(Number(record.entityKey));
        } else if (record.entity === "Promotion") {
          ok = await deletePromotionFromSupabase(Number(record.entityKey));
        }
      } else {
        // UPSERT
        const {
          syncSingleProduct,
          syncWebOrderToSupabase,
          syncStockTransferToSupabase,
          getSelectiveSyncCredentials,
        } = await import("./syncService");

        if (record.entity === "StockMovement") {
          const payload = record.payloadJson ? JSON.parse(record.payloadJson) : null;
          if (!payload?.operationId || !payload?.productId || !Number.isFinite(Number(payload.delta))) {
            ok = false;
          } else {
            const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
            const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/apply_stock_movement`, {
              method: "POST",
              headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                p_tenant_id: tenantId,
                p_operation_id: String(payload.operationId),
                p_product_id: Number(payload.productId),
                p_delta: Number(payload.delta),
                p_branch_id: payload.branchId == null ? null : Number(payload.branchId),
              }),
            });
            if (!response.ok) {
              const body = await response.text();
              throw new Error(`RPC de stock rechazado (${response.status}): ${body.slice(0, 300)}`);
            }
            ok = true;
          }
        } else if (record.entity === "Product" || record.entity === "ProductBranchStock") {
          const localProduct = await prisma.product.findUnique({
            where: { id: Number(record.entityKey) },
            select: { id: true },
          });
          // No hay nada que subir si el producto ya fue eliminado localmente;
          // su delete pendiente es el que debe ejecutarse.
          ok = !localProduct && record.entity === "ProductBranchStock"
            ? true
            : await syncSingleProduct(Number(record.entityKey));
        } else if (record.entity === "ProductModifierGroup") {
          const { getSelectiveSyncCredentials, syncModifierGroupsForProducts } = await import("./syncService");
          const { tenantId } = await getSelectiveSyncCredentials();
          ok = await syncModifierGroupsForProducts(tenantId, [Number(record.entityKey)]);
        } else if (record.entity === "WebOrder") {
          ok = await syncWebOrderToSupabase(Number(record.entityKey));
        } else if (record.entity === "StockTransfer") {
          ok = await syncStockTransferToSupabase(Number(record.entityKey));
        } else if (record.entity === "Sale") {
          const { tenantId } = await getSelectiveSyncCredentials();
          ok = await pushSale(Number(record.entityKey), tenantId);
        } else if (record.entity === "Purchase") {
          const { tenantId } = await getSelectiveSyncCredentials();
          ok = await pushPurchase(Number(record.entityKey), tenantId);
        }
      }

      if (ok) {
        await markDone(record.id);
        if (record.operation === "DELETE") {
          // El borrado quedó confirmado en la nube; el tombstone local ya no
          // es necesario para proteger el próximo pull.
          await prisma.syncTombstone.deleteMany({
            where: { entity: record.entity, entityKey: record.entityKey },
          });
        }
        drained++;
      } else {
        // Un rechazo de la operación no implica necesariamente falta de red.
        // Se marca como FAILED y se continúa con el resto de la cola para que
        // un registro inválido no bloquee cientos de operaciones correctas.
        await markFailed(record.id, "Operación rechazada por la nube o dato inexistente", false);
        continue;
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isNetwork = /fetch|network|ECONN|abort|timeout|ENOTFOUND/i.test(msg);
      await markFailed(record.id, msg, isNetwork);
      if (isNetwork) {
        networkError = true;
        break;
      }
    }
  }

  const remaining = await getPendingCount();
  return { drained, remaining, networkError };
}
