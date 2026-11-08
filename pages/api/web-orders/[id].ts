import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/lib/prisma";
import { PaymentType } from "@prisma/client";
import { isProDevice } from "@/lib/branchIdentity";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query;
  const orderId = Number(id);

  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ message: "ID de pedido inválido." });
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    try {
      // La gestión de pedidos web es exclusiva del Plan Pro.
      if (!(await isProDevice())) {
        return res.status(403).json({ message: "La gestión de pedidos web requiere el Plan Pro.", blockedByPlan: true });
      }
      const { status, paymentStatus, notes, branchId } = req.body;

      const currentOrder = await prisma.webOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!currentOrder) {
        return res.status(404).json({ message: "Pedido web no encontrado." });
      }

      // Gate de pago (Regla del POS): no se prepara un pedido pagado con
      // Mercado Pago hasta que el pago esté confirmado (PAID), salvo que la
      // tienda haya desactivado requireMpForDelivery. Se aplica al avanzar de
      // PENDING_PREPARATION (el paso que dispara la preparación en cocina).
      const isStartingPreparation =
        status === "READY_FOR_PICKUP" &&
        currentOrder.status === "PENDING_PREPARATION";
      if (
        isStartingPreparation &&
        (currentOrder.paymentMethod || "").toUpperCase().includes("MERCADO") &&
        currentOrder.paymentStatus !== "PAID"
      ) {
        const storeConfig = await prisma.storeConfig.findFirst();
        const requirePayingFirst =
          storeConfig?.requireMpForDelivery !== false;
        if (requirePayingFirst) {
          return res.status(409).json({
            message:
              "Este pedido está pendiente de pago (Mercado Pago). Esperá la confirmación del pago antes de prepararlo.",
            blockedByPayment: true,
          });
        }
      }

      // Elaborados (Recetario): el stock se reserva/repone por ingredientes.
      const orderItemIds = currentOrder.items.map((i) => i.productId);
      const recipeIds = new Set<number>(
        (await prisma.product.findMany({
          where: { id: { in: orderItemIds }, isRecipe: true },
          select: { id: true },
        })).map((p: any) => p.id),
      );

      const isDelivered = status === "DELIVERED";
      const isCancelling = status === "CANCELLED" && currentOrder.status !== "CANCELLED";
      const isUncancelling = status && status !== "CANCELLED" && currentOrder.status === "CANCELLED";
      const isAlreadyRegistered = (currentOrder.notes || "").includes("[VENTA_REGISTRADA#");

      // Asignación de sucursal de despacho (DELIVERY). Al asignar se "mueve" la
      // reserva: se devuelve el stock a la sucursal que lo tenía (branchId actual
      // o la principal como reserva provisoria) y se reserva en la nueva.
      const newBranchId = branchId ? Number(branchId) : null;
      const isAssigningBranch =
        newBranchId !== null &&
        newBranchId !== currentOrder.branchId &&
        currentOrder.status !== "CANCELLED";

      // Sucursal principal (usada como reserva provisoria de los DELIVERY sin asignar)
      const mainBranch = await prisma.branch.findFirst({ where: { isMain: true } });
      const mainBranchId = mainBranch?.id;

      // Sucursal efectiva para reposición/venta: la asignada, o la principal como
      // reserva provisoria de los DELIVERY sin asignar.
      const effectiveBranchId = currentOrder.branchId ?? newBranchId ?? mainBranchId;

      let createdSaleId: number | null = null;
      let resolvedNotes = notes !== undefined ? notes : currentOrder.notes || "";

      // Preparar datos para delivery (lecturas, fuera de la transacción)
      let mappedPaymentType: PaymentType = PaymentType.OTHER;
      let seller: any = { id: 1 };
      let openRegister: any = null;
      let saleItemsData: any[] = [];

      if (isDelivered && !isAlreadyRegistered) {
        const pm = (currentOrder.paymentMethod || "").toUpperCase();
        if (pm.includes("MERCADO") || pm.includes("MP")) {
          mappedPaymentType = (PaymentType as any).MERCADO_PAGO || PaymentType.OTHER;
        } else if (pm.includes("TRANSFER")) {
          mappedPaymentType = PaymentType.TRANSFER;
        } else if (pm.includes("CASH") || pm.includes("EFECTIVO")) {
          mappedPaymentType = PaymentType.CASH;
        } else if (pm.includes("CARD") || pm.includes("TARJETA")) {
          mappedPaymentType = PaymentType.CARD;
        }

        seller = (await prisma.seller.findFirst({ where: { isActive: true } })) || { id: 1 };
        openRegister = await prisma.cashRegister.findFirst({ where: { status: "OPEN" } });

        const itemProductIds = currentOrder.items.map((i) => i.productId);
        const dbProducts = await prisma.product.findMany({
          where: { id: { in: itemProductIds } },
        });
        const productsMap = new Map<number, any>();
        dbProducts.forEach((p) => productsMap.set(p.id, p));

        saleItemsData = await Promise.all(
          currentOrder.items.map(async (item) => {
            const prod = productsMap.get(item.productId);
            let purchasePriceAtSale: any = prod ? prod.pricePurchase : 0;
            if (prod?.isRecipe) {
              const { computeRecipeCost } = await import("../../../lib/recipeStock");
              purchasePriceAtSale = (await computeRecipeCost(prisma, item.productId)).cost;
            }
            return {
              productId: item.productId,
              productName: prod?.name || null,
              quantity: item.quantity,
              priceAtSale: item.unitPrice,
              purchasePriceAtSale,
            };
          }),
        );
      }

      // Reembolso MP si se cancela un pedido pagado
      if (isCancelling && currentOrder.paymentMethod === "MERCADO_PAGO" && currentOrder.paymentStatus === "PAID") {
        try {
          const storeConfig = await prisma.storeConfig.findFirst();
          const mpTokenConfig = await prisma.setting.findUnique({ where: { key: "mercadopago_access_token" } });
          const accessToken =
            storeConfig?.mpAccessToken ||
            mpTokenConfig?.value ||
            "";

          if (accessToken) {
            const searchRes = await fetch(
              `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(currentOrder.webOrderNumber)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              const payment = searchData.results?.[0];
              if (payment?.id) {
                const refundRes = await fetch(
                  `https://api.mercadopago.com/v1/payments/${payment.id}/refunds`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${accessToken}`,
                      "Content-Type": "application/json"
                    }
                  }
                );
                if (refundRes.ok) {
                  console.log(`[MP Refund] Reembolso exitoso del pago ${payment.id} para orden ${currentOrder.webOrderNumber}`);
                } else {
                  const refundError = await refundRes.text();
                  console.warn(`[MP Refund] Error al reembolsar pago ${payment.id}:`, refundError);
                }
              }
            }
          }
        } catch (err) {
          console.warn("[MP Refund] Error en proceso de reembolso:", err);
        }
      }

      // Transacción atómica: stock + venta + status update
      // Sucursal que hoy "sostiene" la reserva de stock del pedido.
      const currentReserveBranchId = currentOrder.branchId ?? mainBranchId;

      await prisma.$transaction(async (tx) => {
        // Asignación de sucursal (DELIVERY): mover la reserva de la sucursal que
        // la tenía (branchId actual o principal) hacia la nueva sucursal.
        if (isAssigningBranch && newBranchId) {
          const targetBranch = await tx.branch.findUnique({ where: { id: newBranchId } });
          if (!targetBranch) {
            throw new Error("La sucursal seleccionada no existe.");
          }
          for (const item of currentOrder.items) {
            const qty = Number(item.quantity);
            if (recipeIds.has(item.productId)) {
              const { restoreRecipeStock, deductRecipeStock } = await import("../../../lib/recipeStock");
              if (currentReserveBranchId && currentReserveBranchId !== newBranchId) {
                await restoreRecipeStock(tx, item.productId, qty, currentReserveBranchId);
              }
              await deductRecipeStock(tx, item.productId, qty, newBranchId);
              continue;
            }
            if (currentReserveBranchId && currentReserveBranchId !== newBranchId) {
              // Devolver la reserva provisoria a la sucursal que la tenía
              const { applyMovement } = await import("../../../lib/stockService");
              await applyMovement(tx, {
                productId: item.productId,
                branchId: currentReserveBranchId,
                delta: qty,
                reason: "WEB_ORDER_MOVE_OUT",
                refType: "WebOrder",
                refId: currentOrder.id,
              });
            }
            // Reservar en la nueva sucursal de despacho
            const { applyMovement } = await import("../../../lib/stockService");
            await applyMovement(tx, {
              productId: item.productId,
              branchId: newBranchId,
              delta: -qty,
              reason: "WEB_ORDER_MOVE_IN",
              refType: "WebOrder",
              refId: currentOrder.id,
              allowNegative: true,
            });
          }
        }

        // Stock: reponer al cancelar, descontar al des-cancelar
        // (global + sucursal que sostiene la reserva: branchId o principal).
        if (isCancelling) {
          for (const item of currentOrder.items) {
            if (recipeIds.has(item.productId)) {
              const { restoreRecipeStock } = await import("../../../lib/recipeStock");
              await restoreRecipeStock(tx, item.productId, Number(item.quantity), currentReserveBranchId);
              continue;
            }
            const { applyMovement } = await import("../../../lib/stockService");
            await applyMovement(tx, {
              productId: item.productId,
              branchId: currentReserveBranchId ?? null,
              delta: Number(item.quantity),
              reason: "WEB_ORDER_CANCEL",
              refType: "WebOrder",
              refId: currentOrder.id,
            });
          }
        } else if (isUncancelling) {
          for (const item of currentOrder.items) {
            if (recipeIds.has(item.productId)) {
              const { deductRecipeStock } = await import("../../../lib/recipeStock");
              await deductRecipeStock(tx, item.productId, Number(item.quantity), currentReserveBranchId);
              continue;
            }
            const { applyMovement } = await import("../../../lib/stockService");
            await applyMovement(tx, {
              productId: item.productId,
              branchId: currentReserveBranchId ?? null,
              delta: -Number(item.quantity),
              reason: "WEB_ORDER_RESTORE",
              refType: "WebOrder",
              refId: currentOrder.id,
              allowNegative: true,
            });
          }
        }

        // Venta + movimiento de caja si se entrega (atribuida a la sucursal de despacho)
        if (isDelivered && !isAlreadyRegistered) {
          const sale = await tx.sale.create({
            data: {
              saleDate: new Date(),
              totalAmount: currentOrder.totalAmount,
              paymentType: mappedPaymentType,
              notes: `Pedido Web #${currentOrder.webOrderNumber} (${currentOrder.clientName})`,
              sellerId: seller.id,
              ...(openRegister && { cashRegisterId: openRegister.id }),
              ...(effectiveBranchId && { branchId: effectiveBranchId }),
              status: "COMPLETED",
              items: { create: saleItemsData },
            },
          });

          createdSaleId = sale.id;

          if (openRegister) {
            await tx.cashMovement.create({
              data: {
                cashRegisterId: openRegister.id,
                type: "SALE",
                paymentType: mappedPaymentType,
                sourceId: sale.id,
                amount: currentOrder.totalAmount,
                description: `Pedido Web #${currentOrder.webOrderNumber} (${currentOrder.clientName})`,
              },
            });

            if (mappedPaymentType === PaymentType.MERCADO_PAGO && Number(currentOrder.mpFeeAmount) > 0) {
              await tx.cashMovement.create({
                data: {
                  cashRegisterId: openRegister.id,
                  type: "EXPENSE",
                  paymentType: "MERCADO_PAGO",
                  sourceId: sale.id,
                  amount: -Number(currentOrder.mpFeeAmount),
                  description: `Comisión MP Pedido Web #${currentOrder.webOrderNumber}`,
                },
              });
            }
          }

          resolvedNotes = `${resolvedNotes} [VENTA_REGISTRADA#${sale.id}]`.trim();
        }

        // Status update
        const updateData: any = { notes: resolvedNotes };
        if (status) updateData.status = status;
        if (paymentStatus) updateData.paymentStatus = paymentStatus;
        if (isAssigningBranch && newBranchId) updateData.branchId = newBranchId;
        if (isDelivered && !isAlreadyRegistered) updateData.paymentStatus = "PAID";
        // Al cancelar/entregar se resuelve la revisión (Regla de Oro).
        if (status === "CANCELLED" || status === "DELIVERED") {
          updateData.stockReviewAt = null;
          updateData.stockReviewNote = null;
        }

        await tx.webOrder.update({
          where: { id: orderId },
          data: updateData,
        });
      });

      // Fire-and-forget: encolar el pedido web + productos en el outbox.
      try {
        const { enqueueOutbox } = await import("../../../lib/syncOutbox");
        await enqueueOutbox("WebOrder", "UPSERT", String(orderId));
        for (const item of currentOrder.items) {
          await enqueueOutbox("Product", "UPSERT", String(item.productId));
          await enqueueOutbox("ProductBranchStock", "UPSERT", String(item.productId));
        }
      } catch (enqErr) {
        console.warn("Error al encolar pedido web actualizado:", enqErr);
      }

      // Sync PUNTUAL del pedido a la nube: el tracking público que ve el
      // cliente lee de Supabase, y el sync completo tarda hasta 5 min. Subir
      // este pedido ahora evita que el cambio de estado se refleje recién en el
      // próximo ciclo. Fire-and-forget: no bloquea la respuesta.
      if (status || paymentStatus) {
        try {
          const { syncWebOrderToSupabase } = await import("../../../lib/syncService");
          syncWebOrderToSupabase(orderId).catch((syncErr: any) =>
            console.warn("Error en sync puntual del pedido web:", syncErr?.message || syncErr)
          );
        } catch (syncErr) {
          console.warn("No se pudo disparar el sync puntual del pedido web:", syncErr);
        }
      }

      const updatedOrder = await prisma.webOrder.findUnique({
        where: { id: orderId },
        include: { items: { include: { product: true } } },
      });

      if (!updatedOrder) {
        return res.status(500).json({ message: "No se pudo obtener el pedido actualizado." });
      }

      return res.status(200).json({
        ...updatedOrder,
        totalAmount: updatedOrder.totalAmount.toString(),
        saleId: createdSaleId,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Error al actualizar pedido web." });
    }
  }

  res.setHeader("Allow", ["PUT", "PATCH"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
