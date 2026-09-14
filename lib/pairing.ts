// lib/pairing.ts
// Emparejamiento de sucursales mediante código de un solo uso.
// La Casa Central genera un código PKG-XXXXXXXX (30 min, uso único); la
// sucursal lo ingresa y queda vinculada al tenant y a la sucursal correcta.
import crypto from "crypto";
import prisma from "./prisma";
import { getSelectiveSyncCredentials } from "./syncService";

const PAIRING_TABLE = "PairingCode";
const CODE_TTL_MS = 30 * 60 * 1000;

export interface PairingCodeRow {
  code: string;
  tenant_id: string;
  branch_id: number;
  status: "OPEN" | "USED" | "REVOKED";
  created_at: string;
  expires_at: string;
}

function buildHeaders(supabaseKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
  };
}

export async function generatePairingCode(branchId: number): Promise<{ code: string; expiresAt: string }> {
  const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
  const code = `PKG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const res = await fetch(`${supabaseUrl}/rest/v1/${PAIRING_TABLE}`, {
    method: "POST",
    headers: buildHeaders(supabaseKey),
    body: JSON.stringify({
      code,
      tenant_id: tenantId,
      branch_id: branchId,
      status: "OPEN",
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    }),
  });

  if (!res.ok) {
    throw new Error(`No se pudo crear el código de emparejamiento (HTTP ${res.status}).`);
  }

  return { code, expiresAt };
}

export async function validatePairingCode(
  rawCode: string
): Promise<{ tenantId: string; branchId: number; branchName: string | null }> {
  const { supabaseUrl, supabaseKey } = await getSelectiveSyncCredentials();
  const cleanCode = rawCode.trim().toUpperCase();

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${PAIRING_TABLE}?code=eq.${encodeURIComponent(cleanCode)}&select=*`,
    { headers: buildHeaders(supabaseKey) }
  );

  if (!res.ok) {
    const detail: any = await res.json().catch(() => null);
    const hint =
      res.status === 401 || res.status === 403
        ? "Revisá las credenciales/RLS en Supabase."
        : res.status === 402
          ? "Cuota de Supabase agotada."
          : "Revisá la conexión.";
    throw new Error(
      `No se pudo validar el código contra la nube (HTTP ${res.status}${detail?.message ? `: ${detail.message}` : ""}). ${hint}`
    );
  }

  const rows = await res.json();
  const row: PairingCodeRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) {
    throw new Error("El código no es válido. Verificá con la Casa Central.");
  }
  if (row.status !== "OPEN") {
    throw new Error("Este código ya fue utilizado. Pedí uno nuevo a la Casa Central.");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error("Este código expiró. Pedí uno nuevo a la Casa Central.");
  }

  // Marcar como usado (uso único) antes de aplicarlo localmente.
  const claimRes = await fetch(
    `${supabaseUrl}/rest/v1/${PAIRING_TABLE}?code=eq.${encodeURIComponent(cleanCode)}`,
    {
      method: "PATCH",
      headers: buildHeaders(supabaseKey),
      body: JSON.stringify({ status: "USED" }),
    }
  );
  if (!claimRes.ok) {
    const detail: any = await claimRes.json().catch(() => null);
    throw new Error(
      `No se pudo confirmar el código (HTTP ${claimRes.status}${detail?.message ? `: ${detail.message}` : ""}). Intentá de nuevo.`
    );
  }

  let branchName: string | null = null;
  const localBranch = await prisma.branch.findUnique({ where: { id: row.branch_id } });
  if (localBranch) branchName = localBranch.name;

  return { tenantId: row.tenant_id, branchId: row.branch_id, branchName };
}
