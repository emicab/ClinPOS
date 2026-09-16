// pages/api/compras/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma, PurchaseStatus, PaymentType } from '@prisma/client';
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const purchaseIdQuery = req.query.id as string;

  if (!purchaseIdQuery || isNaN(parseInt(purchaseIdQuery))) {
    return res.status(400).json({ message: 'ID de compra inválido.' });
  }

  const id = parseInt(purchaseIdQuery);

  if (req.method === 'GET') {
    // Obtener los detalles de una compra específica
    try {
      const purchase = await prisma.purchase.findUnique({
        where: { id: id },
        include: {
          supplier: true,
          items: {
            include: {
              product: true,
            },
          },
        },
      });

      if (!purchase) {
        return res.status(404).json({ message: 'Compra no encontrada.' });
      }
       // Convertir Decimal a string
       const purchaseForJson = {
        ...purchase,
        totalAmount: purchase.totalAmount.toString(),
        items: purchase.items.map(item => ({
          ...item,
          purchasePrice: item.purchasePrice.toString(),
          product: {
            ...item.product,
            pricePurchase: item.product.pricePurchase?.toString() || null,
            priceSale: item.product.priceSale.toString(),
          }
        }))
      };
      res.status(200).json(purchaseForJson);
    } catch (error: any) {
      handleApiError(res, error, `fetching purchase ${id}`);
    }
  } else if (req.method === 'PUT') {
    const { status, paymentType, supplierId, items } = req.body;
    let { invoiceNumber, notes } = req.body;
    
    if (invoiceNumber) invoiceNumber = sanitizeString(invoiceNumber);
    if (notes) notes = sanitizeString(notes);

    try {
      // Guarda de Recetario: no se reciben/compran productos elaborados.
      const newStatus = status as PurchaseStatus || undefined;
      const itemIds = (items && Array.isArray(items) && items.length > 0)
        ? items.map((i: any) => i.productId)
        : (newStatus === 'RECEIVED'
            ? (await prisma.purchaseItem.findMany({ where: { purchaseId: id }, select: { productId: true } })).map(i => i.productId)
            : []);
      if (itemIds.length > 0) {
        const recipeBlock = await prisma.product.findFirst({
          where: { id: { in: itemIds }, isRecipe: true },
          select: { name: true },
        });
        if (recipeBlock) {
          return res.status(400).json({
            message: `No se puede recibir un producto elaborado ("${recipeBlock.name}"). Comprá sus ingredientes para reponer stock.`,
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        // 1. Obtener la compra actual con sus items
        const existingPurchase = await tx.purchase.findUnique({
          where: { id },
          include: { items: true, supplier: true },
        });

        if (!existingPurchase) {
          throw new Error('Compra no encontrada.');
        }

        const oldStatus = existingPurchase.status;
        const newStatus = status as PurchaseStatus || oldStatus;

        // Validar status si se envió
        if (status && !Object.values(PurchaseStatus).includes(newStatus)) {
          throw new Error('Estado de compra inválido.');
        }

        // 3. Preparar datos base de actualización
        const updateData: any = { status: newStatus };
        let calculatedTotal = existingPurchase.totalAmount;

        // 2. Manejo de items y stock según transición de estados
        if (items) {
          // Se recibieron items modificados (ORDERED → RECEIVED o edición directa)
          // Revertir stock si la compra estaba recibida
          if (oldStatus === PurchaseStatus.RECEIVED) {
            for (const item of existingPurchase.items) {
              const revertedQty = item.quantityReceived ?? item.quantity;
              const product = await tx.product.findUnique({
                where: { id: item.productId },
                select: { quantityStock: true, name: true },
              });
              if (product && product.quantityStock < revertedQty) {
                throw new Error(`Stock insuficiente para revertir "${product.name}". Disponible: ${product.quantityStock}, Requerido: ${revertedQty}.`);
              }
              await tx.product.update({
                where: { id: item.productId },
                data: { quantityStock: { decrement: revertedQty } },
              });
            }
          }

          // Eliminar items viejos
          await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });

          calculatedTotal = new Decimal(0);

          for (const item of items) {
            const receivedQty = newStatus === PurchaseStatus.RECEIVED ? (item.quantityReceived ?? item.quantity) : null;
            const stockQty = receivedQty ?? 0;

            await tx.purchaseItem.create({
              data: {
                purchaseId: id,
                productId: item.productId,
                quantity: item.quantity,
                quantityReceived: receivedQty,
                purchasePrice: new Decimal(item.purchasePrice),
              },
            });

            calculatedTotal = calculatedTotal.plus(new Decimal(item.purchasePrice).times(item.quantity));

            if (newStatus === PurchaseStatus.RECEIVED && stockQty > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: {
                  quantityStock: { increment: stockQty },
                  // El costo del ingrediente/producto = última compra recibida.
                  pricePurchase: new Decimal(item.purchasePrice),
                },
              });
              const { branchId } = req.body;
              if (branchId) {
                const bId = parseInt(branchId);
                if (!isNaN(bId)) {
                  await tx.productBranchStock.upsert({
                    where: { productId_branchId: { productId: item.productId, branchId: bId } },
                    update: { quantityStock: { increment: stockQty } },
                    create: { productId: item.productId, branchId: bId, quantityStock: stockQty }
                  });
                }
              }
            }
          }

          updateData.totalAmount = calculatedTotal;

        } else if (oldStatus !== newStatus) {
          // Sin cambio de items, solo ajustar stock por cambio de estado
          const { branchId } = req.body;
          const bId = branchId ? parseInt(branchId) : null;
          const existingItems = await tx.purchaseItem.findMany({ where: { purchaseId: id } });
          for (const item of existingItems) {
            if (oldStatus !== PurchaseStatus.RECEIVED && newStatus === PurchaseStatus.RECEIVED) {
              const receivedQty = item.quantityReceived ?? item.quantity;
              await tx.product.update({
                where: { id: item.productId },
                data: {
                  quantityStock: { increment: receivedQty },
                  // El costo del ingrediente/producto = última compra recibida.
                  pricePurchase: new Decimal(item.purchasePrice),
                },
              });
              if (bId && !isNaN(bId)) {
                await tx.productBranchStock.upsert({
                  where: { productId_branchId: { productId: item.productId, branchId: bId } },
                  update: { quantityStock: { increment: receivedQty } },
                  create: { productId: item.productId, branchId: bId, quantityStock: receivedQty }
                });
              }
            } else if (oldStatus === PurchaseStatus.RECEIVED && newStatus !== PurchaseStatus.RECEIVED) {
              const revertedQty = item.quantityReceived ?? item.quantity;
              const product = await tx.product.findUnique({
                where: { id: item.productId },
                select: { quantityStock: true, name: true },
              });
              if (product && product.quantityStock < revertedQty) {
                throw new Error(`Stock insuficiente para revertir "${product.name}". Disponible: ${product.quantityStock}, Requerido: ${revertedQty}.`);
              }
              await tx.product.update({
                where: { id: item.productId },
                data: { quantityStock: { decrement: revertedQty } },
              });
              if (bId && !isNaN(bId)) {
                await tx.productBranchStock.updateMany({
                  where: { productId: item.productId, branchId: bId },
                  data: { quantityStock: { decrement: revertedQty } }
                });
              }
            }
          }
          updateData.totalAmount = existingPurchase.totalAmount;
        } else {
          updateData.totalAmount = existingPurchase.totalAmount;
        }
        if (paymentType !== undefined) updateData.paymentType = paymentType || null;
        if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber;
        if (notes !== undefined) updateData.notes = notes;
        if (supplierId !== undefined) updateData.supplier = { connect: { id: parseInt(supplierId) } };

        const updatedPurchase = await tx.purchase.update({
          where: { id },
          data: updateData,
          include: { supplier: true, items: { include: { product: true } } },
        });

        // Recetario: al recibir mercadería, registrar snapshot de costo de los
        // elaborados afectados (solo si cambió).
        if (newStatus === PurchaseStatus.RECEIVED) {
          const purchaseItemsForCost = await tx.purchaseItem.findMany({
            where: { purchaseId: id },
            select: { productId: true },
          });
          const { findRecipesAffectedByIngredient, recordCostSnapshot } = await import("../../../lib/recipeStock");
          const ingredientIds = purchaseItemsForCost.map((i: any) => i.productId);
          const affected = await findRecipesAffectedByIngredient(tx, ingredientIds);
          for (const rid of affected) {
            await recordCostSnapshot(tx, rid, "purchase");
          }
        }

        // 5. Si se asignó un medio de pago, sincronizar gasto y movimiento de caja
        if (paymentType) {
          const supplierName = updatedPurchase.supplier?.name || existingPurchase.supplier?.name || `Proveedor #${existingPurchase.supplierId}`;
          const desc = `Compra #${id} - ${supplierName}`;

          const existingExpense = await tx.expense.findFirst({ where: { description: desc } });
          if (existingExpense) {
            await tx.expense.update({
              where: { id: existingExpense.id },
              data: {
                amount: calculatedTotal,
                paymentType: paymentType as PaymentType,
                notes: updatedPurchase.notes || null,
              },
            });
          } else {
            await tx.expense.create({
              data: {
                expenseDate: updatedPurchase.purchaseDate,
                description: desc,
                amount: calculatedTotal,
                category: 'Mercadería',
                paymentType: paymentType as PaymentType,
                notes: updatedPurchase.notes || null,
              },
            });
          }

          const existingMovement = await tx.cashMovement.findFirst({
            where: { sourceId: id, type: 'EXPENSE' },
          });
          if (existingMovement) {
            await tx.cashMovement.update({
              where: { id: existingMovement.id },
              data: {
                amount: calculatedTotal.negated(),
                paymentType: paymentType as PaymentType,
              },
            });
          } else {
            const openRegister = await tx.cashRegister.findFirst({ where: { status: 'OPEN' } });
            if (openRegister) {
              await tx.cashMovement.create({
                data: {
                  cashRegisterId: openRegister.id,
                  type: 'EXPENSE',
                  paymentType: paymentType as PaymentType,
                  sourceId: id,
                  amount: calculatedTotal.negated(),
                  description: desc,
                },
              });
            }
          }
        }

        return updatedPurchase;
      });

      // Fire-and-forget: encolar productos recibidos + elaborados afectados
      // (su stock derivado cambió) para mantener la tienda web al día.
      if (result.status === PurchaseStatus.RECEIVED) {
        try {
          const { enqueueOutbox } = await import('../../../lib/syncOutbox');
          const purchaseItems = await prisma.purchaseItem.findMany({
            where: { purchaseId: id },
            select: { productId: true, quantityReceived: true, quantity: true },
          });
          const receivedIds = purchaseItems.map((i) => i.productId);
          for (const pid of receivedIds) {
            await enqueueOutbox('Product', 'UPSERT', String(pid));
            await enqueueOutbox('ProductBranchStock', 'UPSERT', String(pid));
          }
          if (receivedIds.length > 0) {
            const { findRecipesAffectedByIngredient } = await import('../../../lib/recipeStock');
            const affected = await findRecipesAffectedByIngredient(prisma, receivedIds);
            for (const rid of affected) {
              await enqueueOutbox('Product', 'UPSERT', String(rid));
            }
          }
        } catch (enqErr) {
          console.error('[Compras] Error al encolar recepción:', enqErr);
        }
      }

      // Convertir Decimales a string
      const purchaseForJson = {
        ...result,
        totalAmount: result.totalAmount.toString(),
        items: result.items.map(item => ({
          ...item,
          purchasePrice: item.purchasePrice.toString(),
          product: {
            ...item.product,
            pricePurchase: item.product.pricePurchase?.toString() || null,
            priceSale: item.product.priceSale.toString(),
          }
        }))
      };

      res.status(200).json(purchaseForJson);
    } catch (error: any) {
      if (error instanceof Error && (error.message.startsWith('Stock insuficiente') || error.message === 'Compra no encontrada.' || error.message === 'Estado de compra inválido.')) {
        return res.status(400).json({ message: error.message });
      }
      handleApiError(res, error, `updating purchase ${id}`);
    }
  } else if (req.method === 'DELETE') {
    let deletedReceivedItems: Array<{ productId: number; quantity: number }> = [];
    try {
      const result = await prisma.$transaction(async (tx) => {
        const purchaseToDelete = await tx.purchase.findUnique({
          where: { id },
          include: { items: true },
        });

        if (!purchaseToDelete) {
          throw new Error('Compra no encontrada.');
        }

        // Si la compra estaba RECEIVED, revertir stock
        if (purchaseToDelete.status === PurchaseStatus.RECEIVED) {
          deletedReceivedItems = purchaseToDelete.items.map(item => ({
            productId: item.productId,
            quantity: Number(item.quantityReceived ?? item.quantity),
          }));
          for (const item of purchaseToDelete.items) {
            const revertedQty = item.quantityReceived ?? item.quantity;
            const product = await tx.product.findUnique({
              where: { id: item.productId },
              select: { quantityStock: true, name: true },
            });
            if (product && product.quantityStock < revertedQty) {
              throw new Error(`Stock insuficiente para eliminar la compra del producto "${product.name}". Disponible: ${product.quantityStock}, Requerido: ${revertedQty}.`);
            }
            await tx.product.update({
              where: { id: item.productId },
              data: { quantityStock: { decrement: revertedQty } },
            });
          }
        }

        // Eliminar movimiento de caja asociado a la compra
        await tx.cashMovement.deleteMany({
          where: { sourceId: id, type: 'EXPENSE' },
        });

        // Eliminar gasto generado automáticamente desde la compra
        await tx.expense.deleteMany({
          where: { description: { startsWith: `Compra #${id} - ` } },
        });

        // Eliminar compra. Los items se eliminan en cascada en la BD si está configurado en schema.prisma.
        await tx.purchase.delete({
          where: { id },
        });

        return { message: 'Compra eliminada y stock actualizado.' };
      });

      try {
        const { enqueueOutbox, enqueueStockMovement } = await import('../../../lib/syncOutbox');
        for (const [index, item] of deletedReceivedItems.entries()) {
          await enqueueStockMovement({
            operationId: `purchase-delete:${id}:item:${index}`,
            productId: item.productId,
            delta: -item.quantity,
            branchId: null,
          });
          await enqueueOutbox('Product', 'UPSERT', String(item.productId));
          await enqueueOutbox('ProductBranchStock', 'UPSERT', String(item.productId));
        }
      } catch (enqErr) {
        console.error('[Compras] Error al encolar eliminación:', enqErr);
      }

      res.status(200).json(result);
    } catch (error: any) {
      if (error instanceof Error && (error.message.startsWith('Stock insuficiente') || error.message === 'Compra no encontrada.')) {
        return res.status(400).json({ message: error.message });
      }
      handleApiError(res, error, `deleting purchase ${id}`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
