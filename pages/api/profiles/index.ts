import type { NextApiRequest, NextApiResponse } from 'next';
import { PrismaClient } from '@prisma/client';
import prisma, { getClientByProfileId, resetProfileCache } from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';
import {
  listProfiles,
  hasStore,
  createProfile,
  setActiveProfile,
  getActiveProfile,
  getDefaultDbFileName,
  resolveDbFile,
  getDeviceSettings,
} from '../../../lib/profiles';
import { setDeviceSettings, DEVICE_GLOBAL_KEYS } from '../../../lib/deviceSettings';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';

const VALID_SECTORS = ['GASTRONOMIA', 'INDUMENTARIA', 'MINIMARKET', 'RETAIL_GENERAL'];

const BUSINESS_TABLES = [
  'WebOrderItem', 'WebOrder', 'SaleItem', 'Sale', 'PurchaseItem', 'Purchase',
  'ComboItem', 'Combo', 'ConsignmentItem', 'Consignment', 'StockTransferItem', 'StockTransfer',
  'CashMovement', 'AccountMovement', 'CashRegister', 'AccountBalance', 'Expense',
  'ProductBranchStock', 'Product', 'Brand', 'Category', 'Supplier',
  'DiscountCode', 'Promotion', 'PromotionCondition', 'Seller', 'Branch', 'Client',
  'RecipeItem', 'RecipeCostHistory', 'ProductModifierOption', 'ProductModifierGroup',
  'SyncOutbox', 'Invoice', 'ChatSession', 'ChatMessage', 'SavedNote', 'CreditCardPromotion',
  'StoreConfig',
];

