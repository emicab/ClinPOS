import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProduction = process.env.NODE_ENV === 'production';

  // CORS restrictivo: en producción solo se refleja el origen del panel (Tauri)
  // o localhost; nunca un origin arbitrario con credenciales.
  const requestOrigin = request.headers.get('origin');
  const isAllowedOrigin =
    !requestOrigin ||
    !isProduction ||
    requestOrigin.startsWith('http://localhost:') ||
    requestOrigin.startsWith('http://127.0.0.1:') ||
    requestOrigin.startsWith('tauri://localhost') ||
    requestOrigin.startsWith('https://clinstore.vercel.app');
  const corsOrigin = isAllowedOrigin && requestOrigin ? requestOrigin : 'http://localhost:3000';

  // Helper de cabeceras CORS seguras
  const setCorsHeaders = (res: NextResponse) => {
    res.headers.set('Access-Control-Allow-Origin', corsOrigin);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-app-secret, ngrok-skip-browser-warning');
    // Credenciales solo para orígenes de confianza (panel/tauri/localhost).
    res.headers.set('Access-Control-Allow-Credentials', isAllowedOrigin ? 'true' : 'false');
    return res;
  };

  // Manejo global de CORS preflight (OPTIONS)
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 200 });
    return setCorsHeaders(response);
  }

  // Identificar rutas que son verdaderamente públicas según método HTTP
  const isStaticAsset =
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/static/') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.startsWith('/ClinPOS.png') ||
    pathname.startsWith('/IgniteCRM.png');

  // Webhooks de plataformas externas (Rappi y Mercado Pago): llegan con su
  // propio token (Authorization Bearer) que cada ruta valida. El webhook de
  // PedidosYa ya no vive en el POS: apunta a clinstore.
  const isWebhookOrMp =
    pathname.startsWith('/api/webhooks/') ||
    pathname.startsWith('/api/mercadopago/') ||
    pathname.startsWith('/api/mp/') ||
    pathname.startsWith('/api/integrations/rappi/webhook');

  // Solo POST en /api/web-orders para que la tienda cree pedidos.
  // /api/web-orders/mark-paid y GET /api/web-orders NO son públicos.
  const isPublicWebOrderCreate = pathname === '/api/web-orders' && request.method === 'POST';

  // Solo GET para catálogo público consumido por ClinStore
  const isPublicCatalogGet =
    request.method === 'GET' &&
    (pathname.startsWith('/api/products') ||
      pathname.startsWith('/api/categories') ||
      pathname.startsWith('/api/coupons/validate') ||
      pathname.startsWith('/api/store-config') ||
      pathname.startsWith('/api/sync/status'));

  // Salud del esquema local: la sondea el arranque de Tauri antes de navegar.
  // Solo expone nombres de tablas/columnas faltantes, nunca datos ni secrets.
  const isPublicHealthGet =
    request.method === 'GET' && pathname.startsWith('/api/health/');

  const isPublicRoute = isStaticAsset || isWebhookOrMp || isPublicWebOrderCreate || isPublicCatalogGet || isPublicHealthGet;

  if (isPublicRoute) {
    return setCorsHeaders(NextResponse.next());
  }

  // Validación de seguridad interna de escritorio en producción
  if (process.env.NODE_ENV === 'production') {
    const appSecret = process.env.APP_SECRET;

    if (appSecret) {
      const incomingSecretHeader = request.headers.get('x-app-secret');
      const incomingSecretCookie = request.cookies.get('app_auth_token')?.value;
      const urlToken = request.nextUrl.searchParams.get('_token');

      // Si el token de Tauri viene por query string y es válido, lo guardamos en cookie
      if (urlToken === appSecret) {
        const url = request.nextUrl.clone();
        url.searchParams.delete('_token');
        const response = NextResponse.redirect(url);

        response.cookies.set('app_auth_token', appSecret, {
          httpOnly: true,
          // El servidor embebido de Tauri escucha en http://localhost. Enviar
          // Secure=true en ese origen hace que el WebView descarte la cookie y
          // todas las llamadas privadas vuelvan a ser bloqueadas.
          secure: request.nextUrl.protocol === 'https:',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 365, // 1 año
        });
        return setCorsHeaders(response);
      }

      // Si no coincide la cookie ni la cabecera, denegamos el acceso a endpoints privados
      if (incomingSecretHeader !== appSecret && incomingSecretCookie !== appSecret) {
        const clientIp = request.headers.get('x-forwarded-for') || 'desconocido';
        console.warn(`[Security] Bloqueado intento de acceso no autorizado a ${pathname} (${request.method}) desde ${clientIp}`);

        if (pathname.startsWith('/api/')) {
          const forbiddenRes = new NextResponse(
            JSON.stringify({ success: false, error: 'Access Denied: Unauthenticated' }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          );
          return setCorsHeaders(forbiddenRes);
        }

        return new NextResponse(
          `<!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Acceso Denegado - ClinPOS</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #090d16; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background-color: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 400px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
                h1 { color: #f43f5e; margin-top: 0; font-size: 1.5rem; }
                p { color: #9ca3af; font-size: 0.95rem; line-height: 1.5; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Acceso Denegado</h1>
                <p>Este servidor local está protegido y sólo responde a las peticiones del panel oficial de ClinPOS desktop.</p>
              </div>
            </body>
          </html>`,
          { status: 403, headers: { 'content-type': 'text/html' } }
        );
      }
    }
  }

  return setCorsHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
