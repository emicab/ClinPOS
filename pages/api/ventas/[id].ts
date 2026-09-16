// pages/api/ventas/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma } from '@prisma/client';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const saleIdQuery = req.query.id as string;

  if (!saleIdQuery || isNaN(parseInt(saleIdQuery))) {
    return res.status(400).json({ message: 'ID de venta inválido.' });
  }

  const id = parseInt(saleIdQuery);

  if (req.method === 'GET') {
    try {
      const sale = await prisma.sale.findUnique({
        where: { id: id },
        include: {
          client: true,
          seller: true,
          cashRegister: true,
          items: {
            include: {
              product: true,
            },
            orderBy: {
                id: 'asc'
            }
          },
          invoice: true,
          creditCardPromotion: true,
        },
      });

      if (!sale) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
      }

      const saleForJson = {
        ...sale,
        totalAmount: sale.totalAmount.toString(),
        cashRegister: sale.cashRegister ? {
          ...sale.cashRegister,
          initialBalance: sale.cashRegister.initialBalance.toString(),
          expectedBalance: sale.cashRegister.expectedBalance?.toString() || null,
          actualBalance: sale.cashRegister.actualBalance?.toString() || null,
          difference: sale.cashRegister.difference?.toString() || null,
        } : null,
        items: sale.items.map(item => ({
          ...item,
          priceAtSale: item.priceAtSale.toString(),
          product: item.product ? {
            ...item.product,
            pricePurchase: item.product.pricePurchase?.toString() || null,
            priceSale: item.product.priceSale.toString(),
          } : null
        })),
        invoice: sale.invoice ? {
          ...sale.invoice,
        } : null
      };

      res.status(200).json(saleForJson);
    } catch (error: any) {
      handleApiError(res, error, `fetching sale ${id}`);
    }
  } else if (req.method === 'PUT') {
    const { clientId } = req.body;
    try {
      const updatedSale = await prisma.sale.update({
        where: { id: id },
        data: {
          clientId: clientId ? parseInt(clientId) : null,
        },
        include: {
          client: true,
          seller: true,
          cashRegister: true,
          items: {
            include: {
              product: true,
            },
            orderBy: {
              id: 'asc'
            }
          },
          invoice: true
        }
      });

      const saleForJson = {
        ...updatedSale,
        totalAmount: updatedSale.totalAmount.toString(),
        cashRegister: updatedSale.cashRegister ? {
          ...updatedSale.cashRegister,
          initialBalance: updatedSale.cashRegister.initialBalance.toString(),
          expectedBalance: updatedSale.cashRegister.expectedBalance?.toString() || null,
          actualBalance: updatedSale.cashRegister.actualBalance?.toString() || null,
          difference: updatedSale.cashRegister.difference?.toString() || null,
        } : null,
        items: updatedSale.items.map(item => ({
          ...item,
          priceAtSale: item.priceAtSale.toString(),
          product: item.product ? {
            ...item.product,
            pricePurchase: item.product.pricePurchase?.toString() || null,
            priceSale: item.product.priceSale.toString(),
          } : null
        })),
        invoice: updatedSale.invoice ? {
          ...updatedSale.invoice,
        } : null
      };

      res.status(200).json(saleForJson);
    } catch (error: any) {
      handleApiError(res, error, `updating sale ${id}`);
    }

  } else if (req.method === 'DELETE') {
    let affectedProductIds: number[] = [];
    let restoredStockItems: Array<{ productId: number; quantity: number; isRecipe: boolean }> = [];
    let restoredBranchId: number | null = null;

    try {
        const result = await prisma.$transaction(async (tx) => {
          // 1. Encontrar la venta y sus ítems
          const saleToDelete = await tx.sale.findUnique({
            where: { id: id },
            include: {
              items: {
                select: {
                  productId: true,
                  quantity: true,
                  product: {
                    select: { isRecipe: true },
                  },
                },
              },
            },
          });

        if (!saleToDelete) {
          throw new Prisma.PrismaClientKnownRequestError('Venta no encontrada para eliminar.', {
            code: 'P2025',
            clientVersion: Prisma.prismaVersion.client,
          });
        }

        affectedProductIds = saleToDelete.items.filter(i => i.productId != null).map(i => i.productId as number);
        restoredStockItems = saleToDelete.items
          .filter(i => i.productId != null)
          .map(i => ({
            productId: i.productId as number,
            quantity: Number(i.quantity),
            isRecipe: Boolean(i.product?.isRecipe),
          }));
        restoredBranchId = saleToDelete.branchId ?? null;

        // 2. Revertir saldo de Cuenta Corriente si estuvo vinculada a un cliente
        if (saleToDelete.clientId) {
          const balanceRecord = await tx.accountBalance.findUnique({
            where: { clientId: saleToDelete.clientId },
          });

          if (balanceRecord) {
            await tx.accountBalance.update({
              where: { id: balanceRecord.id },
              data: {
                balance: {
                  decrement: saleToDelete.totalAmount,
                },
              },
            });
          }

          await tx.accountMovement.deleteMany({
            where: { saleId: id },
          });
        }

        // 3. Eliminar los movimientos de caja generados por esta venta
        await tx.cashMovement.deleteMany({
          where: {
            sourceId: id,
            type: 'SALE',
          },
        });

        // 4. Reponer stock global y en la sucursal donde se vendió (fallback: principal)
        const mainBranch = await tx.branch.findFirst({ where: { isMain: true } });
        const restoreBranchId = saleToDelete.branchId || mainBranch?.id;

        for (const item of saleToDelete.items) {
          if (item.productId == null) continue; // ítem desvinculado, sin producto para reponer

          // Elaborado: se repone el stock de sus ingredientes, no el del producto.
          if (item.product?.isRecipe) {
            const { restoreRecipeStock } = await import('../../../lib/recipeStock');
            const affected = await restoreRecipeStock(tx, item.productId, item.quantity, restoreBranchId);
            affectedProductIds.push(...affected);
            continue;
          }

          // Reponer en stock general del producto
          await tx.product.update({
            where: { id: item.productId },
            data: {
              quantityStock: {
                increment: item.quantity,
              },
            },
          });

          // Reponer en ProductBranchStock para mantener consistencia con syncService
          if (restoreBranchId) {
            await tx.productBranchStock.upsert({
              where: {
                productId_branchId: {
                  productId: item.productId,
                  branchId: restoreBranchId,
                },
              },
              update: {
                quantityStock: { increment: item.quantity },
              },
              create: {
                productId: item.productId,
                branchId: restoreBranchId,
                quantityStock: item.quantity,
              },
            });
          }
        }

        // 5. Eliminar la venta
        await tx.sale.delete({
          where: { id: id },
        });

        return { message: 'Venta eliminada, stock repuesto y cuenta corriente actualizada exitosamente.' };
      });

      // 6. Encolar los productos afectados (fire-and-forget vía outbox)
      try {
        const { enqueueOutbox, enqueueStockMovement } = await import('../../../lib/syncOutbox');
        await enqueueOutbox('Sale', 'DELETE', String(id));
        for (const [index, item] of restoredStockItems.entries()) {
          if (!item.isRecipe) {
            await enqueueStockMovement({
              operationId: `sale-delete:${id}:item:${index}`,
              productId: item.productId,
              delta: item.quantity,
              branchId: restoredBranchId,
            });
          }
        }
        const uniqueIds = Array.from(new Set(affectedProductIds));
        for (const pid of uniqueIds) {
          await enqueueOutbox('Product', 'UPSERT', String(pid));
          await enqueueOutbox('ProductBranchStock', 'UPSERT', String(pid));
        }
      } catch (enqErr) {
        console.error('[Ventas] Error al encolar post-eliminación:', enqErr);
      }

      res.status(200).json(result);
      return;
    } catch (error: any) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        res.status(404).json({ message: 'Venta no encontrada para eliminar.' });
        return;
      }
      handleApiError(res, error, `deleting sale ${id}`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
