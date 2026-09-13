use std::fs::{self, File};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};
use keyring::Entry;
use rand::Rng;
use rusqlite::Connection;
use serde::Serialize;

const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Auto-migration system ──────────────────────────────────────────────
struct Migration {
    version: i32,
    name: &'static str,
    sql: &'static str,
}

/// All schema migrations for the production database.
/// When adding new columns/tables to schema.prisma, also add a Migration entry here
/// so that existing production databases get updated automatically on app startup.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "add_sale_status",
        sql: r#"ALTER TABLE "Sale" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED'"#,
    },
    Migration {
        version: 2,
        name: "add_consignments",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "Consignment" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "clientId" INTEGER NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'DELIVERED',
                "notes" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL,
                CONSTRAINT "Consignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "ConsignmentItem" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "consignmentId" INTEGER NOT NULL,
                "productId" INTEGER NOT NULL,
                "quantityGiven" REAL NOT NULL,
                "quantitySold" REAL NOT NULL DEFAULT 0,
                "quantityReturned" REAL NOT NULL DEFAULT 0,
                "priceAtGiven" DECIMAL NOT NULL,
                CONSTRAINT "ConsignmentItem_consignmentId_fkey" FOREIGN KEY ("consignmentId") REFERENCES "Consignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "ConsignmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "SavedNote" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "title" TEXT NOT NULL,
                "description" TEXT,
                "content" TEXT NOT NULL,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS "ChatSession" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "title" TEXT NOT NULL,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL
            );

            CREATE TABLE IF NOT EXISTS "ChatMessage" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "sessionId" TEXT NOT NULL,
                "role" TEXT NOT NULL,
                "content" TEXT NOT NULL,
                "suggestions" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "CONSTRAINT ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
            );
        "#,
    },
    Migration {
        version: 3,
        name: "add_store_config_and_web_orders",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "StoreConfig" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "slug" TEXT NOT NULL UNIQUE,
                "businessName" TEXT NOT NULL,
                "description" TEXT,
                "logoUrl" TEXT,
                "bannerUrl" TEXT,
                "primaryColor" TEXT DEFAULT '#2563eb',
                "isWebActive" BOOLEAN NOT NULL DEFAULT 0,
                "mpAccessToken" TEXT,
                "mpPublicKey" TEXT,
                "mpFeePercent" DECIMAL NOT NULL DEFAULT 0,
                "whatsappPhone" TEXT,
                "minStockBuffer" REAL NOT NULL DEFAULT 1,
                "allowPickup" BOOLEAN NOT NULL DEFAULT 1,
                "allowDelivery" BOOLEAN NOT NULL DEFAULT 1,
                "deliveryFee" DECIMAL NOT NULL DEFAULT 0,
                "minDeliveryAmount" DECIMAL NOT NULL DEFAULT 0,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS "WebOrder" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "webOrderNumber" TEXT NOT NULL UNIQUE,
                "clientName" TEXT NOT NULL,
                "clientEmail" TEXT,
                "clientPhone" TEXT NOT NULL,
                "shippingAddress" TEXT,
                "deliveryType" TEXT NOT NULL,
                "paymentMethod" TEXT NOT NULL,
                "paymentStatus" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'PENDING_PREPARATION',
                "totalAmount" DECIMAL NOT NULL,
                "notes" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS "WebOrderItem" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "webOrderId" INTEGER NOT NULL,
                "productId" INTEGER NOT NULL,
                "quantity" REAL NOT NULL,
                "unitPrice" DECIMAL NOT NULL,
                "subtotal" DECIMAL NOT NULL,
                CONSTRAINT "WebOrderItem_webOrderId_fkey" FOREIGN KEY ("webOrderId") REFERENCES "WebOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "WebOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );
        "#,
    },
    Migration {
        version: 4,
        name: "add_promotions_and_coupons_and_invoices",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "CreditCardPromotion" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "bank" TEXT NOT NULL,
                "installments" TEXT NOT NULL,
                "startDate" DATETIME,
                "endDate" DATETIME,
                "notes" TEXT,
                "active" BOOLEAN NOT NULL DEFAULT 1,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS "Invoice" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "saleId" INTEGER NOT NULL UNIQUE,
                "cae" TEXT NOT NULL,
                "caeExpiration" DATETIME NOT NULL,
                "invoiceType" TEXT NOT NULL,
                "invoiceNumber" INTEGER NOT NULL,
                "pointOfSale" INTEGER NOT NULL,
                "clientCuit" TEXT,
                "clientName" TEXT,
                "xmlRequest" TEXT,
                "xmlResponse" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "Invoice_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "Coupon" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "code" TEXT NOT NULL UNIQUE,
                "discountType" TEXT NOT NULL DEFAULT 'PERCENTAGE',
                "discountValue" DECIMAL NOT NULL,
                "minPurchase" DECIMAL DEFAULT 0,
                "maxUses" INTEGER,
                "usedCount" INTEGER NOT NULL DEFAULT 0,
                "startDate" DATETIME,
                "endDate" DATETIME,
                "active" BOOLEAN NOT NULL DEFAULT 1,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE "Client" ADD COLUMN "cuit" TEXT;
            ALTER TABLE "Client" ADD COLUMN "businessName" TEXT;

            ALTER TABLE "DiscountCode" ADD COLUMN "discountType" TEXT DEFAULT 'PERCENTAGE';
            ALTER TABLE "DiscountCode" ADD COLUMN "discountValue" DECIMAL;
            ALTER TABLE "DiscountCode" ADD COLUMN "minPurchase" DECIMAL DEFAULT 0;
        "#,
    },
    Migration {
        version: 5,
        name: "add_missing_ecommerce_columns",
        sql: r#"
            ALTER TABLE "Product" ADD COLUMN "unitType" TEXT;
            ALTER TABLE "Product" ADD COLUMN "isPublicWeb" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "Product" ADD COLUMN "webCategory" TEXT;
            ALTER TABLE "Product" ADD COLUMN "imageUrl" TEXT;

            ALTER TABLE "Sale" ADD COLUMN "discountCodeApplied" TEXT;
            ALTER TABLE "Sale" ADD COLUMN "promotionsApplied" TEXT;
            ALTER TABLE "Sale" ADD COLUMN "creditCardPromotionId" INTEGER;
            ALTER TABLE "Sale" ADD COLUMN "onAccount" BOOLEAN NOT NULL DEFAULT 0;
        "#,
    },
    Migration {
        version: 6,
        name: "add_images_to_combos_and_promotions",
        sql: r#"
            ALTER TABLE "Combo" ADD COLUMN "imageUrl" TEXT;
            ALTER TABLE "Promotion" ADD COLUMN "imageUrl" TEXT;
        "#,
    },
    Migration {
        version: 7,
        name: "add_store_custom_domain",
        sql: r#"ALTER TABLE "StoreConfig" ADD COLUMN "customDomain" TEXT"#,
    },
    Migration {
        version: 8,
        name: "add_branch_to_sale",
        sql: r#"ALTER TABLE "Sale" ADD COLUMN "branchId" INTEGER"#,
    },
    Migration {
        version: 9,
        name: "add_multi_branch_tables",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "Branch" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "name" TEXT NOT NULL,
                "address" TEXT,
                "phone" TEXT,
                "isMain" BOOLEAN NOT NULL DEFAULT 0,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS "ProductBranchStock" (
                "productId" INTEGER NOT NULL,
                "branchId" INTEGER NOT NULL,
                "quantityStock" REAL NOT NULL DEFAULT 0,
                "minStock" REAL DEFAULT 0,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY ("productId", "branchId"),
                CONSTRAINT "ProductBranchStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "ProductBranchStock_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "StockTransfer" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "sourceBranchId" INTEGER NOT NULL,
                "targetBranchId" INTEGER NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'COMPLETED',
                "notes" TEXT,
                "createdByName" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "StockTransfer_sourceBranchId_fkey" FOREIGN KEY ("sourceBranchId") REFERENCES "Branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
                CONSTRAINT "StockTransfer_targetBranchId_fkey" FOREIGN KEY ("targetBranchId") REFERENCES "Branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "StockTransferItem" (
                "transferId" INTEGER NOT NULL,
                "productId" INTEGER NOT NULL,
                "productName" TEXT,
                "quantity" REAL NOT NULL,
                "receivedQuantity" REAL,
                PRIMARY KEY ("transferId", "productId"),
                CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "StockTransferItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );
        "#,
    },
    Migration {
        version: 10,
        name: "add_mp_fee_amount_to_weborder",
        sql: r#"ALTER TABLE "WebOrder" ADD COLUMN "mpFeeAmount" DECIMAL NOT NULL DEFAULT 0"#,
    },
    Migration {
        version: 11,
        name: "add_branch_to_weborder",
        sql: r#"ALTER TABLE "WebOrder" ADD COLUMN "branchId" INTEGER"#,
    },
    Migration {
        version: 12,
        name: "add_sync_outbox",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "SyncOutbox" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "operation" TEXT NOT NULL,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'PENDING',
                "attempts" INTEGER NOT NULL DEFAULT 0,
                "lastError" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL
            );
            CREATE INDEX IF NOT EXISTS "SyncOutbox_status_idx" ON "SyncOutbox" ("status");
        "#,
    },
    Migration {
        version: 13,
        name: "make_saleitem_product_optional",
        sql: r#"
            PRAGMA foreign_keys=OFF;
            CREATE TABLE "SaleItem_new" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "quantity" REAL NOT NULL,
                "priceAtSale" DECIMAL NOT NULL,
                "purchasePriceAtSale" DECIMAL NOT NULL,
                "saleId" INTEGER NOT NULL,
                "productId" INTEGER,
                "productName" TEXT,
                CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
            );
            INSERT INTO "SaleItem_new" ("id", "quantity", "priceAtSale", "purchasePriceAtSale", "saleId", "productId", "productName")
                SELECT "id", "quantity", "priceAtSale", "purchasePriceAtSale", "saleId", "productId",
                       (SELECT "name" FROM "Product" WHERE "Product"."id" = "SaleItem"."productId")
                FROM "SaleItem";
            DROP TABLE "SaleItem";
            ALTER TABLE "SaleItem_new" RENAME TO "SaleItem";
            CREATE INDEX IF NOT EXISTS "SaleItem_saleId_idx" ON "SaleItem" ("saleId");
            CREATE INDEX IF NOT EXISTS "SaleItem_productId_idx" ON "SaleItem" ("productId");
            PRAGMA foreign_keys=ON;
        "#,
    },
    Migration {
        version: 14,
        name: "add_recetario",
        sql: r#"
            ALTER TABLE "Product" ADD COLUMN "isRecipe" BOOLEAN NOT NULL DEFAULT 0;

            CREATE TABLE IF NOT EXISTS "RecipeItem" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "productId" INTEGER NOT NULL,
                "ingredientId" INTEGER NOT NULL,
                "quantity" REAL NOT NULL,
                "unitType" TEXT NOT NULL,
                CONSTRAINT "RecipeItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "RecipeItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "RecipeItem_productId_idx" ON "RecipeItem" ("productId");
            CREATE INDEX IF NOT EXISTS "RecipeItem_ingredientId_idx" ON "RecipeItem" ("ingredientId");
        "#,
    },
    Migration {
        version: 15,
        name: "recetario_ingredientes_marca_categoria_opcionales",
        sql: r#"
            PRAGMA foreign_keys=OFF;
            CREATE TABLE "Product_new" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "name" TEXT NOT NULL,
                "sku" TEXT,
                "description" TEXT,
                "pricePurchase" DECIMAL NOT NULL,
                "priceSale" DECIMAL NOT NULL,
                "quantityStock" REAL NOT NULL,
                "stockMinAlert" REAL,
                "unitType" TEXT,
                "isPublicWeb" BOOLEAN NOT NULL DEFAULT 0,
                "webCategory" TEXT,
                "imageUrl" TEXT,
                "brandId" INTEGER,
                "categoryId" INTEGER,
                "supplierId" INTEGER,
                "isRecipe" BOOLEAN NOT NULL DEFAULT 0,
                "isIngredient" BOOLEAN NOT NULL DEFAULT 0,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL,
                CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
                CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
                CONSTRAINT "Product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
            );
            INSERT INTO "Product_new" ("id", "name", "sku", "description", "pricePurchase", "priceSale", "quantityStock", "stockMinAlert", "unitType", "isPublicWeb", "webCategory", "imageUrl", "brandId", "categoryId", "supplierId", "isRecipe", "isIngredient", "createdAt", "updatedAt")
                SELECT "id", "name", "sku", "description", "pricePurchase", "priceSale", "quantityStock", "stockMinAlert", "unitType", "isPublicWeb", "webCategory", "imageUrl", "brandId", "categoryId", "supplierId", "isRecipe", 0, "createdAt", "updatedAt"
                FROM "Product";
            DROP TABLE "Product";
            ALTER TABLE "Product_new" RENAME TO "Product";
            CREATE UNIQUE INDEX IF NOT EXISTS "Product_sku_key" ON "Product"("sku");
            PRAGMA foreign_keys=ON;
        "#,
    },
    Migration {
        version: 16,
        name: "add_recipe_cost_history",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "RecipeCostHistory" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "productId" INTEGER NOT NULL,
                "cost" DECIMAL NOT NULL,
                "hasFullCost" BOOLEAN NOT NULL DEFAULT 1,
                "source" TEXT NOT NULL,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "RecipeCostHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "RecipeCostHistory_productId_idx" ON "RecipeCostHistory" ("productId");
            CREATE INDEX IF NOT EXISTS "RecipeCostHistory_createdAt_idx" ON "RecipeCostHistory" ("createdAt");
        "#,
    },
    Migration {
        version: 17,
        name: "add_product_modifiers_and_business_sector",
        sql: r#"
            ALTER TABLE "StoreConfig" ADD COLUMN "businessSector" TEXT NOT NULL DEFAULT 'GASTRONOMIA';

            ALTER TABLE "WebOrder" ADD COLUMN "scheduledFor" DATETIME;

            ALTER TABLE "WebOrderItem" ADD COLUMN "modifiers" TEXT;

            ALTER TABLE "SaleItem" ADD COLUMN "modifiers" TEXT;

            CREATE TABLE IF NOT EXISTS "ProductModifierGroup" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "productId" INTEGER NOT NULL,
                "name" TEXT NOT NULL,
                "type" TEXT NOT NULL DEFAULT 'MULTI_SELECT',
                "isRequired" BOOLEAN NOT NULL DEFAULT 0,
                "minSelect" INTEGER NOT NULL DEFAULT 0,
                "maxSelect" INTEGER,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "ProductModifierGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "ProductModifierGroup_productId_idx" ON "ProductModifierGroup" ("productId");

            CREATE TABLE IF NOT EXISTS "ProductModifierOption" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "modifierGroupId" INTEGER NOT NULL,
                "name" TEXT NOT NULL,
                "priceExtra" DECIMAL NOT NULL DEFAULT 0,
                "colorHex" TEXT,
                "ingredientId" INTEGER,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "ProductModifierOption_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "ProductModifierGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT "ProductModifierOption_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "ProductModifierOption_modifierGroupId_idx" ON "ProductModifierOption" ("modifierGroupId");
        "#,
    },
    Migration {
        version: 18,
        name: "add_modifier_option_ingredient_qty",
        sql: r#"
            ALTER TABLE "ProductModifierOption" ADD COLUMN "ingredientQty" DECIMAL NOT NULL DEFAULT 1;
        "#,
    },
    Migration {
        version: 19,
        name: "add_weborder_discount_fields",
        sql: r#"
            ALTER TABLE "WebOrder" ADD COLUMN "subtotalAmount" DECIMAL NOT NULL DEFAULT 0;
            ALTER TABLE "WebOrder" ADD COLUMN "discountAmount" DECIMAL NOT NULL DEFAULT 0;
            ALTER TABLE "WebOrder" ADD COLUMN "deliveryFee" DECIMAL NOT NULL DEFAULT 0;
            ALTER TABLE "WebOrder" ADD COLUMN "couponCode" TEXT;
        "#,
    },
    Migration {
        version: 20,
        name: "add_weborder_origin",
        sql: r#"
            ALTER TABLE "WebOrder" ADD COLUMN "origin" TEXT;
        "#,
    },
    Migration {
        version: 21,
        name: "fase2_delivery_zones_and_stock_review",
        sql: r#"
            ALTER TABLE "StoreConfig" ADD COLUMN "lat" REAL;
            ALTER TABLE "StoreConfig" ADD COLUMN "lng" REAL;
            ALTER TABLE "StoreConfig" ADD COLUMN "deliveryZones" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "openingHours" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "deliveryZone" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "trackingCode" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "stockReviewNote" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "stockReviewAt" DATETIME;
            ALTER TABLE "WebOrder" ADD COLUMN "mpPaymentId" TEXT;
        "#,
    },
    Migration {
        version: 22,
        name: "add_weborder_discount_breakdown",
        sql: r#"
            ALTER TABLE "WebOrder" ADD COLUMN "discountBreakdown" TEXT;
        "#,
    },
    Migration {
        version: 23,
        name: "add_product_web_unavailable",
        sql: r#"
            ALTER TABLE "Product" ADD COLUMN "webUnavailable" INTEGER NOT NULL DEFAULT 0;
        "#,
    },
    Migration {
        version: 24,
        name: "fase3_integrations_parity",
        sql: r#"
            ALTER TABLE "StoreConfig" ADD COLUMN "requireMpForDelivery" BOOLEAN NOT NULL DEFAULT 1;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaEnabled" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaConnected" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaClientId" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaClientSecret" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaChainId" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaVendorId" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaEnv" TEXT NOT NULL DEFAULT 'SANDBOX';
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaAutoAccept" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaOutletStatus" TEXT NOT NULL DEFAULT 'OPEN';
            ALTER TABLE "StoreConfig" ADD COLUMN "peyaWebhookSecret" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiEnabled" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiConnected" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiApiKey" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiStoreId" TEXT;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiAutoAccept" BOOLEAN NOT NULL DEFAULT 0;
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiOutletStatus" TEXT NOT NULL DEFAULT 'OPEN';
            ALTER TABLE "StoreConfig" ADD COLUMN "rappiWebhookSecret" TEXT;
            ALTER TABLE "Product" ADD COLUMN "externalSku" TEXT;
            ALTER TABLE "Product" ADD COLUMN "lastSyncJobId" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "orderCode" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "externalOrderId" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "chainId" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "vendorId" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "transportType" TEXT;
            ALTER TABLE "WebOrder" ADD COLUMN "promisedFor" DATETIME;
            ALTER TABLE "WebOrder" ADD COLUMN "acceptedFor" DATETIME;
            ALTER TABLE "WebOrder" ADD COLUMN "riderInfo" TEXT;
            ALTER TABLE "WebOrderItem" ADD COLUMN "externalItemId" TEXT;
            ALTER TABLE "Coupon" ADD COLUMN "expiresAt" DATETIME;
            ALTER TABLE "Sale" ADD COLUMN "cashRegisterId" INTEGER;
            CREATE UNIQUE INDEX IF NOT EXISTS "WebOrder_externalOrderId_key" ON "WebOrder"("externalOrderId");
        "#,
    },
];

