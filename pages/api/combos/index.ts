import { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/lib/prisma";
import { getRecipeAvailability } from "@/lib/recipeStock";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const includeAll = req.query.all === "true" || req.query.all === "1";
    const parsedBranch = parseInt(String(req.query.branchId));
    const branchId = isNaN(parsedBranch) ? null : parsedBranch;
    try {
      const combos = await prisma.combo.findMany({
        where: includeAll ? {} : { active: true },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  unitType: true,
                  quantityStock: true,
                  priceSale: true,
                  isRecipe: true,
                },
              },
            },
          },
        },
        orderBy: { name: "asc" },
      });

      // Stock efectivo por producto: respeta la sucursal (si se pide) y deriva
      // el de los elaborados desde sus ingredientes. Leer solo quantityStock
      // global dejaba en 0 a los productos elaborados y a los de otra sucursal.
      const effectiveStock = new Map<number, number>();
      for (const combo of combos) {
        for (const item of combo.items) {
          if (!item.product || effectiveStock.has(item.product.id)) continue;
          try {
            const av = await getRecipeAvailability(prisma, item.product.id, branchId);
            effectiveStock.set(item.product.id, av.available);
          } catch {
            effectiveStock.set(item.product.id, Number(item.product.quantityStock) || 0);
          }
        }
      }

      // Vista de administración: todos los combos (activos e inactivos) con su forma completa
      if (includeAll) {
        return res.status(200).json(
          combos.map((c) => ({
            ...c,
            price: c.price.toString(),
            items: c.items.map((i) => ({
              id: i.id,
              productId: i.productId,
              product: i.product ? {
                id: i.product.id,
                name: i.product.name,
                unitType: i.product.unitType,
                priceSale: i.product.priceSale.toString(),
                // El POS valida stock con estos campos: sin ellos todo combo
                // aparecía con stock 0. Con branchId se devuelve la fila de esa
                // sucursal (ya efectiva) para que getLocalStock la lea.
                quantityStock: effectiveStock.get(i.product.id) ?? 0,
                branchStocks: branchId !== null
                  ? [{ branchId, quantityStock: effectiveStock.get(i.product.id) ?? 0 }]
                  : [],
              } : null,
              quantity: i.quantity,
              customPrice: i.customPrice ? i.customPrice.toString() : null,
            })),
          }))
        );
      }

      // Calcular el stock máximo disponible por combo según el stock de cada producto ingrediente
      const mappedCombos = combos.map((c) => {
        let maxComboStock = 99999;
        const items = c.items.map((i) => {
          const prodStock = i.product ? effectiveStock.get(i.product.id) ?? 0 : 0;
          const reqQty = i.quantity > 0 ? i.quantity : 1;
          const possiblePacks = Math.floor(prodStock / reqQty);
          if (possiblePacks < maxComboStock) {
            maxComboStock = possiblePacks;
          }
          return {
            id: i.id,
            productId: i.productId,
            productName: i.product?.name || "Producto",
            unitType: i.product?.unitType || "UNIT",
            quantity: i.quantity,
            priceSale: i.product ? i.product.priceSale.toString() : "0",
          };
        });

        if (maxComboStock === 99999) maxComboStock = 0;

        return {
          id: c.id,
          name: c.name,
          description: c.description,
          imageUrl: c.imageUrl,
          priceSale: c.price.toString(),
          isCombo: true,
          webCategory: "Combos & Promos 🔥",
          quantityStock: Math.max(0, maxComboStock),
          isPublicWeb: true,
          items,
        };
      });

      return res.status(200).json(mappedCombos);
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Error al obtener combos." });
    }
  } else if (req.method === "POST") {
    const { name, description, price, imageUrl, items } = req.body;
    if (!name || !price) {
      return res.status(400).json({ message: "Nombre y precio son obligatorios." });
    }
    try {
      const combo = await prisma.combo.create({
        data: {
          name,
          description: description || null,
          imageUrl: imageUrl || null,
          price: price,
          active: true,
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              quantity: item.quantity || 1,
              customPrice: item.customPrice || null,
            })),
          },
        },
      });
      return res.status(201).json(combo);
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Error al crear combo." });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
