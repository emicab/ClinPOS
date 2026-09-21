// lib/syncService.ts
// Orquestación del sync a Supabase + helpers de sync puntual (selectivo).
// Las fases del sync completo viven en lib/syncPhases.ts (grafo acíclico).
import prisma from "./prisma";
import os from "os";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { isMainDevice } from "./branchIdentity";
import { getDataDir, getDeviceSettings } from "./profiles";
import {
  fetchWithTimeout,
  recalcProductTotal,
  recalcProductTotals,
  getMainBranchId,
  isCloudAllowed,
  revalidateLicenseIfMain,
  bootstrapBranchStocks,
  loadLocalEntities,
  mapCloudWebOrderIds,
  buildPushPayload,
  refreshStoreConfigPayload,
  refreshProductPayload,
  pullWebOrdersFromCloud,
  pullStoreConfigFromCloud,
  pullPlanFromCloud,
  pullCoreEntitiesFromCloud,
  toProductPayload,
  toPbsPayload,
  toRecipeItemPayload,
  buildModifierPayloads,
  toBrandPayload,
  toCategoryPayload,
  toSupplierPayload,
  toWebOrderPayload,
  toWebOrderItemPayload,
  toStockTransferPayload,
  toStockTransferItemPayload,
  type SyncPhaseContext,
  type SyncCursors,
} from "./syncPhases";

const SYNC_CURSORS_SETTING = "supabase_sync_cursors";

// Solo metadatos del JWT (rol/ref/longitud). Nunca loguear el secreto.
function describeSupabaseKey(key: string): { role: string | null; ref: string | null; len: number } {
  const len = key?.length || 0;
  try {
    const parts = key.split(".");
    if (parts.length < 2) return { role: null, ref: null, len };
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return {
      role: typeof payload.role === "string" ? payload.role : null,
      ref: typeof payload.ref === "string" ? payload.ref : null,
      len,
    };
  } catch {
    return { role: null, ref: null, len };
  }
}

