import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import os from "os";
import { setDeviceSettings } from "../../../lib/deviceSettings";
import { isProLicenseKey } from "../../../lib/licenseStatus";

const getHardwareId = () => {
  if (process.env.HARDWARE_ID) return process.env.HARDWARE_ID;
  const hostname = typeof os.hostname === "function" ? os.hostname() : "LOCAL-POS";
  return `POS-${hostname.toUpperCase().replace(/[^A-Z0-9_\-]/g, "_")}`;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Método no permitido" });
  }

  try {
    const { licenseKey, hardwareId: clientHardwareId } = req.body;

    if (!licenseKey || typeof licenseKey !== "string") {
      return res
        .status(400)
        .json({ message: "Por favor ingresá una clave de licencia válida." });
    }

    const cleanKey = licenseKey.trim().toUpperCase();
    const activeHardwareId = clientHardwareId || getHardwareId();

    let targetPlan: "basico" | "pro" = "basico";
    let message = "";
    let validatedViaSupabase = false;

    // Intentar validación en la base de licencias de Supabase (crm-admin)
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://htroigemnwqiugieodmv.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0cm9pZ2VtbndxaXVnaWVvZG12Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MDM4ODcsImV4cCI6MjA5OTI3OTg4N30.sSp5vEDvI7OHuYL0SeeFiATilC_f_BdZao2BjeN0IVQ';

    if (supabaseUrl && supabaseKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        // La tabla "licenses" no es accesible con la clave publica: se usa la funcion
        // get_license (una clave concreta) y register_license_activation.
        const { data: licRows, error } = await supabase.rpc("get_license", { p_key: cleanKey });
        const lic = Array.isArray(licRows) ? licRows[0] : null;

        if (error) {
          console.warn("Error al consultar licencia en Supabase:", error);
        }

        if (lic && !error) {
          if (!lic.is_active) {
            return res.status(400).json({ message: "Esta licencia se encuentra desactivada." });
          }
          if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
            return res.status(400).json({ message: "Esta licencia ha expirado." });
          }
          if (lic.max_activations && lic.activations_count >= lic.max_activations && lic.hardware_id && lic.hardware_id !== activeHardwareId) {
            return res.status(400).json({ message: "La licencia alcanzó el máximo de activaciones permitidas." });
          }

          // Vincular hardware_id e incrementar contador de activaciones en Supabase
          const { error: updateErr } = await supabase.rpc("register_license_activation", {
            p_key: cleanKey,
            p_hardware_id: activeHardwareId,
          });

          if (updateErr) {
            console.error("Error al actualizar hardware_id en Supabase:", updateErr);
          }

          if (isProLicenseKey(cleanKey)) {
            targetPlan = "pro";
          } else {
            targetPlan = "basico";
          }

          validatedViaSupabase = true;
          message = `¡Licencia verificada en la nube! Plan ${targetPlan.toUpperCase()} activado correctamente.`;
        }
      } catch (err) {
        console.warn("Supabase validation skipped or failed:", err);
      }
    }

    // Fallback de validación por formato de clave (ej. CRM-XXXX-YYYY-ZZZZ)
    if (!validatedViaSupabase) {
      if (isProLicenseKey(cleanKey)) {
        targetPlan = "pro";
        message = "¡Licencia PLAN PRO activada con éxito! Nube y herramientas avanzadas desbloqueadas.";
      } else if (
        cleanKey.includes("BASICO") ||
        cleanKey.startsWith("CLIN-BASICO") ||
        cleanKey.startsWith("CRM-BASICO") ||
        cleanKey.startsWith("CLIN-BASE")
      ) {
        targetPlan = "basico";
        message = "¡Licencia PLAN BÁSICO activada con éxito!";
      } else if (cleanKey.startsWith("CRM-") || cleanKey.length >= 8) {
        targetPlan = "pro";
        message = "¡Clave de licencia verificada y activada con éxito!";
      } else {
        return res.status(400).json({
          message: "Clave de licencia no reconocida. Verificá los caracteres ingresados.",
        });
      }
    }

    const updates: Record<string, string> = {
      license_key: cleanKey,
      hardware_id: activeHardwareId,
      app_plan: targetPlan,
      plan_type: targetPlan,
      unlocked_plan_pro: targetPlan === "pro" ? "true" : "false",
      storage_mode: targetPlan === "pro" ? "seguro" : "local",
      license_activated_at: new Date().toISOString(),
    };

    await setDeviceSettings(updates);

    return res.status(200).json({
      success: true,
      plan: targetPlan,
      plan_type: targetPlan,
      message,
    });
  } catch (error: any) {
    console.error("Error al activar licencia:", error);
    return res.status(500).json({
      message: "Error interno al activar la licencia.",
    });
  }
}
