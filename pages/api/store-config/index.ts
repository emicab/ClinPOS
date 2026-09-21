// pages/api/store-config/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';
import { isMainDevice, isProDevice } from '../../../lib/branchIdentity';
import { resolveDbForRequest } from '../../../lib/requestDb';
import { Prisma } from '@prisma/client';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      const reqSlug = req.query.slug ? sanitizeString(String(req.query.slug).toLowerCase()) : null;
      const db = await resolveDbForRequest(req);
      let config = null;

      if (reqSlug) {
        config = await db.storeConfig.findFirst({ where: { slug: reqSlug } });
        if (!config) {
          return res.status(404).json({
            message: `La tienda "${reqSlug}" no existe.`,
            exists: false,
            isWebActive: false,
            slug: reqSlug,
          });
        }
      } else {
        config = await db.storeConfig.findFirst();
      }

      if (!config) {
        res.status(200).json({
          slug: reqSlug || '',
          customDomain: '',
          businessName: reqSlug ? reqSlug.toUpperCase().replace(/-/g, ' ') : 'Mi Tienda',
          description: '',
          logoUrl: '',
          bannerUrl: '',
          primaryColor: '#2563eb',
          isWebActive: false,
          mpAccessToken: '',
          mpPublicKey: '',
          mpFeePercent: '0',
          whatsappPhone: '',
          minStockBuffer: 1,
          allowPickup: true,
          allowDelivery: true,
          requireMpForDelivery: true,
          deliveryFee: '0',
          minDeliveryAmount: '0',
          businessSector: 'GASTRONOMIA',
        });
        return;
      }

      res.status(200).json({
        ...config,
        // NUNCA exponer secrets por GET público: el middleware deja pasar
        // GET /api/store-config (catálogo público) y el server escucha en la LAN.
        mpAccessToken: undefined,
        mpPublicKey: undefined,
        peyaClientId: undefined,
        peyaClientSecret: undefined,
        peyaWebhookSecret: undefined,
        rappiApiKey: undefined,
        rappiWebhookSecret: undefined,
        businessSector: config.businessSector || 'GASTRONOMIA',
        deliveryFee: config.deliveryFee ? config.deliveryFee.toString() : '0',
        minDeliveryAmount: config.minDeliveryAmount ? config.minDeliveryAmount.toString() : '0',
        mpFeePercent: config.mpFeePercent ? config.mpFeePercent.toString() : '0',
      });
      return;
    } catch (error) {
      handleApiError(res, error, "fetching store config");
      return;
    }
  } else if (req.method === 'PUT' || req.method === 'POST') {
    try {
      // La tienda web es una funcionalidad del plan Pro
      if (!(await isProDevice())) {
        res.status(403).json({ message: 'La tienda web requiere el plan Pro.' });
        return;
      }
      // La tienda web la administra SOLO la Casa Central
      if (!(await isMainDevice())) {
        res.status(403).json({ message: 'La tienda web solo se administra desde la Casa Central.' });
        return;
      }

      const {
        slug,
        customDomain,
        businessName,
        description,
        logoUrl,
        bannerUrl,
        primaryColor,
        isWebActive,
        mpAccessToken,
        mpPublicKey,
        mpFeePercent,
        whatsappPhone,
        minStockBuffer,
        allowPickup,
        allowDelivery,
        requireMpForDelivery,
        deliveryFee,
        minDeliveryAmount,
        businessSector,
        lat,
        lng,
        deliveryZones,
        openingHours,
        peyaEnabled,
        peyaClientId,
        peyaClientSecret,
        peyaChainId,
        peyaVendorId,
        peyaEnv,
        peyaAutoAccept,
        peyaConnected,
        peyaWebhookSecret,
        rappiEnabled,
        rappiApiKey,
        rappiStoreId,
        rappiAutoAccept,
        rappiWebhookSecret,
      } = req.body;

      if (!slug || !slug.trim()) {
        res.status(400).json({ message: 'El subdominio/slug de la tienda es obligatorio.' });
        return;
      }

      const cleanSlug = sanitizeString(slug.trim().toLowerCase().replace(/[^a-z0-9_\-]/gi, '-'));
      const cleanBusinessName = sanitizeString(businessName || 'Mi Tienda');
      // El dominio de la plataforma solo se actualiza si viene explícito en el body
      // (se detecta automáticamente desde clinstore vía sync). undefined = no tocar.
      const cleanCustomDomain = "customDomain" in req.body
        ? (customDomain
            ? sanitizeString(
                String(customDomain)
                  .trim()
                  .replace(/^https?:\/\//i, '')
                  .replace(/\/.*$/, '')
                  .toLowerCase(),
              ) || null
            : null)
        : undefined;

      const existingConfig = await prisma.storeConfig.findFirst();

      const parsedMpFeePercent = new Prisma.Decimal(parseFloat(mpFeePercent) || 0);
      const parsedDeliveryFee = new Prisma.Decimal(parseFloat(deliveryFee) || 0);
      const parsedMinDeliveryAmount = new Prisma.Decimal(parseFloat(minDeliveryAmount) || 0);
      const parsedMinStockBuffer = minStockBuffer !== undefined && minStockBuffer !== '' ? (Number.isFinite(Number(minStockBuffer)) ? Number(minStockBuffer) : 1) : 1;
      const validSectors = ['GASTRONOMIA', 'INDUMENTARIA', 'MINIMARKET', 'RETAIL_GENERAL'];
      const cleanBusinessSector = validSectors.includes(businessSector) ? businessSector : 'GASTRONOMIA';

      const parseCoord = (v: unknown): number | null => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null;
      };
      const cleanLat = parseCoord(lat);
      const cleanLng = parseCoord(lng);
      if ((cleanLat === null && lat !== undefined && lat !== null && lat !== '') ||
          (cleanLng === null && lng !== undefined && lng !== null && lng !== '')) {
        res.status(400).json({ message: 'Las coordenadas lat/lng no son válidas.' });
        return;
      }
      const toJsonOrNull = (v: unknown): string | null => {
        if (v === undefined || v === null || v === '') return null;
        let arr: unknown = v;
        if (typeof v === 'string') {
          try {
            arr = JSON.parse(v);
          } catch {
            return null;
          }
        }
        return Array.isArray(arr) ? JSON.stringify(arr) : null;
      };
      const cleanDeliveryZones = toJsonOrNull(deliveryZones);
      const cleanOpeningHours = toJsonOrNull(openingHours);

      // Los secrets nunca viajan por GET (seguridad), así que cuando llegan
      // vacíos desde el form se conserva el valor almacenado. Solo se
      // actualizan si el usuario escribe un valor nuevo.
      const keepOr = (incoming: unknown, existing: string | null | undefined) =>
        incoming !== undefined && String(incoming).trim() !== "" ? String(incoming) : existing ?? null;

      const peyaData = {
        peyaEnabled: peyaEnabled !== undefined ? Boolean(peyaEnabled) : existingConfig?.peyaEnabled ?? false,
        peyaClientId: keepOr(peyaClientId, existingConfig?.peyaClientId ?? null),
        peyaClientSecret: keepOr(peyaClientSecret, existingConfig?.peyaClientSecret ?? null),
        peyaChainId: keepOr(peyaChainId, existingConfig?.peyaChainId ?? null),
        peyaVendorId: keepOr(peyaVendorId, existingConfig?.peyaVendorId ?? null),
        peyaEnv: peyaEnv || existingConfig?.peyaEnv || "SANDBOX",
        peyaAutoAccept: peyaAutoAccept !== undefined ? Boolean(peyaAutoAccept) : existingConfig?.peyaAutoAccept ?? false,
        peyaConnected: peyaConnected !== undefined ? Boolean(peyaConnected) : existingConfig?.peyaConnected ?? false,
        peyaWebhookSecret: keepOr(peyaWebhookSecret, existingConfig?.peyaWebhookSecret ?? null),
        rappiEnabled: rappiEnabled !== undefined ? Boolean(rappiEnabled) : existingConfig?.rappiEnabled ?? false,
        rappiApiKey: keepOr(rappiApiKey, existingConfig?.rappiApiKey ?? null),
        rappiStoreId: keepOr(rappiStoreId, existingConfig?.rappiStoreId ?? null),
        rappiAutoAccept: rappiAutoAccept !== undefined ? Boolean(rappiAutoAccept) : existingConfig?.rappiAutoAccept ?? false,
        rappiWebhookSecret: keepOr(rappiWebhookSecret, existingConfig?.rappiWebhookSecret ?? null),
      };

      let result;
      if (existingConfig) {
        result = await prisma.storeConfig.update({
          where: { id: existingConfig.id },
          data: {
            slug: cleanSlug,
            customDomain: cleanCustomDomain,
            businessName: cleanBusinessName,
            description: description ? sanitizeString(description) : null,
            logoUrl: logoUrl || null,
            bannerUrl: bannerUrl || null,
            primaryColor: primaryColor || '#2563eb',
            isWebActive: Boolean(isWebActive),
            // Los secrets nunca viajan por GET, así que un valor vacío en el
            // form significa "conservar el almacenado" (igual que peya/rappi
            // con keepOr). Solo un valor nuevo no vacío lo reemplaza; para
            // borrar hay POST /api/mercadopago/disconnect explícito. Sin esto,
            // cada Guardar posterior al OAuth borraba el token en silencio.
            mpAccessToken: keepOr(mpAccessToken, existingConfig?.mpAccessToken ?? null),
            mpPublicKey: keepOr(mpPublicKey, existingConfig?.mpPublicKey ?? null),
            mpFeePercent: parsedMpFeePercent,
            whatsappPhone: whatsappPhone ? whatsappPhone.trim() : null,
            minStockBuffer: parsedMinStockBuffer,
            allowPickup: allowPickup !== undefined ? Boolean(allowPickup) : true,
            allowDelivery: allowDelivery !== undefined ? Boolean(allowDelivery) : true,
            requireMpForDelivery: requireMpForDelivery !== undefined ? Boolean(requireMpForDelivery) : true,
            deliveryFee: parsedDeliveryFee,
            minDeliveryAmount: parsedMinDeliveryAmount,
            businessSector: cleanBusinessSector,
            lat: cleanLat,
            lng: cleanLng,
            deliveryZones: cleanDeliveryZones,
            openingHours: cleanOpeningHours,
            ...peyaData,
          },
        });
      } else {
        result = await prisma.storeConfig.create({
          data: {
            slug: cleanSlug,
            customDomain: cleanCustomDomain,
            businessName: cleanBusinessName,
            description: description ? sanitizeString(description) : null,
            logoUrl: logoUrl || null,
            bannerUrl: bannerUrl || null,
            primaryColor: primaryColor || '#2563eb',
            isWebActive: Boolean(isWebActive),
            mpAccessToken: mpAccessToken ? mpAccessToken.trim() : null,
            mpPublicKey: mpPublicKey ? mpPublicKey.trim() : null,
            mpFeePercent: parsedMpFeePercent,
            whatsappPhone: whatsappPhone ? whatsappPhone.trim() : null,
            minStockBuffer: parsedMinStockBuffer,
            allowPickup: allowPickup !== undefined ? Boolean(allowPickup) : true,
            allowDelivery: allowDelivery !== undefined ? Boolean(allowDelivery) : true,
            requireMpForDelivery: requireMpForDelivery !== undefined ? Boolean(requireMpForDelivery) : true,
            deliveryFee: parsedDeliveryFee,
            minDeliveryAmount: parsedMinDeliveryAmount,
            businessSector: cleanBusinessSector,
            lat: cleanLat,
            lng: cleanLng,
            deliveryZones: cleanDeliveryZones,
            openingHours: cleanOpeningHours,
            ...peyaData,
          },
        });
      }

      // Sincronizar inmediatamente con Supabase en segundo plano
      // (el sync sube StoreConfig con el tenant_id real del hash de licencia)
      try {
        const { runSupabaseSync } = await import("../../../lib/syncService");
        runSupabaseSync(true).catch((err: any) => console.error("Error auto-syncing store config to Supabase:", err));
      } catch (err) {
        console.warn("Could not auto-sync store config:", err);
      }

      // Si el token de MP pasó de no-vacío a vacío, propagar el borrado a la
      // nube de forma determinística y verificada (upsert directo con
      // updatedAt = now()), para que no dependa del sync fire-and-forget ni de
      // que un sync en curso re-subiera el token desde un local desactualizado.
      // Si el token de MP pasó de no-vacío a vacío, propagar el borrado a la
      // nube usando PATCH para una actualización parcial segura.
      if (existingConfig?.mpAccessToken && !result.mpAccessToken) {
        try {
          const { getSelectiveSyncCredentials } = await import("../../../lib/syncService");
          const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
          
          // Cambiamos a PATCH y agregamos el filtro por tenant_id en la URL
          const patchRes = await fetch(`${supabaseUrl}/rest/v1/StoreConfig?tenant_id=eq.${tenantId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
            },
            // Al usar PATCH, enviamos un objeto directo en lugar de un array
            body: JSON.stringify({
              mpAccessToken: null,
              mpPublicKey: null,
              updatedAt: new Date().toISOString(),
            }),
          });
          
          if (!patchRes.ok) {
            console.error("Error al borrar credenciales MP en Supabase:", await patchRes.text());
          } else {
            console.log(`[StoreConfig] Credenciales MP borradas en Supabase (tenant ${tenantId})`);
          }
        } catch (err) {
          console.warn("No se pudo borrar las credenciales MP en Supabase:", err);
        }
      }

      res.status(200).json({
        ...result,
        deliveryFee: result.deliveryFee.toString(),
        minDeliveryAmount: result.minDeliveryAmount ? result.minDeliveryAmount.toString() : '0',
        mpFeePercent: result.mpFeePercent ? result.mpFeePercent.toString() : '0',
      });
      return;
    } catch (error) {
      handleApiError(res, error, "saving store config");
      return;
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }
}