function extractSupabaseRef(url: string): string | null {
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

function parseSyncCursors(value?: string): SyncCursors {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadConfigFromDb(): Promise<Record<string, string>> {
  const settings = await prisma.setting.findMany();
  const config: Record<string, string> = {};
  for (const s of settings) {
    // Los valores de Setting se guardan sin trim (a diferencia de envLoader).
    // Un service_role con espacios o salto de línea da 401 global en PostgREST.
    config[s.key] = typeof s.value === "string" ? s.value.trim() : s.value;
  }
  // Overlay de settings a nivel máquina (licencia, plan, credenciales Supabase)
  // para que el sync use las mismas credenciales en todos los negocios.
  const device = getDeviceSettings();
  for (const [k, v] of Object.entries(device)) {
    config[k] = v;
  }
  return config;
}

export async function getSelectiveSyncCredentials(): Promise<{
  supabaseUrl: string;
  supabaseKey: string;
  tenantId: string;
}> {
  const config = await loadConfigFromDb();

  const supabaseUrl = (config.supabase_url || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const serviceRoleFromDb = (config.supabase_service_role_key || "").trim();
  const serviceRoleFromEnv = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const anonFromDb = (config.supabase_anon_key || "").trim();
  const anonFromEnv = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  const supabaseKey = serviceRoleFromDb || serviceRoleFromEnv || anonFromDb || anonFromEnv;
  const keySource = serviceRoleFromDb ? "setting:supabase_service_role_key"
    : serviceRoleFromEnv ? "env:SUPABASE_SERVICE_ROLE_KEY"
    : anonFromDb ? "setting:supabase_anon_key"
    : "env:anon/publishable";

  // Diagnóstico sin exponer el secreto: rol + ref del JWT y longitud.
  // StoreConfig es la única tabla con REVOKE por columna (mpAccessToken,
  // peyaWebhookSecret): con anon key el upsert/pull de esa tabla da 401
  // aunque el resto pase. Ver sql/20260810_hardening_stock_mp.sql.
  const keyInfo = describeSupabaseKey(supabaseKey);
  const urlRef = extractSupabaseRef(supabaseUrl);
  if (keyInfo.role === "anon") {
    console.warn(`[Sync] Credencial efectiva: anon (${keySource}). StoreConfig requiere service_role por el hardening de mpAccessToken/peyaWebhookSecret; con anon el sync de esa tabla falla con 401. Configure supabase_service_role_key a nivel máquina.`);
  } else if (keyInfo.role) {
    console.log(`[Sync] Credencial efectiva: ${keyInfo.role} (${keySource}, len=${keyInfo.len}).`);
  }
  if (urlRef && keyInfo.ref && urlRef !== keyInfo.ref) {
    console.warn(`[Sync] El ref del JWT (${keyInfo.ref}) no coincide con el de la URL (${urlRef}). La key es de otro proyecto: todos los upserts darán 401.`);
  }

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Credenciales de Supabase no configuradas. Debe configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY " +
      "en .env o en la configuración del sistema antes de sincronizar."
    );
  }

  const storeConfigs = await prisma.storeConfig.findMany();
  const firstStoreConfig = storeConfigs[0];

  // Sucursal emparejada: el tenant_id asignado por el código manda sobre cualquier otro cálculo.
  const storedTenantId = config.tenant_id?.trim();
  let tenantId: string;
  if (storedTenantId) {
    tenantId = storedTenantId;
  } else {
    const computerHostname = typeof os.hostname === "function" ? os.hostname() : "pos_local";
    const rawTenant = (
      config.license_key?.trim() ||
      firstStoreConfig?.slug?.trim() ||
      config.businessCuit?.trim() ||
      config.businessName?.trim() ||
      process.env.LICENSE_KEY?.trim() ||
      process.env.HARDWARE_ID?.trim() ||
      `pos_${computerHostname}`
    );
    // El tenant_id se persiste por negocio en su DB local (Setting.tenant_id)
    // cuando se adopta/crea el negocio, así que este fallback solo aplica a
    // instalaciones legacy de un solo negocio (fórmula original, sin slug).
    tenantId = crypto.createHash("sha256").update(rawTenant).digest("hex").slice(0, 16);
  }

  return { supabaseUrl, supabaseKey, tenantId };
}

type SyncResult = {
  success: boolean;
  message?: string;
  lastSync?: string;
  syncedTables?: Record<string, number>;
  tenantId?: string;
};

// Evita que el auto-sync y un sync manual trabajen sobre el mismo watermark
// al mismo tiempo. Esto es especialmente importante porque el flujo hace
// PULL y PUSH en varias fases y no es transaccional entre todas las tablas.
let activeSyncPromise: Promise<SyncResult> | null = null;

const SYNC_LOCK_FILE = "clinpos-sync.lock";
const SYNC_LOCK_MAX_AGE_MS = 15 * 60 * 1000;

async function acquirePersistentSyncLock(): Promise<(() => Promise<void>) | null> {
  const lockPath = path.join(getDataDir(), SYNC_LOCK_FILE);
  const token = `${process.pid}:${crypto.randomBytes(12).toString("hex")}`;

  const tryCreate = async (): Promise<boolean> => {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      return false;
    }
  };

  let acquired = await tryCreate();
  if (!acquired) {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > SYNC_LOCK_MAX_AGE_MS) {
        await fs.unlink(lockPath);
        acquired = await tryCreate();
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") acquired = await tryCreate();
    }
  }

  if (!acquired) return null;

  return async () => {
    try {
      const raw = await fs.readFile(lockPath, "utf8");
      if (raw.includes(token)) await fs.unlink(lockPath);
    } catch {
      // Si otro proceso recuperó un lock vencido, no debemos borrarlo.
    }
  };
}

