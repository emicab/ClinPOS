// lib/licenseStatus.ts
// Revalidación online de la licencia de la Casa Central contra la tabla
// "licenses" de Supabase. La app solo LEE esa tabla (la renovación mensual la
// actualiza crm-admin). Si la clave está expirada/desactivada, el plan baja a
// "basico" localmente y luego se propaga a la nube para que las sucursales
// también bajen.
import os from "os";
import { getDeviceSetting, setDeviceSettings } from "./deviceSettings";

const OFFICIAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://htroigemnwqiugieodmv.supabase.co";
const OFFICIAL_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0cm9pZ2VtbndxaXVnaWVvZG12Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MDM4ODcsImV4cCI6MjA5OTI3OTg4N30.sSp5vEDvI7OHuYL0SeeFiATilC_f_BdZao2BjeN0IVQ";

async function getSettingValue(key: string): Promise<string | null> {
  return getDeviceSetting(key);
}

function getHardwareId(): string {
  if (process.env.HARDWARE_ID) return process.env.HARDWARE_ID;
  const hostname = os.hostname();
  return `POS-${hostname.toUpperCase().replace(/[^A-Z0-9_\-]/g, "_")}`;
}

async function getSupabaseCreds(): Promise<{ supabaseUrl: string; supabaseKey: string }> {
  const storedUrl = await getSettingValue("supabase_url");
  const storedKey = await getSettingValue("supabase_anon_key");
  const supabaseUrl = storedUrl || OFFICIAL_SUPABASE_URL;
  const supabaseKey = storedKey || OFFICIAL_SUPABASE_KEY;
  return { supabaseUrl, supabaseKey };
}

export interface LicenseStatus {
  hasLicense: boolean;
  plan: "pro" | "basico";
  active: boolean;
  online: boolean;
  expiresAt: string | null;
  changed: boolean;
}

function planFromKey(cleanKey: string): "pro" | "basico" {
  if (
    cleanKey.includes("PRO") ||
    cleanKey.startsWith("CLIN-PRO") ||
    cleanKey.startsWith("CRM-PRO")
  ) {
    return "pro";
  }
  if (
    cleanKey.includes("BASICO") ||
    cleanKey.startsWith("CLIN-BASICO") ||
    cleanKey.startsWith("CRM-BASICO") ||
    cleanKey.startsWith("CLIN-BASE")
  ) {
    return "basico";
  }
  // Formato genérico de clave larga se asume PRO (compatibilidad con activate.ts)
  return cleanKey.startsWith("CRM-") || cleanKey.length >= 8 ? "pro" : "basico";
}

async function applyPlan(plan: "pro" | "basico"): Promise<void> {
  const isPro = plan === "pro";
  const entries: Record<string, string> = {
    app_plan: plan,
    plan_type: plan,
    unlocked_plan_pro: isPro ? "true" : "false",
    storage_mode: isPro ? "seguro" : "local",
  };
  await setDeviceSettings(entries);
}

export async function getLocalPlan(): Promise<"pro" | "basico"> {
  const appPlan = await getSettingValue("app_plan");
  const planType = await getSettingValue("plan_type");
  const unlockedPro = await getSettingValue("unlocked_plan_pro");
  const storageMode = await getSettingValue("storage_mode");
  if (
    appPlan === "pro" ||
    planType === "pro" ||
    unlockedPro === "true" ||
    storageMode === "seguro"
  ) {
    return "pro";
  }
  return "basico";
}

// Revalida la licencia contra la nube. Solo tiene sentido en la Casa Central
// (que posee el license_key). Devuelve el estado resultante.
export async function revalidateLicense(): Promise<LicenseStatus> {
  const licenseKey = await getSettingValue("license_key");
  if (!licenseKey || !licenseKey.trim()) {
    return {
      hasLicense: false,
      plan: await getLocalPlan(),
      active: false,
      online: false,
      expiresAt: null,
      changed: false,
    };
  }

  const cleanKey = licenseKey.trim().toUpperCase();
  const { supabaseUrl, supabaseKey } = await getSupabaseCreds();

  let rows: any[] | null = null;
  let online = true;
  try {
    // La tabla "licenses" ya no es legible con la clave publica (se podian listar todas
    // las claves): se consulta UNA clave concreta via la funcion get_license.
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_license`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_key: cleanKey }),
    });
    if (!res.ok) {
      rows = null;
    } else {
      const data = await res.json();
      rows = Array.isArray(data) ? data : null;
    }
  } catch {
    online = false;
  }

  // Modo offline: no podemos verificar; se mantiene el plan actual sin castigar.
  if (!online || rows === null) {
    return {
      hasLicense: true,
      plan: await getLocalPlan(),
      active: true,
      online: false,
      expiresAt: null,
      changed: false,
    };
  }

  const lic = rows[0];

  // Clave inexistente o desactivada → bajar a básico.
  if (!lic || !lic.is_active) {
    const before = await getLocalPlan();
    if (before === "pro") await applyPlan("basico");
    return {
      hasLicense: true,
      plan: "basico",
      active: false,
      online: true,
      expiresAt: lic?.expires_at || null,
      changed: before === "pro",
    };
  }

  // Expirada → bajar a básico.
  if (lic.expires_at && new Date(lic.expires_at).getTime() < Date.now()) {
    const before = await getLocalPlan();
    if (before === "pro") await applyPlan("basico");
    return {
      hasLicense: true,
      plan: "basico",
      active: false,
      online: true,
      expiresAt: lic.expires_at,
      changed: before === "pro",
    };
  }

  // Asignada a otro hardware → tratar como inactiva.
  if (lic.hardware_id && lic.hardware_id !== getHardwareId()) {
    const before = await getLocalPlan();
    if (before === "pro") await applyPlan("basico");
    return {
      hasLicense: true,
      plan: "basico",
      active: false,
      online: true,
      expiresAt: lic.expires_at || null,
      changed: before === "pro",
    };
  }

  // Válida → aplicar el plan que corresponde a la clave.
  const targetPlan = planFromKey(cleanKey);
  const before = await getLocalPlan();
  if (before !== targetPlan) await applyPlan(targetPlan);

  return {
    hasLicense: true,
    plan: targetPlan,
    active: true,
    online: true,
    expiresAt: lic.expires_at || null,
    changed: before !== targetPlan,
  };
}
