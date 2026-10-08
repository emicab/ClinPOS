import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = parseInt(req.query.id as string);
  if (isNaN(id)) return res.status(400).json({ message: 'ID inválido.' });

  if (req.method === 'GET') {
    try {
      const register = await prisma.cashRegister.findUnique({
        where: { id },
        include: { movements: { orderBy: { createdAt: 'asc' } } },
      });
      if (!register) return res.status(404).json({ message: 'Caja no encontrada.' });

      const registerForJson = {
        ...register,
        initialBalance: register.initialBalance.toString(),
        ...(register.expectedBalance && { expectedBalance: register.expectedBalance.toString() }),
        ...(register.actualBalance && { actualBalance: register.actualBalance.toString() }),
        ...(register.difference && { difference: register.difference.toString() }),
        movements: register.movements.map((m: any) => ({
          ...m,
          amount: m.amount.toString(),
        })),
      };

      res.status(200).json(registerForJson);
    } catch (error) {
      handleApiError(res, error, `fetching cash register ${id}`);
    }
  } else if (req.method === 'PUT') {
    const { actualBalance, notes } = req.body;

    if (actualBalance === undefined || actualBalance === null || actualBalance === '' || !Number.isFinite(Number(actualBalance))) {
      return res.status(400).json({ message: 'El saldo real es obligatorio y debe ser un número para cerrar la caja.' });
    }

    try {
      const register = await prisma.cashRegister.findUnique({
        where: { id },
        include: { movements: true },
      });

      if (!register) return res.status(404).json({ message: 'Caja no encontrada.' });
      if (register.status !== 'OPEN') return res.status(400).json({ message: 'La caja ya está cerrada.' });

      // Esperado = efectivo físico: saldo inicial + movimientos en efectivo. Tarjeta,
      // transferencia, QR o Mercado Pago no pasan por el cajón (así lo muestra la
      // pantalla de caja); sumarlos hacía que la diferencia nunca cerrara.
      const cashMovements = register.movements
        .filter((m: any) => m.paymentType === 'CASH')
        .reduce((sum: number, m: any) => sum + Number(m.amount), 0);
      const expected = Number(register.initialBalance) + cashMovements;
      const diff = Number(actualBalance) - expected;

      const updated = await prisma.cashRegister.update({
        where: { id },
        data: {
          closeDate: new Date(),
          actualBalance,
          expectedBalance: expected,
          difference: diff,
          status: 'CLOSED',
          notes: notes || null,
        },
      });

      res.status(200).json(updated);
    } catch (error) {
      handleApiError(res, error, `closing cash register ${id}`);
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT']);
    res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
