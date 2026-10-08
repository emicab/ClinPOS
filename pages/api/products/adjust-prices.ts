import { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/lib/prisma";
import { buildBulkProductWhere } from '../../../lib/productFilters';
import {
  calcAdjustedPrice,
  validateAdjustValue,
  type AdjustType,
  type RoundOption,
} from "@/lib/priceAdjuster";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "PUT") {
    res.setHeader("Allow", ["POST", "PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const {
      ids,
      allPages,
      filters,
      targetField, // 'sale' | 'purchase' | 'both'
      adjustType,  // 'PERCENT_INCREASE' | 'PERCENT_DECREASE' | 'FIXED_INCREASE' | 'FIXED_DECREASE' | 'SET_FIXED'
      value,       // e.g. 10 (for 10%) or 500
      roundOption, // 'none' | 'integer' | 'tens' | 'hundreds'
    } = req.body;

    const numValue = validateAdjustValue(value);
    const adjType: AdjustType = adjustType;
    const round: RoundOption = roundOption || "none";

    const whereClause: any = {};
    if (allPages) {
      // Mismo criterio que la lista (sin tildes, sin ingredientes ocultos).
      Object.assign(whereClause, await buildBulkProductWhere(prisma, filters));
    } else if (Array.isArray(ids) && ids.length > 0) {
      whereClause.id = { in: ids.map((i: any) => Number(i)) };
    } else {
      return res.status(400).json({ message: "Debe seleccionar al menos un producto." });
    }

    const products = await prisma.product.findMany({ where: whereClause });
    if (!products || products.length === 0) {
      return res.status(404).json({ message: "No se encontraron productos para ajustar." });
    }

    let updatedCount = 0;
    const updatedIds: number[] = [];

    await prisma.$transaction(async (tx: any) => {
      for (const p of products) {
        const newSale = parseFloat(p.priceSale.toString()) || 0;
        const newPurchase = parseFloat(p.pricePurchase.toString()) || 0;

        const calcNewValue = (current: number) => {
          return calcAdjustedPrice(current, adjType, numValue, round);
        };

        // [FIX] Forzar updatedAt para que la fecha local sea más reciente que la de Supabase
        const updateData: any = {
          updatedAt: new Date(),
        };

        if (targetField === "sale" || targetField === "both") {
          updateData.priceSale = calcNewValue(newSale);
        }
        if (targetField === "purchase" || targetField === "both") {
          updateData.pricePurchase = calcNewValue(newPurchase);
        }

        await tx.product.update({
          where: { id: p.id },
          data: updateData,
        });

        updatedIds.push(p.id);
        updatedCount++;
      }
    });

    // [FIX] Sync directo y selectivo solo de los productos cuyos precios cambiaron
    // (fire-and-forget vía outbox)
    try {
      const { enqueueOutbox } = await import("../../../lib/syncOutbox");
      for (const pid of updatedIds) {
        await enqueueOutbox("Product", "UPSERT", String(pid));
      }
    } catch (enqErr) {
      console.error("[BatchPrice] Error al encolar precios:", enqErr);
    }

    return res.status(200).json({
      success: true,
      message: `¡Precios actualizados con éxito en ${updatedCount} productos!`,
      count: updatedCount,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Error al ajustar precios." });
  }
}