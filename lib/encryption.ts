import crypto from "crypto";
import { machineIdSync } from "node-machine-id";

const ALGORITHM = "aes-256-gcm";

/**
 * Genera la clave maestra AES-256 combinando 3 capas de protección:
 *
 * 1. CLINPOS_ENCRYPTION_SECRET: Secreto aleatorio real, generado una vez por instalación
 *    y protegido por safeStorage de Electron (DPAPI en Windows / Keychain en macOS).
 *    → Requiere las credenciales de sesión del usuario del SO para accederlo.
 *
 * 2. Hardware ID (machineIdSync): UUID físico del motherboard/CPU.
 *    → Previene portabilidad del .db entre computadoras.
 *
 * 3. Usuario del SO: Nombre de la cuenta de Windows/Mac activa.
 *    → Aísla por sesión de usuario en equipos compartidos.
 *
 * Si el secreto de safeStorage no está disponible (modo dev sin Electron),
 * la clave se deriva solo de machineId + usuario (protección contra portabilidad).
 */
function getMasterKey(): Buffer {
  const safeStorageSecret = process.env.CLINPOS_ENCRYPTION_SECRET || "";

  let hardwareId = "";
  try {
    hardwareId = machineIdSync(true);
  } catch {
    hardwareId =
      process.env.COMPUTERNAME ||
      process.env.HOSTNAME ||
      "ClinPOS-Fallback-Device-ID";
  }

  const osUser = process.env.USERNAME || process.env.USER || "default_user";

  // El secreto de safeStorage es el componente crítico que aporta protección real
  // contra acceso local. machineId y osUser complementan contra portabilidad.
  const rawSeed = `ClinPOS::${safeStorageSecret}::HW::${hardwareId}::USER::${osUser}`;

  return crypto.scryptSync(rawSeed, "clinpos_safe_salt_v3", 32);
}

/**
 * Encripta un texto sensible (ej: clave privada ARCA) usando AES-256-GCM.
 * La clave de cifrado está protegida por el keychain del SO (safeStorage/DPAPI).
 * Formato de salida: "ENC::iv.authTag.ciphertext"
 */
export function encryptText(text: string): string {
  if (!text) return "";
  if (text.startsWith("ENC::")) return text;

  const iv = crypto.randomBytes(12);
  const key = getMasterKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return `ENC::${iv.toString("hex")}.${authTag}.${encrypted}`;
}

/**
 * Desencripta un texto cifrado con AES-256-GCM.
 *
 * Si el .db fue copiado a otra máquina o el usuario del SO cambió,
 * el descifrado fallará de forma segura (el secreto de safeStorage
 * no puede reproducirse fuera de la sesión original).
 */
export function decryptText(encryptedText: string): string {
  if (!encryptedText) return "";
  if (!encryptedText.startsWith("ENC::")) return encryptedText;

  const rawData = encryptedText.substring(5);
  const delimiter = rawData.includes(".") ? "." : ":";
  const parts = rawData.split(delimiter);

  if (parts.length !== 3) return encryptedText;

  const [ivHex, authTagHex, cipherHex] = parts;

  // Intento 1: clave actual (safeStorage + machineId + user)
  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const key = getMasterKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch {
    // Intento 2: fallback con clave v2 legacy (machineId + user, sin safeStorage)
    try {
      let hardwareId = "";
      try { hardwareId = machineIdSync(true); } catch { hardwareId = process.env.COMPUTERNAME || ""; }
      const osUser = process.env.USERNAME || process.env.USER || "default_user";
      const legacySeed = `ClinPOS_HW::${hardwareId}::USER::${osUser}`;
      const legacyKey = crypto.scryptSync(legacySeed, "clinpos_hardware_salt_v2", 32);

      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(authTagHex, "hex");
      const decipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(cipherHex, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch {
      // Intento 3: fallback con clave v1 legacy (salt estático original)
      try {
        const legacyKeyString = ["ClinPOS", "ARCA", "Secure", "Key", "2026"].join("-");
        const v1Key = crypto.scryptSync(legacyKeyString, "clinpos_salt_v1", 32);
        const iv = Buffer.from(ivHex, "hex");
        const authTag = Buffer.from(authTagHex, "hex");
        const decipher = crypto.createDecipheriv(ALGORITHM, v1Key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(cipherHex, "hex", "utf8");
        decrypted += decipher.final("utf8");

        return decrypted;
      } catch {
        // Intento 4: fallback con clave de desarrollo (sin safeStorageSecret pero con salt v3)
        try {
          let hardwareId = "";
          try { hardwareId = machineIdSync(true); } catch { hardwareId = process.env.COMPUTERNAME || process.env.HOSTNAME || "ClinPOS-Fallback-Device-ID"; }
          const osUser = process.env.USERNAME || process.env.USER || "default_user";
          
          const devSeed = `ClinPOS::::HW::${hardwareId}::USER::${osUser}`;
          const devKey = crypto.scryptSync(devSeed, "clinpos_safe_salt_v3", 32);

          const iv = Buffer.from(ivHex, "hex");
          const authTag = Buffer.from(authTagHex, "hex");
          const decipher = crypto.createDecipheriv(ALGORITHM, devKey, iv);
          decipher.setAuthTag(authTag);

          let decrypted = decipher.update(cipherHex, "hex", "utf8");
          decrypted += decipher.final("utf8");

          return decrypted;
        } catch {
          console.warn("⚠️ No se pudo desencriptar el dato con ninguna clave conocida.");
          // No devolver ENC::... como si fuera un secreto válido: eso provoca
          // errores secundarios en ARCA, SMTP y otras integraciones.
          return "";
        }
      }
    }
  }
}
