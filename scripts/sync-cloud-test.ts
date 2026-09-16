import prisma from "../lib/prisma";
import { getSelectiveSyncCredentials } from "../lib/syncService";

const apply = process.argv.includes("--apply");
const productId = Number(process.env.SYNC_CLOUD_TEST_PRODUCT_ID || "");

async function getProduct(url: string, key: string, tenantId: string, id: number) {
  const response = await fetch(`${url}/rest/v1/Product?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${id}&select=id,quantityStock`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`No se pudo leer el producto (${response.status}).`);
  const rows = await response.json();
  if (!rows[0]) throw new Error("El producto de prueba no existe en la nube.");
  return Number(rows[0].quantityStock);
}

async function applyMovement(url: string, key: string, tenantId: string, operationId: string, id: number, delta: number) {
  const response = await fetch(`${url}/rest/v1/rpc/apply_stock_movement`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_tenant_id: tenantId,
      p_operation_id: operationId,
      p_product_id: id,
      p_delta: delta,
      p_branch_id: null,
    }),
  });
  if (!response.ok) throw new Error(`RPC rechazado (${response.status}): ${await response.text()}`);
}

async function main() {
  if (!apply) {
    console.log("Smoke test cloud en modo seguro.");
    console.log("Para probar el RPC real, definí SYNC_CLOUD_TEST_PRODUCT_ID y ejecutá con --apply.");
    return;
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new Error("Falta SYNC_CLOUD_TEST_PRODUCT_ID con el ID de un producto de prueba.");
  }

  const { supabaseUrl, supabaseKey, tenantId } = await getSelectiveSyncCredentials();
  const before = await getProduct(supabaseUrl, supabaseKey, tenantId, productId);
  const operationId = `clinpos-smoke-${Date.now()}`;

  await applyMovement(supabaseUrl, supabaseKey, tenantId, operationId, productId, 1);
  await applyMovement(supabaseUrl, supabaseKey, tenantId, operationId, productId, 1);
  const afterIncrement = await getProduct(supabaseUrl, supabaseKey, tenantId, productId);
  if (afterIncrement !== before + 1) {
    throw new Error(`RPC no idempotente: antes=${before}, después=${afterIncrement}.`);
  }

  await applyMovement(supabaseUrl, supabaseKey, tenantId, `${operationId}-rollback`, productId, -1);
  const afterRollback = await getProduct(supabaseUrl, supabaseKey, tenantId, productId);
  if (afterRollback !== before) {
    throw new Error(`El rollback del test no devolvió el stock original: esperado=${before}, actual=${afterRollback}.`);
  }

  console.log("✓ RPC cloud idempotente: el movimiento se aplicó una sola vez.");
  console.log("✓ Stock restaurado al valor original.");
}

main().catch((error) => {
  console.error("✗ Falló el cloud test:", error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
