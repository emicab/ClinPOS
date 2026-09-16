import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../lib/prisma";
import crypto from "crypto";
import os from "os";
import { isProDevice } from "../../../lib/branchIdentity";

function isServiceRoleKey(value: string): boolean {
  try {
    const payload = value.split('.')[1];
    if (!payload) return false;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded?.role === 'service_role';
  } catch {
    return false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    // El Realtime/la nube es exclusivo del Plan Pro.
    if (!(await isProDevice())) {
      return res.status(403).json({ message: "El acceso a la nube requiere el Plan Pro.", blockedByPlan: true });
    }

    const settings = await prisma.setting.findMany();
    const config: Record<string, string> = {};
    for (const s of settings) {
      config[s.key] = s.value;
    }

    const supabaseUrl = config.supabase_url || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    // Solo clave pública para el frontend
    const configuredKey = config.supabase_anon_key || "";
    const supabaseAnonKey = !isServiceRoleKey(configuredKey)
      ? configuredKey
      : (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(400).json({ message: "Supabase no está configurado." });
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
      tenantId = crypto.createHash("sha256").update(rawTenant).digest("hex").slice(0, 16);
    }

    res.status(200).json({ supabaseUrl, supabaseAnonKey, tenantId });
  } catch (error: any) {
    console.error("Error obteniendo configuración de Realtime:", error);
    res.status(500).json({ message: error.message });
  }
}
