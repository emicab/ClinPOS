// pages/api/products/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma } from '@prisma/client';
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const productIdQuery = req.query.id as string;

  if (!productIdQuery || isNaN(parseInt(productIdQuery))) {
    return res.status(400).json({ message: 'ID de producto inválido.' });
  }
  
  const id = parseInt(productIdQuery);

  if (req.method === 'GET') {
    try {
      const product = await prisma.product.findUnique({
        where: { id },
        include: {
          brand: true,
          category: true,
          supplier: true,
        },
      });
      if (!product) {
        return res.status(404).json({ message: 'Producto no encontrado.' });
      }
      res.status(200).json(product);
    } catch (error: any) {
      handleApiError(res, error, `fetching product ${id}`);
    }
  } else if (req.method === 'PUT') {
    const { isPublicWeb, webCategory, webUnavailable } = req.body;

    // Si es una actualización rápida de visibilidad web únicamente:
    if (isPublicWeb !== undefined && Object.keys(req.body).every((k) => ['isPublicWeb', 'webCategory'].includes(k))) {
      try {
        const updated = await prisma.product.update({
          where: { id },
          data: {
            isPublicWeb: Boolean(isPublicWeb),
            ...(webCategory !== undefined ? { webCategory: webCategory || null } : {}),
          },
          include: { brand: true, category: true, supplier: true, branchStocks: true },
        });
        
        // Fire-and-forget: encolar el cambio en el outbox.
        try {
          const { enqueueOutbox } = await import("../../../lib/syncOutbox");
          await enqueueOutbox("Product", "UPSERT", String(id));
        } catch (enqErr) {
          console.error("[Productos] Error al encolar visibilidad web:", enqErr);
        }
        
        res.status(200).json(updated);
        return;
      } catch (error: any) {
        handleApiError(res, error, `updating product web status ${id}`);
        return;
      }
    }

    // Actualización rápida del flag "agotado en la tienda web" únicamente:
    if (webUnavailable !== undefined && Object.keys(req.body).every((k) => ['webUnavailable'].includes(k))) {
      try {
        const updated = await prisma.product.update({
          where: { id },
          data: {
            webUnavailable: Boolean(webUnavailable),
            ...(webUnavailable ? { isPublicWeb: true } : {}),
          },
          include: { brand: true, category: true, supplier: true, branchStocks: true },
        });

        try {
          const { enqueueOutbox } = await import("../../../lib/syncOutbox");
          await enqueueOutbox("Product", "UPSERT", String(id));
        } catch (enqErr) {
          console.error("[Productos] Error al encolar agotado web:", enqErr);
        }

        res.status(200).json(updated);
        return;
      } catch (error: any) {
        handleApiError(res, error, `updating product web availability ${id}`);
        return;
      }
    }

    const {
      pricePurchase, priceSale, quantityStock, stockMinAlert,
      brandId, categoryId, supplierId, unitType, branchStocks, branchId, isRecipe, recipeItems, isIngredient
    } = req.body;
    let {
      name, sku, description,
    } = req.body;

    // Los ingredientes no usan categoría ni precio de venta (igual que en el POST).
    // Se detecta con el flag del body o, si viene una actualización parcial, con el
    // registro existente en la BD.
    let isIngredientProduct = isIngredient === true || isIngredient === 'true';
    if (!isIngredientProduct) {
      try {
        const existingProduct = await prisma.product.findUnique({ where: { id }, select: { isIngredient: true } });
        isIngredientProduct = existingProduct?.isIngredient === true;
      } catch { /* si falla, se asume producto vendible */ }
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ message: 'El nombre del producto es obligatorio.' });
    }
    if (!isIngredientProduct && (priceSale === undefined || isNaN(parseFloat(priceSale)))) {
      return res.status(400).json({ message: 'El precio de venta es obligatorio y debe ser un número.' });
    }
    if (!isIngredientProduct && (categoryId === undefined || isNaN(parseInt(categoryId)))) {
      return res.status(400).json({ message: 'La categoría es obligatoria.' });
    }

    name = sanitizeString(name);
    if (sku) sku = sanitizeString(sku);
    if (description) description = sanitizeString(description);

    try {
      const brandIdInt = brandId !== undefined && brandId !== null && brandId !== '' ? parseInt(brandId) : null;
      const brandIdValid = brandIdInt !== null && !isNaN(brandIdInt);
      if (brandIdValid) {
        const brandExists = await prisma.brand.findUnique({ where: { id: brandIdInt } });
        if (!brandExists) return res.status(400).json({ message: `Marca con ID ${brandId} no existe.` });
      }

      if (categoryId !== undefined && categoryId !== null && categoryId !== '' && !isNaN(parseInt(categoryId))) {
        const categoryExists = await prisma.category.findUnique({ where: { id: parseInt(categoryId) }});
        if (!categoryExists) return res.status(400).json({ message: `Categoría con ID ${categoryId} no existe.` });
      }

      let totalStockCalculated = quantityStock !== undefined ? parseFloat(quantityStock) : undefined;

      // [CORREGIDO] Lógica de recálculo de stock por sucursales
      if (branchStocks && (Array.isArray(branchStocks) || typeof branchStocks === 'object')) {
        const items = Array.isArray(branchStocks)
          ? branchStocks
          : Object.entries(branchStocks).map(([bId, s]) => ({ branchId: Number(bId), stock: s }));

        for (const item of items) {
          const bId = parseInt(String(item.branchId ?? item.id));
          const stockVal = parseFloat(String(item.stock ?? item.quantityStock ?? 0));
          if (!isNaN(bId) && !isNaN(stockVal)) {
            await prisma.productBranchStock.upsert({
              where: { productId_branchId: { productId: id, branchId: bId } },
              update: { quantityStock: stockVal },
              create: { productId: id, branchId: bId, quantityStock: stockVal }
            });
          }
        }
        
        // Recalcular SIEMPRE desde la BD para no ignorar sucursales excluidas en el payload
        const totalStockAgg = await prisma.productBranchStock.aggregate({
          where: { productId: id },
          _sum: { quantityStock: true }
        });
        totalStockCalculated = totalStockAgg._sum.quantityStock ?? 0;
        
      } else if (branchId && quantityStock !== undefined) {
        const bId = parseInt(branchId);
        if (!isNaN(bId)) {
          await prisma.productBranchStock.upsert({
            where: { productId_branchId: { productId: id, branchId: bId } },
            update: { quantityStock: parseFloat(quantityStock) },
            create: { productId: id, branchId: bId, quantityStock: parseFloat(quantityStock) }
          });
        }
        
        const totalStockAgg = await prisma.productBranchStock.aggregate({
          where: { productId: id },
          _sum: { quantityStock: true }
        });
        totalStockCalculated = totalStockAgg._sum.quantityStock ?? 0;
      } else if (quantityStock !== undefined && !(isRecipe === true || isRecipe === 'true')) {
        const mainBranch = await prisma.branch.findFirst({ where: { isMain: true } });
        const stockVal = parseFloat(quantityStock);
        if (mainBranch && !isNaN(stockVal)) {
          await prisma.productBranchStock.upsert({
            where: { productId_branchId: { productId: id, branchId: mainBranch.id } },
            update: { quantityStock: stockVal },
            create: { productId: id, branchId: mainBranch.id, quantityStock: stockVal }
          });
        }
      }

      const dataToUpdate: Prisma.ProductUpdateInput = {
        name: name.trim(),
        ...(priceSale !== undefined && priceSale !== null && priceSale !== '' ? { priceSale: new Decimal(parseFloat(priceSale)) } : {}),
        ...(totalStockCalculated !== undefined ? { quantityStock: totalStockCalculated } : {}),
        ...(brandIdValid ? { brand: { connect: { id: brandIdInt } } } : {}),
        ...(categoryId !== undefined && categoryId !== null && categoryId !== '' && !isNaN(parseInt(categoryId))
          ? { category: { connect: { id: parseInt(categoryId) } } }
          : {}),
      };

      // La marca es opcional: si llega vacía la desvinculamos, si no viene no la tocamos.
      if (brandId !== undefined && !brandIdValid) {
        dataToUpdate.brand = { disconnect: true };
      }

      if (sku !== undefined) {
        dataToUpdate.sku = typeof sku === 'string' ? (sku.trim() || null) : sku;
      }
      if (description !== undefined) {
        dataToUpdate.description = typeof description === 'string' ? (description.trim() || null) : description;
      }
      if (req.body.imageUrl !== undefined) {
        dataToUpdate.imageUrl = typeof req.body.imageUrl === 'string' ? (req.body.imageUrl.trim() || null) : req.body.imageUrl;
      }
      if (pricePurchase !== undefined && pricePurchase !== null && pricePurchase !== '') {
        dataToUpdate.pricePurchase = new Decimal(parseFloat(pricePurchase));
      } else if (pricePurchase === '' || pricePurchase === null) {
        dataToUpdate.pricePurchase = null as any;
      }
      if (stockMinAlert !== undefined && stockMinAlert !== null && stockMinAlert !== '') {
        dataToUpdate.stockMinAlert = parseFloat(stockMinAlert);
      } else if (stockMinAlert === '' || stockMinAlert === null) {
        dataToUpdate.stockMinAlert = null;
      }
      if (unitType !== undefined) {
        const validUnitTypes = [null, 'UNIT', 'WEIGHT', 'VOLUME'];
        dataToUpdate.unitType = validUnitTypes.includes(unitType) ? (unitType || null) : null;
      }
      if (isRecipe !== undefined) {
        dataToUpdate.isRecipe = Boolean(isRecipe) || (Array.isArray(recipeItems) && recipeItems.length > 0);
      }
      if (req.body.isPublicWeb !== undefined) {
        dataToUpdate.isPublicWeb = Boolean(req.body.isPublicWeb);
      }
      if (req.body.webCategory !== undefined) {
        dataToUpdate.webCategory = typeof req.body.webCategory === 'string' ? (req.body.webCategory.trim() || null) : req.body.webCategory;
      }
      if (req.body.webUnavailable !== undefined) {
        dataToUpdate.webUnavailable = Boolean(req.body.webUnavailable);
      }
      if (supplierId !== undefined && supplierId !== null && supplierId !== '') {
        dataToUpdate.supplier = { connect: { id: parseInt(supplierId) } };
      } else if (supplierId === '' || supplierId === null) {
        dataToUpdate.supplier = { disconnect: true };
      }

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: dataToUpdate,
        include: { brand: true, category: true, supplier: true, branchStocks: true },
      });

      // [CORREGIDO] Guardar la receta junto al producto. Antes el PUT ignoraba
      // recipeItems/isRecipe y los ingredientes no se persistían (bug "no lo suma").
      const finalIsRecipe = isRecipe !== undefined ? Boolean(isRecipe) : (Array.isArray(recipeItems) && recipeItems.length > 0);
      if (finalIsRecipe) {
        const { replaceRecipeItems, recordCostSnapshot } = await import("../../../lib/recipeStock");
        await replaceRecipeItems(prisma, id, Array.isArray(recipeItems) ? recipeItems : []);
        await recordCostSnapshot(prisma, id, "recipe_save");
      } else if (Array.isArray(recipeItems)) {
        // Dejó de ser receta (o viene con items vacíos): limpiar ingredientes.
        await prisma.recipeItem.deleteMany({ where: { productId: id } });
      }

      // Fire-and-forget: encolar el cambio en el outbox.
      try {
        const { enqueueOutbox } = await import("../../../lib/syncOutbox");
        await enqueueOutbox("Product", "UPSERT", String(id));
      } catch (enqErr) {
        console.error("[Productos] Error al encolar producto:", enqErr);
      }

      res.status(200).json(updatedProduct);
    } catch (error: any) {
      handleApiError(res, error, `updating product ${id}`);
    }
  } else if (req.method === 'DELETE') {
    try {
      // Borrado forzado (doble verificación del frontend): elimina en cascada
      // todas las dependencias. Se acepta por body o query (?force=true).
      const isForce = req.body?.force === true || req.query.force === 'true';
      const [saleItemsCount, purchaseItemsCount, comboItemsCount, promotionConditionsCount, activeConsignmentItemsCount, stockTransferItemsCount] = await Promise.all([
        prisma.saleItem.count({ where: { productId: id } }),
        prisma.purchaseItem.count({ where: { productId: id } }),
        prisma.comboItem.count({ where: { productId: id } }),
        prisma.promotionCondition.count({ where: { productId: id } }),
        // Solo bloquean las consignaciones ACTIVAS (DELIVERED/SETTLED). Las
        // canceladas se limpian automáticamente para no impedir el borrado.
        prisma.consignmentItem.count({
          where: { productId: id, consignment: { status: { in: ['DELIVERED', 'SETTLED'] } } },
        }),
        prisma.stockTransferItem.count({ where: { productId: id } }),
      ]);

      // Los ítems de venta se DESVINCULAN (productId -> null) conservando el
      // nombre (productName) para no perder el historial. Las demás referencias
      // sí bloquean.
      const relations = [];
      if (purchaseItemsCount > 0) relations.push(`${purchaseItemsCount} ítem(s) de compra`);
      if (comboItemsCount > 0) relations.push(`${comboItemsCount} ítem(s) de combo`);
      if (promotionConditionsCount > 0) relations.push(`${promotionConditionsCount} condición(es) de promoción`);
      if (activeConsignmentItemsCount > 0) relations.push(`${activeConsignmentItemsCount} ítem(s) de consignación activa`);
      if (stockTransferItemsCount > 0) relations.push(`${stockTransferItemsCount} ítem(s) de traspaso de stock`);

      if (relations.length > 0 && !isForce) {
        return res.status(409).json({
          message: `No se puede eliminar el producto porque está asociado a ${relations.join(', ')}. Considere marcarlo como no disponible o discontinuado.`,
          canForce: true,
          relations,
        });
      }

      // Pedidos web que referencian este producto. Sin force solo se limpian
      // automáticamente los PENDIENTES y NO pagados (ej. un checkout fallido);
      // con force se eliminan todos.
      const webOrderItems = await prisma.webOrderItem.findMany({
        where: { productId: id },
        select: { webOrderId: true },
      });
      const webOrderIds = [...new Set(webOrderItems.map(i => i.webOrderId))];

      let webOrderNumbersToDelete: string[] = [];
      if (webOrderIds.length > 0) {
        const webOrders = await prisma.webOrder.findMany({
          where: { id: { in: webOrderIds } },
          select: { id: true, webOrderNumber: true, status: true, paymentStatus: true },
        });

        const blocked = webOrders.filter(o =>
          o.paymentStatus === "PAID" || o.status === "DELIVERED"
        );
        if (blocked.length > 0 && !isForce) {
          return res.status(409).json({
            message: `No se puede eliminar el producto porque está asociado a pedidos web confirmados (${blocked.map(o => o.webOrderNumber).join(', ')}). Considere marcarlo como no disponible.`,
            canForce: true,
            relations: [`pedidos web confirmados: ${blocked.map(o => o.webOrderNumber).join(', ')}`],
          });
        }

        webOrderNumbersToDelete = webOrders.map(o => o.webOrderNumber);
      }

      // Recetas que usan este producto como ingrediente. Se eliminan sus items
      // (RecipeItem.ingredient no tiene onDelete) y luego se re-suben a la nube
      // para que el FK de Supabase no rompa el borrado del producto.
      const affectedRecipeIds = [
        ...new Set(
          (
            await prisma.recipeItem.findMany({
              where: { ingredientId: id },
              select: { productId: true },
            })
          ).map((ri) => ri.productId)
        ),
      ];

      const deletedRelations: Record<string, number> = {};

      // Borrar dependencias de órdenes web pendientes y el producto (transacción atómica).
      await prisma.$transaction(async (tx) => {
        if (webOrderIds.length > 0) {
          await tx.webOrderItem.deleteMany({ where: { webOrderId: { in: webOrderIds } } });
          await tx.webOrder.deleteMany({ where: { id: { in: webOrderIds } } });
        }
        // Desvincular los ítems de venta: conservan el nombre (productName) para
        // no perder el historial, pero dejan de referenciar al producto.
        if (saleItemsCount > 0) {
          const productToDelete = await tx.product.findUnique({ where: { id }, select: { name: true } });
          await tx.saleItem.updateMany({
            where: { productId: id },
            data: { productId: null, productName: productToDelete?.name || null },
          });
        }
        if (isForce) {
          // Cascada total (solo tras doble verificación).
          const purchaseRes = await tx.purchaseItem.deleteMany({ where: { productId: id } });
          deletedRelations.purchaseItems = purchaseRes.count;

          const comboIds = [...new Set((await tx.comboItem.findMany({
            where: { productId: id }, select: { comboId: true },
          })).map((i) => i.comboId))];
          const comboRes = await tx.comboItem.deleteMany({ where: { productId: id } });
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
            where: { productId: id }, select: { promotionId: true },
          })).map((c) => c.promotionId))];
          const promoRes = await tx.promotionCondition.deleteMany({ where: { productId: id } });
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
            where: { productId: id }, select: { consignmentId: true },
          })).map((i) => i.consignmentId))];
          const consignmentRes = await tx.consignmentItem.deleteMany({ where: { productId: id } });
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
            where: { productId: id }, select: { transferId: true },
          })).map((i) => i.transferId))];
          const transferRes = await tx.stockTransferItem.deleteMany({ where: { productId: id } });
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

          await tx.productModifierOption.updateMany({
            where: { ingredientId: id },
            data: { ingredientId: null },
          });
        } else {
          // Limpiar ítems de consignaciones CANCELADAS (no impiden el borrado).
          await tx.consignmentItem.deleteMany({
            where: { productId: id, consignment: { status: 'CANCELLED' } },
          });
        }
        await tx.productBranchStock.deleteMany({ where: { productId: id } });
        // Quitar el producto de las recetas que lo usan como ingrediente.
        await tx.recipeItem.deleteMany({ where: { ingredientId: id } });
        await tx.product.delete({ where: { id } });
      });

      // Reflejar la eliminación en la nube vía outbox (fire-and-forget). Así un
      // borrado offline no se pierde: el drain lo aplica al reconectar.
      try {
        const { enqueueOutbox } = await import("../../../lib/syncOutbox");
        for (const num of webOrderNumbersToDelete) {
          await enqueueOutbox("WebOrder", "DELETE", num);
        }
        // Primero re-subir las recetas afectadas (limpiar sus RecipeItem en la
        // nube) y después borrar el producto, para no violar el FK de Supabase.
        for (const recipeId of affectedRecipeIds) {
          await enqueueOutbox("Product", "UPSERT", String(recipeId));
        }
        await enqueueOutbox("Product", "DELETE", String(id));
      } catch (enqErr) {
        console.error("[Productos] Error al encolar borrado:", enqErr);
      }

      if (isForce) {
        deletedRelations.webOrders = webOrderNumbersToDelete.length;
        const detail = Object.entries(deletedRelations)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
        res.status(200).json({
          message: `Producto eliminado con borrado forzado${detail ? ` (también se eliminó: ${detail})` : ''}.`,
          forced: true,
          deletedRelations,
        });
        return;
      }

      res.status(204).end();
    } catch (error: any) {
      handleApiError(res, error, `deleting product ${id}`);
    }
  } else if (req.method === 'PATCH') {
    const { quantityStock, unitType } = req.body;
    const dataToUpdate: Prisma.ProductUpdateInput = {};
    if (quantityStock !== undefined) {
      if (isNaN(parseFloat(quantityStock))) {
        return res.status(400).json({ message: 'quantityStock inválido.' });
      }
      dataToUpdate.quantityStock = parseFloat(quantityStock);
    }
    if (unitType !== undefined) {
      const validUnitTypes = [null, 'UNIT', 'WEIGHT', 'VOLUME'];
      dataToUpdate.unitType = validUnitTypes.includes(unitType) ? (unitType || null) : null;
    }
    if (Object.keys(dataToUpdate).length === 0) {
      return res.status(400).json({ message: 'No hay campos para actualizar.' });
    }
      try {
        const updated = await prisma.product.update({
          where: { id },
          data: dataToUpdate,
        });
      
        try {
          const { enqueueOutbox } = await import("../../../lib/syncOutbox");
          await enqueueOutbox("Product", "UPSERT", String(id));
        } catch (enqErr) {
          console.error("[Productos] Error al encolar PATCH:", enqErr);
        }
      
        res.status(200).json(updated);
    } catch (error: any) {
      handleApiError(res, error, `patching product ${id} stock`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'PATCH', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}