async function initFreshBusiness(client: PrismaClient, tenantId: string): Promise<void> {
  try {
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF;');
    for (const t of BUSINESS_TABLES) {
      try {
        await client.$executeRawUnsafe(`DELETE FROM "${t}";`);
      } catch {
        // tabla inexistente en este esquema: se ignora
      }
    }
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
  } catch (e) {
    console.warn('[Profiles] Error limpiando negocio nuevo:', e);
  }

  try {
    await (client as any).branch.create({
      data: { id: 1, name: 'Sucursal Principal', isMain: true },
    });
  } catch {
    // ya existe
  }

  const identityKeys = [
    'license_key', 'hardware_id', 'license_activated_at',
    'tenant_id', 'device_role', 'device_branch_id', 'business_profile',
    'supabase_last_sync',
  ];
  try {
    await (client as any).setting.deleteMany({ where: { key: { in: identityKeys } } });
  } catch {
    // ignore
  }
  try {
    await (client as any).setting.upsert({
      where: { key: 'business_profile' },
      update: { value: 'unset' },
      create: { key: 'business_profile', value: 'unset' },
    });
  } catch {
    // ignore
  }
  // Tenant único y estable del negocio nuevo (evita colisiones con otros
  // negocios en la nube). Se persiste para que el sync lo use siempre.
  try {
    await (client as any).setting.upsert({
      where: { key: 'tenant_id' },
      update: { value: tenantId },
      create: { key: 'tenant_id', value: tenantId },
    });
  } catch {
    // ignore
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const profiles = listProfiles();
      const active = getActiveProfile();
      const defaultDb = getDefaultDbFileName();
      res.status(200).json({
        profiles: profiles.map((p) => ({ ...p, deletable: p.dbFile !== defaultDb })),
        activeProfileId: active?.id ?? null,
        isMultiBusiness: profiles.length > 1,
        hasStore: hasStore(),
      });
    } catch (error) {
      handleApiError(res, error, 'listing profiles');
    }
  } else if (req.method === 'POST') {
    try {
      const { name, businessSector } = req.body || {};
      const cleanName = sanitizeString((name || '').trim());
      if (!cleanName) {
        res.status(400).json({ message: 'El nombre del negocio es obligatorio.' });
        return;
      }
      const sector = VALID_SECTORS.includes(businessSector) ? businessSector : 'RETAIL_GENERAL';

      // 1. Adoptar la DB actual como primer negocio si el registro aún no existe.
      if (!hasStore() || listProfiles().length === 0) {
        const sc = await (prisma as any).storeConfig.findFirst();
        const settings = await (prisma as any).setting.findMany();
        const map: Record<string, string> = {};
        for (const s of settings) map[s.key] = s.value;

        const legacyName = sanitizeString(sc?.businessName || map.businessName || 'Negocio Principal');
        let legacySector = 'RETAIL_GENERAL';
        if (VALID_SECTORS.includes(sc?.businessSector)) legacySector = sc.businessSector;
        else if (map.businessSector && VALID_SECTORS.includes(map.businessSector)) legacySector = map.businessSector;
        else if (map.business_profile === 'boutique') legacySector = 'INDUMENTARIA';
        else if (map.business_profile === 'gastronomia' || map.business_profile === 'kiosco') legacySector = 'GASTRONOMIA';

        await createProfile({
          id: 'legacy',
          name: legacyName,
          businessSector: legacySector,
          dbFile: getDefaultDbFileName(),
        });

        const deviceEntries: Record<string, string> = {};
        for (const k of DEVICE_GLOBAL_KEYS) {
          if (map[k] !== undefined && map[k] !== '') deviceEntries[k] = map[k];
        }
        await setDeviceSettings(deviceEntries);
        resetProfileCache();

        // Persistir el tenant legacy actual para conservar la data ya
        // sincronizada en la nube (fórmula original, sin slug).
        try {
          const hostname = os.hostname?.() || "pos_local";
          const rawTenant = (
            map.license_key?.trim() ||
            sc?.slug?.trim() ||
            map.businessCuit?.trim() ||
            map.businessName?.trim() ||
            process.env.LICENSE_KEY?.trim() ||
            process.env.HARDWARE_ID?.trim() ||
            `pos_${hostname}`
          );
          const legacyTenantId = crypto.createHash("sha256").update(rawTenant).digest("hex").slice(0, 16);
          await (prisma as any).setting.upsert({
            where: { key: 'tenant_id' },
            update: { value: legacyTenantId },
            create: { key: 'tenant_id', value: legacyTenantId },
          });
        } catch (e) {
          console.warn('[Profiles] No se pudo persistir el tenant legacy:', e);
        }
      }

      // 2. Crear el archivo de DB del negocio nuevo (clonando la DB actual, que
      // tiene el schema correcto) y registrarlo.
      const id = `b${crypto.randomBytes(5).toString('hex')}`;
      const dbFile = `business_${id}.db`;
      const src = resolveDbFile(getDefaultDbFileName());
      const dst = resolveDbFile(dbFile);
      // VACUUM INTO genera una copia consistente (incluye lo que aun esta en el
      // -wal); copiar el archivo en vivo puede perder datos o salir corrupto.
      try {
        const defaultClient = await getClientByProfileId(null);
        if (!defaultClient) throw new Error('sin cliente default');
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        await defaultClient.$executeRawUnsafe(`VACUUM INTO '${dst.replace(/\\/g, '/').replace(/'/g, "''")}'`);
      } catch (e) {
        console.warn('[Profiles] VACUUM INTO falló, se copia el archivo:', e);
        fs.copyFileSync(src, dst);
      }

      const profile = await createProfile({ id, name: cleanName, businessSector: sector, dbFile });
      resetProfileCache();
      await setActiveProfile(id);

      // 3. Inicializar el negocio nuevo (vaciarlo, semillar sucursal, forzar
      // onboarding y asignarle un tenant_id único y estable).
      const device = getDeviceSettings();
      const hostname = os.hostname?.() || "pos_local";
      const licenseBase = device.license_key?.trim() || process.env.LICENSE_KEY?.trim() || `pos_${hostname}`;
      const newTenantId = crypto.createHash("sha256").update(`${licenseBase}:${id}`).digest("hex").slice(0, 16);

      const client = await getClientByProfileId(id);
      if (client) await initFreshBusiness(client, newTenantId);

      res.status(201).json({ profile });
    } catch (error) {
      handleApiError(res, error, 'creating profile');
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