// ── Declarative safety net ─────────────────────────────────────────────
// Fuente de verdad: prisma/schema.prisma (modelos foco: Setting, StoreConfig,
// Product, WebOrder, WebOrderItem, Coupon, Sale, SaleItem).
// Si una columna futura se agrega al schema pero se olvida en MIGRATIONS,
// este verificador la crea igual de forma idempotente en cada arranque
// (ignora "duplicate column").
//
// Tipos intencionalmente NULLABLES (sin NOT NULL): lo único que importa para
// evitar P2021/P2022 es la existencia de la columna. Las tablas frescas
// obtienen constraints correctos vía `prisma db push` del template, y los
// upgrades con defaults correctos vía MIGRATIONS versionadas (que corren
// antes que este verificador).
// Mantener sincronizado con pages/api/health/db.ts y scripts/check-drift.js.
const EXPECTED_COLUMNS: &[(&str, &str, &str)] = &[
    ("Setting", "id", "INTEGER"),
    ("Setting", "key", "TEXT"),
    ("Setting", "value", "TEXT"),
    ("StoreConfig", "id", "INTEGER"),
    ("StoreConfig", "slug", "TEXT"),
    ("StoreConfig", "customDomain", "TEXT"),
    ("StoreConfig", "businessName", "TEXT"),
    ("StoreConfig", "description", "TEXT"),
    ("StoreConfig", "logoUrl", "TEXT"),
    ("StoreConfig", "bannerUrl", "TEXT"),
    ("StoreConfig", "primaryColor", "TEXT"),
    ("StoreConfig", "isWebActive", "BOOLEAN"),
    ("StoreConfig", "mpAccessToken", "TEXT"),
    ("StoreConfig", "mpPublicKey", "TEXT"),
    ("StoreConfig", "mpFeePercent", "DECIMAL"),
    ("StoreConfig", "whatsappPhone", "TEXT"),
    ("StoreConfig", "minStockBuffer", "REAL"),
    ("StoreConfig", "allowPickup", "BOOLEAN"),
    ("StoreConfig", "allowDelivery", "BOOLEAN"),
    ("StoreConfig", "deliveryFee", "DECIMAL"),
    ("StoreConfig", "minDeliveryAmount", "DECIMAL"),
    ("StoreConfig", "businessSector", "TEXT"),
    ("StoreConfig", "requireMpForDelivery", "BOOLEAN"),
    ("StoreConfig", "lat", "REAL"),
    ("StoreConfig", "lng", "REAL"),
    ("StoreConfig", "deliveryZones", "TEXT"),
    ("StoreConfig", "openingHours", "TEXT"),
    ("StoreConfig", "peyaEnabled", "BOOLEAN"),
    ("StoreConfig", "peyaConnected", "BOOLEAN"),
    ("StoreConfig", "peyaClientId", "TEXT"),
    ("StoreConfig", "peyaClientSecret", "TEXT"),
    ("StoreConfig", "peyaChainId", "TEXT"),
    ("StoreConfig", "peyaVendorId", "TEXT"),
    ("StoreConfig", "peyaEnv", "TEXT"),
    ("StoreConfig", "peyaAutoAccept", "BOOLEAN"),
    ("StoreConfig", "peyaOutletStatus", "TEXT"),
    ("StoreConfig", "peyaWebhookSecret", "TEXT"),
    ("StoreConfig", "rappiEnabled", "BOOLEAN"),
    ("StoreConfig", "rappiConnected", "BOOLEAN"),
    ("StoreConfig", "rappiApiKey", "TEXT"),
    ("StoreConfig", "rappiStoreId", "TEXT"),
    ("StoreConfig", "rappiAutoAccept", "BOOLEAN"),
    ("StoreConfig", "rappiOutletStatus", "TEXT"),
    ("StoreConfig", "rappiWebhookSecret", "TEXT"),
    ("StoreConfig", "createdAt", "DATETIME"),
    ("StoreConfig", "updatedAt", "DATETIME"),
    ("Product", "id", "INTEGER"),
    ("Product", "name", "TEXT"),
    ("Product", "sku", "TEXT"),
    ("Product", "description", "TEXT"),
    ("Product", "pricePurchase", "DECIMAL"),
    ("Product", "priceSale", "DECIMAL"),
    ("Product", "quantityStock", "REAL"),
    ("Product", "stockMinAlert", "REAL"),
    ("Product", "unitType", "TEXT"),
    ("Product", "isPublicWeb", "BOOLEAN"),
    ("Product", "webCategory", "TEXT"),
    ("Product", "webUnavailable", "BOOLEAN"),
    ("Product", "externalSku", "TEXT"),
    ("Product", "lastSyncJobId", "TEXT"),
    ("Product", "imageUrl", "TEXT"),
    ("Product", "brandId", "INTEGER"),
    ("Product", "categoryId", "INTEGER"),
    ("Product", "supplierId", "INTEGER"),
    ("Product", "isRecipe", "BOOLEAN"),
    ("Product", "isIngredient", "BOOLEAN"),
    ("Product", "createdAt", "DATETIME"),
    ("Product", "updatedAt", "DATETIME"),
    ("WebOrder", "id", "INTEGER"),
    ("WebOrder", "webOrderNumber", "TEXT"),
    ("WebOrder", "clientName", "TEXT"),
    ("WebOrder", "clientEmail", "TEXT"),
    ("WebOrder", "clientPhone", "TEXT"),
    ("WebOrder", "shippingAddress", "TEXT"),
    ("WebOrder", "deliveryType", "TEXT"),
    ("WebOrder", "branchId", "INTEGER"),
    ("WebOrder", "paymentMethod", "TEXT"),
    ("WebOrder", "paymentStatus", "TEXT"),
    ("WebOrder", "status", "TEXT"),
    ("WebOrder", "totalAmount", "DECIMAL"),
    ("WebOrder", "mpFeeAmount", "DECIMAL"),
    ("WebOrder", "subtotalAmount", "DECIMAL"),
    ("WebOrder", "discountAmount", "DECIMAL"),
    ("WebOrder", "deliveryFee", "DECIMAL"),
    ("WebOrder", "couponCode", "TEXT"),
    ("WebOrder", "deliveryZone", "TEXT"),
    ("WebOrder", "trackingCode", "TEXT"),
    ("WebOrder", "origin", "TEXT"),
    ("WebOrder", "orderCode", "TEXT"),
    ("WebOrder", "externalOrderId", "TEXT"),
    ("WebOrder", "chainId", "TEXT"),
    ("WebOrder", "vendorId", "TEXT"),
    ("WebOrder", "transportType", "TEXT"),
    ("WebOrder", "promisedFor", "DATETIME"),
    ("WebOrder", "acceptedFor", "DATETIME"),
    ("WebOrder", "riderInfo", "TEXT"),
    ("WebOrder", "scheduledFor", "DATETIME"),
    ("WebOrder", "stockReviewNote", "TEXT"),
    ("WebOrder", "stockReviewAt", "DATETIME"),
    ("WebOrder", "mpPaymentId", "TEXT"),
    ("WebOrder", "discountBreakdown", "TEXT"),
    ("WebOrder", "notes", "TEXT"),
    ("WebOrder", "createdAt", "DATETIME"),
    ("WebOrder", "updatedAt", "DATETIME"),
    ("WebOrderItem", "id", "INTEGER"),
    ("WebOrderItem", "webOrderId", "INTEGER"),
    ("WebOrderItem", "productId", "INTEGER"),
    ("WebOrderItem", "quantity", "REAL"),
    ("WebOrderItem", "unitPrice", "DECIMAL"),
    ("WebOrderItem", "subtotal", "DECIMAL"),
    ("WebOrderItem", "modifiers", "TEXT"),
    ("WebOrderItem", "externalItemId", "TEXT"),
    ("Coupon", "id", "INTEGER"),
    ("Coupon", "code", "TEXT"),
    ("Coupon", "discountType", "TEXT"),
    ("Coupon", "discountValue", "DECIMAL"),
    ("Coupon", "minPurchase", "DECIMAL"),
    ("Coupon", "active", "BOOLEAN"),
    ("Coupon", "createdAt", "DATETIME"),
    ("Coupon", "expiresAt", "DATETIME"),
    ("Sale", "id", "INTEGER"),
    ("Sale", "saleDate", "DATETIME"),
    ("Sale", "totalAmount", "DECIMAL"),
    ("Sale", "paymentType", "TEXT"),
    ("Sale", "notes", "TEXT"),
    ("Sale", "clientId", "INTEGER"),
    ("Sale", "sellerId", "INTEGER"),
    ("Sale", "cashRegisterId", "INTEGER"),
    ("Sale", "branchId", "INTEGER"),
    ("Sale", "createdAt", "DATETIME"),
    ("Sale", "updatedAt", "DATETIME"),
    ("Sale", "discountCodeApplied", "TEXT"),
    ("Sale", "promotionsApplied", "TEXT"),
    ("Sale", "creditCardPromotionId", "INTEGER"),
    ("Sale", "onAccount", "BOOLEAN"),
    ("Sale", "status", "TEXT"),
    ("SaleItem", "id", "INTEGER"),
    ("SaleItem", "quantity", "REAL"),
    ("SaleItem", "priceAtSale", "DECIMAL"),
    ("SaleItem", "purchasePriceAtSale", "DECIMAL"),
    ("SaleItem", "saleId", "INTEGER"),
    ("SaleItem", "productId", "INTEGER"),
    ("SaleItem", "productName", "TEXT"),
    ("SaleItem", "modifiers", "TEXT"),
];

