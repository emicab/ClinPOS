import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma, PaymentType } from '@prisma/client';
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';
import { getArcaConfig, createElectronicInvoice } from '../../../lib/arcaService';
import { getPaymentTypeDisplay } from '../../../lib/displayTexts';
import { getDeviceBranchId } from '../../../lib/branchIdentity';

interface SaleItemInput {
  productId: number;
  quantity: number;
  priceAtSale: number;
}

interface PromoAppliedInput {
  promotionId: number;
  name: string;
  type: string;
  discountAmount: number;
}

interface CreateSaleInput {
  clientId?: number;
  sellerId: number;
  paymentType: PaymentType;
  notes?: string;
  items: SaleItemInput[];
  discountCodeApplied?: string;
  promotionsApplied?: PromoAppliedInput[];
  paymentMethodDiscount?: number;
  onAccount?: boolean;
  invoiceType?: 'A' | 'B' | 'C' | 'NONE';
  clientCuit?: string;
  clientName?: string;
  creditCardPromotionId?: number | null;
  status?: 'COMPLETED' | 'PENDING';
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    const { clientId, sellerId, from, to, sort } = req.query; 

    const whereClause: Prisma.SaleWhereInput = {}; 

    if (clientId && typeof clientId === 'string') {
      const parsedClientId = parseInt(clientId);
      if (!isNaN(parsedClientId)) {
        whereClause.clientId = parsedClientId;
      } else {
        return res.status(400).json({ message: 'clientId inválido.' });
      }
    }

    if (sellerId && typeof sellerId === 'string') {
      const parsedSellerId = parseInt(sellerId);
      if (!isNaN(parsedSellerId)) {
        whereClause.sellerId = parsedSellerId;
      } else {
        return res.status(400).json({ message: 'sellerId inválido.' });
      }
    }

