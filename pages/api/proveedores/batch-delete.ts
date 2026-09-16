// pages/api/proveedores/batch-delete.ts
// Eliminación masiva de proveedores. Por cada id:
// - con compras asociadas → se omite (historial comercial, igual que el
//   delete simple) y se reporta el motivo;
// - sin compras → se desvinculan sus productos (supplierId = null) y se
//   elimina, para no romper la FK.
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';

interface SkippedSupplier {
  id: number;
  name: string;
  reason: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'Debe proporcionar una lista de IDs.' });
  }

  const cleanIds = [...new Set(ids.map((i: any) => Number(i)).filter((n: number) => Number.isInteger(n) && n > 0))];
  if (cleanIds.length === 0) {
    return res.status(400).json({ message: 'IDs de proveedor inválidos.' });
  }

  try {
    const deleted: string[] = [];
    const deletedIds: number[] = [];
    const skipped: SkippedSupplier[] = [];

    for (const id of cleanIds) {
      const supplier = await prisma.supplier.findUnique({
        where: { id },
        select: { id: true, name: true },
      });
      if (!supplier) {
        skipped.push({ id, name: `#${id}`, reason: 'No existe.' });
        continue;
      }

      const purchaseCount = await prisma.purchase.count({
        where: { supplierId: id },
      });
      if (purchaseCount > 0) {
        skipped.push({
          id,
          name: supplier.name,
          reason: `Tiene ${purchaseCount} compra(s) asociada(s).`,
        });
        continue;
      }

      // Desvincular productos antes de eliminar (evita error de FK).
      await prisma.product.updateMany({
        where: { supplierId: id },
        data: { supplierId: null },
      });
      await prisma.supplier.delete({ where: { id } });
      deleted.push(supplier.name);
      deletedIds.push(supplier.id);
    }

    return res.status(200).json({
      message: `Eliminados: ${deleted.length}${skipped.length > 0 ? ` — Omitidos: ${skipped.length}` : ''}.`,
      deleted,
      deletedIds,
      skipped,
    });
  } catch (error: unknown) {
    handleApiError(res, error, 'deleting suppliers in batch');
  }
}
