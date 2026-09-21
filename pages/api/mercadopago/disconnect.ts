// pages/api/mercadopago/disconnect.ts
// Desvincula la cuenta de Mercado Pago (borra token + public key).
//
// Necesario porque PUT /api/store-config conserva los secrets almacenados
// cuando llegan vacíos (keepOr): sin este endpoint no habría forma explícita
// de desconectar.
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { isMainDevice, isProDevice } from '../../../lib/branchIdentity';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }

  try {
    if (!(await isProDevice())) {
      return res.status(403).json({ message: 'La tienda web requiere el plan Pro.' });
    }
    if (!(await isMainDevice())) {
      return res.status(403).json({ message: 'La tienda web solo se administra desde la Casa Central.' });
    }

    const config = await prisma.storeConfig.findFirst();
    if (!config) {
      return res.status(404).json({ message: 'No hay tienda configurada.' });
    }

    await prisma.storeConfig.update({
      where: { id: config.id },
      data: { mpAccessToken: null, mpPublicKey: null },
    });

    // Propagar el borrado a la nube (PATCH parcial con tenant_id), igual que
    // hacía PUT /api/store-config al detectar token no-vacío → vacío.
    try {
      const { getSelectiveSyncCredentials } = await import('../../../lib/syncService');
      const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
      const patchRes = await fetch(`${supabaseUrl}/rest/v1/StoreConfig?tenant_id=eq.${tenantId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          mpAccessToken: null,
          mpPublicKey: null,
          updatedAt: new Date().toISOString(),
        }),
      });
      if (!patchRes.ok) {
        console.error('[MP Disconnect] Error al borrar credenciales en Supabase:', await patchRes.text());
      }
    } catch (err) {
      console.warn('[MP Disconnect] No se pudo borrar las credenciales en Supabase:', err);
    }

    return res.status(200).json({
      success: true,
      message: 'Cuenta de Mercado Pago desconectada.',
      data: { connected: false },
    });
  } catch (error) {
    handleApiError(res, error, 'disconnecting mercadopago');
    return;
  }
}
