// pages/api/products/batch-delete.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.setHeader('Allow', ['DELETE', 'POST']);
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }

  try {
    const { ids, productIds, allPages, isAllPagesSelected, filters, force } = req.body;
    // Borrado forzado: elimina en cascada todas las dependencias (historial
    // de compras, combos, promociones, etc.). Solo se usa tras la doble
    // verificación del frontend.
    const isForce = force === true || force === 'true';

    // Aceptar alias del frontend (isAllPagesSelected) y de otros clientes (productIds).
    const selectAll = allPages ?? isAllPagesSelected ?? false;
    const idList = Array.isArray(ids) && ids.length > 0 ? ids : productIds;

    // Construir el criterio de selección (IDs explícitos o todos los filtrados)
    const whereClause: any = {};

    if (selectAll) {
      if (filters?.search) {
        whereClause.OR = [
          { name: { contains: filters.search } },
          { sku: { contains: filters.search } },
        ];
      }
      if (filters?.brandId) whereClause.brandId = Number(filters.brandId);
      if (filters?.categoryId) whereClause.categoryId = Number(filters.categoryId);
      if (filters?.supplierId) whereClause.supplierId = Number(filters.supplierId);
    } else if (Array.isArray(idList) && idList.length > 0) {
      whereClause.id = { in: idList.map((i: any) => Number(i)) };
    } else {
      return res.status(400).json({ message: 'Debe proporcionar una lista de IDs o seleccionar todas las páginas.' });
    }

    const candidates = await prisma.product.findMany({
      where: whereClause,
      select: { id: true },
    });
    const candidateIds = candidates.map((p) => p.id);

    if (candidateIds.length === 0) {
      return res.status(404).json({ message: 'No se encontraron productos para eliminar.' });
    }

    // Validar dependencias de negocio (los ítems de venta se desvinculan en vez
    // de bloquear; las consignaciones canceladas se limpian; el resto sí bloquea).
    const [purchaseItemsCount, comboItemsCount, promotionConditionsCount, activeConsignmentItemsCount, stockTransferItemsCount, recipeIngredientCount] = await Promise.all([
      prisma.purchaseItem.count({ where: { productId: { in: candidateIds } } }),
      prisma.comboItem.count({ where: { productId: { in: candidateIds } } }),
      prisma.promotionCondition.count({ where: { productId: { in: candidateIds } } }),
      prisma.consignmentItem.count({
        where: { productId: { in: candidateIds }, consignment: { status: { in: ['DELIVERED', 'SETTLED'] } } },
      }),
      prisma.stockTransferItem.count({ where: { productId: { in: candidateIds } } }),
      prisma.recipeItem.count({ where: { ingredientId: { in: candidateIds } } }),
    ]);

    const relations = [];
    if (purchaseItemsCount > 0) relations.push(`${purchaseItemsCount} ítem(s) de compra`);
    if (comboItemsCount > 0) relations.push(`${comboItemsCount} ítem(s) de combo`);
    if (promotionConditionsCount > 0) relations.push(`${promotionConditionsCount} condición(es) de promoción`);
    if (activeConsignmentItemsCount > 0) relations.push(`${activeConsignmentItemsCount} ítem(s) de consignación activa`);
    if (stockTransferItemsCount > 0) relations.push(`${stockTransferItemsCount} ítem(s) de traspaso de stock`);
    if (recipeIngredientCount > 0) relations.push(`${recipeIngredientCount} receta(s) que lo(s) usan como ingrediente`);

    if (relations.length > 0 && !isForce) {
      return res.status(409).json({
        message: `No se pueden eliminar los productos seleccionados porque están asociados a ${relations.join(', ')}. Considere marcarlos como no disponibles o discontinuados.`,
        canForce: true,
        relations,
      });
    }

    // Pedidos web que referencian alguno de los productos. Sin force solo se
    // limpian automáticamente los NO pagados / NO entregados (checkout
    // fallido); con force se eliminan todos y se reportan sus números.
    const webOrderItems = await prisma.webOrderItem.findMany({
      where: { productId: { in: candidateIds } },
      select: { webOrderId: true },
    });
    const webOrderIds = [...new Set(webOrderItems.map((i) => i.webOrderId))];

    let webOrderNumbersToDelete: string[] = [];
    if (webOrderIds.length > 0) {
      const webOrders = await prisma.webOrder.findMany({
        where: { id: { in: webOrderIds } },
        select: { id: true, webOrderNumber: true, status: true, paymentStatus: true },
      });

      const blocked = webOrders.filter(
        (o) => o.paymentStatus === "PAID" || o.status === "DELIVERED"
      );
      if (blocked.length > 0 && !isForce) {
        return res.status(409).json({
          message: `No se pueden eliminar los productos porque están asociados a pedidos web confirmados (${blocked.map((o) => o.webOrderNumber).join(', ')}). Considere marcarlos como no disponibles.`,
          canForce: true,
          relations: [`pedidos web confirmados: ${blocked.map((o) => o.webOrderNumber).join(', ')}`],
        });
      }

      webOrderNumbersToDelete = webOrders.map((o) => o.webOrderNumber);
    }

    // Recetas que usan estos productos como ingrediente (el FK no tiene
    // onDelete: hay que limpiarlas antes de borrar el producto).
    const affectedRecipeIds = [
      ...new Set(
        (
          await prisma.recipeItem.findMany({
            where: { ingredientId: { in: candidateIds } },
            select: { productId: true },
          })
        ).map((ri) => ri.productId)
      ),
    ];

    const deletedRelations: Record<string, number> = {};

    // Borrar dependencias y productos en una transacción atómica.
    await prisma.$transaction(async (tx) => {
      if (webOrderIds.length > 0) {
        await tx.webOrderItem.deleteMany({ where: { webOrderId: { in: webOrderIds } } });
        await tx.webOrder.deleteMany({ where: { id: { in: webOrderIds } } });
      }
      // Desvincular los ítems de venta: conservan el nombre (productName) y
      // dejan de referenciar al producto.
      if (candidateIds.length > 0) {
        const productsToDelete = await tx.product.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, name: true },
        });
        const nameById = new Map(productsToDelete.map((p) => [p.id, p.name]));
        for (const pid of candidateIds) {
          const name = nameById.get(pid);
          if (name) {
            await tx.saleItem.updateMany({
              where: { productId: pid },
              data: { productId: null, productName: name },
            });
          }
        }
      }
      if (isForce) {
        // Cascada total: historial de compras, combos, promos, consignaciones
        // (cualquiera sea su estado), traspasos y recetas como ingrediente.
        const purchaseRes = await tx.purchaseItem.deleteMany({ where: { productId: { in: candidateIds } } });
        deletedRelations.purchaseItems = purchaseRes.count;

        const comboIds = [...new Set((await tx.comboItem.findMany({
          where: { productId: { in: candidateIds } }, select: { comboId: true },
        })).map((i) => i.comboId))];
        const comboRes = await tx.comboItem.deleteMany({ where: { productId: { in: candidateIds } } });
        deletedRelations.comboItems = comboRes.count;
        if (comboIds.length > 0) {
          const orphanCombos = await tx.combo.findMany({
            where: { id: { in: comboIds }, items: { none: {} } }, select: { id: true },
          });
          if (orphanCombos.length > 0) {
            await tx.combo.deleteMany({ where: { id: { in: orphanCombos.map((c) => c.id) } } });
            deletedRelations.combosDeleted = orphanCombos.length;
          }
        }

        const promoIds = [...new Set((await tx.promotionCondition.findMany({
          where: { productId: { in: candidateIds } }, select: { promotionId: true },
        })).map((c) => c.promotionId))];
        const promoRes = await tx.promotionCondition.deleteMany({ where: { productId: { in: candidateIds } } });
        deletedRelations.promotionConditions = promoRes.count;
        if (promoIds.length > 0) {
          const orphanPromos = await tx.promotion.findMany({
            where: { id: { in: promoIds }, conditions: { none: {} } }, select: { id: true },
          });
          if (orphanPromos.length > 0) {
            await tx.promotion.deleteMany({ where: { id: { in: orphanPromos.map((p) => p.id) } } });
            deletedRelations.promotionsDeleted = orphanPromos.length;
          }
        }

        const consignmentIds = [...new Set((await tx.consignmentItem.findMany({
          where: { productId: { in: candidateIds } }, select: { consignmentId: true },
        })).map((i) => i.consignmentId))];
        const consignmentRes = await tx.consignmentItem.deleteMany({ where: { productId: { in: candidateIds } } });
        deletedRelations.consignmentItems = consignmentRes.count;
        if (consignmentIds.length > 0) {
          const orphanConsignments = await tx.consignment.findMany({
            where: { id: { in: consignmentIds }, items: { none: {} } }, select: { id: true },
          });
          if (orphanConsignments.length > 0) {
            await tx.consignment.deleteMany({ where: { id: { in: orphanConsignments.map((c) => c.id) } } });
            deletedRelations.consignmentsDeleted = orphanConsignments.length;
          }
        }

        const transferIds = [...new Set((await tx.stockTransferItem.findMany({
          where: { productId: { in: candidateIds } }, select: { transferId: true },
        })).map((i) => i.transferId))];
        const transferRes = await tx.stockTransferItem.deleteMany({ where: { productId: { in: candidateIds } } });
        deletedRelations.stockTransferItems = transferRes.count;
        if (transferIds.length > 0) {
          const orphanTransfers = await tx.stockTransfer.findMany({
            where: { id: { in: transferIds }, items: { none: {} } }, select: { id: true },
          });
          if (orphanTransfers.length > 0) {
            await tx.stockTransfer.deleteMany({ where: { id: { in: orphanTransfers.map((t) => t.id) } } });
            deletedRelations.transfersDeleted = orphanTransfers.length;
          }
        }

        const recipeRes = await tx.recipeItem.deleteMany({ where: { ingredientId: { in: candidateIds } } });
        deletedRelations.recipeItems = recipeRes.count;
        // Los modificadores que usan estos productos como ingrediente se desvinculan.
        await tx.productModifierOption.updateMany({
          where: { ingredientId: { in: candidateIds } },
          data: { ingredientId: null },
        });
      } else {
        // Limpiar ítems de consignaciones CANCELADAS (no impiden el borrado).
        await tx.consignmentItem.deleteMany({
          where: { productId: { in: candidateIds }, consignment: { status: 'CANCELLED' } },
        });
      }
      await tx.productBranchStock.deleteMany({ where: { productId: { in: candidateIds } } });
      await tx.product.deleteMany({ where: { id: { in: candidateIds } } });
    });

    // Reflejar la eliminación en la nube vía outbox (fire-and-forget, tolerante offline).
    try {
      const { enqueueOutbox } = await import('../../../lib/syncOutbox');
      for (const num of webOrderNumbersToDelete) {
        await enqueueOutbox('WebOrder', 'DELETE', num);
      }
      // Re-subir recetas afectadas para limpiar sus RecipeItem en la nube
      // antes de borrar el producto (FK de Supabase).
      for (const recipeId of affectedRecipeIds) {
        if (!candidateIds.includes(recipeId)) {
          await enqueueOutbox('Product', 'UPSERT', String(recipeId));
        }
      }
      for (const pid of candidateIds) {
        await enqueueOutbox('Product', 'DELETE', String(pid));
      }
    } catch (enqErr) {
      console.error('[BatchDelete] Error al encolar borrado en outbox:', enqErr);
    }

    if (isForce) {
      deletedRelations.webOrders = webOrderNumbersToDelete.length;
      const detail = Object.entries(deletedRelations)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      return res.status(200).json({
        message: `${candidateIds.length} producto(s) eliminado(s) con borrado forzado${detail ? ` (también se eliminó: ${detail})` : ''}.`,
        count: candidateIds.length,
        deletedCount: candidateIds.length,
        forced: true,
        deletedRelations,
        deletedWebOrders: webOrderNumbersToDelete,
      });
    }

    return res.status(200).json({
      message: `${candidateIds.length} producto(s) eliminado(s) correctamente.`,
      count: candidateIds.length,
      deletedCount: candidateIds.length,
    });
  } catch (error: any) {
    handleApiError(res, error, 'deleting products in batch');
  }
}
