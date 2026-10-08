// pages/api/cuenta-corriente/payment.ts
import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../lib/prisma";
import { Prisma, PaymentType } from "@prisma/client";
const Decimal = Prisma.Decimal;
import { handleApiError } from "../../../lib/apiErrorHandler";
import { sanitizeString } from "../../../lib/sanitize";

interface RegisterPaymentInput {
  clientId: number;
  amount: number;
  paymentType: PaymentType;
  description?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    const { clientId, amount, paymentType, description: rawDescription } = req.body as RegisterPaymentInput;

    if (!clientId || amount === undefined || !paymentType) {
      return res.status(400).json({ message: "Faltan campos requeridos: clientId, amount, paymentType." });
    }

    if (typeof amount !== "number" && typeof amount !== "string") {
      return res.status(400).json({ message: "El monto del pago es inválido." });
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({ message: "El monto del pago debe ser un número mayor a cero." });
    }

    if (!Object.values(PaymentType).includes(paymentType)) {
      return res.status(400).json({ message: "Método de pago inválido." });
    }

    const description = sanitizeString(rawDescription || "Pago de cuenta corriente");

    try {
      // Regla de Oro: La caja debe estar abierta para registrar movimientos de dinero
      const openRegister = await prisma.cashRegister.findFirst({ where: { status: "OPEN" } });
      if (!openRegister) {
        return res.status(400).json({ message: "Debe haber una caja abierta para registrar un cobro de cuenta corriente." });
      }

      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) {
        return res.status(404).json({ message: "Cliente no encontrado." });
      }

      const result = await prisma.$transaction(async (tx) => {
        // 1. Obtener o crear la cuenta corriente del cliente
        let account = await tx.accountBalance.findUnique({ where: { clientId } });
        if (!account) {
          account = await tx.accountBalance.create({
            data: {
              clientId,
              balance: new Decimal(0),
            },
          });
        }

        // 2. Actualizar el saldo (pago resta la deuda)
        const updatedAccount = await tx.accountBalance.update({
          where: { id: account.id },
          data: {
            balance: {
              decrement: new Decimal(amountNumber),
            },
          },
        });

        // 3. Registrar movimiento en la cuenta corriente
        const accountMovement = await tx.accountMovement.create({
          data: {
            accountBalanceId: account.id,
            type: "PAYMENT",
            amount: new Decimal(-Math.abs(amountNumber)), // reduce la deuda
            description,
          },
        });

        // 4. Registrar ingreso en la caja abierta
        await tx.cashMovement.create({
          data: {
            cashRegisterId: openRegister.id,
            type: "DEPOSIT",
            paymentType,
            sourceId: accountMovement.id,
            amount: new Decimal(amountNumber), // ingreso positivo a caja
            description: `Cobro Cta Cte: ${client.firstName} ${client.lastName || ""} - ${description}`,
          },
        });

        return updatedAccount;
      });

      return res.status(200).json({
        id: result.id,
        clientId: result.clientId,
        balance: result.balance.toString(),
      });
    } catch (error) {
      return handleApiError(res, error, "registering account payment");
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
