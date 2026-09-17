import { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const includeAll = req.query.all === "true" || req.query.all === "1";
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
                },
              },
            },
          },
        },
        orderBy: { name: "asc" },
      });

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
          const prodStock = i.product ? Number(i.product.quantityStock) : 0;
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
