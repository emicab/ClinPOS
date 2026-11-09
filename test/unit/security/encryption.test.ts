import crypto from "node:crypto";
import { machineIdSync } from "node-machine-id";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptText, encryptText } from "../../../lib/encryption";

const ALGORITHM = "aes-256-gcm";

function hardwareId(): string {
  try {
    return machineIdSync(true);
  } catch {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || "ClinPOS-Fallback-Device-ID";
  }
}

function osUser(): string {
  return process.env.USERNAME || process.env.USER || "default_user";
}

function encryptWithKey(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `ENC::${iv.toString("hex")}.${authTag}.${encrypted}`;
}

// Los secretos de ARCA (clave privada) y SMTP viven cifrados en la base. Si el
// descifrado devolviera basura o el propio `ENC::...`, la facturación falla de
// formas difíciles de diagnosticar. También hay que poder leer datos viejos
// cifrados con las claves anteriores tras una actualización.
describe("encryptText / decryptText", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CLINPOS_ENCRYPTION_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.CLINPOS_ENCRYPTION_SECRET;
    else process.env.CLINPOS_ENCRYPTION_SECRET = originalSecret;
  });

  it("un texto vacío queda vacío", () => {
    expect(encryptText("")).toBe("");
    expect(decryptText("")).toBe("");
  });

  it("no vuelve a cifrar algo que ya es ENC::", () => {
    const already = "ENC::aabbcc.ddeeff.0011";
    expect(encryptText(already)).toBe(already);
  });

  it("produce el formato ENC::iv.authTag.ciphertext", () => {
    const out = encryptText("secreto");
    expect(out).toMatch(/^ENC::[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
  });

  it("descifra lo que cifró (ida y vuelta)", () => {
    const text = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    expect(decryptText(encryptText(text))).toBe(text);
  });

  it("soporta acentos, emojis y textos largos", () => {
    const text = "Facturación electrónica 🔐 ñandú ".repeat(200);
    expect(decryptText(encryptText(text))).toBe(text);
  });

  it("usa un IV distinto en cada cifrado", () => {
    const a = encryptText("mismo texto");
    const b = encryptText("mismo texto");
    expect(a).not.toBe(b);
    expect(decryptText(a)).toBe("mismo texto");
    expect(decryptText(b)).toBe("mismo texto");
  });

  it("un texto sin prefijo ENC:: se devuelve tal cual", () => {
    expect(decryptText("texto plano")).toBe("texto plano");
  });

  it("un ENC:: con formato inválido se devuelve sin romper", () => {
    expect(decryptText("ENC::solo-dos-partes")).toBe("ENC::solo-dos-partes");
  });

  it("un ENC:: con partes no-hex no se propaga como secreto válido", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(decryptText("ENC::zz.yy.xx")).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("un ciphertext manipulado no descifra y devuelve vacío", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const encrypted = encryptText("secreto");
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith("00") ? "11" : "00");

    expect(decryptText(tampered)).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("lee datos cifrados con la clave legacy v2 (sin safeStorage)", () => {
    const legacyKey = crypto.scryptSync(
      `ClinPOS_HW::${hardwareId()}::USER::${osUser()}`,
      "clinpos_hardware_salt_v2",
      32,
    );
    const encrypted = encryptWithKey("clave ARCA vieja", legacyKey);

    expect(decryptText(encrypted)).toBe("clave ARCA vieja");
  });

  it("lee datos cifrados con la clave legacy v1 (salt estático)", () => {
    const v1Key = crypto.scryptSync(
      ["ClinPOS", "ARCA", "Secure", "Key", "2026"].join("-"),
      "clinpos_salt_v1",
      32,
    );
    const encrypted = encryptWithKey("clave ARCA muy vieja", v1Key);

    expect(decryptText(encrypted)).toBe("clave ARCA muy vieja");
  });

  it("sin secreto de safeStorage usa la clave de desarrollo", () => {
    delete process.env.CLINPOS_ENCRYPTION_SECRET;
    const encrypted = encryptText("modo dev");

    // Al aparecer el secreto, la clave primaria cambia; el fallback de dev
    // (intento 4) es el que permite seguir leyendo lo cifrado en dev.
    process.env.CLINPOS_ENCRYPTION_SECRET = "secreto-que-no-existia-al-cifrar";
    expect(decryptText(encrypted)).toBe("modo dev");
  });

  it("si el secreto de safeStorage desaparece, un dato cifrado con él no se puede leer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CLINPOS_ENCRYPTION_SECRET = "secreto-real";
    const encrypted = encryptText("dato protegido");

    delete process.env.CLINPOS_ENCRYPTION_SECRET;

    expect(decryptText(encrypted)).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("con secreto presente el ida y vuelta sigue funcionando", () => {
    process.env.CLINPOS_ENCRYPTION_SECRET = "secreto-real";
    expect(decryptText(encryptText("hola"))).toBe("hola");
  });
});
