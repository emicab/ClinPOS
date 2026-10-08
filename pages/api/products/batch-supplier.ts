import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { buildBulkProductWhere } from '../../../lib/productFilters';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', ['PATCH']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { productIds, allPages, filters, supplierId, brandId, categoryId } = req.body;

  let whereClause: any = {};
  if (allPages) {
      // Mismo criterio que la lista (sin tildes, sin ingredientes ocultos).
      Object.assign(whereClause, await buildBulkProductWhere(prisma, filters));
    } else if (Array.isArray(productIds) && productIds.length > 0) {
    whereClause.id = { in: productIds.map((id: any) => parseInt(id)) };
  } else {
    return res.status(400).json({ message: 'productIds debe ser un array no vacío o especificar allPages.' });
  }

  try {
    const updateData: any = {};

    // Solo actualizamos los campos que el usuario especificó
    if (supplierId !== undefined) {
      if (supplierId === null || supplierId === '' || supplierId === 'null') {
        updateData.supplierId = null;
      } else {
        const parsedSupplierId = parseInt(supplierId);
        if (!isNaN(parsedSupplierId)) {
          const supplierExists = await prisma.supplier.findUnique({ where: { id: parsedSupplierId } });
          if (!supplierExists) {
            return res.status(400).json({ message: 'Proveedor no encontrado.' });
          }
          updateData.supplierId = parsedSupplierId;
        }
      }
    }

    if (brandId !== undefined && brandId !== null && brandId !== '' && brandId !== 'null') {
      const parsedBrandId = parseInt(brandId);
      if (!isNaN(parsedBrandId)) {
        const brandExists = await prisma.brand.findUnique({ where: { id: parsedBrandId } });
        if (!brandExists) {
          return res.status(400).json({ message: 'Marca no encontrada.' });
        }
        updateData.brandId = parsedBrandId;
      }
    }

    if (categoryId !== undefined && categoryId !== null && categoryId !== '' && categoryId !== 'null') {
      const parsedCategoryId = parseInt(categoryId);
      if (!isNaN(parsedCategoryId)) {
        const categoryExists = await prisma.category.findUnique({ where: { id: parsedCategoryId } });
        if (!categoryExists) {
          return res.status(400).json({ message: 'Categoría no encontrada.' });
        }
        updateData.categoryId = parsedCategoryId;
      }
    }

    // Si no hay datos para actualizar
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No se especificaron cambios válidos para actualizar.' });
    }

    const result = await prisma.product.updateMany({
      where: whereClause,
      data: updateData,
    });

    res.status(200).json({ message: 'Productos actualizados con éxito de forma masiva.', count: result.count });
  } catch (error) {
    console.error('Error updating batch products:', error);
    res.status(500).json({ message: 'Error al realizar la actualización masiva.' });
  }
}