fn ensure_expected_columns(conn: &Connection) {
    for (table, column, def) in EXPECTED_COLUMNS {
        let stmt = format!(r#"ALTER TABLE "{}" ADD COLUMN "{}" {}"#, table, column, def);
        match conn.execute(&stmt, []) {
            Ok(_) => println!("[Migrations] ensure: added {}.{}", table, column),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") || msg.contains("already exists") {
                    // ya existe: estado deseado alcanzado
                } else if msg.contains("no such table") {
                    eprintln!("[Migrations] ensure: table {} missing, skipping {}.{} ({})", table, table, column, e);
                } else {
                    eprintln!("[Migrations] ensure error on {}.{}: {}", table, column, e);
                }
            }
        }
    }
    let _ = conn.execute(
        r#"CREATE UNIQUE INDEX IF NOT EXISTS "WebOrder_externalOrderId_key" ON "WebOrder"("externalOrderId")"#,
        [],
    );
}

fn run_migrations(db_path: &Path) {
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Migrations] Failed to open database: {}", e);
            return;
        }
    };

    // Create the migrations tracking table if it doesn't exist
    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _app_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ) {
        eprintln!("[Migrations] Failed to create tracking table: {}", e);
        return;
    }

    // Backup pre-migración (solo al actualizar una DB existente con migraciones
    // pendientes; en instalaciones frescas no hay datos que respaldar).
    // Conserva los últimos 3 backups.
    let latest_applied: Option<i32> = conn
        .query_row("SELECT MAX(version) FROM _app_migrations", [], |r| {
            r.get(0)
        })
        .unwrap_or(None);
    let latest_known: i32 = MIGRATIONS.last().map(|m| m.version).unwrap_or(0);
    let needs_backup = latest_applied.map(|v| v < latest_known).unwrap_or(false);
    if needs_backup && db_path.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let bak = db_path.with_extension(format!("db.{}.bak", stamp));
        match fs::copy(db_path, &bak) {
            Ok(_) => {
                println!("[Migrations] Backup pre-migración: {}", bak.display());
                // Podar backups viejos, conservar los 3 más recientes.
                if let Some(parent) = db_path.parent() {
                    let mut baks: Vec<_> = fs::read_dir(parent)
                        .map(|rd| {
                            rd.filter_map(|e| e.ok())
                                .map(|e| e.path())
                                .filter(|p| {
                                    p.extension().map(|x| x == "bak").unwrap_or(false)
                                        && p.file_stem()
                                            .map(|s| s.to_string_lossy().contains("crm_prod.db."))
                                            .unwrap_or(false)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    baks.sort();
                    while baks.len() > 3 {
                        if let Some(old) = baks.first().cloned() {
                            let _ = fs::remove_file(&old);
                            baks.remove(0);
                        } else {
                            break;
                        }
                    }
                }
            }
            Err(e) => eprintln!("[Migrations] No se pudo crear backup: {}", e),
        }
    }

    for migration in MIGRATIONS {
        let already_applied: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM _app_migrations WHERE version = ?1",
                [migration.version],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if already_applied {
            continue;
        }

        println!("[Migrations] Applying v{}: {} ...", migration.version, migration.name);

        let mut has_error = false;
        for statement in migration.sql.split(';') {
            let stmt = statement.trim();
            if stmt.is_empty() {
                continue;
            }
            if let Err(e) = conn.execute(stmt, []) {
                let err_msg = e.to_string();
                if err_msg.contains("duplicate column") || err_msg.contains("already exists") {
                    println!("[Migrations] Statement already applied: {}", err_msg);
                } else {
                    eprintln!("[Migrations] Error executing statement ({}): {}", stmt, e);
                    has_error = true;
                }
            }
        }

        if !has_error {
            let _ = conn.execute(
                "INSERT INTO _app_migrations (version, name) VALUES (?1, ?2)",
                rusqlite::params![migration.version, migration.name],
            );
            println!("[Migrations] ✓ v{} applied successfully", migration.version);
        }
    }

    // Red de seguridad declarativa: crea cualquier columna esperada que falte,
    // aunque su migración versionada se haya marcado aplicada en el pasado.
    ensure_expected_columns(&conn);
}
// ── End auto-migration system ──────────────────────────────────────────

struct ServerState(Mutex<Option<Child>>);

#[derive(Serialize)]
struct BackupResult {
    success: bool,
    path: Option<String>,
    error: Option<String>,
    canceled: bool,
}

#[derive(Serialize)]
struct RestoreResult {
    success: bool,
    message: Option<String>,
    error: Option<String>,
    canceled: bool,
}

#[derive(Serialize)]
struct SaveFileResult {
    success: bool,
    path: Option<String>,
    error: Option<String>,
    canceled: bool,
}

fn get_db_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("crm_prod.db")
}

#[tauri::command]
async fn backup_database(app_handle: tauri::AppHandle) -> Result<BackupResult, String> {
    let db_path = get_db_path(&app_handle);
    if !db_path.exists() {
        return Ok(BackupResult { success: false, path: None, error: Some("Base de datos no encontrada.".into()), canceled: false });
    }

    use tauri_plugin_dialog::DialogExt;
    let file_path = app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db"])
        .set_file_name(&format!("backup_crm_{}.db", chrono::Local::now().format("%Y-%m-%d")))
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = path.into_path().unwrap();
            match fs::copy(&db_path, &path_str) {
                Ok(_) => Ok(BackupResult { success: true, path: Some(path_str.to_string_lossy().into_owned()), error: None, canceled: false }),
                Err(e) => Ok(BackupResult { success: false, path: None, error: Some(e.to_string()), canceled: false }),
            }
        },
        None => Ok(BackupResult { success: false, path: None, error: None, canceled: true }),
    }
}