async function runSupabaseSyncInternal(forceFullSync: boolean = false): Promise<SyncResult> {
  try {
    const { loadEnv } = await import("./envLoader");
    loadEnv();

    const config = await loadConfigFromDb();
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
    const lastSyncStr = config.supabase_last_sync;
    const syncCursors = parseSyncCursors(config[SYNC_CURSORS_SETTING]);

    const isMainDeviceFlag = await isMainDevice();

    // La Casa Central revalida su licencia online en cada sync: si el plan bajó
    // (mensualidad no renovada) se actualiza app_plan local y se propaga a la
    // nube para que las sucursales también bajen.
    await revalidateLicenseIfMain(isMainDeviceFlag);

    // La sincronización en la nube es exclusiva del Plan Pro.
    if (!(await isCloudAllowed())) {
      return {
        success: false,
        message: "La sincronización en la nube requiere el Plan Pro.",
      };
    }

    const lastSync = (forceFullSync || !lastSyncStr) ? new Date(0) : new Date(lastSyncStr);
    const syncStartTime = new Date();

    const productIdsToRecalc = new Set<number>();

    const mainBranchId = await getMainBranchId();
    await bootstrapBranchStocks(mainBranchId);

    const entities = await loadLocalEntities(lastSync, forceFullSync, syncCursors);
    const firstStoreConfig = entities.storeConfigs[0];
    const supabaseWebOrderIds = await mapCloudWebOrderIds(supabaseUrl, supabaseKey, tenantId);

    const ctx: SyncPhaseContext = {
      supabaseUrl,
      supabaseKey,
      tenantId,
      forceFullSync,
      lastSync,
      isMainDeviceFlag,
      mainBranchId,
      productIdsToRecalc,
    };

    const payload = buildPushPayload(tenantId, isMainDeviceFlag, entities, supabaseWebOrderIds, config);

    // [MODIFICADO BUG 2] PULL de Supabase ANTES del PUSH ("último escritor gana")
    await pullWebOrdersFromCloud(ctx);
    await pullStoreConfigFromCloud(ctx, firstStoreConfig);
    if (!isMainDeviceFlag) {
      await pullPlanFromCloud(ctx);
    }
    await pullCoreEntitiesFromCloud(ctx);

    // Reconstruir StoreConfig justo antes del PUSH usando el estado local tras el
    // PULL ("último escritor gana"). Evita re-subir un mpAccessToken que acaba de
    // borrarse en la nube: si el pull lo vació localmente, acá se sube vacío.
    if (isMainDeviceFlag) {
      await refreshStoreConfigPayload(payload, tenantId);
    }

    // 6c. Recalcular el total (PULL PUSH fix)
    await recalcProductTotals(productIdsToRecalc);

    // [HOTFIX BUG 2] Refrescar los arrays del payload antes del PUSH para garantizar que se suban los datos unificados y evitar pisar los datos de Supabase.
    if (productIdsToRecalc.size > 0) {
      await refreshProductPayload(payload, tenantId, forceFullSync, lastSync);
    }

    // 6. Enviar datos a Supabase tabla por tabla (StoreConfig primero).
    //    Tolerante: si una tabla falla (ej. columna que aún no existe en la
    //    nube), el resto del sync continúa y el fallo se reporta en `failed`.
    const { summary, failed } = await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload, { tolerant: true });

    if (failed.length > 0) {
      const failedTables = failed.map(f => `${f.table} [HTTP ${f.status}]`).join(", ");
      console.warn(`[Sync] Sincronización parcial: fallaron tablas → ${failedTables}`);
      return {
        success: false,
        message: `Sincronización parcial: no se pudieron subir ${failed.length} tabla(s) (${failedTables}). Se reintentará en el próximo sync.`,
        syncedTables: summary,
        tenantId
      };
    }

    // 6b. Drenar el outbox (operaciones que el watermark no cubre: borrados,
    //     pedidos web creados localmente, etc.). Si hay error de red, dejamos
    //     el watermark sin actualizar para reintentar en el próximo sync.
    let outboxNetworkError = false;
    try {
      const { drainOutbox } = await import("./syncOutbox");
      const outboxResult = await drainOutbox(1000);
      outboxNetworkError = outboxResult.networkError;
      if (outboxResult.drained > 0) {
        console.log(`[Sync] Outbox drenado: ${outboxResult.drained} operación(es). Pendientes: ${outboxResult.remaining}`);
      }
    } catch (outboxErr) {
      console.warn("[Sync] Error al drenar el outbox:", outboxErr);
    }

    if (outboxNetworkError) {
      return {
        success: false,
        message: "Sincronización parcial: quedaron operaciones pendientes por falta de conexión.",
      };
    }

    // 7. Actualizar marca de tiempo de última sincronización
    const syncTimeString = syncStartTime.toISOString();
    console.log(`[Sync] Saving lastSync: ${syncTimeString}`);
    await prisma.setting.upsert({
      where: { key: "supabase_last_sync" },
      update: { value: syncTimeString },
      create: { key: "supabase_last_sync", value: syncTimeString }
    });

    // Cursor por dominio: queda actualizado solo cuando todo el ciclo y el
    // outbox terminaron correctamente. El watermark global se conserva para
    // compatibilidad con instalaciones anteriores.
    const nextCursors: SyncCursors = {
      ...syncCursors,
      default: syncTimeString,
      Branch: syncTimeString,
      Brand: syncTimeString,
      Category: syncTimeString,
      Supplier: syncTimeString,
      DiscountCode: syncTimeString,
      Promotion: syncTimeString,
      Client: syncTimeString,
      Seller: syncTimeString,
      User: syncTimeString,
      Product: syncTimeString,
      ProductBranchStock: syncTimeString,
      CashRegister: syncTimeString,
      AccountBalance: syncTimeString,
      Combo: syncTimeString,
      Sale: syncTimeString,
      Purchase: syncTimeString,
      Expense: syncTimeString,
      CashMovement: syncTimeString,
      AccountMovement: syncTimeString,
      WebOrder: syncTimeString,
      StockTransfer: syncTimeString,
      ProductModifierGroup: syncTimeString,
    };
    await prisma.setting.upsert({
      where: { key: SYNC_CURSORS_SETTING },
      update: { value: JSON.stringify(nextCursors) },
      create: { key: SYNC_CURSORS_SETTING, value: JSON.stringify(nextCursors) },
    });

    console.log(`[Sync] Finished successfully.`);

    return {
      success: true,
      message: `Sincronización realizada con éxito. Identificador de Local: ${tenantId}`,
      lastSync: syncTimeString,
      syncedTables: summary,
      tenantId
    };
  } catch (error: any) {
    console.error("Error en runSupabaseSync:", error);
    return {
      success: false,
      message: error.message || "Error al sincronizar con Supabase."
    };
  }
}

