// pages/api/users/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../lib/prisma";
import crypto from "crypto";
import { handleApiError } from "../../../lib/apiErrorHandler";

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

// Bloqueo temporal por usuario tras intentos fallidos: un PIN de 4 digitos se
// adivina en minutos sin limite de intentos. En memoria (se reinicia con la app).
const MAX_FAILED_ATTEMPTS = 5;
const failedAttempts = new Map<number, { count: number; lockedUntil: number }>();

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    const { userId, pin } = req.body;

    if (!userId || !pin) {
      return res.status(400).json({ message: "userId y pin son requeridos." });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: parseInt(userId) },
      });

      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }

      const state = failedAttempts.get(user.id);
      if (state && state.lockedUntil > Date.now()) {
        const wait = Math.ceil((state.lockedUntil - Date.now()) / 1000);
        res.setHeader("Retry-After", wait);
        return res.status(429).json({ message: `Demasiados intentos fallidos. Esperá ${wait} s para volver a probar.` });
      }

      const calculatedHash = hashPin(String(pin));
      if (!safeEqualHex(calculatedHash, user.pinHash)) {
        const count = (state?.count ?? 0) + 1;
        // Cada bloqueo duplica la espera (30 s, 60 s, 120 s... hasta 10 min).
        const lockedUntil = count >= MAX_FAILED_ATTEMPTS
          ? Date.now() + Math.min(30_000 * 2 ** (Math.floor(count / MAX_FAILED_ATTEMPTS) - 1), 600_000)
          : 0;
        failedAttempts.set(user.id, { count, lockedUntil });
        return res.status(401).json({ message: "Código PIN incorrecto." });
      }
      failedAttempts.delete(user.id);

      return res.status(200).json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
        },
      });
    } catch (error) {
      return handleApiError(res, error, "verifying PIN login");
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