#[tauri::command]
async fn restore_database(app_handle: tauri::AppHandle) -> Result<RestoreResult, String> {
    let db_path = get_db_path(&app_handle);

    use tauri_plugin_dialog::DialogExt;
    let file_path = app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db"])
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let source_path = path.into_path().unwrap();
            let mut temp_backup = db_path.clone();
            temp_backup.set_extension("db.backup_temp");
            
            if db_path.exists() {
                let _ = fs::copy(&db_path, &temp_backup);
            }
            
            match fs::copy(&source_path, &db_path) {
                Ok(_) => {
                    if temp_backup.exists() {
                        let _ = fs::remove_file(&temp_backup);
                    }
                    Ok(RestoreResult { success: true, message: Some("Base de datos restaurada. Se recomienda reiniciar la aplicación.".into()), error: None, canceled: false })
                },
                Err(e) => {
                    if temp_backup.exists() {
                        let _ = fs::copy(&temp_backup, &db_path);
                        let _ = fs::remove_file(&temp_backup);
                    }
                    Ok(RestoreResult { success: false, message: None, error: Some(e.to_string()), canceled: false })
                }
            }
        },
        None => Ok(RestoreResult { success: false, message: None, error: None, canceled: true }),
    }
}

#[tauri::command]
async fn save_report_file(
    app_handle: tauri::AppHandle,
    content_b64: String,
    file_name: String,
    ext: String,
) -> Result<SaveFileResult, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use tauri_plugin_dialog::DialogExt;

    let file_path = app_handle
        .dialog()
        .file()
        .add_filter("Archivo", &[ext.as_str()])
        .set_file_name(&file_name)
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = path.into_path().unwrap();
            match B64.decode(&content_b64) {
                Ok(bytes) => match fs::write(&path_str, &bytes) {
                    Ok(_) => Ok(SaveFileResult {
                        success: true,
                        path: Some(path_str.to_string_lossy().into_owned()),
                        error: None,
                        canceled: false,
                    }),
                    Err(e) => Ok(SaveFileResult {
                        success: false,
                        path: None,
                        error: Some(e.to_string()),
                        canceled: false,
                    }),
                },
                Err(e) => Ok(SaveFileResult {
                    success: false,
                    path: None,
                    error: Some(e.to_string()),
                    canceled: false,
                }),
            }
        }
        None => Ok(SaveFileResult {
            success: false,
            path: None,
            error: None,
            canceled: true,
        }),
    }
}

