// pages/api/mercadopago/status.ts
// Estado de vinculación de Mercado Pago SIN exponer secrets.
//
// Contexto: GET /api/store-config sanitiza mpAccessToken/mpPublicKey a
// undefined (correcto: es público), así que el frontend jamás podía saber si
// hay una cuenta vinculada y el botón quedaba clavado en "Conectar". Este
// endpoint devuelve solo un booleano + updatedAt para pintar el botón.
import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveDbForRequest } from '../../../lib/requestDb';
import { handleApiError } from '../../../lib/apiErrorHandler';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }

  try {
    const db = await resolveDbForRequest(req);
    const config = await db.storeConfig.findFirst({
      select: { id: true, updatedAt: true, mpAccessToken: true, mpPublicKey: true },
    });

    const connected = Boolean(config?.mpAccessToken && config.mpAccessToken.trim() !== '');

    return res.status(200).json({
      success: true,
      data: {
        connected,
        hasPublicKey: Boolean(config?.mpPublicKey && config.mpPublicKey.trim() !== ''),
        updatedAt: config?.updatedAt ?? null,
      },
    });
  } catch (error) {
    handleApiError(res, error, 'fetching mercadopago status');
    return;
  }
}
