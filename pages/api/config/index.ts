import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { handleApiError } from '../../../lib/apiErrorHandler';
import { encryptText, decryptText } from '../../../lib/encryption';
import { getDeviceBranchId, isMainDevice } from '../../../lib/branchIdentity';
import { getDeviceSettings } from '../../../lib/profiles';
import { isDeviceGlobalKey, setDeviceSettings } from '../../../lib/deviceSettings';
import os from 'os';

const OFFICIAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://htroigemnwqiugieodmv.supabase.co';
const OFFICIAL_SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0cm9pZ2VtbndxaXVnaWVvZG12Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MDM4ODcsImV4cCI6MjA5OTI3OTg4N30.sSp5vEDvI7OHuYL0SeeFiATilC_f_BdZao2BjeN0IVQ';

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

const getHardwareId = () => {
  if (process.env.HARDWARE_ID) return process.env.HARDWARE_ID;
  const hostname = typeof os.hostname === 'function' ? os.hostname() : 'LOCAL-POS';
  return `POS-${hostname.toUpperCase().replace(/[^A-Z0-9_\-]/g, '_')}`;
};

const DEFAULT_SETTINGS: Record<string, string> = {
  taxRate: '21',
  businessName: '',
  businessCuit: '',
  businessAddress: '',
  businessPhone: '',
  receiptFooter: 'Gracias por su compra',
  defaultPaymentType: 'CASH',
  nextReceiptNumber: '1',
  discount_CASH: '0',
  discount_TRANSFER: '10',
  discount_CARD: '0',
  discount_OTHER: '0',
  arcaEnabled: 'false',
  arcaCuit: '',
  arcaPointOfSale: '1',
  arcaEnv: 'produccion',
  arcaCert: '',
  arcaKey: '',
  arcaIibb: '',
  arcaBusinessStartDate: '',
  arcaIvaCondition: 'RI',
  app_plan: 'basico',
  plan_type: 'basico',
  unlocked_plan_pro: 'false',
  storage_mode: 'safe',
  business_profile: 'general',
  module_recetario: 'false',
  license_key: '',
  license_activated_at: '',
  hardware_id: getHardwareId(),
  supabase_url: OFFICIAL_SUPABASE_URL,
  supabase_anon_key: OFFICIAL_SUPABASE_KEY,
  supabase_last_sync: '',
  device_branch_id: '',
  device_role: '',
  tenant_id: '',
  admin_pin_setup: 'false',
  smtpHost: '',
  smtpPort: '587',
  smtpUser: '',
  smtpPass: '',
  smtpFromName: 'Mi Negocio - Ventas',
  geminiApiKey: '',
  cloudinaryCloudName: '',
  cloudinaryApiKey: '',
  cloudinaryApiSecret: '',
};

const ENCRYPTED_FIELDS = ['arcaCert', 'arcaKey', 'smtpPass', 'geminiApiKey', 'cloudinaryApiKey', 'cloudinaryApiSecret'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const settings = await prisma.setting.findMany();
      const result: Record<string, string> = { ...DEFAULT_SETTINGS };
      for (const s of settings) {
        if (ENCRYPTED_FIELDS.includes(s.key)) {
          result[s.key] = decryptText(s.value);
        } else {
          result[s.key] = s.value;
        }
      }

      // Garantizar que siempre haya credenciales y hardware_id válidos
      if (!result.hardware_id) result.hardware_id = getHardwareId();
      if (!result.supabase_url) result.supabase_url = OFFICIAL_SUPABASE_URL;
      if (!result.supabase_anon_key) result.supabase_anon_key = OFFICIAL_SUPABASE_KEY;

      // Overlay de settings a nivel máquina (licencia, plan, credenciales) para
      // que todos los negocios de esta PC compartan el mismo plan/licencia.
      const deviceSettings = getDeviceSettings();
      for (const [k, v] of Object.entries(deviceSettings)) {
        result[k] = v;
      }

      // Nunca exponer una credencial privada al frontend.
      delete result.supabase_service_role_key;
      if (!result.supabase_anon_key || isServiceRoleKey(result.supabase_anon_key)) {
        result.supabase_anon_key = OFFICIAL_SUPABASE_KEY;
      }

      // Identidad de sucursal de esta PC (server-side)
      const deviceBranchId = await getDeviceBranchId();
      result.device_branch_id = deviceBranchId ? String(deviceBranchId) : '';
      result.is_main_device = (await isMainDevice()) ? 'true' : 'false';

      res.status(200).json(result);
    } catch (error) {
      handleApiError(res, error, 'fetching settings');
    }
  } else if (req.method === 'PUT') {
    try {
      const entries = req.body as Record<string, string>;
      const deviceEntries: Record<string, string> = {};
      const businessEntries: Record<string, string> = {};

      for (const [key, rawValue] of Object.entries(entries)) {
        if (isDeviceGlobalKey(key)) {
          deviceEntries[key] = String(rawValue);
        } else {
          businessEntries[key] = String(rawValue);
        }
      }

      if (Object.keys(deviceEntries).length > 0) {
        await setDeviceSettings(deviceEntries);
      }

      for (const [key, rawValue] of Object.entries(businessEntries)) {
        let storedValue = String(rawValue);
        if (ENCRYPTED_FIELDS.includes(key) && storedValue.trim() !== '') {
          storedValue = encryptText(storedValue);
        }

        await prisma.setting.upsert({
          where: { key },
          update: { value: storedValue },
          create: { key, value: storedValue },
        });
      }
      res.status(200).json({ message: 'Configuración guardada.' });
    } catch (error) {
      handleApiError(res, error, 'saving settings');
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT']);
    res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
