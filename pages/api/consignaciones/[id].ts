// pages/api/consignaciones/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { incrementStock, resolveTargetBranch } from '../../../lib/stockAdjust';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { getPaymentTypeDisplay } from '../../../lib/displayTexts';
import { getArcaConfig, createElectronicInvoice } from '../../../lib/arcaService';
import { Prisma, PaymentType } from '@prisma/client';
const Decimal = Prisma.Decimal;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query;
  const consignmentId = parseInt(String(id));

  if (isNaN(consignmentId)) {
    return res.status(400).json({ message: 'ID de consignación inválido.' });
  }

  if (req.method === 'GET') {
    try {
      const consignment = await prisma.consignment.findUnique({
        where: { id: consignmentId },
        include: {
          client: true,
          items: {
            include: {
              product: true,
            },
          },
        },
      });

      if (!consignment) {
        return res.status(404).json({ message: 'Consignación no encontrada.' });
      }

      const formatted = {
        ...consignment,
        items: consignment.items.map((i) => ({
          ...i,
          priceAtGiven: i.priceAtGiven.toString(),
          product: i.product
            ? {
                ...i.product,
                priceSale: i.product.priceSale.toString(),
                pricePurchase: i.product.pricePurchase?.toString() || null,
              }
            : null,
        })),
      };

      res.status(200).json(formatted);
    } catch (error: any) {
      handleApiError(res, error, `fetching consignment ${consignmentId}`);
    }
  } else if (req.method === 'PUT') {
    // Rendición / Arqueo de Consignación
    const { settlementItems, paymentType, sellerId, invoiceType } = req.body;

    if (!settlementItems || !Array.isArray(settlementItems) || settlementItems.length === 0) {
      return res.status(400).json({ message: 'Se requieren los ítems del arqueo.' });
    }

    try {
      const consignmentBranchId = (await resolveTargetBranch(null)).branchId;
      const result = await prisma.$transaction(async (tx) => {
        const consignment = await tx.consignment.findUnique({
          where: { id: consignmentId },
          include: { items: true },
        });

        if (!consignment) {
          throw new Error('Consignación no encontrada.');
        }

        if (consignment.status === 'SETTLED') {
          throw new Error('Esta consignación ya fue saldada previamente.');
        }

        let totalSoldAmount = new Decimal(0);
        const saleItemsToCreate: { productId: number; productName?: string | null; quantity: number; priceAtSale: Prisma.Decimal; purchasePriceAtSale: Prisma.Decimal }[] = [];

        for (const sItem of settlementItems) {
          const cItem = consignment.items.find((i) => i.id === sItem.itemId);
          if (!cItem) continue;

          const qSold = parseFloat(sItem.quantitySold || 0);
          const qReturned = parseFloat(sItem.quantityReturned || 0);

          if (qSold + qReturned > cItem.quantityGiven) {
            throw new Error(`La suma vendida (${qSold}) + devuelta (${qReturned}) excede lo entregado (${cItem.quantityGiven}).`);
          }

          // 1. Actualizar ítem de consignación
          await tx.consignmentItem.update({
            where: { id: cItem.id },
            data: {
              quantitySold: qSold,
              quantityReturned: qReturned,
            },
          });

          // 2. Reingresar productos devueltos al stock
          if (qReturned > 0) {
            await incrementStock(tx, cItem.productId, qReturned, consignmentBranchId);
          }

          // 3. Acumular venta por lo vendido
          if (qSold > 0) {
            const itemTotal = cItem.priceAtGiven.times(qSold);
            totalSoldAmount = totalSoldAmount.plus(itemTotal);

            const product = await tx.product.findUnique({ where: { id: cItem.productId } });
            saleItemsToCreate.push({
              productId: cItem.productId,
              productName: product?.name || null,
              quantity: qSold,
              priceAtSale: cItem.priceAtGiven,
              purchasePriceAtSale: product?.pricePurchase || new Decimal(0),
            });
          }
        }

        let createdSale = null;

        // 4. Generar Venta si hubo ítems vendidos
        if (totalSoldAmount.greaterThan(0)) {
          const activeSellerId = sellerId ? parseInt(sellerId) : 1;
          const openRegister = await tx.cashRegister.findFirst({ where: { status: 'OPEN' } });

          const isAccountSale = paymentType === PaymentType.ON_ACCOUNT || paymentType === 'ON_ACCOUNT';
          const effectivePaymentType = isAccountSale ? PaymentType.ON_ACCOUNT : (paymentType as PaymentType) || PaymentType.CASH;

          createdSale = await tx.sale.create({
            data: {
              saleDate: new Date(),
              totalAmount: totalSoldAmount,
              paymentType: effectivePaymentType,
              onAccount: isAccountSale,
              notes: `Rendición de Consignación #${consignment.id}`,
              clientId: consignment.clientId,
              sellerId: activeSellerId,
              status: 'COMPLETED',
              ...(openRegister && { cashRegisterId: openRegister.id }),
              items: {
                create: saleItemsToCreate.map((item) => ({
                  productId: item.productId,
                  productName: item.productName,
                  quantity: item.quantity,
                  priceAtSale: item.priceAtSale,
                  purchasePriceAtSale: item.purchasePriceAtSale,
                })),
              },
            },
          });

          // Cargar a Cuenta Corriente si corresponde
          if (isAccountSale) {
            let balanceRecord = await tx.accountBalance.findUnique({
              where: { clientId: consignment.clientId },
            });
            if (!balanceRecord) {
              balanceRecord = await tx.accountBalance.create({
                data: { clientId: consignment.clientId, balance: new Decimal(0) },
              });
            }
            await tx.accountBalance.update({
              where: { id: balanceRecord.id },
              data: { balance: { increment: totalSoldAmount } },
            });
            await tx.accountMovement.create({
              data: {
                accountBalanceId: balanceRecord.id,
                type: 'SALE_ON_ACCOUNT',
                amount: totalSoldAmount,
                description: `Venta por rendición de consignación #${consignment.id}`,
                saleId: createdSale.id,
              },
            });
          }

          // Registrar movimiento en caja si hay caja abierta y no es a cuenta corriente
          if (openRegister && !isAccountSale) {
            await tx.cashMovement.create({
              data: {
                cashRegisterId: openRegister.id,
                type: 'SALE',
                paymentType: effectivePaymentType,
                sourceId: createdSale.id,
                amount: totalSoldAmount,
                description: `Rendición Consignación #${consignment.id} - ${getPaymentTypeDisplay(effectivePaymentType)}`,
              },
            });
          }
        }

        // 5. Marcar consignación como SALDADA
        const updatedConsignment = await tx.consignment.update({
          where: { id: consignmentId },
          data: {
            status: 'SETTLED',
          },
          include: {
            client: true,
            items: {
              include: {
                product: true,
              },
            },
          },
        });

        return { consignment: updatedConsignment, sale: createdSale };
      });

      // Intentar generar factura electrónica si está activada y el usuario solicitó facturación
      let invoice = null;
      let arcaError = null;

      if (result.sale && invoiceType && invoiceType !== 'NONE') {
        try {
          const arcaConfig = await getArcaConfig();
          if (arcaConfig.enabled) {
            const client = result.consignment.client;
            const clientCuit = client?.cuit || undefined;
            const clientName = client ? `${client.firstName} ${client.lastName || ''}`.trim() : undefined;
            invoice = await createElectronicInvoice(
              result.sale.id,
              invoiceType as any,
              clientCuit,
              clientName
            );
          }
        } catch (err: any) {
          console.error('Error al generar factura electrónica en rendición de consignación:', err);
          arcaError = err.message || 'No se pudo generar la factura electrónica con ARCA/AFIP.';
        }
      }

      res.status(200).json({
        ...result,
        invoice,
        arcaError,
      });
    } catch (error: any) {
      handleApiError(res, error, `settling consignment ${consignmentId}`);
    }
  } else if (req.method === 'DELETE') {
    // Cancelar consignación y devolver todo a stock
    try {
      const consignmentBranchId = (await resolveTargetBranch(null)).branchId;
      await prisma.$transaction(async (tx) => {
        const consignment = await tx.consignment.findUnique({
          where: { id: consignmentId },
          include: { items: true },
        });

        if (!consignment) {
          throw new Error('Consignación no encontrada.');
        }

        if (consignment.status === 'SETTLED') {
          throw new Error('No se puede cancelar una consignación ya saldada.');
        }

        // Devolver lo no rendido al stock
        for (const item of consignment.items) {
          const pendingQty = item.quantityGiven - item.quantityReturned - item.quantitySold;
          if (pendingQty > 0) {
            await incrementStock(tx, item.productId, pendingQty, consignmentBranchId);
          }
        }

        await tx.consignment.update({
          where: { id: consignmentId },
          data: { status: 'CANCELLED' },
        });
      });

      res.status(200).json({ message: 'Consignación cancelada y stock devuelto exitosamente.' });
    } catch (error: any) {
      handleApiError(res, error, `cancelling consignment ${consignmentId}`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
