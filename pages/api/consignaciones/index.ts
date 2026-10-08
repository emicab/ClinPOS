// pages/api/consignaciones/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { incrementStock, resolveTargetBranch } from '../../../lib/stockAdjust';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const consignments = await prisma.consignment.findMany({
        include: {
          client: true,
          items: {
            include: {
              product: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      const formatted = consignments.map((c) => ({
        ...c,
        items: c.items.map((i) => ({
          ...i,
          priceAtGiven: i.priceAtGiven.toString(),
          product: i.product
            ? {
                ...i.product,
                priceSale: i.product.priceSale.toString(),
                pricePurchase: i.product.pricePurchase?.toString() || null,
              }
            : null,
        })),
      }));

      res.status(200).json(formatted);
    } catch (error: any) {
      handleApiError(res, error, 'fetching consignments');
    }
  } else if (req.method === 'POST') {
    const { clientId, notes, items } = req.body;

    if (!clientId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cliente y al menos un producto son requeridos.' });
    }

    try {
      // Guarda de Recetario: los productos elaborados no se consignan (no tienen stock físico propio).
      const recipeBlock = await prisma.product.findFirst({
        where: { id: { in: items.map((i: any) => i.productId) }, isRecipe: true },
        select: { name: true },
      });
      if (recipeBlock) {
        return res.status(400).json({
          message: `No se puede consignar un producto elaborado ("${recipeBlock.name}").`,
        });
      }

      // El stock sale de la sucursal de este equipo (o la Principal).
      const consignmentBranchId = (await resolveTargetBranch(null)).branchId;
      const result = await prisma.$transaction(async (tx) => {
        // 1. Verificar y descontar stock de cada producto entregado
        for (const item of items) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (!product) {
            throw new Error(`Producto con ID ${item.productId} no encontrado.`);
          }
          if (product.quantityStock < item.quantityGiven) {
            throw new Error(`Stock insuficiente para "${product.name}". Disponible: ${product.quantityStock}, Solicitado: ${item.quantityGiven}.`);
          }

          // Descontar del stock local (pasa a estar entregado en consignación)
          await incrementStock(tx, item.productId, -Number(item.quantityGiven), consignmentBranchId);
        }

        // 2. Crear registro de Consignación
        const consignment = await tx.consignment.create({
          data: {
            clientId: parseInt(clientId),
            notes: notes || null,
            status: 'DELIVERED',
            items: {
              create: items.map((item: any) => ({
                productId: item.productId,
                quantityGiven: parseFloat(item.quantityGiven),
                quantitySold: 0,
                quantityReturned: 0,
                priceAtGiven: item.priceAtGiven,
              })),
            },
          },
          include: {
            client: true,
            items: {
              include: {
                product: true,
              },
            },
          },
        });

        return consignment;
      });

      const formatted = {
        ...result,
        items: result.items.map((i) => ({
          ...i,
          priceAtGiven: i.priceAtGiven.toString(),
        })),
      };

      res.status(201).json(formatted);
    } catch (error: any) {
      handleApiError(res, error, 'creating consignment');
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
