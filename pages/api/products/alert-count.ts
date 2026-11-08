import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { getDeviceBranchId } = await import('../../../lib/branchIdentity');
    let branchId = await getDeviceBranchId();
    if (!branchId) {
      const main = await prisma.branch.findFirst({ where: { isMain: true }, select: { id: true } });
      branchId = main?.id ?? null;
    }

    // Los elaborados (isRecipe = 1) no se cuentan aquí: se cuentan aparte vía
    // stock derivado (computeDerivedStock). Acá solo productos simples e
    // ingredientes: stock bajo el mínimo o stock 0 aunque no tengan
    // stockMinAlert configurado. Se usa la sucursal activa.
    const result: any = branchId
      ? await prisma.$queryRawUnsafe(
          `SELECT COUNT(*) as count FROM Product p
           INNER JOIN ProductBranchStock bs ON bs.productId = p.id
           WHERE p.isRecipe = 0 AND bs.branchId = ?
             AND ((p.stockMinAlert IS NOT NULL AND bs.quantityStock < p.stockMinAlert) OR bs.quantityStock <= 0)`,
          branchId,
        )
      : await prisma.$queryRawUnsafe(
          `SELECT COUNT(*) as count FROM Product WHERE isRecipe = 0 AND ((stockMinAlert IS NOT NULL AND quantityStock < stockMinAlert) OR quantityStock <= 0)`,
        );
    const count = Number(result[0]?.count || 0);

    // Contar elaborados sin disponibilidad (no se pueden preparar).
    let recipeAlerts = 0;
    try {
      const { computeDerivedStock } = await import('../../../lib/recipeStock');
      const recipes = await prisma.product.findMany({
        where: { isRecipe: true },
        select: { id: true, stockMinAlert: true },
      });
      for (const r of recipes) {
        const derived = await computeDerivedStock(prisma, r.id, branchId);
        if (derived <= 0 || (r.stockMinAlert !== null && derived < r.stockMinAlert)) {
          recipeAlerts++;
        }
      }
    } catch {
      // si falla el recetario, no romper el contador
    }

    res.status(200).json({ count: count + recipeAlerts });
  } catch (error) {
    console.error('Error counting stock alerts:', error);
    res.status(500).json({ message: 'Error al contar alertas de stock' });
  }
}
