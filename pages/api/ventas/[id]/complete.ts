import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../../lib/prisma';
import { Prisma, PaymentType } from '@prisma/client';
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../../lib/apiErrorHandler';
// ARCA imports removed because they were unused
import { getPaymentTypeDisplay } from '../../../../lib/displayTexts';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;
  const saleId = parseInt(id as string, 10);
  if (isNaN(saleId)) return res.status(400).json({ message: 'ID de venta inválido' });

  const { paymentType } = req.body;

  try {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { items: { include: { product: true } } }
    });

    if (!sale) return res.status(404).json({ message: 'Venta no encontrada.' });
    if ((sale as any).status !== 'PENDING') {
      return res.status(400).json({ message: 'La venta no está pendiente.' });
    }

    const newPaymentType = paymentType || sale.paymentType;
    const isAccountSale = newPaymentType === PaymentType.ON_ACCOUNT || sale.onAccount === true;
    const effectivePaymentType = isAccountSale ? PaymentType.ON_ACCOUNT : newPaymentType;
    const calculatedTotalAmount = sale.totalAmount;

    const result = await prisma.$transaction(async (tx) => {
      // Registrar movimiento en caja si hay una abierta
      const openRegister = await tx.cashRegister.findFirst({ where: { status: 'OPEN' } });

      if (isAccountSale && sale.clientId) {
        let balanceRecord = await tx.accountBalance.findUnique({
          where: { clientId: sale.clientId },
        });
        if (!balanceRecord) {
          balanceRecord = await tx.accountBalance.create({
            data: { clientId: sale.clientId, balance: new Decimal(0) },
          });
        }
        await tx.accountBalance.update({
          where: { id: balanceRecord.id },
          data: { balance: { increment: calculatedTotalAmount } },
        });
        await tx.accountMovement.create({
          data: {
            accountBalanceId: balanceRecord.id,
            type: "SALE_ON_ACCOUNT",
            amount: calculatedTotalAmount,
            description: `Venta en cuenta #${sale.id}`,
            saleId: sale.id,
          },
        });
      }

      if (openRegister) {
        const cashAmount = effectivePaymentType === 'CASH' ? calculatedTotalAmount : new Decimal(0);
        const otherAmount = effectivePaymentType !== 'CASH' ? calculatedTotalAmount : new Decimal(0);
        if (cashAmount.greaterThan(0)) {
          await tx.cashMovement.create({
            data: {
              cashRegisterId: openRegister.id,
              type: 'SALE',
              paymentType: effectivePaymentType as PaymentType,
              sourceId: sale.id,
              amount: cashAmount,
              description: `Venta #${sale.id} - Efectivo`,
            },
          });
        }
        if (otherAmount.greaterThan(0)) {
          await tx.cashMovement.create({
            data: {
              cashRegisterId: openRegister.id,
              type: 'SALE',
              paymentType: effectivePaymentType as PaymentType,
              sourceId: sale.id,
              amount: otherAmount,
              description: `Venta #${sale.id} - ${getPaymentTypeDisplay(effectivePaymentType as PaymentType)}`,
            },
          });
        }
      }

      const affectedIngredientIds: number[] = [];

      // Chequeo COMBINADO de ingredientes: la disponibilidad derivada por
      // elaborado no es sumable entre variantes que comparten ingredientes.
      const { computeOrderIngredientShortfall, formatIngredientShortfall } = await import("../../../../lib/recipeStock");
      const shortfalls = await computeOrderIngredientShortfall(
        tx,
        sale.items
          .filter((i) => i.productId != null)
          .map((i) => ({ productId: i.productId!, quantity: Number(i.quantity) || 0 })),
        sale.branchId,
      );
      if (shortfalls.length > 0) {
        throw new Error(
          `Stock insuficiente de ingredientes para completar la venta: ${shortfalls.map(formatIngredientShortfall).join('; ')}. Reducí cantidades o reponé stock.`,
        );
      }

      for (const item of sale.items) {
        if (item.productId == null) continue; // ítem desvinculado, sin producto

        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product) {
          throw new Error(`Producto con ID ${item.productId} no encontrado.`);
        }

        if (product.isRecipe === true) {
          // Elaborado: validar disponibilidad derivada y descontar ingredientes.
          const { getRecipeAvailability, deductRecipeStock, computeRecipeCost } = await import("../../../../lib/recipeStock");
          const availability = await getRecipeAvailability(tx, item.productId, sale.branchId);
          if (availability.available < Number(item.quantity)) {
            const limitText = availability.limiting.map(l => `"${l.name}"`).join(", ");
            throw new Error(`Stock insuficiente para preparar "${product.name}". Solo podés preparar ${availability.available}. Falta: ${limitText}.`);
          }
          // Corregir el costo registrado (las ventas pendientes previas al fix quedaron en 0).
          const recipeCost = (await computeRecipeCost(tx, item.productId)).cost;
          await tx.saleItem.update({
            where: { id: item.id },
            data: { purchasePriceAtSale: recipeCost },
          });
          const affected = await deductRecipeStock(tx, item.productId, Number(item.quantity), sale.branchId);
          affectedIngredientIds.push(...affected);
          continue;
        }

        const { applyMovement, getBranchStock } = await import("../../../../lib/stockService");
        // Validar contra el stock de la sucursal de la venta, no contra el global.
        const available = sale.branchId
          ? ((await getBranchStock(tx, item.productId, sale.branchId)) ?? 0)
          : Number(product.quantityStock) || 0;
        if (available < Number(item.quantity)) {
          throw new Error(`Stock insuficiente para el producto "${product.name}". Disponible: ${available}, Solicitado: ${item.quantity}.`);
        }

        await applyMovement(tx, {
          productId: item.productId,
          branchId: sale.branchId ?? null,
          delta: -Number(item.quantity),
          reason: "SALE",
          refType: "Sale",
          refId: sale.id,
          note: product.name,
        });
      }

      const updatedSale = await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: 'COMPLETED' as any,
          paymentType: effectivePaymentType,
          onAccount: isAccountSale,
          ...(openRegister && { cashRegister: { connect: { id: openRegister.id } } })
        },
        include: { client: true, seller: true, items: { include: { product: true } } }
      });
      return { ...updatedSale, affectedIngredientIds };
    });

    // Fire-and-forget: encolar venta + productos vendidos en el outbox.
    try {
      const { enqueueOutbox } = await import("../../../../lib/syncOutbox");
      await enqueueOutbox("Sale", "UPSERT", String(sale.id));
      const allAffected = Array.from(new Set([
        ...sale.items.map((item: any) => item.productId),
        ...(result as any)?.affectedIngredientIds || [],
      ]));      for (const pid of allAffected) {
        await enqueueOutbox("Product", "UPSERT", String(pid));
        await enqueueOutbox("ProductBranchStock", "UPSERT", String(pid));
      }
    } catch (enqErr) {
      console.error("[Ventas] Error al encolar venta completada:", enqErr);
    }

    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof Error && (error.message.startsWith('Stock insuficiente') || error.message.startsWith('Producto con ID'))) {
      return res.status(409).json({ message: error.message });
    }
    handleApiError(res, error, "completing sale");
  }
}