/// Sondea GET /api/health/db (ruta pública) hasta que responda {"ok":true}.
/// Devuelve true si la DB está sana, false si se agota el timeout (~60s).
/// Sin dependencias nuevas: HTTP/1.0 crudo sobre TcpStream.
fn wait_for_db_health(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::time::Duration;

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", port)
        .parse()
        .unwrap_or_else(|_| "127.0.0.1:3001".parse().unwrap());
    for _ in 0..240 {
        if let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let req = "GET /api/health/db HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = Vec::with_capacity(4096);
                if stream.read_to_end(&mut buf).is_ok() {
                    let body = String::from_utf8_lossy(&buf);
                    if body.contains(r#""ok":true"#) {
                        return true;
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    false
}

#[tauri::command]
async fn kill_server(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    if let Ok(mut server_state) = state.0.lock() {
        if let Some(mut child) = server_state.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

// ── Node orphan prevention ─────────────────────────────────────────────
// Sin esto, un crash / kill por task-manager / apagado deja node.exe
// huérfano reteniendo node.exe, la DLL de Prisma y el puerto 3001, y el
// updater (o el instalador) falla con `os error 32` al reescribir archivos.

// Handle del Job Object: debe vivir hasta la salida del proceso para que
// KILL_ON_JOB_CLOSE siga vigente. El SO lo libera al terminar la app.
#[cfg(not(debug_assertions))]
static JOB_HANDLE: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

/// Asigna el server recién spawneado a un Job Object con KILL_ON_JOB_CLOSE:
/// si la app muere por la vía que sea, Windows mata a node automáticamente.
#[cfg(not(debug_assertions))]
fn assign_to_job_object(child: &Child) {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    unsafe {
        let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if proc.is_null() || proc == INVALID_HANDLE_VALUE {
            return;
        }
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            CloseHandle(proc);
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok != 0 && AssignProcessToJobObject(job, proc) != 0 {
            if let Ok(mut slot) = JOB_HANDLE.lock() {
                *slot = job as usize;
            }
            // `job` queda abierto a propósito hasta la salida del proceso.
        } else {
            CloseHandle(job);
        }
        CloseHandle(proc);
    }
}

/// Resuelve el standalone empaquetado igual que el setup (misma prioridad).
fn resolve_standalone_dir(resource_dir: &Path) -> std::path::PathBuf {
    if resource_dir.join("_up_").join("app_standalone").join("server.js").exists() {
        resource_dir.join("_up_").join("app_standalone")
    } else if resource_dir.join("app_standalone").join("server.js").exists() {
        resource_dir.join("app_standalone")
    } else {
        resource_dir.to_path_buf()
    }
}

/// PIDs de node.exe cuyo command-line contiene `needle` (ruta del standalone).
/// Solo matchea el empaquetado propio; nunca dev ni otras apps.
fn find_stale_node_pids(needle: &str) -> Vec<u32> {
    if needle.is_empty() {
        return vec![];
    }
    let ps = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {{ if ($_.CommandLine -and $_.CommandLine.Replace('\\','/').ToLower().Contains('{0}')) {{ $_.ProcessId }} }}",
        needle.replace('\'', "")
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    // Nunca incluir al propio proceso (defensivo).
    let me = std::process::id();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok())
        .filter(|p| *p != me)
        .collect()
}

/// Mata por árbol (/T) y con fuerza (/F). Devuelve cuántos taskkill salieron ok.
fn kill_pids(pids: &[u32], tag: &str) -> usize {
    let mut ok = 0;
    for pid in pids {
        println!("[{}] Matando node huérfano (pid {})", tag, pid);
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if status.map(|s| s.success()).unwrap_or(false) {
            ok += 1;
        }
    }
    ok
}

fn standalone_needle(standalone_dir: &Path) -> String {
    standalone_dir
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

/// Reaper de arranque: mata huérfanos de arranques anteriores. Las 2ª
/// instancias vivas nunca llegan acá (single-instance las frena antes del
/// setup), así que todo match es un huérfano seguro de matar.
#[cfg(not(debug_assertions))]
fn reap_stale_node_servers(standalone_dir: &Path) {
    let needle = standalone_needle(standalone_dir);
    if needle.is_empty() {
        return;
    }
    kill_pids(&find_stale_node_pids(&needle), "Startup");
}

/// Comando para el flujo de update: caza huérfanos que el `kill_server`
/// (solo mata al hijo trackeado) no alcanza — ej. restos de versiones sin
/// Job Object. Sin esto, el puerto 3001 sigue ocupado y el instalador falla.
/// Devuelve cuántos mató. En debug no hace nada (0).
#[tauri::command]
async fn kill_stale_node_servers(app_handle: tauri::AppHandle) -> Result<usize, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app_handle;
        return Ok(0);
    }
    #[cfg(not(debug_assertions))]
    {
        let resource_dir = app_handle.path().resource_dir().unwrap_or_default();
        let standalone_dir = resolve_standalone_dir(&resource_dir);
        let needle = standalone_needle(&standalone_dir);
        if needle.is_empty() {
            return Ok(0);
        }
        Ok(kill_pids(&find_stale_node_pids(&needle), "Update"))
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_dialog::init())
    // 2ª instancia → enfoca la ventana existente y sale (nunca spawnea un
    // 2º server ni llega al setup, así el reaper no puede matar un vivo).
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .manage(ServerState(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![backup_database, restore_database, kill_server, kill_stale_node_servers, save_report_file])
    .setup(|app| {
      #[cfg(debug_assertions)]
      {
        let _ = app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        );
      }

      #[cfg(not(debug_assertions))]
      {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
          std::env::temp_dir()
        });

        let _ = fs::create_dir_all(&app_data_dir);

        let target_db = app_data_dir.join("crm_prod.db");
        let template_db = if resource_dir.join("_up_").join("prisma").join("crm_template.db").exists() {
          resource_dir.join("_up_").join("prisma").join("crm_template.db")
        } else {
          resource_dir.join("crm_template.db")
        };

        if !target_db.exists() && template_db.exists() {
          let _ = fs::copy(&template_db, &target_db);
        }

        // Run auto-migrations before starting the server
        run_migrations(&target_db);

        let db_url = format!("file:{}", target_db.to_string_lossy().replace('\\', "/"));

        let standalone_dir = resolve_standalone_dir(&resource_dir);

        let server_js = standalone_dir.join("server.js");
        let local_node = standalone_dir.join("node.exe");

        // KEYRING LOGIC: Get or create secure encryption secret
        let service = "com.emidev.clinpos";
        let user = "clinpos_encryption_secret";
        let entry = Entry::new(service, user).expect("Failed to access keyring");
        let encryption_secret = match entry.get_password() {
            Ok(secret) => secret,
            Err(_) => {
                // Generate a new 64-char random secret
                const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
                let mut rng = rand::thread_rng();
                let new_secret: String = (0..64)
                    .map(|_| {
                        let idx = rng.gen_range(0..CHARSET.len());
                        CHARSET[idx] as char
                    })
                    .collect();
                
                let _ = entry.set_password(&new_secret);
                new_secret
            }
        };

        // Generate a random APP_SECRET to protect the local server from browser access
        let app_secret: String = {
            let mut rng = rand::thread_rng();
            const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            (0..48).map(|_| { let idx = rng.gen_range(0..CHARSET.len()); CHARSET[idx] as char }).collect()
        };

        // Limpiar node.exe huérfanos de arranques anteriores ANTES de spawnear.
        reap_stale_node_servers(&standalone_dir);

        if server_js.exists() {
          let node_bin = if local_node.exists() {
            local_node.to_string_lossy().to_string()
          } else {
            "node".to_string()
          };

          let log_file_path = app_data_dir.join("server.log");
          let log_file = File::create(&log_file_path).expect("failed to create log file");
          let err_file = log_file.try_clone().expect("failed to clone log file");

          let node_bin_clean = node_bin.replace("\\\\?\\", "");
          let server_js_clean = server_js.to_string_lossy().replace("\\\\?\\", "");
          let standalone_dir_clean = standalone_dir.to_string_lossy().replace("\\\\?\\", "");


          let mut cmd = Command::new(node_bin_clean);
          cmd.arg(server_js_clean);
          cmd.current_dir(standalone_dir_clean);
          cmd.env("PORT", "3001");
          cmd.env("NODE_ENV", "production");
          cmd.env("DATABASE_URL", db_url);
          cmd.env("CLINPOS_ENCRYPTION_SECRET", encryption_secret);
          cmd.env("APP_SECRET", &app_secret);

          cmd.creation_flags(CREATE_NO_WINDOW);
          cmd.stdout(Stdio::from(log_file));
          cmd.stderr(Stdio::from(err_file));

          if let Ok(child) = cmd.spawn() {
            // Garantía del SO: si la app muere, node muere con ella.
            assign_to_job_object(&child);
            if let Ok(mut state) = app.state::<ServerState>().0.lock() {
              *state = Some(child);
            }
          }
        }

          // Store app_secret for the webview navigation
          let secret_for_nav = app_secret.clone();

          let app_handle = app.handle().clone();
          std::thread::spawn(move || {
            let port = 3001;
            // Navigate with secret as query param; middleware will set a cookie
            let target_url = format!("http://localhost:{}?_token={}", port, secret_for_nav);

            // 1) Esperar a que el puerto TCP acepte conexiones.
            let mut tcp_ok = false;
            for _ in 0..120 {
              if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                tcp_ok = true;
                break;
              }
              std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if !tcp_ok {
              eprintln!("[Startup] server TCP never came up on port {}", port);
            }

            // 2) Gate de salud de DB: no navegar hasta que /api/health/db diga ok.
            //    Nunca bloquea más de ~60s: si el backend no sana, se navega igual
            //    y el error queda visible en server.log + health endpoint.
            if wait_for_db_health(port) {
              println!("[Startup] DB health ok, navigating webview");
            } else {
              eprintln!("[Startup] DB health NOT ok after timeout — navigating anyway, check server.log and /api/health/db");
            }

            if let Some(window) = app_handle.get_webview_window("main") {
              let url: tauri::Url = target_url.parse().unwrap();
              let _ = window.navigate(url);
            }
          });
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      // Se mata en CloseRequested (libera puerto/archivos cuanto antes) y se
      // reintenta en Destroyed por seguridad.
      if matches!(
        event,
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
      ) {
        if let Ok(mut state) = window.state::<ServerState>().0.lock() {
          if let Some(mut child) = state.take() {
            let _ = child.kill();
            let _ = child.wait();
          }
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
          if let Ok(mut state) = app_handle.state::<ServerState>().0.lock() {
            if let Some(mut child) = state.take() {
              let _ = child.kill();
              let _ = child.wait();
            }
          }
        }
        _ => {}
      }
    });
}