export function runSupabaseSync(forceFullSync: boolean = false): Promise<SyncResult> {
  if (activeSyncPromise) {
    console.warn("[Sync] Ya hay una sincronización en curso; se reutiliza su resultado.");
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const releaseLock = await acquirePersistentSyncLock();
    if (!releaseLock) {
      return {
        success: true,
        message: "Ya hay otra sincronización en curso. Se continuará automáticamente.",
      };
    }
    try {
      return await runSupabaseSyncInternal(forceFullSync);
    } finally {
      await releaseLock();
    }
  })().finally(() => {
    activeSyncPromise = null;
  });

  return activeSyncPromise;
}

// ===== SELECTIVE SYNC HELPERS =====

// Cuando la nube todavía no tiene una columna (PGRST204 o 42703), reintentamos
// el upsert con un payload reducido que omite los campos que aún no existen en
// Supabase. Esto permite sincronizar aunque la migración SQL de la nube esté
// pendiente (ej. isPublicWeb/webCategory en Product, o discountType/discountValue/
// minPurchase en DiscountCode) sin romper el resto del sync.
const PGRST204_FALLBACKS: Record<string, (records: any[]) => any[]> = {
  Product: (records) => records.map(({ isPublicWeb, webCategory, webUnavailable, externalSku, lastSyncJobId, ...rest }) => rest),
  DiscountCode: (records) => records.map(({ discountType, discountValue, minPurchase, ...rest }) => rest),
  // La nube base (supabase_schema.sql) no tiene las columnas de fase 2
  // (lat/lng/deliveryZones/openingHours, ver 20260809_fase2_tienda_vende.sql)
  // ni requireMpForDelivery (20260810_hardening_stock_mp.sql:109), ni
  // customDomain/rappi*/peyaClient* del schema local. Si la migración de la
  // nube está pendiente el upsert da PGRST204/42703: se reintenta sin ellas.
  // mpAccessToken/mpPublicKey/businessSector sí están en la base y se conservan.
  StoreConfig: (records) => records.map(({ businessSector, rappiWebhookSecret, peyaEnabled, peyaChainId, peyaVendorId, peyaEnv, peyaAutoAccept, peyaConnected, peyaWebhookSecret, lat, lng, deliveryZones, openingHours, requireMpForDelivery, customDomain, peyaClientId, peyaClientSecret, peyaOutletStatus, rappiEnabled, rappiConnected, rappiApiKey, rappiStoreId, rappiAutoAccept, rappiOutletStatus, ...rest }) => rest),
  WebOrder: (records) => records.map(({ discountBreakdown, orderCode, externalOrderId, chainId, vendorId, transportType, promisedFor, acceptedFor, riderInfo, ...rest }) => rest),
  WebOrderItem: (records) => records.map(({ externalItemId, ...rest }) => rest),
};

