import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';
import { isMainDevice, isProDevice } from '../../../lib/branchIdentity';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      let branches = await (prisma as any).branch.findMany({
        orderBy: { id: 'asc' },
      });

      if (!branches || branches.length === 0) {
        const mainBranch = await (prisma as any).branch.create({
          data: {
            name: 'Sucursal Principal',
            isMain: true,
          },
        });
        branches = [mainBranch];
      }

      res.status(200).json(branches);
    } catch (error) {
      handleApiError(res, error, "fetching branches");
    }
  } else if (req.method === 'POST') {
    try {
      // Los locales requieren el plan Pro
      if (!(await isProDevice())) {
        res.status(403).json({ message: 'Los locales de venta requieren el plan Pro.' });
        return;
      }
      // Los locales solo se administran desde la Casa Central
      if (!(await isMainDevice())) {
        res.status(403).json({ message: 'Los locales solo se administran desde la Casa Central.' });
        return;
      }

      const { name, address, phone, isMain } = req.body;

      if (!name || !name.trim()) {
        res.status(400).json({ message: 'El nombre de la sucursal es obligatorio.' });
        return;
      }

      const cleanName = sanitizeString(name.trim());
      const newBranch = await (prisma as any).branch.create({
        data: {
          name: cleanName,
          address: address ? sanitizeString(address.trim()) : null,
          phone: phone ? sanitizeString(phone.trim()) : null,
          isMain: Boolean(isMain),
        },
      });

      // La sucursal nueva arranca en 0 para los productos existentes (sin esto,
      // el filtro por sucursal los excluiría por falta de fila).
      try {
        const existing = await (prisma as any).product.findMany({ select: { id: true } });
        if (existing.length > 0) {
          // Sin skipDuplicates (no existe en SQLite): la sucursal es recién
          // creada, no puede haber filas previas; la carrera cae en el catch.
          await (prisma as any).productBranchStock.createMany({
            data: existing.map((p: any) => ({
              productId: p.id,
              branchId: newBranch.id,
              quantityStock: 0,
            })),
          });
        }
      } catch (e) {
        console.warn('[Branches] backfill inicial de stock falló:', e);
      }

      try {
        const { runSupabaseSync } = await import('../../../lib/syncService');
        runSupabaseSync(true).catch(() => {});
      } catch {}

      res.status(201).json(newBranch);
    } catch (error) {
      handleApiError(res, error, "creating branch");
    }
  } else if (req.method === 'PUT') {
    try {
      // Los locales requieren el plan Pro
      if (!(await isProDevice())) {
        res.status(403).json({ message: 'Los locales de venta requieren el plan Pro.' });
        return;
      }
      // Los locales solo se administran desde la Casa Central
      if (!(await isMainDevice())) {
        res.status(403).json({ message: 'Los locales solo se administran desde la Casa Central.' });
        return;
      }

      const { id, name, address, phone, isMain } = req.body;
      if (!id) {
        res.status(400).json({ message: 'ID de sucursal es obligatorio.' });
        return;
      }

      const updated = await (prisma as any).branch.update({
        where: { id: Number(id) },
        data: {
          name: name ? sanitizeString(name.trim()) : undefined,
          address: address !== undefined ? (address ? sanitizeString(address.trim()) : null) : undefined,
          phone: phone !== undefined ? (phone ? sanitizeString(phone.trim()) : null) : undefined,
          isMain: isMain !== undefined ? Boolean(isMain) : undefined,
        },
      });

      try {
        const { runSupabaseSync } = await import('../../../lib/syncService');
        runSupabaseSync(true).catch(() => {});
      } catch {}

      res.status(200).json(updated);
    } catch (error) {
      handleApiError(res, error, "updating branch");
    }
  } else if (req.method === 'DELETE') {
    try {
      // Los locales requieren el plan Pro
      if (!(await isProDevice())) {
        res.status(403).json({ message: 'Los locales de venta requieren el plan Pro.' });
        return;
      }
      // Los locales solo se administran desde la Casa Central
      if (!(await isMainDevice())) {
        res.status(403).json({ message: 'Los locales solo se administran desde la Casa Central.' });
        return;
      }

      const { id } = req.query;
      if (!id) {
        res.status(400).json({ message: 'ID de sucursal es obligatorio.' });
        return;
      }

      const branchId = Number(id);
      const branchToDelete = await (prisma as any).branch.findUnique({ where: { id: branchId } });
      if (branchToDelete?.isMain) {
        res.status(400).json({ message: 'No podés eliminar la Sucursal Principal.' });
        return;
      }

      await (prisma as any).branch.delete({ where: { id: branchId } });

      try {
        const { runSupabaseSync } = await import('../../../lib/syncService');
        runSupabaseSync(true).catch(() => {});
      } catch {}

      res.status(200).json({ success: true, message: 'Sucursal eliminada.' });
    } catch (error) {
      handleApiError(res, error, "deleting branch");
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
