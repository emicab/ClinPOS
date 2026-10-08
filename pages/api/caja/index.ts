import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const openRegister = await prisma.cashRegister.findFirst({
        where: { status: 'OPEN' },
        include: { movements: { orderBy: { createdAt: 'desc' } }, seller: { select: { id: true, name: true } } },
      });

      const history = await prisma.cashRegister.findMany({
        where: { status: 'CLOSED' },
        orderBy: { closeDate: 'desc' },
        take: 10,
      });

      res.status(200).json({ open: openRegister, history });
    } catch (error) {
      handleApiError(res, error, 'fetching cash register');
    }
  } else if (req.method === 'POST') {
    const { notes, sellerId } = req.body;
    const initialBalance = req.body.initialBalance !== undefined && req.body.initialBalance !== '' ? Number(req.body.initialBalance) : 0;
    if (!Number.isFinite(initialBalance) || initialBalance < 0) {
      return res.status(400).json({ message: 'El saldo inicial debe ser un número mayor o igual a 0.' });
    }

    try {
      const existing = await prisma.cashRegister.findFirst({ where: { status: 'OPEN' } });
      if (existing) {
        return res.status(400).json({ message: 'Ya hay una caja abierta. Ciérrela antes de abrir una nueva.' });
      }

      const register = await prisma.cashRegister.create({
        data: {
          initialBalance,
          notes: notes || null,
          sellerId: sellerId ? parseInt(sellerId) : null,
        },
      });

      res.status(201).json(register);
    } catch (error) {
      handleApiError(res, error, 'opening cash register');
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
