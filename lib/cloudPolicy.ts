// lib/cloudPolicy.ts
// Interruptor maestro del modo local. Cuando `cloud_sync_enabled` está apagado
// (valor por defecto), la base SQLite local es la única fuente de verdad:
// no se encola nada para la nube, no se sube ni se baja información y la UI no
// muestra avisos de sincronización. El código de sync queda dormido detrás de
// este flag para poder reactivarlo sin borrar nada.
import { getDeviceSetting } from "./deviceSettings";

export const CLOUD_SYNC_SETTING_KEY = "cloud_sync_enabled";
// Modo local permanente: solo una activación explícita habilita la nube.
export const CLOUD_SYNC_DEFAULT = false;

const CACHE_TTL_MS = 5000;

let cached: { value: boolean; expiresAt: number } | null = null;

/** Invalida el cache corto (se llama al guardar la configuración). */
export function invalidateCloudPolicyCache(): void {
  cached = null;
}

function parseFlag(raw: string | null): boolean {
  if (raw === null || raw === undefined || raw === "") {
    return CLOUD_SYNC_DEFAULT;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "si" || normalized === "sí";
}

/**
 * True solo si la nube fue habilitada explícitamente en esta instalación.
 * Lectura con cache corto para no consultar la DB en cada operación.
 */
export async function isCloudSyncEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const raw = await getDeviceSetting(CLOUD_SYNC_SETTING_KEY);
  const value = parseFlag(raw);
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}