export async function pushEntitiesToSupabase(
  supabaseUrl: string,
  supabaseKey: string,
  payload: Record<string, any[]>,
  options: { tolerant?: boolean } = {}
): Promise<{ summary: Record<string, number>; failed: { table: string; status: number; body: string }[] }> {
  const { tolerant = false } = options;
  const summary: Record<string, number> = {};
  const failed: { table: string; status: number; body: string }[] = [];

  const priorityTable = Object.keys(payload).includes("StoreConfig") ? "StoreConfig" : null;
  const orderedTables = priorityTable
    ? [priorityTable, ...Object.keys(payload).filter(t => t !== priorityTable)]
    : Object.keys(payload);

  for (const tableName of orderedTables) {
    const records = payload[tableName];
    if (!records || records.length === 0) continue;

    const url = `${supabaseUrl}/rest/v1/${tableName}`;
    const headers = {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Prefer": "resolution=merge-duplicates"
    };
    const upsert = (r: any[]) => fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(r) });

    let res = await upsert(records);

    if (!res.ok) {
      const errorText = await res.text();
      const isMissingColumn = errorText.includes("PGRST204") || errorText.includes("42703");
      const fallback = isMissingColumn ? PGRST204_FALLBACKS[tableName] : null;

      if (fallback) {
        res = await upsert(fallback(records));
        if (!res.ok) {
          const retryText = await res.text();
          if (tolerant) {
            failed.push({ table: tableName, status: res.status, body: retryText.slice(0, 500) });
            console.warn(`[Sync] Upsert falló [Tabla: ${tableName}] (HTTP ${res.status}) tras fallback de columnas. Se omite y continúa:`, retryText.slice(0, 500));
            continue;
          }
          throw new Error(`Error en Supabase upsert [Tabla: ${tableName}]: [HTTP ${res.status}] ${retryText}`);
        }
      } else {
        if (tolerant) {
          failed.push({ table: tableName, status: res.status, body: errorText.slice(0, 500) });
          if (res.status === 401 && tableName === "StoreConfig") {
            const role = describeSupabaseKey(supabaseKey).role || "desconocido";
            console.warn(`[Sync] Upsert falló [Tabla: StoreConfig] (HTTP 401, key role=${role}). Causa probable: sync con anon key + REVOKE por columna (mpAccessToken/peyaWebhookSecret) o service_role de otro proyecto/rotada. Verifique supabase_service_role_key del dispositivo. Detalle:`, errorText.slice(0, 500));
          } else {
            console.warn(`[Sync] Upsert falló [Tabla: ${tableName}] (HTTP ${res.status}). Se omite y continúa:`, errorText.slice(0, 500));
          }
          continue;
        }
        throw new Error(`Error en Supabase upsert [Tabla: ${tableName}]: [HTTP ${res.status}] ${errorText}`);
      }
    }

    summary[tableName] = records.length;
  }

  return { summary, failed };
}

// Sincroniza RecipeItem de productos puntuales: primero borra los items de esos
// productos en la nube (evita huérfanos cuando la receta perdió ingredientes) y
// después inserta el set actual con ids deterministas (productId*1000+i).
async function pushRecipeItemsToSupabase(
  supabaseUrl: string,
  supabaseKey: string,
  tenantId: string,
  productIds: number[],
  recipeItems: any[]
): Promise<void> {
  if (productIds.length === 0) return;
  const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" };
  const url = `${supabaseUrl}/rest/v1/RecipeItem`;
  const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

  // 1. Borrar items actuales de los productos (para no dejar huérfanos).
  const idsParam = productIds.join(",");
  await fetch(`${url}?${tenantParam}&productId=in.(${idsParam})`, {
    method: "DELETE",
    headers,
  }).catch((err) => console.warn("[Sync] Error al limpiar RecipeItem en la nube:", err));

  // 2. Insertar el set actual.
  if (recipeItems.length === 0) return;
  const counters = new Map<number, number>();
  const records = recipeItems.map((ri) => {
    const idx = counters.get(ri.productId) ?? 0;
    counters.set(ri.productId, idx + 1);
    return toRecipeItemPayload(ri, idx, tenantId);
  });
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(records),
  }).catch((err) => console.warn("[Sync] Error al subir RecipeItem a la nube:", err));
}

