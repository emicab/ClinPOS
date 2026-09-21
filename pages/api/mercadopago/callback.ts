// pages/api/mercadopago/callback.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { isMainDevice, isProDevice } from '../../../lib/branchIdentity';
import { Prisma } from '@prisma/client';

function renderHtmlResponse(
  res: NextApiResponse,
  success: boolean,
  title: string,
  message: string
) {
  const icon = success ? '✓' : '✕';
  const color = success ? '#22c55e' : '#f43f5e';
  const bgIcon = success ? 'rgba(34, 197, 94, 0.15)' : 'rgba(244, 63, 94, 0.15)';
  // Avisa a la ventana del POS (si sigue abierta) para que refresque el
  // estado del botón sin F5. El frontend también revalida con focus, por si
  // el popup se abrió en otro navegador (Tauri shell.open) sin opener.
  const notified = success ? 'true' : 'false';

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title} - ClinPOS</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #090d16; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background-color: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1.25rem; text-align: center; max-width: 440px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
      .icon { width: 64px; height: 64px; background: ${bgIcon}; color: ${color}; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem auto; font-size: 2rem; font-weight: bold; }
      h1 { color: ${color}; margin: 0 0 0.5rem 0; font-size: 1.5rem; }
      p { color: #9ca3af; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem 0; }
      .btn { display: inline-block; background-color: #2563eb; color: white; padding: 0.75rem 1.5rem; border-radius: 0.75rem; text-decoration: none; font-weight: 600; font-size: 0.9rem; cursor: pointer; border: none; }
      .btn:hover { background-color: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${icon}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <button class="btn" onclick="window.close()">Cerrar esta Ventana</button>
    </div>
    <script>
      try {
        if (window.opener) window.opener.postMessage({ type: 'mp-oauth', success: ${notified} }, '*');
      } catch (e) {}
    </script>
  </body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { code, error } = req.query;

  if (error || !code) {
    return renderHtmlResponse(
      res,
      false,
      'Error de Autorización',
      'No se pudo completar la autorización con Mercado Pago. Podés intentar nuevamente desde el panel de ClinPOS.'
    );
  }

  const clientId = process.env.MP_CLIENT_ID;
  const clientSecret = process.env.MP_CLIENT_SECRET;
  const host = req.headers.host || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/mercadopago/callback`;

  try {
    // La tienda web (y su Mercado Pago) es una funcionalidad del plan Pro
    if (!(await isProDevice())) {
      return renderHtmlResponse(
        res,
        false,
        'Plan Básico',
        'La tienda web requiere el plan Pro. Activá tu licencia Pro para vincular Mercado Pago.'
      );
    }

    if (!clientId || !clientSecret) {
      // Si no hay client secret configurado en .env, registramos el code de autorización de todas formas
      return renderHtmlResponse(
        res,
        true,
        'Código Registrado',
        'Tu código de autorización fue recibido. Podés copiar este código si es necesario o cerrar esta ventana.'
      );
    }

    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Mercado Pago OAuth token exchange error:', tokenData);
      return renderHtmlResponse(
        res,
        false,
        'Error de Credenciales',
        'Mercado Pago no pudo intercambiar el código de autorización. Verificá que MP_CLIENT_ID y MP_CLIENT_SECRET sean válidos.'
      );
    }

    const accessToken = tokenData.access_token;
    const publicKey = tokenData.public_key || '';

    // Guardar la credencial en StoreConfig (solo la Casa Central puede crearla)
    const isMain = await isMainDevice();
    const config = await prisma.storeConfig.findFirst();
    if (config) {
      await prisma.storeConfig.update({
        where: { id: config.id },
        data: {
          mpAccessToken: accessToken,
          mpPublicKey: publicKey,
        },
      });
    } else if (isMain) {
      await prisma.storeConfig.create({
        data: {
          slug: 'mi-tienda',
          businessName: 'Mi Tienda',
          mpAccessToken: accessToken,
          mpPublicKey: publicKey,
          deliveryFee: new Prisma.Decimal(0),
          minDeliveryAmount: new Prisma.Decimal(0),
        },
      });
    } else {
      console.warn('[MP Callback] Esta PC es una sucursal; no se crea StoreConfig (la tienda la administra la Casa Central).');
    }

    return renderHtmlResponse(
      res,
      true,
      '¡Mercado Pago Conectado!',
      'Tu cuenta de Mercado Pago fue vinculada exitosamente con ClinPOS. Ya podés cerrar esta ventana y volver al sistema.'
    );
  } catch (err: any) {
    console.error('Mercado Pago Callback Exception:', err);
    return renderHtmlResponse(
      res,
      false,
      'Error Servidor',
      'Ocurrió una excepción inesperada al procesar la vinculación. Podés intentar nuevamente.'
    );
  }
}
