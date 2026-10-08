// pages/api/gastos/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma, PaymentType } from '@prisma/client';
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';

interface CreateExpenseInput {
  expenseDate?: string; // Fecha opcional, si no se provee se usa la actual
  description: string;
  amount: number; // Recibimos como número, convertimos a Decimal
  category: string;
  paymentType: PaymentType;
  notes?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    // Listar todos los gastos, podríamos añadir filtros por fecha, categoría, etc.
    const { category: queryCategory, startDate, endDate } = req.query;

    const whereClause: Prisma.ExpenseWhereInput = {};

    if (queryCategory && typeof queryCategory === 'string') {
      whereClause.category = { contains: queryCategory };
    }

    const dateFilter: Prisma.DateTimeFilter = {};
    if (startDate && typeof startDate === 'string') {
      const parsedStartDate = new Date(startDate);
      if (!isNaN(parsedStartDate.valueOf())) {
        dateFilter.gte = parsedStartDate;
      }
    }
    if (endDate && typeof endDate === 'string') {
      const parsedEndDate = new Date(endDate);
      if (!isNaN(parsedEndDate.valueOf())) {
         // Para que incluya todo el día de endDate
        parsedEndDate.setHours(23, 59, 59, 999);
        dateFilter.lte = parsedEndDate;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      whereClause.expenseDate = dateFilter;
    }

    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string) || 50, 100) : 50;
    const skip = page ? (page - 1) * limit : undefined;

    try {
      const [expenses, total] = await Promise.all([
        prisma.expense.findMany({
          where: whereClause,
          orderBy: { expenseDate: 'desc' },
          ...(skip !== undefined && { skip, take: limit }),
        }),
        prisma.expense.count({ where: whereClause }),
      ]);

      // Convertir Decimal a string para la respuesta JSON
      const expensesForJson = expenses.map(expense => ({
        ...expense,
        amount: expense.amount.toString(),
      }));

      if (page !== undefined) {
        res.status(200).json({
          data: expensesForJson,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          }
        });
      } else {
        res.status(200).json(expensesForJson);
      }
    } catch (error) {
      handleApiError(res, error, "fetching expenses");
    }
  } else if (req.method === 'POST') {
    const { amount, paymentType, expenseDate: expenseDateString } = req.body as CreateExpenseInput;
    let { description, category, notes } = req.body as CreateExpenseInput;

    let finalExpenseDate: Date;
    if (expenseDateString) {
        const [year, month, day] = expenseDateString.split('-').map(Number);
        // Creamos la fecha como mediodía UTC para evitar problemas de "un día antes"
        finalExpenseDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)); 
    } else {
        finalExpenseDate = new Date(); // O maneja como error si la fecha es obligatoria
    }

    if (!description || amount === undefined || !category || !paymentType) {
      return res.status(400).json({ message: 'Faltan datos obligatorios: descripción, monto, categoría o tipo de pago.' });
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ message: 'El monto debe ser mayor a cero.' });
    }
    if (!Object.values(PaymentType).includes(paymentType)) {
        return res.status(400).json({ message: 'Tipo de pago inválido.' });
    }

    description = sanitizeString(description);
    category = sanitizeString(category);
    if (notes) notes = sanitizeString(notes);

    let parsedExpenseDate: Date | undefined = undefined;
    if (finalExpenseDate) {
        parsedExpenseDate = new Date(finalExpenseDate);
        if (isNaN(parsedExpenseDate.valueOf())) {
            return res.status(400).json({ message: 'Fecha del gasto inválida.' });
        }
    }

    try {
      const openRegister = await prisma.cashRegister.findFirst({ where: { status: 'OPEN' } });
      if (!openRegister) {
        return res.status(400).json({ message: 'Debe haber una caja abierta para poder registrar un gasto.' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const newExpense = await tx.expense.create({
          data: {
            description,
            amount: new Decimal(amount),
            category,
            paymentType,
            expenseDate: parsedExpenseDate || new Date(),
            notes: notes || null,
          },
        });

        // Registrar movimiento en caja (caja abierta garantizada por verificación previa)
        await tx.cashMovement.create({
          data: {
            cashRegisterId: openRegister.id,
            type: 'EXPENSE',
            paymentType,
            sourceId: newExpense.id,
            amount: -Math.abs(amount), // gasto: monto negativo
            description: `Gasto: ${category} - ${description}`,
          },
        });

        return newExpense;
      });

      // Convertir Decimal a string para la respuesta JSON
      const expenseForJson = {
        ...result,
        amount: result.amount.toString(),
      }
      res.status(201).json(expenseForJson);
    } catch (error: any) {
      handleApiError(res, error, "creating expense");
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}