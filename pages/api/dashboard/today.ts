// pages/api/dashboard/today.ts
// KPIs del día para el Home. Todo tolerante a fallos: cada métrica que falle
// vuelve null y el Home la oculta, nunca rompe la página.
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const out: {
    salesToday: { count: number; total: number } | null;
    ticketAvg: number | null;
    lowStock: number | null;
    cashOpen: { expected: number } | null;
  } = { salesToday: null, ticketAvg: null, lowStock: null, cashOpen: null };

  // Ventas de hoy (sin canceladas).
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const agg = await prisma.sale.aggregate({
      where: { saleDate: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      _count: { id: true },
      _sum: { totalAmount: true },
    });
    const count = agg._count.id || 0;
    const total = Number(agg._sum.totalAmount || 0);
    out.salesToday = { count, total };
    out.ticketAvg = count > 0 ? Math.round((total / count) * 100) / 100 : 0;
  } catch {
    // sin ventas o error: queda null
  }

  // Productos bajo mínimo (misma regla que /api/products/alert-count, sin
  // el loop de recetario para mantenerlo barato).
  try {
    const rows: any = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM Product WHERE isRecipe = 0 AND ((stockMinAlert IS NOT NULL AND quantityStock < stockMinAlert) OR quantityStock <= 0)`
    );
    out.lowStock = Number(rows[0]?.count || 0);
  } catch {
    // ignore
  }

  // Caja abierta: esperado = inicial + movimientos.
  try {
    const open = await prisma.cashRegister.findFirst({
      where: { status: 'OPEN' },
      include: { movements: { select: { amount: true } } },
    });
    if (open) {
      const moves = (open.movements || []).reduce(
        (s: number, m: any) => s + Number(m.amount || 0),
        0,
      );
      out.cashOpen = {
        expected: Math.round((Number(open.initialBalance || 0) + moves) * 100) / 100,
      };
    } else {
      out.cashOpen = null;
    }
  } catch {
    // ignore
  }

  res.status(200).json(out);
}
