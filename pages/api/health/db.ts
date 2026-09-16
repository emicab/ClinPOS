// pages/api/health/db.ts
// Salud del esquema SQLite local. RUTA PÚBLICA (ver middleware.ts): solo
// expone nombres de tablas/columnas faltantes, nunca datos ni secrets.
// El arranque de Tauri la sondea antes de navegar el webview (ver
// wait_for_db_health en src-tauri/src/lib.rs).
//
// Fuente de verdad: prisma/schema.prisma. Mantener sincronizado con:
//   - EXPECTED_COLUMNS en src-tauri/src/lib.rs
//   - scripts/check-drift.js
import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../lib/prisma";
import { ensureLocalSyncSchema } from "../../../lib/ensureLocalSyncSchema";

const EXPECTED_TABLES = [
  "Setting",
  "StoreConfig",
  "Product",
  "WebOrder",
  "WebOrderItem",
  "Coupon",
  "Sale",
  "SyncOutbox",
  "SyncTombstone",
  "SyncConflict",
] as const;

// Cobertura total de escalares de los modelos foco (ver EXPECTED_COLUMNS en
// src-tauri/src/lib.rs). Lista exhaustiva a propósito: el chequeo es barato
// y así un campo nuevo olvidado falla en build en vez de romper en prod.
const EXPECTED_COLUMNS: Array<[table: string, column: string]> = [
  ["Setting", "id"],
  ["Setting", "key"],
  ["Setting", "value"],
  ["StoreConfig", "id"],
  ["StoreConfig", "slug"],
  ["StoreConfig", "customDomain"],
  ["StoreConfig", "businessName"],
  ["StoreConfig", "description"],
  ["StoreConfig", "logoUrl"],
  ["StoreConfig", "bannerUrl"],
  ["StoreConfig", "primaryColor"],
  ["StoreConfig", "isWebActive"],
  ["StoreConfig", "mpAccessToken"],
  ["StoreConfig", "mpPublicKey"],
  ["StoreConfig", "mpFeePercent"],
  ["StoreConfig", "whatsappPhone"],
  ["StoreConfig", "minStockBuffer"],
  ["StoreConfig", "allowPickup"],
  ["StoreConfig", "allowDelivery"],
  ["StoreConfig", "deliveryFee"],
  ["StoreConfig", "minDeliveryAmount"],
  ["StoreConfig", "businessSector"],
  ["StoreConfig", "requireMpForDelivery"],
  ["StoreConfig", "lat"],
  ["StoreConfig", "lng"],
  ["StoreConfig", "deliveryZones"],
  ["StoreConfig", "openingHours"],
  ["StoreConfig", "peyaEnabled"],
  ["StoreConfig", "peyaConnected"],
  ["StoreConfig", "peyaClientId"],
  ["StoreConfig", "peyaClientSecret"],
  ["StoreConfig", "peyaChainId"],
  ["StoreConfig", "peyaVendorId"],
  ["StoreConfig", "peyaEnv"],
  ["StoreConfig", "peyaAutoAccept"],
  ["StoreConfig", "peyaOutletStatus"],
  ["StoreConfig", "peyaWebhookSecret"],
  ["StoreConfig", "rappiEnabled"],
  ["StoreConfig", "rappiConnected"],
  ["StoreConfig", "rappiApiKey"],
  ["StoreConfig", "rappiStoreId"],
  ["StoreConfig", "rappiAutoAccept"],
  ["StoreConfig", "rappiOutletStatus"],
  ["StoreConfig", "rappiWebhookSecret"],
  ["StoreConfig", "createdAt"],
  ["StoreConfig", "updatedAt"],
  ["Product", "id"],
  ["Product", "name"],
  ["Product", "sku"],
  ["Product", "description"],
  ["Product", "pricePurchase"],
  ["Product", "priceSale"],
  ["Product", "quantityStock"],
  ["Product", "stockMinAlert"],
  ["Product", "unitType"],
  ["Product", "isPublicWeb"],
  ["Product", "webCategory"],
  ["Product", "webUnavailable"],
  ["Product", "externalSku"],
  ["Product", "lastSyncJobId"],
  ["Product", "imageUrl"],
  ["Product", "brandId"],
  ["Product", "categoryId"],
  ["Product", "supplierId"],
  ["Product", "isRecipe"],
  ["Product", "isIngredient"],
  ["Product", "createdAt"],
  ["Product", "updatedAt"],
  ["WebOrder", "id"],
  ["WebOrder", "webOrderNumber"],
  ["WebOrder", "clientName"],
  ["WebOrder", "clientEmail"],
  ["WebOrder", "clientPhone"],
  ["WebOrder", "shippingAddress"],
  ["WebOrder", "deliveryType"],
  ["WebOrder", "branchId"],
  ["WebOrder", "paymentMethod"],
  ["WebOrder", "paymentStatus"],
  ["WebOrder", "status"],
  ["WebOrder", "totalAmount"],
  ["WebOrder", "mpFeeAmount"],
  ["WebOrder", "subtotalAmount"],
  ["WebOrder", "discountAmount"],
  ["WebOrder", "deliveryFee"],
  ["WebOrder", "couponCode"],
  ["WebOrder", "deliveryZone"],
  ["WebOrder", "trackingCode"],
  ["WebOrder", "origin"],
  ["WebOrder", "orderCode"],
  ["WebOrder", "externalOrderId"],
  ["WebOrder", "chainId"],
  ["WebOrder", "vendorId"],
  ["WebOrder", "transportType"],
  ["WebOrder", "promisedFor"],
  ["WebOrder", "acceptedFor"],
  ["WebOrder", "riderInfo"],
  ["WebOrder", "scheduledFor"],
  ["WebOrder", "stockReviewNote"],
  ["WebOrder", "stockReviewAt"],
  ["WebOrder", "mpPaymentId"],
  ["WebOrder", "discountBreakdown"],
  ["WebOrder", "notes"],
  ["WebOrder", "createdAt"],
  ["WebOrder", "updatedAt"],
  ["WebOrderItem", "id"],
  ["WebOrderItem", "webOrderId"],
  ["WebOrderItem", "productId"],
  ["WebOrderItem", "quantity"],
  ["WebOrderItem", "unitPrice"],
  ["WebOrderItem", "subtotal"],
  ["WebOrderItem", "modifiers"],
  ["WebOrderItem", "externalItemId"],
  ["Coupon", "id"],
  ["Coupon", "code"],
  ["Coupon", "discountType"],
  ["Coupon", "discountValue"],
  ["Coupon", "minPurchase"],
  ["Coupon", "active"],
  ["Coupon", "createdAt"],
  ["Coupon", "expiresAt"],
  ["Sale", "id"],
  ["Sale", "saleDate"],
  ["Sale", "totalAmount"],
  ["Sale", "paymentType"],
  ["Sale", "notes"],
  ["Sale", "clientId"],
  ["Sale", "sellerId"],
  ["Sale", "cashRegisterId"],
  ["Sale", "branchId"],
  ["Sale", "createdAt"],
  ["Sale", "updatedAt"],
  ["Sale", "discountCodeApplied"],
  ["Sale", "promotionsApplied"],
  ["Sale", "creditCardPromotionId"],
  ["Sale", "onAccount"],
  ["Sale", "status"],
  ["SaleItem", "id"],
  ["SaleItem", "quantity"],
  ["SaleItem", "priceAtSale"],
  ["SaleItem", "purchasePriceAtSale"],
  ["SaleItem", "saleId"],
  ["SaleItem", "productId"],
  ["SaleItem", "productName"],
  ["SaleItem", "modifiers"],
  ["SyncOutbox", "payloadJson"],
  ["SyncOutbox", "nextAttemptAt"],
  ["SyncOutbox", "lastAttemptAt"],
  ["SyncOutbox", "lockedAt"],
  ["SyncConflict", "status"],
  ["SyncTombstone", "entityKey"],
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // En producción standalone no siempre se ejecuta Tauri (que normalmente
    // aplica las migraciones). Reparar primero garantiza que el chequeo y las
    // rutas de sync no consulten tablas/columnas de una versión anterior.
    await ensureLocalSyncSchema();

    const tablesRows = (await prisma.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table'`
    )) as Array<{ name: string }>;
    const tables = new Set(tablesRows.map((r) => r.name));

    const missingTables = EXPECTED_TABLES.filter((t) => !tables.has(t));
    const missingColumns: string[] = [];

    for (const [table, column] of EXPECTED_COLUMNS) {
      if (!tables.has(table)) {
        missingColumns.push(`${table}.${column}`);
        continue;
      }
      const cols = (await prisma.$queryRawUnsafe(
        `PRAGMA table_info("${table}")`
      )) as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        missingColumns.push(`${table}.${column}`);
      }
    }

    let appMigrationsMax: number | null = null;
    try {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT MAX(version) as v FROM _app_migrations`
      )) as Array<{ v: number | null }>;
      appMigrationsMax = rows?.[0]?.v ?? null;
    } catch {
      appMigrationsMax = null;
    }

    // Lectura mínima de ponta a ponta (detecta DB corrupta aunque el esquema esté ok).
    let settingsCount: number | null = null;
    try {
      settingsCount = await prisma.setting.count();
    } catch {
      settingsCount = null;
    }

    const ok =
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      settingsCount !== null;

    // 200 siempre (salvo 405): el gate de Tauri parsea el body, no el status.
    return res.status(200).json({
      ok,
      missingTables,
      missingColumns,
      appMigrationsMax,
      settingsCount,
    });
  } catch (error: any) {
    return res.status(200).json({
      ok: false,
      missingTables: [],
      missingColumns: [],
      appMigrationsMax: null,
      settingsCount: null,
      error: String(error?.message || error),
    });
  }
}