    const dateFilter: Prisma.DateTimeFilter = {};
    if (typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      const [y, m, d] = from.split('-').map(Number);
      dateFilter.gte = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + 3 * 60 * 60 * 1000);
    }
    if (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const [y, m, d] = to.split('-').map(Number);
      dateFilter.lte = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) + 3 * 60 * 60 * 1000);
    }
    if (Object.keys(dateFilter).length > 0) {
      whereClause.saleDate = dateFilter;
    }

    const sortOrder: 'asc' | 'desc' = sort === 'asc' ? 'asc' : 'desc';

    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string) || 50, 100) : 50;
    const skip = page ? (page - 1) * limit : undefined;

    try {
      const [sales, total] = await Promise.all([
        prisma.sale.findMany({
          where: whereClause,
          include: {
            client: true,
            seller: true,
            cashRegister: true,
            items: {
              include: {
                product: true,
              },
            },
          },
          orderBy: { saleDate: sortOrder },
          ...(skip !== undefined && { skip, take: limit }),
        }),
        prisma.sale.count({ where: whereClause }),
      ]);

      const salesForJson = sales.map(sale => ({
        ...sale,
        totalAmount: sale.totalAmount.toString(),
        items: sale.items.map(item => ({
          ...item,
          priceAtSale: item.priceAtSale.toString(),
          product: item.product ? { 
            ...item.product,
            pricePurchase: item.product.pricePurchase?.toString() || null,
            priceSale: item.product.priceSale.toString(),
          } : null
        }))
      }));

      if (page !== undefined) {
        res.status(200).json({
          data: salesForJson,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          }
        });
      } else {
        res.status(200).json(salesForJson);
      }
    } catch (error) {
      handleApiError(res, error, "fetching sales");
    }
  } else if (req.method === 'POST') {
    const { clientId, sellerId, paymentType, items, promotionsApplied, paymentMethodDiscount, invoiceType, clientCuit, clientName, creditCardPromotionId } = req.body as CreateSaleInput;
    let { notes, discountCodeApplied } = req.body as CreateSaleInput;

    if (!sellerId || !paymentType || !items || items.length === 0) {
      return res.status(400).json({ message: 'Faltan datos obligatorios: vendedor, tipo de pago o ítems.' });
    }
    if (!Object.values(PaymentType).includes(paymentType)) {
        return res.status(400).json({ message: 'Tipo de pago inválido.' });
    }
    if ((paymentType === PaymentType.ON_ACCOUNT || req.body.onAccount === true) && !clientId) {
        return res.status(400).json({ message: 'Para registrar una venta en cuenta corriente se requiere seleccionar un cliente.' });
    }

    if (notes) notes = sanitizeString(notes);
    if (discountCodeApplied) discountCodeApplied = sanitizeString(discountCodeApplied);

    let calculatedTotalAmount = new Decimal(0);
    for (const item of items) {
      if (item.quantity <= 0 || item.priceAtSale < 0) {
        return res.status(400).json({ message: `Cantidad o precio inválido para el producto ID ${item.productId}.` });
      }
      calculatedTotalAmount = calculatedTotalAmount.plus(new Decimal(item.priceAtSale).times(item.quantity));
    }
    
    let discountPercent = 0;
    let discountCodeRecord: any = null;
    if (discountCodeApplied) {
      const codeUpper = discountCodeApplied.toUpperCase().trim();
      try {
        discountCodeRecord = await prisma.discountCode.findUnique({
          where: { code: codeUpper }
        });
      } catch {
        // Ignorar error si no está sincronizado
      }
      
      if (!discountCodeRecord) {
        return res.status(400).json({ message: `El código de descuento "${discountCodeApplied}" no existe.` });
      }
      if (!discountCodeRecord.isActive) {
        return res.status(400).json({ message: `El código de descuento "${discountCodeApplied}" está inactivo.` });
      }
      
      const now = new Date();
      if (discountCodeRecord.validFrom && now < new Date(discountCodeRecord.validFrom)) {
        return res.status(400).json({ message: `El código de descuento "${discountCodeApplied}" aún no es válido.` });
      }
      if (discountCodeRecord.validUntil && now > new Date(discountCodeRecord.validUntil)) {
        return res.status(400).json({ message: `El código de descuento "${discountCodeApplied}" ha expirado.` });
      }
      if (discountCodeRecord.maxUses !== null && discountCodeRecord.currentUses >= discountCodeRecord.maxUses) {
        return res.status(400).json({ message: `El código de descuento "${discountCodeApplied}" ha alcanzado su límite de usos.` });
      }
      
      discountPercent = parseFloat(discountCodeRecord.discountPercent.toString());
    }

    let promotionsAppliedJson: string | null = null;
    if (promotionsApplied && Array.isArray(promotionsApplied) && promotionsApplied.length > 0) {
      for (const promo of promotionsApplied) {
        if (promo.type === 'COMBO') continue;

        const promoRecord = await prisma.promotion.findUnique({ where: { id: promo.promotionId } });
        if (!promoRecord || promoRecord.status !== 'ACTIVE') {
          return res.status(400).json({ message: `La promoción "${promo.name}" no está activa o no existe.` });
        }
        const now = new Date();
        if (promoRecord.startDate && now < promoRecord.startDate) {
          return res.status(400).json({ message: `La promoción "${promo.name}" aún no es válida.` });
        }
        if (promoRecord.endDate && now > promoRecord.endDate) {
          return res.status(400).json({ message: `La promoción "${promo.name}" ha expirado.` });
        }
      }

      let totalPromoDiscount = new Decimal(0);
      for (const promo of promotionsApplied) {
        totalPromoDiscount = totalPromoDiscount.plus(new Decimal(promo.discountAmount));
      }
      calculatedTotalAmount = calculatedTotalAmount.minus(totalPromoDiscount);
      if (calculatedTotalAmount.lessThan(0)) {
        calculatedTotalAmount = new Decimal(0);
      }

      promotionsAppliedJson = JSON.stringify(promotionsApplied);
    }

    if (discountCodeRecord) {
      const minPurchaseVal = discountCodeRecord.minPurchase ? parseFloat(discountCodeRecord.minPurchase.toString()) : 0;
      if (minPurchaseVal > 0 && calculatedTotalAmount.lessThan(minPurchaseVal)) {
        return res.status(400).json({
          message: `El código "${discountCodeApplied}" requiere una compra mínima de $${minPurchaseVal.toLocaleString('es-AR')}.`
        });
      }

      const discType = discountCodeRecord.discountType || "PERCENTAGE";
      const discVal = discountCodeRecord.discountValue !== null && discountCodeRecord.discountValue !== undefined
        ? parseFloat(discountCodeRecord.discountValue.toString())
        : parseFloat(discountCodeRecord.discountPercent.toString());

      if (discType === "FIXED_AMOUNT") {
        const discountAmount = Decimal.min(calculatedTotalAmount, new Decimal(discVal));
        calculatedTotalAmount = calculatedTotalAmount.minus(discountAmount);
      } else {
        const discountAmount = calculatedTotalAmount.times(discVal).div(100);
        calculatedTotalAmount = calculatedTotalAmount.minus(discountAmount);
      }
    }

    const paymentMethodDiscountDecimal = new Decimal(paymentMethodDiscount || 0);
    if (paymentMethodDiscountDecimal.greaterThan(0)) {
      calculatedTotalAmount = calculatedTotalAmount.minus(paymentMethodDiscountDecimal);
      if (calculatedTotalAmount.lessThan(0)) {
        calculatedTotalAmount = new Decimal(0);
      }
    }

    try {
      const seller = await prisma.seller.findUnique({ where: { id: Number(sellerId) }, select: { id: true } });
      if (!seller) {
        return res.status(400).json({ message: "El vendedor seleccionado ya no existe. Actualizá la lista de vendedores." });
      }

      // Sucursal efectiva: solicitada > sucursal de esta PC > principal
      let effectiveBranchId: number | undefined;
      if (req.body.branchId && !isNaN(parseInt(req.body.branchId))) {
        const requestedBranch = await prisma.branch.findUnique({ where: { id: parseInt(req.body.branchId) } });
        if (requestedBranch) effectiveBranchId = requestedBranch.id;
      }
      if (!effectiveBranchId) {
        const deviceBranchId = await getDeviceBranchId();
        if (deviceBranchId) {
          const deviceBranch = await prisma.branch.findUnique({ where: { id: deviceBranchId } });
          if (deviceBranch) effectiveBranchId = deviceBranch.id;
        }
      }
      if (!effectiveBranchId) {
        const mainBranch = await prisma.branch.findFirst({ where: { isMain: true } });
        if (mainBranch) effectiveBranchId = mainBranch.id;
      }

      const affectedIngredientIds: number[] = [];
      const result = await prisma.$transaction(async (tx) => {
        if (discountCodeRecord) {
          await tx.discountCode.update({
            where: { id: discountCodeRecord.id },
            data: { currentUses: { increment: 1 } }
          });
        }

        const openRegister = await tx.cashRegister.findFirst({ where: { status: 'OPEN' } });

        const isAccountSale = paymentType === PaymentType.ON_ACCOUNT || req.body.onAccount === true;
        const effectivePaymentType = isAccountSale ? PaymentType.ON_ACCOUNT : paymentType;

        const newSale = await tx.sale.create({
          data: {
            saleDate: new Date(),
            totalAmount: calculatedTotalAmount,
            paymentType: effectivePaymentType,
            onAccount: isAccountSale,
            notes: notes || null,
            discountCodeApplied: discountCodeApplied || null,
            promotionsApplied: promotionsAppliedJson,
            ...(creditCardPromotionId && { creditCardPromotion: { connect: { id: creditCardPromotionId } } }),
            ...(clientId && { client: { connect: { id: clientId } } }),
            seller: { connect: { id: sellerId } },
            ...(openRegister && { cashRegister: { connect: { id: openRegister.id } } }),
            ...(effectiveBranchId ? { branch: { connect: { id: effectiveBranchId } } } : {}),
            status: (req.body.status === 'PENDING' ? 'PENDING' : 'COMPLETED') as any,
          },
        });

        const isPending = req.body.status === 'PENDING';

        if (!isPending && isAccountSale && clientId) {
          let balanceRecord = await tx.accountBalance.findUnique({
            where: { clientId },
          });
          if (!balanceRecord) {
            balanceRecord = await tx.accountBalance.create({
              data: { clientId, balance: new Decimal(0) },
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
              description: `Venta en cuenta #${newSale.id}`,
              saleId: newSale.id,
            },
          });
        }

        if (!isPending && openRegister) {
          const cashAmount = paymentType === 'CASH' ? calculatedTotalAmount : new Decimal(0);
          const otherAmount = paymentType !== 'CASH' ? calculatedTotalAmount : new Decimal(0);
          if (cashAmount.greaterThan(0)) {
            await tx.cashMovement.create({
              data: {
                cashRegisterId: openRegister.id,
                type: 'SALE',
                paymentType: paymentType,
                sourceId: newSale.id,
                amount: cashAmount,
                description: `Venta #${newSale.id} - Efectivo`,
              },
            });
          }
          if (otherAmount.greaterThan(0)) {
            await tx.cashMovement.create({
              data: {
                cashRegisterId: openRegister.id,
                type: 'SALE',
                paymentType: paymentType,
                sourceId: newSale.id,
                amount: otherAmount,
                description: `Venta #${newSale.id} - ${getPaymentTypeDisplay(paymentType)}`,
              },
            });
          }
        }

        // Chequeo COMBINADO de ingredientes. El stock derivado por elaborado es
        // correcto por tipo pero NO sumable entre variantes que comparten
        // ingredientes (ej. 2A + 2B puede superar la harina disponible).
        if (!isPending) {
          const { computeOrderIngredientShortfall, formatIngredientShortfall } = await import("../../../lib/recipeStock");
          const combinedBranchId = effectiveBranchId ?? (req.body.branchId ? parseInt(req.body.branchId) : undefined);
          const shortfalls = await computeOrderIngredientShortfall(
            tx,
            items,
            combinedBranchId && !isNaN(combinedBranchId) ? combinedBranchId : undefined,
          );
          if (shortfalls.length > 0) {
            throw new Error(
              `Stock insuficiente de ingredientes para completar la venta: ${shortfalls.map(formatIngredientShortfall).join('; ')}. Reducí cantidades o reponé stock.`,
            );
          }
        }

        for (const item of items) {          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (!product) {
            throw new Error(`Producto con ID ${item.productId} no encontrado.`);
          }

          const bId = effectiveBranchId ?? (req.body.branchId ? parseInt(req.body.branchId) : undefined);
          const recipeBranchId = bId && !isNaN(bId) ? bId : undefined;
          const isRecipeProduct = product.isRecipe === true;

          // Validación de stock de productos simples. Los elaborados ya se
          // validaron de forma combinada contra los ingredientes (antes del loop).
          if (!isPending && !isRecipeProduct && Number(product.quantityStock) < item.quantity) {
            throw new Error(`Stock insuficiente para el producto "${product.name}". Disponible: ${product.quantityStock}, Solicitado: ${item.quantity}.`);
          }

          let purchasePriceAtSale = product.pricePurchase;
          if (!purchasePriceAtSale || purchasePriceAtSale.equals(0)) {
            const lastPurchase = await tx.purchaseItem.findFirst({
              where: { productId: item.productId },
              orderBy: { id: 'desc' },
              select: { purchasePrice: true },
            });
            if (lastPurchase) {
              purchasePriceAtSale = lastPurchase.purchasePrice;
            }
          }

          // Elaborado: el costo se calcula desde sus ingredientes (Σ costo × cantidad).
          if (isRecipeProduct) {
            const { computeRecipeCost } = await import("../../../lib/recipeStock");
            purchasePriceAtSale = (await computeRecipeCost(tx, item.productId)).cost;
          }

          await tx.saleItem.create({
            data: {
              saleId: newSale.id,
              productId: item.productId,
              productName: product.name,
              quantity: item.quantity,
              priceAtSale: new Decimal(item.priceAtSale),
              purchasePriceAtSale: purchasePriceAtSale || new Decimal(0),
            },
          });

          if (!isPending) {
            if (isRecipeProduct) {
              // Elaborado: no se descuenta su propio stock, sino el de los ingredientes.
              const { deductRecipeStock } = await import("../../../lib/recipeStock");
              const affected = await deductRecipeStock(tx, item.productId, item.quantity, recipeBranchId);
              affectedIngredientIds.push(...affected);
            } else {
              const updateResult = await tx.product.updateMany({
                where: {
                  id: item.productId,
                  quantityStock: { gte: item.quantity }
                },
                data: {
                  quantityStock: { decrement: item.quantity }
                }
              });
              if (updateResult.count === 0) {
                throw new Error(`Stock insuficiente o modificado concurrentemente para el producto "${product.name}".`);
              }

              if (recipeBranchId) {
                await tx.productBranchStock.upsert({
                  where: {
                    productId_branchId: {
                      productId: item.productId,
                      branchId: recipeBranchId
                    }
                  },
                  update: {
                    quantityStock: { decrement: item.quantity }
                  },
                  create: {
                    productId: item.productId,
                    branchId: recipeBranchId,
                    quantityStock: -item.quantity
                  }
                });
              }
            }
          }

          if (!isPending) {
            if (isRecipeProduct) {
              // Alerta de elaborado: comparar la disponibilidad derivada contra el mínimo.
              const { getRecipeAvailability } = await import("../../../lib/recipeStock");
              const afterAvailability = await getRecipeAvailability(tx, item.productId, recipeBranchId);
              if (product.stockMinAlert !== null && afterAvailability.available < product.stockMinAlert) {
                console.warn(`[STOCK ALERT] El producto elaborado "${product.name}" (ID: ${product.id}) quedó con disponibilidad ${afterAvailability.available} por debajo del mínimo (${product.stockMinAlert}).`);
              }
            } else {
              const updatedProduct = await tx.product.findUnique({
                where: { id: item.productId },
                select: { id: true, name: true, quantityStock: true, stockMinAlert: true }
              });
              if (updatedProduct && updatedProduct.stockMinAlert !== null && updatedProduct.quantityStock < updatedProduct.stockMinAlert) {
                console.warn(`[STOCK ALERT] El producto "${updatedProduct.name}" (ID: ${updatedProduct.id}) ha quedado por debajo del mínimo de alerta de stock (${updatedProduct.stockMinAlert}). Stock actual: ${updatedProduct.quantityStock}`);
                console.log(`[MOCK EMAIL] Enviado correo ficticio a: administracion@empresa.com | Asunto: Alerta de Stock Mínimo - ${updatedProduct.name} | Contenido: El producto "${updatedProduct.name}" tiene ${updatedProduct.quantityStock} unidades disponibles (Umbral mínimo: ${updatedProduct.stockMinAlert}).`);
              }
            }
          }
        }
        return tx.sale.findUnique({
            where: { id: newSale.id },
            include: { client: true, seller: true, items: { include: { product: true } } }
        });
      });

      let invoice = null;
      let arcaError = null;

      try {
        const arcaConfig = await getArcaConfig();
        if (req.body.status !== 'PENDING' && arcaConfig.enabled && invoiceType && invoiceType !== 'NONE') {
          invoice = await createElectronicInvoice(
            result!.id,
            invoiceType as any,
            clientCuit,
            clientName
          );
        }
      } catch (err: any) {
        console.error("Error al generar factura electrónica al cerrar venta:", err);
        arcaError = err.message || "No se pudo comunicar con ARCA.";
      }

      // [MODIFICADO] Fire-and-forget: encolar venta + productos vendidos en el
      // outbox. El sync a la nube lo hace el auto-sync/drain sin bloquear la venta.
      try {
        const { enqueueOutbox, enqueueStockMovement } = await import("../../../lib/syncOutbox");
        if (result?.id) {
          await enqueueOutbox("Sale", "UPSERT", String(result.id));
        }
        const productIds = items.map((item: any) => item.productId);
        if (result?.id && req.body.status !== 'PENDING') {
          for (const [index, item] of items.entries()) {
            const product = await prisma.product.findUnique({
              where: { id: item.productId },
              select: { isRecipe: true },
            });
            // Los elaborados descuentan ingredientes; esos movimientos se
            // incorporan en una etapa específica del recetario.
            if (!product?.isRecipe) {
              await enqueueStockMovement({
                operationId: `sale:${result.id}:item:${index}`,
                productId: item.productId,
                delta: -Number(item.quantity),
                branchId: effectiveBranchId ?? null,
              });
            }
          }
        }
        const allAffected = Array.from(new Set([...productIds, ...affectedIngredientIds]));
        for (const pid of allAffected) {
          await enqueueOutbox("Product", "UPSERT", String(pid));
          await enqueueOutbox("ProductBranchStock", "UPSERT", String(pid));
        }
      } catch (enqErr) {
        console.error("[Ventas] Error al encolar venta:", enqErr);
      }

      res.status(201).json({
        ...result,
        invoice,
        arcaError
      });

    } catch (error: any) {
      if (error instanceof Error && (error.message.startsWith('Stock insuficiente') || error.message.startsWith('Producto con ID'))) {
        return res.status(409).json({ message: error.message });
      }
      handleApiError(res, error, "creating sale");
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
