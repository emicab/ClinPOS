// pages/api/web-orders/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { isProDevice } from '../../../lib/branchIdentity';
import { applyRateLimit } from '../../../lib/rateLimit';
import { sanitizeString } from '../../../lib/sanitize';
import { resolveDbForRequest } from '../../../lib/requestDb';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      // Verificación de autenticación de dispositivo / sesión interna
      if (!(await isProDevice())) {
        return res.status(403).json({ message: 'La gestión de pedidos web requiere el Plan Pro.', blockedByPlan: true });
      }

      const orders = await prisma.webOrder.findMany({
        include: {
          items: {
            include: {
              product: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const formattedOrders = orders.map(o => ({
        ...o,
        totalAmount: o.totalAmount.toString(),
        items: o.items.map(item => ({
          ...item,
          unitPrice: item.unitPrice.toString(),
          subtotal: item.subtotal.toString(),
          product: {
            ...item.product,
            pricePurchase: item.product.pricePurchase.toString(),
            priceSale: item.product.priceSale.toString(),
          }
        }))
      }));

      res.status(200).json(formattedOrders);
    } catch (error) {
      handleApiError(res, error, "fetching web orders");
    }
  } else if (req.method === 'POST') {
    // Registra un nuevo pedido web (desde ClinStore o sincronizado)
    try {
      // Control de tasa de peticiones (Rate Limit: 20 pedidos por minuto)
      if (!applyRateLimit(req, res, 20, 60 * 1000)) {
        return;
      }

      // Resolver el negocio por slug (multi-negocio) o usar el activo.
      const db = await resolveDbForRequest(req);

      const {
        webOrderNumber,
        clientName,
        clientEmail,
        clientPhone,
        shippingAddress,
        deliveryType,
        paymentMethod,
        notes,
        items,
        branchId,
        subtotalAmount,
        discountAmount,
        deliveryFee,
        deliveryZone,
        couponCode,
        origin,
        discountBreakdown,
      } = req.body;

      if (!clientName || !clientPhone || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ message: 'Nombre, teléfono e ítems válidos son obligatorios.' });
      }

      // Sanitización de strings de entrada
      const sanitizedName = sanitizeString(clientName);
      const sanitizedEmail = clientEmail ? sanitizeString(clientEmail) : null;
      const sanitizedPhone = sanitizeString(clientPhone);
      const sanitizedAddress = shippingAddress ? sanitizeString(shippingAddress) : null;
      const sanitizedNotes = notes ? sanitizeString(notes) : null;

      const generatedNumber = webOrderNumber ? sanitizeString(webOrderNumber) : `WEB-${Date.now().toString().slice(-6)}`;

      const generateTrackingCode = (): string => {
        const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 8; i++) {
          code += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        return code;
      };

      // Si el pedido ya existe, evitar duplicados y responder 200 OK
      const existing = await db.webOrder.findFirst({
        where: { webOrderNumber: generatedNumber },
      });

      if (existing) {
        return res.status(200).json(existing);
      }

      const parsedBranchId = branchId ? parseInt(branchId) : null;

      // SEGURIDAD: Recalcular precios unitarios y subtotal server-side consultando
      // la base de datos oficial para evitar manipulación de precios desde el cliente.
      const productIds = items.map((i: any) => parseInt(i.productId)).filter(id => !isNaN(id));
      const dbProducts = await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, priceSale: true }
      });
      const productMap = new Map(dbProducts.map(p => [p.id, Number(p.priceSale)]));

      // Suma los precios extra de los modificadores seleccionados (JSON string o array).
      const modifierExtras = (raw: any): number => {
        if (!raw) return 0;
        let parsed: any[] = [];
        try {
          parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          return 0;
        }
        if (!Array.isArray(parsed)) return 0;
        return parsed.reduce((sum, m) => sum + (parseFloat(m?.priceExtra) || 0), 0);
      };

      let calculatedTotal = 0;
      const verifiedItems = [];

      for (const rawItem of items) {
        const pId = parseInt(rawItem.productId);
        const qty = parseFloat(rawItem.quantity);
        if (isNaN(pId) || isNaN(qty) || qty <= 0) continue;

        const dbPrice = productMap.get(pId);
        // Precio base desde la base oficial (fallback al enviado si el producto no existe).
        // Si el producto existe, los extras de modificadores se suman UNA vez al precio
        // (el unitPrice enviado por el cliente se ignora para evitar manipulación).
        const basePrice = dbPrice !== undefined ? dbPrice : (parseFloat(rawItem.unitPrice) || 0);
        const extras = dbPrice !== undefined ? modifierExtras(rawItem.modifiers) : 0;
        const unitPrice = basePrice + extras;
        const subtotal = qty * unitPrice;
        calculatedTotal += subtotal;

        verifiedItems.push({
          productId: pId,
          quantity: qty,
          unitPrice: unitPrice,
          subtotal: subtotal,
          modifiers: rawItem.modifiers
            ? (typeof rawItem.modifiers === 'string' ? rawItem.modifiers : JSON.stringify(rawItem.modifiers))
            : null,
        });
      }

      if (verifiedItems.length === 0) {
        return res.status(400).json({ message: 'No se encontraron productos válidos en el pedido.' });
      }

      // Por defecto, todo pedido web público inicia en estado PENDING de pago
      const newOrder = await db.webOrder.create({
        data: {
          webOrderNumber: generatedNumber,
          clientName: sanitizedName,
          clientEmail: sanitizedEmail,
          clientPhone: sanitizedPhone,
          shippingAddress: sanitizedAddress,
          deliveryType: deliveryType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
          branchId: parsedBranchId,
          paymentMethod: paymentMethod || 'CASH_ON_DELIVERY',
          paymentStatus: 'PENDING', // Se valida mediante webhook de MP o confirmación de caja
          status: 'PENDING_PREPARATION',
          totalAmount: calculatedTotal,
          subtotalAmount: !isNaN(parseFloat(subtotalAmount)) ? parseFloat(subtotalAmount) : calculatedTotal,
          discountAmount: !isNaN(parseFloat(discountAmount)) ? parseFloat(discountAmount) : 0,
          deliveryFee: !isNaN(parseFloat(deliveryFee)) ? parseFloat(deliveryFee) : 0,
          couponCode: couponCode ? sanitizeString(String(couponCode)) : null,
          discountBreakdown: discountBreakdown
            ? sanitizeString(String(discountBreakdown)).slice(0, 4000)
            : null,
          deliveryZone: deliveryZone ? sanitizeString(String(deliveryZone)) : null,
          trackingCode: generateTrackingCode(),
          origin: ["WHATSAPP", "PHONE", "IN_STORE", "OTHER"].includes(origin) ? origin : "WEB",
          notes: sanitizedNotes,
          items: {
            create: verifiedItems
          }
        },
        include: { items: { include: { product: true } } }
      });

      // Descuenta stock automáticamente
        const mainBranch = await db.branch.findFirst({ where: { isMain: true } });
      const stockBranchId = parsedBranchId ?? mainBranch?.id;
      for (const item of verifiedItems) {
        try {
          const product = await db.product.findUnique({
            where: { id: item.productId },
            select: { isRecipe: true },
          });
          if (product?.isRecipe) {
            const { deductRecipeStock } = await import("../../../lib/recipeStock");
            await deductRecipeStock(prisma, item.productId, item.quantity, stockBranchId);
          } else {
            const { applyMovement } = await import("../../../lib/stockService");
            await applyMovement(prisma, {
              productId: item.productId,
              branchId: stockBranchId ?? null,
              delta: -Number(item.quantity),
              reason: "WEB_ORDER_RESERVE",
              refType: "WebOrder",
              refId: newOrder.id,
              allowNegative: true,
            });
          }
        } catch (stkErr) {
          console.warn("Error descontando stock para item:", item, stkErr);
        }
      }

      // Encolar outbox para sync
      try {
        const { enqueueOutbox } = await import('../../../lib/syncOutbox');
        await enqueueOutbox('WebOrder', 'UPSERT', String(newOrder.id));
      } catch (enqErr) {
        console.warn('[WebOrders] Error al encolar pedido web:', enqErr);
      }

      return res.status(201).json(newOrder);
    } catch (error) {
      handleApiError(res, error, "creating web order");
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
