// pages/api/proveedores/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';

import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const supplierIdQuery = req.query.id as string;

  if (!supplierIdQuery || isNaN(parseInt(supplierIdQuery))) {
    return res.status(400).json({ message: 'ID de proveedor inválido.' });
  }
  
  const id = parseInt(supplierIdQuery);

  if (req.method === 'GET') {
    // Obtener un proveedor por su ID
    try {
      const supplier = await prisma.supplier.findUnique({
        where: { id },
      });
      if (!supplier) {
        return res.status(404).json({ message: 'Proveedor no encontrado.' });
      }
      res.status(200).json(supplier);
    } catch (error: unknown) {
      handleApiError(res, error, `fetching supplier ${id}`);
    }
  } else if (req.method === 'PUT') {
    // Actualizar un proveedor
    let { name, contactPerson, email, phone, address, notes } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ message: 'El nombre del proveedor es obligatorio.' });
    }
    
    name = sanitizeString(name);
    if (contactPerson) contactPerson = sanitizeString(contactPerson);
    if (email) email = sanitizeString(email);
    if (phone) phone = sanitizeString(phone);
    if (address) address = sanitizeString(address);
    if (notes) notes = sanitizeString(notes);

    try {
      const updatedSupplier = await prisma.supplier.update({
        where: { id },
        data: {
          name: name.trim(),
          contactPerson: contactPerson || null,
          email: email || null,
          phone: phone || null,
          address: address || null,
          notes: notes || null,
        },
      });
      res.status(200).json(updatedSupplier);
    } catch (error: unknown) {
      handleApiError(res, error, `updating supplier ${id}`);
    }
  } else if (req.method === 'DELETE') {
    // Eliminar un proveedor
    try {
      // Importante: Verificar si el proveedor tiene compras asociadas antes de eliminarlo.
      const purchaseCount = await prisma.purchase.count({
        where: { supplierId: id },
      });

      if (purchaseCount > 0) {
        return res.status(409).json({
          message: `No se puede eliminar el proveedor porque tiene ${purchaseCount} compra(s) asociada(s).`
        });
      }

      // Desvincular productos antes de eliminar (evita error de FK).
      await prisma.product.updateMany({
        where: { supplierId: id },
        data: { supplierId: null },
      });

      await prisma.supplier.delete({
        where: { id },
      });
      res.status(204).end(); // No Content, éxito en la eliminación

    } catch (error: unknown) {
      handleApiError(res, error, `deleting supplier ${id}`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}