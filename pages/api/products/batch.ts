import { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/lib/prisma";
import { buildBulkProductWhere } from '@/lib/productFilters';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "PUT" || req.method === "POST") {
    try {
      const { ids, allPages, filters, isPublicWeb, brandId, categoryId, supplierId } = req.body;

      const whereClause: any = {};

      if (allPages) {
      // Mismo criterio que la lista (sin tildes, sin ingredientes ocultos).
      Object.assign(whereClause, await buildBulkProductWhere(prisma, filters));
    } else if (Array.isArray(ids) && ids.length > 0) {
        whereClause.id = { in: ids.map((i: any) => Number(i)) };
      } else {
        return res.status(400).json({ message: "Debe proporcionar una lista de IDs o seleccionar todas las páginas." });
      }

      // [FIX] Recolectar las IDs afectadas antes del updateMany para sincronizarlas
      const affectedProducts = await prisma.product.findMany({
        where: whereClause,
        select: { id: true },
      });
      const affectedIds = affectedProducts.map((p) => p.id);

      if (affectedIds.length === 0) {
        return res.status(404).json({ message: "No se encontraron productos para actualizar." });
      }

      // [FIX] Prisma updateMany NO actualiza @updatedAt automáticamente, lo agregamos explícitamente
      const updateData: any = {
        updatedAt: new Date(),
      };

      if (isPublicWeb !== undefined) {
        updateData.isPublicWeb = Boolean(isPublicWeb);
      }
      if (brandId !== undefined && !allPages) updateData.brandId = Number(brandId);
      if (categoryId !== undefined && !allPages) updateData.categoryId = Number(categoryId);
      if (supplierId !== undefined && !allPages) updateData.supplierId = supplierId ? Number(supplierId) : null;

      const result = await prisma.product.updateMany({
        where: whereClause,
        data: updateData,
      });

      // [FIX] Sync selectivo únicamente con las entidades modificadas (fire-and-forget vía outbox)
      try {
        const { enqueueOutbox } = await import("../../../lib/syncOutbox");
        for (const pid of affectedIds) {
          await enqueueOutbox("Product", "UPSERT", String(pid));
        }
      } catch (enqErr) {
        console.error("[BatchUpdate] Error al encolar productos:", enqErr);
      }

      return res.status(200).json({ message: "Productos actualizados correctamente.", count: result.count });
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Error al actualizar productos en lote." });
    }
  }

  res.setHeader("Allow", ["PUT", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}