// Sincroniza los grupos/opciones de modifiers de productos puntuales: borra los
// registros de esos productos en la nube y re-inserta el set actual con ids
// deterministas (mismo patrón que pushRecipeItemsToSupabase).
export async function syncModifierGroupsForProducts(tenantId: string, productIds: number[]): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  if (productIds.length === 0) return true;
  try {
    const { supabaseUrl, supabaseKey } = await getSelectiveSyncCredentials();
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" };
    const idsParam = productIds.join(",");
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    // 1. Cargar grupos locales para calcular sus ids deterministas de nube y borrar opciones/grupos.
    const groups = await prisma.productModifierGroup.findMany({
      where: { productId: { in: productIds } },
      orderBy: { id: "asc" },
    });
    const counters = new Map<number, number>();
    const cloudGroupIds = groups.map((g) => {
      const idx = counters.get(g.productId) ?? 0;
      counters.set(g.productId, idx + 1);
      return Number(g.productId) * 1000000 + idx;
    });

    // 2. Borrar opciones y grupos de esos productos (evita huérfanos).
    if (cloudGroupIds.length > 0) {
      await fetch(`${supabaseUrl}/rest/v1/ProductModifierOption?${tenantParam}&modifierGroupId=in.(${cloudGroupIds.join(",")})`, {
        method: "DELETE",
        headers,
      }).catch((err) => console.warn("[Sync] Error al limpiar ProductModifierOption en la nube:", err));
    }
    await fetch(`${supabaseUrl}/rest/v1/ProductModifierGroup?${tenantParam}&productId=in.(${idsParam})`, {
      method: "DELETE",
      headers,
    }).catch((err) => console.warn("[Sync] Error al limpiar ProductModifierGroup en la nube:", err));

    // 3. Subir el set actual con ids deterministas.
    if (groups.length === 0) return true;

    const options = await prisma.productModifierOption.findMany({
      where: { modifierGroup: { productId: { in: productIds } } },
      orderBy: { id: "asc" },
      include: { modifierGroup: { select: { id: true, productId: true } } },
    });

    const { ProductModifierGroup, ProductModifierOption } = buildModifierPayloads(groups, options, tenantId);

    if (ProductModifierGroup.length > 0) {
      await fetch(`${supabaseUrl}/rest/v1/ProductModifierGroup`, {
        method: "POST",
        headers,
        body: JSON.stringify(ProductModifierGroup),
      }).catch((err) => console.warn("[Sync] Error al subir ProductModifierGroup a la nube:", err));
    }
    if (ProductModifierOption.length > 0) {
      await fetch(`${supabaseUrl}/rest/v1/ProductModifierOption`, {
        method: "POST",
        headers,
        body: JSON.stringify(ProductModifierOption),
      }).catch((err) => console.warn("[Sync] Error al subir ProductModifierOption a la nube:", err));
    }
    return true;
  } catch (error) {
    console.error("Error en syncModifierGroupsForProducts:", error);
    return false;
  }
}

export async function syncSingleProduct(productId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { brand: true, category: true, supplier: true, branchStocks: true }
    });
    if (!product) return false;

    const payload: Record<string, any[]> = {};

    if (product.brand) payload.Brand = [toBrandPayload(product.brand, tenantId)];
    if (product.category) payload.Category = [toCategoryPayload(product.category, tenantId)];
    if (product.supplier) payload.Supplier = [toSupplierPayload(product.supplier, tenantId)];

    payload.Product = [toProductPayload(product, tenantId)];

    payload.ProductBranchStock = (product.branchStocks || []).map(bs => toPbsPayload(bs, tenantId));

    const recipeItems = await prisma.recipeItem.findMany({
      where: { productId },
      orderBy: { ingredientId: "asc" },
    });
    await pushRecipeItemsToSupabase(supabaseUrl, supabaseKey, tenantId, [productId], recipeItems);
    await syncModifierGroupsForProducts(tenantId, [productId]);

    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);

    // [MODIFICADO BUG 3] Bajar los cambios desde el otro POS (ej. stock descontado por ventas) y recalcular local
    await pullSingleProductStock(productId);

    return true;
  } catch (error) {
    console.error("Error en syncSingleProduct:", error);
    return false;
  }
}

export async function syncProducts(productIds: number[]): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { brand: true, category: true, supplier: true, branchStocks: true }
    });
    if (products.length === 0) return false;

    const brands = Array.from(new Map(products.filter(p => p.brand).map(p => [p.brand!.id, p.brand!])).values());
    const categories = Array.from(new Map(products.filter(p => p.category).map(p => [p.category!.id, p.category!])).values());
    const suppliers = Array.from(new Map(products.filter(p => p.supplier).map(p => [p.supplier!.id, p.supplier!])).values());
    const branchStocks = products.flatMap(p => p.branchStocks || []);

    const payload: Record<string, any[]> = {};

    if (brands.length > 0) payload.Brand = brands.map(b => toBrandPayload(b, tenantId));
    if (categories.length > 0) payload.Category = categories.map(c => toCategoryPayload(c, tenantId));
    if (suppliers.length > 0) payload.Supplier = suppliers.map(s => toSupplierPayload(s, tenantId));

    payload.Product = products.map(p => toProductPayload(p, tenantId));
    payload.ProductBranchStock = branchStocks.map(bs => toPbsPayload(bs, tenantId));

    const recipeItems = await prisma.recipeItem.findMany({
      where: { productId: { in: productIds } },
      orderBy: { ingredientId: "asc" },
    });
    await pushRecipeItemsToSupabase(supabaseUrl, supabaseKey, tenantId, productIds, recipeItems);
    await syncModifierGroupsForProducts(tenantId, productIds);

    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);
    return true;
  } catch (error) {
    console.error("Error en syncProducts:", error);
    return false;
  }
}

