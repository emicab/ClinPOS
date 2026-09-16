import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      const resolution = String(req.body?.resolution || "");
      if (!Number.isInteger(id) || !["LOCAL", "CLOUD", "LATER"].includes(resolution)) {
        return res.status(400).json({ message: "Resolución inválida." });
      }

      const conflict = await prisma.syncConflict.findUnique({ where: { id } });
      if (!conflict || conflict.status !== "OPEN") {
        return res.status(404).json({ message: "El cambio ya fue resuelto o no existe." });
      }
      if (resolution === "LATER") return res.status(200).json({ ok: true, deferred: true });

      const payload = JSON.parse(resolution === "LOCAL" ? conflict.localPayload || "{}" : conflict.remotePayload || "{}");
      if (conflict.entity === "Product") {
        await prisma.product.update({
          where: { id: Number(conflict.entityKey) },
          data: resolution === "CLOUD" ? {
            name: payload.name,
            sku: payload.sku || null,
            description: payload.description || null,
            pricePurchase: payload.pricePurchase,
            priceSale: payload.priceSale,
            quantityStock: payload.quantityStock ?? 0,
            stockMinAlert: payload.stockMinAlert ?? null,
            unitType: payload.unitType || null,
            isPublicWeb: payload.isPublicWeb === true,
            webCategory: payload.webCategory || null,
            webUnavailable: payload.webUnavailable === true,
            imageUrl: payload.imageUrl || null,
            brandId: payload.brandId ?? null,
            categoryId: payload.categoryId ?? null,
            supplierId: payload.supplierId ?? null,
            isRecipe: payload.isRecipe === true,
            isIngredient: payload.isIngredient === true,
            updatedAt: new Date(payload.updatedAt || Date.now()),
          } : {},
        });
        if (resolution === "LOCAL") {
          const { enqueueOutbox } = await import("../../../lib/syncOutbox");
          await enqueueOutbox("Product", "UPSERT", conflict.entityKey);
        }
      } else if (conflict.entity === "ProductBranchStock") {
        const [productId, branchId] = conflict.entityKey.split(":").map(Number);
        await prisma.productBranchStock.upsert({
          where: { productId_branchId: { productId, branchId } },
          update: {
            quantityStock: payload.quantityStock ?? 0,
            minStock: payload.minStock ?? 0,
            updatedAt: new Date(payload.updatedAt || Date.now()),
          },
          create: { productId, branchId, quantityStock: payload.quantityStock ?? 0, minStock: payload.minStock ?? 0, updatedAt: new Date(payload.updatedAt || Date.now()) },
        });
        if (resolution === "LOCAL") {
          const { enqueueOutbox } = await import("../../../lib/syncOutbox");
          await enqueueOutbox("ProductBranchStock", "UPSERT", String(productId));
        }
      } else {
        return res.status(400).json({ message: "Este tipo de conflicto todavía no admite resolución automática." });
      }

      await prisma.syncConflict.update({
        where: { id },
        data: { status: "RESOLVED", resolution, resolvedAt: new Date() },
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET", "PATCH"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const conflicts = await prisma.syncConflict.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        entity: true,
        entityKey: true,
        localVersion: true,
        remoteVersion: true,
        localPayload: true,
        remotePayload: true,
        createdAt: true,
      },
    });

    return res.status(200).json({ conflicts });
  } catch (error: any) {
    console.error("[SyncConflicts] Error:", error);
    return res.status(500).json({ message: error.message || "No se pudieron cargar los cambios para revisar." });
  }
}
