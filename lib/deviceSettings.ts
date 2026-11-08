// lib/deviceSettings.ts
// Configuración a nivel máquina (licencia, plan, credenciales de Supabase).
// En modo multi-negocio vive en store.json; en instalaciones legacy (un solo
// negocio) sigue viviendo en la tabla Setting de la DB local.
import {
  hasStore,
  getDeviceSetting as getMetaDeviceSetting,
  setDeviceSettings as setMetaDeviceSettings,
} from './profiles';

// Claves que pertenecen a la MÁQUINA (no al negocio). Se comparten entre
// todos los negocios de esta PC.
export const DEVICE_GLOBAL_KEYS = [
  'license_key',
  'hardware_id',
  'license_activated_at',
  'app_plan',
  'plan_type',
  'unlocked_plan_pro',
  'storage_mode',
  'cloud_sync_enabled',
  'supabase_url',
  'supabase_anon_key',
  'supabase_service_role_key',
];

export function isDeviceGlobalKey(key: string): boolean {
  return DEVICE_GLOBAL_KEYS.includes(key);
}

export async function getDeviceSetting(key: string): Promise<string | null> {
  if (hasStore()) {
    const meta = getMetaDeviceSetting(key);
    if (meta !== null) return meta;
  }
  try {
    const prisma = (await import('./prisma')).default;
    const s = await (prisma as any).setting.findUnique({ where: { key } });
    return s?.value ?? null;
  } catch {
    return null;
  }
}

export async function setDeviceSetting(key: string, value: string): Promise<void> {
  if (hasStore()) {
    setMetaDeviceSettings({ [key]: value });
  }
  try {
    const prisma = (await import('./prisma')).default;
    await (prisma as any).setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  } catch {
    // ignore
  }
}

export async function setDeviceSettings(entries: Record<string, string>): Promise<void> {
  if (hasStore()) {
    setMetaDeviceSettings(entries);
  }
  try {
    const prisma = (await import('./prisma')).default;
    for (const [key, value] of Object.entries(entries)) {
      await (prisma as any).setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  } catch {
    // ignore
  }
}