export async function deleteProductFromSupabase(productId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const url = `${supabaseUrl}/rest/v1/Product?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${productId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      }
    });

    return res.ok;
  } catch (error) {
    console.error("Error en deleteProductFromSupabase:", error);
    return false;
  }
}

export async function deleteSaleFromSupabase(saleId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const url = `${supabaseUrl}/rest/v1/Sale?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${saleId}`;
    const res = await fetch(url, { method: "DELETE", headers });
    return res.ok;
  } catch (error) {
    console.error("Error en deleteSaleFromSupabase:", error);
    return false;
  }
}

export async function deleteComboFromSupabase(comboId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    // Borrar items del combo y el combo.
    await fetch(`${supabaseUrl}/rest/v1/ComboItem?${tenantParam}&comboId=eq.${comboId}`, { method: "DELETE", headers });
    const res = await fetch(`${supabaseUrl}/rest/v1/Combo?${tenantParam}&id=eq.${comboId}`, { method: "DELETE", headers });

    return res.ok;
  } catch (error) {
    console.error("Error en deleteComboFromSupabase:", error);
    return false;
  }
}

export async function deletePromotionFromSupabase(promotionId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    // PromotionCondition no existe como tabla en Supabase (las condiciones viajan
    // embebidas en Promotion.conditions), así que solo se borra la promoción.
    const res = await fetch(`${supabaseUrl}/rest/v1/Promotion?${tenantParam}&id=eq.${promotionId}`, { method: "DELETE", headers });

    return res.ok;
  } catch (error) {
    console.error("Error en deletePromotionFromSupabase:", error);
    return false;
  }
}

export async function syncWebOrderToSupabase(orderId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const order = await prisma.webOrder.findUnique({
      where: { id: orderId },
      include: { items: true }
    });
    if (!order) return false;

    // [FIX 409] Las órdenes creadas por clinstore tienen un id distinto al local.
    // Hay que mapear webOrderNumber -> id de nube (como hace el full sync) para
    // que el upsert por PK (tenant_id, id) actualice en vez de intentar insertar
    // y violar el UNIQUE (tenant_id, webOrderNumber).
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    let cloudId = order.id;
    try {
      const idRes = await fetch(
        `${supabaseUrl}/rest/v1/WebOrder?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,webOrderNumber`,
        { headers }
      );
      if (idRes.ok) {
        const existing: { id: number; webOrderNumber: string }[] = await idRes.json();
        const match = existing.find(o => o.webOrderNumber === order.webOrderNumber);
        if (match) cloudId = match.id;
      }
    } catch (mapErr) {
      console.warn("[Sync] No se pudieron mapear ids de WebOrders:", mapErr);
    }

    const payload: Record<string, any[]> = {
      WebOrder: [toWebOrderPayload(order, cloudId, tenantId)],
      WebOrderItem: order.items.map((i, index) => toWebOrderItemPayload(i, cloudId, index, tenantId))
    };

    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);
    return true;
  } catch (error) {
    console.error("Error en syncWebOrderToSupabase:", error);
    return false;
  }
}

export async function deleteWebOrdersFromSupabase(webOrderNumbers: string[]): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const numbers = [...new Set(webOrderNumbers)].filter(Boolean);
    if (numbers.length === 0) return true;

    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" };
    const apiBase = `${supabaseUrl}/rest/v1`;
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    let allSupabaseIds: number[] = [];
    for (const num of numbers) {
      const p = `webOrderNumber=eq.${encodeURIComponent(num)}`;
      const r = await fetch(`${apiBase}/WebOrder?${tenantParam}&${p}&select=id`, { headers });
      if (r.ok) {
        const rows: { id: number }[] = await r.json();
        allSupabaseIds.push(...rows.map(x => x.id));
      }
    }

    const itemsDeleteIds = [...new Set(allSupabaseIds)];
    if (itemsDeleteIds.length > 0) {
      const idList = itemsDeleteIds.join(",");
      await fetch(`${apiBase}/WebOrderItem?${tenantParam}&webOrderId=in.(${idList})`, { method: "DELETE", headers });
    }

    let totalDeleted = 0;
    for (const num of numbers) {
      const p = `webOrderNumber=eq.${encodeURIComponent(num)}`;
      const r = await fetch(`${apiBase}/WebOrder?${tenantParam}&${p}`, { method: "DELETE", headers });
      if (r.ok) {
        totalDeleted++;
      } else {
        const text = await r.text().catch(() => "");
        console.warn(`[deleteWebOrdersFromSupabase] Delete fail ${num}: ${r.status} ${text}`);
      }
    }

    console.log(`[deleteWebOrdersFromSupabase] Deleted ${totalDeleted}/${numbers.length} orders from Supabase`);
    return totalDeleted > 0;
  } catch (error) {
    console.error("Error en deleteWebOrdersFromSupabase:", error);
    return false;
  }
}

export async function pullSingleProductStock(productId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    const resPBS = await fetch(
      `${supabaseUrl}/rest/v1/ProductBranchStock?${tenantParam}&productId=eq.${productId}&select=*`,
      { headers }
    );
    if (!resPBS.ok) return false;

    const cloudPBS = await resPBS.json();
    for (const bs of cloudPBS) {
      await prisma.productBranchStock.upsert({
        where: { productId_branchId: { productId: bs.productId, branchId: bs.branchId } },
        update: { quantityStock: bs.quantityStock },
        create: { productId: bs.productId, branchId: bs.branchId, quantityStock: bs.quantityStock }
      });
    }

    await recalcProductTotal(productId);
    return true;
  } catch (error) {
    console.error("Error en pullSingleProductStock:", error);
    return false;
  }
}

// Sync de stock liviano post-venta. Sube a la nube el stock de los productos
// vendidos (solo de la sucursal local) y baja el de las otras sucursales para
// esos mismos productos, sin recorrer el resto del catálogo. Fire-and-forget.
export async function syncStockForProducts(productIds: number[]): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const uniqueIds = Array.from(new Set(productIds));
    if (uniqueIds.length === 0) return false;

    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    // 1. Recalcular totales locales antes del push (Product.quantityStock = suma de PBS)
    await recalcProductTotals(uniqueIds);

    // 2. Leer productos con su stock por sucursal
    const products = await prisma.product.findMany({
      where: { id: { in: uniqueIds } },
      include: { branchStocks: true }
    });
    if (products.length === 0) return false;

    // 3. Push: solo Product + ProductBranchStock (sin brand/category/supplier)
    const payload: Record<string, any[]> = {};
    payload.Product = products.map(p => toProductPayload(p, tenantId));
    payload.ProductBranchStock = products.flatMap(p => p.branchStocks || []).map(bs => toPbsPayload(bs, tenantId));

    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);

    // 4. Pull: bajar el stock de esos productos de todas las sucursales (una sola query)
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;
    const idsParam = uniqueIds.join(",");
    const resPBS = await fetch(
      `${supabaseUrl}/rest/v1/ProductBranchStock?${tenantParam}&productId=in.(${idsParam})&select=*`,
      { headers }
    );
    if (resPBS.ok) {
      const cloudPBS = await resPBS.json();
      for (const bs of cloudPBS) {
        const productExists = await prisma.product.findUnique({ where: { id: bs.productId }, select: { id: true } });
        const branchExists = await prisma.branch.findUnique({ where: { id: bs.branchId }, select: { id: true } });
        if (!productExists || !branchExists) continue;
        await prisma.productBranchStock.upsert({
          where: { productId_branchId: { productId: bs.productId, branchId: bs.branchId } },
          update: { quantityStock: bs.quantityStock, updatedAt: new Date(bs.updatedAt) },
          create: { productId: bs.productId, branchId: bs.branchId, quantityStock: bs.quantityStock, updatedAt: new Date(bs.updatedAt) }
        });
      }
    } else {
      console.warn(`[SyncStock] No se pudo descargar ProductBranchStock (${resPBS.status}).`);
    }

    // 5. Recalcular totales locales tras el pull (stock de la red actualizado)
    await recalcProductTotals(uniqueIds);

    return true;
  } catch (error) {
    console.error("Error en syncStockForProducts:", error);
    return false;
  }
}

// Push puntual de un traspaso de stock y sus ítems a la nube. Se usa al crear,
// responder o cancelar un traspaso, para que la otra sucursal lo vea sin
// esperar el sync global.
export async function syncStockTransferToSupabase(transferId: number): Promise<boolean> {
  if (!(await isCloudAllowed())) return false;
  try {
    const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();

    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: transferId },
      include: { items: true },
    });
    if (!transfer) return false;

    const payload: Record<string, any[]> = {
      StockTransfer: [toStockTransferPayload(transfer, tenantId)],
      StockTransferItem: transfer.items.map(sti => toStockTransferItemPayload(sti, tenantId)),
    };

    await pushEntitiesToSupabase(supabaseUrl, supabaseKey, payload);
    return true;
  } catch (error) {
    console.error("Error en syncStockTransferToSupabase:", error);
    return false;
  }
}
