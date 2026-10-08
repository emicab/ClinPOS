use std::fs::{self, File};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, State};
use keyring::Entry;
use rand::Rng;
use rusqlite::Connection;
use serde::Serialize;

const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Log de la app ──────────────────────────────────────────────────────
// En release la app corre con windows_subsystem = "windows": stdout/stderr no
// van a ningún lado. Este log a archivo deja rastro de migraciones, keyring y
// arranque. Rota al superar 1 MB conservando el anterior (.1).
static APP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
const APP_LOG_MAX_BYTES: u64 = 1_048_576;

fn app_log(msg: &str) {
    eprintln!("{}", msg);
    if let Some(path) = APP_LOG_PATH.get() {
        if fs::metadata(path).map(|m| m.len() > APP_LOG_MAX_BYTES).unwrap_or(false) {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
        }
    }
}

macro_rules! log_line {
    ($($arg:tt)*) => { app_log(&format!($($arg)*)) };
}

/// Rota `base` → `base.1` → `base.2`… conservando `keep` copias previas, para
/// no perder el log del arranque anterior (justo el que sirve tras un crash).
fn rotate_log_file(base: &Path, keep: usize) {
    if !base.exists() {
        return;
    }
    let numbered = |n: usize| -> PathBuf {
        let mut name = base.as_os_str().to_os_string();
        name.push(format!(".{}", n));
        PathBuf::from(name)
    };
    let _ = fs::remove_file(numbered(keep));
    for n in (1..keep).rev() {
        let from = numbered(n);
        if from.exists() {
            let _ = fs::rename(&from, numbered(n + 1));
        }
    }
    let _ = fs::rename(base, numbered(1));
}

/// Conserva solo los `keep` archivos más recientes de `dir` cuyo nombre
/// contiene `marker` y termina en `.bak`.
fn prune_backups(dir: &Path, marker: &str, keep: usize) {
    let mut baks: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().map(|x| x == "bak").unwrap_or(false)
                        && p.file_name()
                            .map(|n| n.to_string_lossy().contains(marker))
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    baks.sort();
    while baks.len() > keep {
        let old = baks.remove(0);
        let _ = fs::remove_file(&old);
    }
}

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
    Migration {
        version: 25,
        name: "sync_protocol_v2",
        sql: r#"
            ALTER TABLE "SyncOutbox" ADD COLUMN "payloadJson" TEXT;
            ALTER TABLE "SyncOutbox" ADD COLUMN "nextAttemptAt" DATETIME;
            ALTER TABLE "SyncOutbox" ADD COLUMN "lastAttemptAt" DATETIME;
            ALTER TABLE "SyncOutbox" ADD COLUMN "lockedAt" DATETIME;
            CREATE INDEX IF NOT EXISTS "SyncOutbox_status_nextAttemptAt_idx"
                ON "SyncOutbox" ("status", "nextAttemptAt");
            CREATE INDEX IF NOT EXISTS "SyncOutbox_entity_entityKey_status_idx"
                ON "SyncOutbox" ("entity", "entityKey", "status");
            CREATE TABLE IF NOT EXISTS "SyncTombstone" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "deviceId" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "SyncTombstone_entity_entityKey_key"
                ON "SyncTombstone" ("entity", "entityKey");
            CREATE TABLE IF NOT EXISTS "SyncConflict" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "localVersion" TEXT,
                "remoteVersion" TEXT,
                "localPayload" TEXT,
                "remotePayload" TEXT,
                "status" TEXT NOT NULL DEFAULT 'OPEN',
                "resolution" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "resolvedAt" DATETIME
            );
            CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx"
                ON "SyncConflict" ("status");
            CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx"
                ON "SyncConflict" ("entity", "entityKey", "status");
        "#,
    },
    Migration {
        version: 26,
        name: "sync_protocol_v2_repair",
        sql: r#"
            CREATE TABLE IF NOT EXISTS "SyncOutbox" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "operation" TEXT NOT NULL,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'PENDING',
                "attempts" INTEGER NOT NULL DEFAULT 0,
                "lastError" TEXT,
                "payloadJson" TEXT,
                "nextAttemptAt" DATETIME,
                "lastAttemptAt" DATETIME,
                "lockedAt" DATETIME,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE "SyncOutbox" ADD COLUMN "payloadJson" TEXT;
            ALTER TABLE "SyncOutbox" ADD COLUMN "nextAttemptAt" DATETIME;
            ALTER TABLE "SyncOutbox" ADD COLUMN "lastAttemptAt" DATETIME;
            ALTER TABLE "SyncOutbox" ADD COLUMN "lockedAt" DATETIME;
            CREATE INDEX IF NOT EXISTS "SyncOutbox_status_idx" ON "SyncOutbox"("status");
            CREATE INDEX IF NOT EXISTS "SyncOutbox_status_nextAttemptAt_idx" ON "SyncOutbox"("status", "nextAttemptAt");
            CREATE INDEX IF NOT EXISTS "SyncOutbox_entity_entityKey_status_idx" ON "SyncOutbox"("entity", "entityKey", "status");
            CREATE TABLE IF NOT EXISTS "SyncTombstone" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "deviceId" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "SyncTombstone_entity_entityKey_key" ON "SyncTombstone"("entity", "entityKey");
            CREATE INDEX IF NOT EXISTS "SyncTombstone_deletedAt_idx" ON "SyncTombstone"("deletedAt");
            CREATE TABLE IF NOT EXISTS "SyncConflict" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "entity" TEXT NOT NULL,
                "entityKey" TEXT NOT NULL,
                "localVersion" TEXT,
                "remoteVersion" TEXT,
                "localPayload" TEXT,
                "remotePayload" TEXT,
                "status" TEXT NOT NULL DEFAULT 'OPEN',
                "resolution" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "resolvedAt" DATETIME
            );
            CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx" ON "SyncConflict"("status");
            CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx" ON "SyncConflict"("entity", "entityKey", "status");
        "#,
    },
    Migration {
        version: 27,
        name: "add_performance_indexes",
        // Solo aditiva: crea indices sobre columnas existentes (sin tocar datos).
        sql: r#"
            CREATE INDEX IF NOT EXISTS "Sale_saleDate_idx" ON "Sale"("saleDate");
            CREATE INDEX IF NOT EXISTS "Sale_clientId_idx" ON "Sale"("clientId");
            CREATE INDEX IF NOT EXISTS "Sale_sellerId_idx" ON "Sale"("sellerId");
            CREATE INDEX IF NOT EXISTS "Sale_cashRegisterId_idx" ON "Sale"("cashRegisterId");
            CREATE INDEX IF NOT EXISTS "Sale_branchId_idx" ON "Sale"("branchId");
            CREATE INDEX IF NOT EXISTS "Sale_status_idx" ON "Sale"("status");
            CREATE INDEX IF NOT EXISTS "SaleItem_saleId_idx" ON "SaleItem"("saleId");
            CREATE INDEX IF NOT EXISTS "SaleItem_productId_idx" ON "SaleItem"("productId");
            CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");
            CREATE INDEX IF NOT EXISTS "Product_brandId_idx" ON "Product"("brandId");
            CREATE INDEX IF NOT EXISTS "Product_supplierId_idx" ON "Product"("supplierId");
            CREATE INDEX IF NOT EXISTS "Product_isPublicWeb_idx" ON "Product"("isPublicWeb");
            CREATE INDEX IF NOT EXISTS "Purchase_supplierId_idx" ON "Purchase"("supplierId");
            CREATE INDEX IF NOT EXISTS "Purchase_purchaseDate_idx" ON "Purchase"("purchaseDate");
            CREATE INDEX IF NOT EXISTS "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");
            CREATE INDEX IF NOT EXISTS "PurchaseItem_productId_idx" ON "PurchaseItem"("productId");
            CREATE INDEX IF NOT EXISTS "ComboItem_comboId_idx" ON "ComboItem"("comboId");
            CREATE INDEX IF NOT EXISTS "ComboItem_productId_idx" ON "ComboItem"("productId");
            CREATE INDEX IF NOT EXISTS "WebOrder_status_idx" ON "WebOrder"("status");
            CREATE INDEX IF NOT EXISTS "WebOrder_createdAt_idx" ON "WebOrder"("createdAt");
            CREATE INDEX IF NOT EXISTS "WebOrder_branchId_idx" ON "WebOrder"("branchId");
            CREATE INDEX IF NOT EXISTS "WebOrderItem_webOrderId_idx" ON "WebOrderItem"("webOrderId");
            CREATE INDEX IF NOT EXISTS "WebOrderItem_productId_idx" ON "WebOrderItem"("productId");
            CREATE INDEX IF NOT EXISTS "CashMovement_cashRegisterId_idx" ON "CashMovement"("cashRegisterId");
            CREATE INDEX IF NOT EXISTS "CashMovement_sourceId_idx" ON "CashMovement"("sourceId");
            CREATE INDEX IF NOT EXISTS "AccountMovement_accountBalanceId_idx" ON "AccountMovement"("accountBalanceId");
            CREATE INDEX IF NOT EXISTS "AccountMovement_saleId_idx" ON "AccountMovement"("saleId");
            CREATE INDEX IF NOT EXISTS "StockTransferItem_productId_idx" ON "StockTransferItem"("productId");
            CREATE INDEX IF NOT EXISTS "ProductBranchStock_branchId_idx" ON "ProductBranchStock"("branchId");
            CREATE INDEX IF NOT EXISTS "Expense_expenseDate_idx" ON "Expense"("expenseDate");
            CREATE INDEX IF NOT EXISTS "CashRegister_status_idx" ON "CashRegister"("status");
            CREATE INDEX IF NOT EXISTS "ConsignmentItem_consignmentId_idx" ON "ConsignmentItem"("consignmentId");
            CREATE INDEX IF NOT EXISTS "ConsignmentItem_productId_idx" ON "ConsignmentItem"("productId");
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
    ("SyncOutbox", "payloadJson", "TEXT"),
    ("SyncOutbox", "nextAttemptAt", "DATETIME"),
    ("SyncOutbox", "lastAttemptAt", "DATETIME"),
    ("SyncOutbox", "lockedAt", "DATETIME"),
    ("SyncConflict", "status", "TEXT"),
    ("SyncTombstone", "entityKey", "TEXT"),
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
            Ok(_) => log_line!("[Migrations] ensure: added {}.{}", table, column),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") || msg.contains("already exists") {
                    // ya existe: estado deseado alcanzado
                } else if msg.contains("no such table") {
                    log_line!("[Migrations] ensure: table {} missing, skipping {}.{} ({})", table, table, column, e);
                } else {
                    log_line!("[Migrations] ensure error on {}.{}: {}", table, column, e);
                }
            }
        }
    }
    let _ = conn.execute(
        r#"CREATE UNIQUE INDEX IF NOT EXISTS "WebOrder_externalOrderId_key" ON "WebOrder"("externalOrderId")"#,
        [],
    );
}

// Se ejecuta en cada arranque y no depende de _app_migrations. Esto repara
// instalaciones donde una actualización quedó interrumpida o fue marcada
// como aplicada sin crear todas las tablas del protocolo de sync.
fn ensure_sync_protocol_tables(conn: &Connection) {
    let statements = [
        r#"CREATE TABLE IF NOT EXISTS "SyncOutbox" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "operation" TEXT NOT NULL,
            "entity" TEXT NOT NULL,
            "entityKey" TEXT NOT NULL,
            "status" TEXT NOT NULL DEFAULT 'PENDING',
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "lastError" TEXT,
            "payloadJson" TEXT,
            "nextAttemptAt" DATETIME,
            "lastAttemptAt" DATETIME,
            "lockedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"#,
        r#"CREATE TABLE IF NOT EXISTS "SyncTombstone" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "entity" TEXT NOT NULL,
            "entityKey" TEXT NOT NULL,
            "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "deviceId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"#,
        r#"CREATE TABLE IF NOT EXISTS "SyncConflict" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "entity" TEXT NOT NULL,
            "entityKey" TEXT NOT NULL,
            "localVersion" TEXT,
            "remoteVersion" TEXT,
            "localPayload" TEXT,
            "remotePayload" TEXT,
            "status" TEXT NOT NULL DEFAULT 'OPEN',
            "resolution" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "resolvedAt" DATETIME
        )"#,
        r#"CREATE INDEX IF NOT EXISTS "SyncOutbox_status_idx" ON "SyncOutbox"("status")"#,
        r#"CREATE INDEX IF NOT EXISTS "SyncOutbox_status_nextAttemptAt_idx" ON "SyncOutbox"("status", "nextAttemptAt")"#,
        r#"CREATE INDEX IF NOT EXISTS "SyncOutbox_entity_entityKey_status_idx" ON "SyncOutbox"("entity", "entityKey", "status")"#,
        r#"CREATE UNIQUE INDEX IF NOT EXISTS "SyncTombstone_entity_entityKey_key" ON "SyncTombstone"("entity", "entityKey")"#,
        r#"CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx" ON "SyncConflict"("status")"#,
        r#"CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx" ON "SyncConflict"("entity", "entityKey", "status")"#,
    ];
    for statement in statements {
        if let Err(error) = conn.execute(statement, []) {
            log_line!("[Migrations] sync schema repair error: {}", error);
        }
    }
}

fn run_migrations(db_path: &Path) {
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            log_line!("[Migrations] Failed to open database: {}", e);
            return;
        }
    };

    // WAL: lecturas concurrentes con escrituras (sync + ventas) y commits mas
    // rapidos. Es una propiedad persistente del archivo; no altera datos. Los
    // backups usan VACUUM INTO y el restore limpia -wal/-shm, asi que es seguro.
    match conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0)) {
        Ok(mode) if mode.eq_ignore_ascii_case("wal") => {}
        Ok(mode) => log_line!("[Migrations] journal_mode={} (no se pudo activar WAL en {})", mode, db_path.display()),
        Err(e) => log_line!("[Migrations] No se pudo activar WAL en {}: {}", db_path.display(), e),
    }

    // Create the migrations tracking table if it doesn't exist
    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _app_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ) {
        log_line!("[Migrations] Failed to create tracking table: {}", e);
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
        match vacuum_into(&conn, &bak) {
            Ok(_) => {
                log_line!("[Migrations] Backup pre-migración: {}", bak.display());
                // Podar backups viejos, conservar los 3 más recientes.
                if let Some(parent) = db_path.parent() {
                    // "<archivo>.<fecha 20xx...>.bak"; no incluye los .pre-restore-.
                    let name = db_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    prune_backups(parent, &format!("{}.20", name), 3);
                }
            }
            Err(e) => log_line!("[Migrations] No se pudo crear backup: {}", e),
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

        log_line!("[Migrations] Applying v{}: {} ...", migration.version, migration.name);

        let mut has_error = false;
        for statement in migration.sql.split(';') {
            let stmt = statement.trim();
            if stmt.is_empty() {
                continue;
            }
            if let Err(e) = conn.execute(stmt, []) {
                let err_msg = e.to_string();
                if err_msg.contains("duplicate column") || err_msg.contains("already exists") {
                    log_line!("[Migrations] Statement already applied: {}", err_msg);
                } else {
                    log_line!("[Migrations] Error executing statement ({}): {}", stmt, e);
                    has_error = true;
                }
            }
        }

        if !has_error {
            let _ = conn.execute(
                "INSERT INTO _app_migrations (version, name) VALUES (?1, ?2)",
                rusqlite::params![migration.version, migration.name],
            );
            log_line!("[Migrations] ✓ v{} applied successfully", migration.version);
        }
    }

    ensure_sync_protocol_tables(&conn);

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

fn get_db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("crm_prod.db")
}

/// Base del negocio activo. `store.json` (junto a la DB principal) guarda los
/// perfiles; si el activo apunta a otro archivo que `crm_prod.db`, el backup y
/// la restauración deben operar sobre ese archivo y no sobre la base default.
fn active_db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let default = get_db_path(app_handle);
    let dir = match default.parent() {
        Some(d) => d.to_path_buf(),
        None => return default,
    };
    let raw = match fs::read_to_string(dir.join("store.json")) {
        Ok(r) => r,
        Err(_) => return default,
    };
    let store: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return default,
    };
    let active_id = match store.get("activeProfileId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return default,
    };
    let db_file = store
        .get("profiles")
        .and_then(|p| p.as_array())
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(active_id))
        })
        .and_then(|p| p.get("dbFile").and_then(|v| v.as_str()));
    if let Some(file) = db_file {
        let candidate = Path::new(file);
        let path = if candidate.is_absolute() { candidate.to_path_buf() } else { dir.join(candidate) };
        if path.exists() {
            return path;
        }
    }
    default
}

/// Archivos de base de todos los negocios registrados en `store.json` (el
/// registro de perfiles vive junto a la DB principal). Cada negocio es una base
/// SQLite independiente y debe recibir las mismas migraciones que `crm_prod.db`.
fn profile_db_files(data_dir: &Path) -> Vec<PathBuf> {
    let raw = match fs::read_to_string(data_dir.join("store.json")) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let store: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    store
        .get("profiles")
        .and_then(|p| p.as_array())
        .map(|profiles| {
            profiles
                .iter()
                .filter_map(|p| p.get("dbFile").and_then(|v| v.as_str()))
                .map(|f| {
                    let c = Path::new(f);
                    if c.is_absolute() { c.to_path_buf() } else { data_dir.join(c) }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Copia consistente de la base con `VACUUM INTO`: genera un archivo SQLite
/// autocontenido (sin -wal/-shm pendientes) aunque otro proceso esté
/// escribiendo. Un `fs::copy` del archivo en vivo puede salir corrupto.
fn vacuum_into(conn: &Connection, dest: &Path) -> rusqlite::Result<()> {
    if dest.exists() {
        fs::remove_file(dest).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    }
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let escaped = dest.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}'", escaped))
}

fn pending_restore_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".restore_pending");
    PathBuf::from(name)
}

/// Valida que `source` sea una base ClinPOS sana y deja una copia limpia en
/// `pending`. No toca la base activa: la restauración se aplica al reiniciar.
fn stage_restore(source: &Path, pending: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("No se pudo abrir el archivo como base SQLite: {}", e))?;

    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("El archivo no es una base SQLite válida: {}", e))?;
    if check != "ok" {
        return Err(format!("El archivo está dañado (quick_check: {}).", check));
    }

    for table in ["Product", "Sale", "Setting"] {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !exists {
            return Err(format!("El archivo no parece una copia de ClinPOS (falta la tabla {}).", table));
        }
    }

    vacuum_into(&conn, pending).map_err(|e| {
        let _ = fs::remove_file(pending);
        format!("No se pudo preparar la restauración: {}", e)
    })
}

/// Aplica restauraciones pendientes. Corre al iniciar, ANTES de levantar node,
/// cuando nadie tiene la base abierta. Guarda antes una copia de la base actual
/// y descarta los -wal/-shm viejos para que no se mezclen con la restaurada.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn apply_pending_restores(data_dir: &Path) {
    let entries = match fs::read_dir(data_dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let pending = entry.path();
        let file_name = pending.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let target_name = match file_name.strip_suffix(".restore_pending") {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let target = data_dir.join(&target_name);

        if target.exists() {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
            let safety = data_dir.join(format!("{}.pre-restore-{}.bak", target_name, stamp));
            let saved = Connection::open(&target)
                .and_then(|c| vacuum_into(&c, &safety))
                .is_ok()
                || fs::copy(&target, &safety).is_ok();
            if !saved {
                log_line!("[Restore] No se pudo respaldar {}; se cancela la restauración.", target_name);
                let _ = fs::remove_file(&pending);
                continue;
            }
            prune_backups(data_dir, &format!("{}.pre-restore-", target_name), 3);
        }

        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = target.as_os_str().to_os_string();
            sidecar.push(suffix);
            let _ = fs::remove_file(PathBuf::from(sidecar));
        }

        match fs::rename(&pending, &target) {
            Ok(_) => log_line!("[Restore] Base {} restaurada desde la copia seleccionada.", target_name),
            Err(e) => log_line!("[Restore] No se pudo aplicar la restauración de {}: {}", target_name, e),
        }
    }
}

#[tauri::command]
async fn backup_database(app_handle: tauri::AppHandle) -> Result<BackupResult, String> {
    let db_path = active_db_path(&app_handle);
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
            let path_str = match path.into_path() {
                Ok(p) => p,
                Err(e) => return Ok(BackupResult { success: false, path: None, error: Some(format!("Ruta inválida: {}", e)), canceled: false }),
            };
            let result = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .and_then(|conn| vacuum_into(&conn, &path_str));
            match result {
                Ok(_) => Ok(BackupResult { success: true, path: Some(path_str.to_string_lossy().into_owned()), error: None, canceled: false }),
                Err(e) => {
                    log_line!("[Backup] Error al exportar copia: {}", e);
                    Ok(BackupResult { success: false, path: None, error: Some(e.to_string()), canceled: false })
                }
            }
        },
        None => Ok(BackupResult { success: false, path: None, error: None, canceled: true }),
    }
}

/// No pisa la base en uso: valida la copia elegida y la deja "pendiente"; se
/// aplica al próximo arranque (ver `apply_pending_restores`).
#[tauri::command]
async fn restore_database(app_handle: tauri::AppHandle) -> Result<RestoreResult, String> {
    let target = active_db_path(&app_handle);

    use tauri_plugin_dialog::DialogExt;
    let file_path = app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db"])
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let source_path = match path.into_path() {
                Ok(p) => p,
                Err(e) => return Ok(RestoreResult { success: false, message: None, error: Some(format!("Ruta inválida: {}", e)), canceled: false }),
            };
            let same_file = match (fs::canonicalize(&source_path), fs::canonicalize(&target)) {
                (Ok(a), Ok(b)) => a == b,
                _ => false,
            };
            if same_file {
                return Ok(RestoreResult { success: false, message: None, error: Some("Elegiste la base que está en uso. Seleccioná un archivo de copia de seguridad.".into()), canceled: false });
            }

            match stage_restore(&source_path, &pending_restore_path(&target)) {
                Ok(_) => Ok(RestoreResult {
                    success: true,
                    message: Some("Copia validada. Se aplicará al reiniciar ClinPOS (antes se guarda una copia de los datos actuales).".into()),
                    error: None,
                    canceled: false,
                }),
                Err(e) => {
                    log_line!("[Restore] Copia rechazada: {}", e);
                    Ok(RestoreResult { success: false, message: None, error: Some(e), canceled: false })
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
            let path_str = match path.into_path() {
                Ok(p) => p,
                Err(e) => return Ok(SaveFileResult { success: false, path: None, error: Some(format!("Ruta inválida: {}", e)), canceled: false }),
            };
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

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
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
        log_line!("[{}] Matando node huérfano (pid {})", tag, pid);
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

/// Cierre definitivo para el updater. Cerrar solo la ventana puede dejar vivo
/// el runtime Tauri/WebView durante unos instantes y Windows todavía ve node
/// como archivo en uso. Este comando libera el servidor y termina el proceso
/// principal de forma explícita después de descargar/instalar la actualización.
#[tauri::command]
async fn exit_for_update(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
) -> Result<(), String> {
    if let Ok(mut server_state) = state.0.lock() {
        if let Some(mut child) = server_state.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[cfg(not(debug_assertions))]
    {
        let resource_dir = app_handle.path().resource_dir().unwrap_or_default();
        let standalone_dir = resolve_standalone_dir(&resource_dir);
        let needle = standalone_needle(&standalone_dir);
        if !needle.is_empty() {
            kill_pids(&find_stale_node_pids(&needle), "ExitForUpdate");
        }
    }

    app_handle.exit(0);
    Ok(())
}
/// Secreto de cifrado persistente guardado en el Credential Manager de Windows.
///
/// Reglas para no perder datos cifrados (claves ARCA, API keys en Setting):
/// - Solo se genera un secreto nuevo si NO existe entrada (`NoEntry`); un error
///   transitorio de lectura nunca sobrescribe el secreto existente.
/// - Tras guardarlo se relee para comprobar que realmente persistió.
/// - Si el almacén no está disponible se devuelve "" (clave derivada solo del
///   equipo y usuario): es estable entre arranques, a diferencia de un secreto
///   aleatorio que se perdería al cerrar la app.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn load_or_create_encryption_secret() -> String {
    const SERVICE: &str = "com.emidev.clinpos";
    const USER: &str = "clinpos_encryption_secret";

    let entry = match Entry::new(SERVICE, USER) {
        Ok(e) => e,
        Err(e) => {
            log_line!("[Keyring] Almacén de credenciales inaccesible ({}). Se usa la clave derivada del equipo.", e);
            return String::new();
        }
    };

    for attempt in 1..=3 {
        match entry.get_password() {
            Ok(secret) if !secret.is_empty() => return secret,
            Ok(_) | Err(keyring::Error::NoEntry) => break,
            Err(e) => {
                log_line!("[Keyring] Lectura fallida (intento {}/3): {}", attempt, e);
                if attempt == 3 {
                    log_line!("[Keyring] Se conserva el secreto existente sin sobrescribir; esta sesión usa la clave derivada del equipo.");
                    return String::new();
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }

    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let mut rng = rand::thread_rng();
    let new_secret: String = (0..64)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect();

    match entry.set_password(&new_secret) {
        Ok(_) => match entry.get_password() {
            Ok(stored) if stored == new_secret => {
                log_line!("[Keyring] Secreto de cifrado creado y verificado.");
                new_secret
            }
            _ => {
                log_line!("[Keyring] El secreto no persistió tras guardarlo; se usa la clave derivada del equipo.");
                String::new()
            }
        },
        Err(e) => {
            log_line!("[Keyring] No se pudo guardar el secreto ({}); se usa la clave derivada del equipo.", e);
            String::new()
        }
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
    .invoke_handler(tauri::generate_handler![backup_database, restore_database, kill_server, kill_stale_node_servers, exit_for_update, save_report_file])
    .setup(|app| {
      if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = APP_LOG_PATH.set(dir.join("clinpos-app.log"));
      }

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

        // Aplica restauraciones elegidas en la sesión anterior, antes de que
        // nadie abra la base (ver restore_database).
        apply_pending_restores(&app_data_dir);

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

        // Los demas negocios (store.json) tambien necesitan las migraciones: antes
        // solo se migraba crm_prod.db y las bases de otros negocios quedaban atras.
        for extra in profile_db_files(&app_data_dir) {
          if extra.file_name() == target_db.file_name() || !extra.exists() {
            continue;
          }
          log_line!("[Migrations] Migrando base de negocio {}", extra.display());
          run_migrations(&extra);
        }

        let db_url = format!("file:{}", target_db.to_string_lossy().replace('\\', "/"));

        let standalone_dir = resolve_standalone_dir(&resource_dir);

        let server_js = standalone_dir.join("server.js");
        let local_node = standalone_dir.join("node.exe");

        let encryption_secret = load_or_create_encryption_secret();

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

          // Conserva los logs de los 3 arranques anteriores: tras un crash el
          // que sirve es el de la sesión previa, no uno recién truncado.
          let log_file_path = app_data_dir.join("server.log");
          rotate_log_file(&log_file_path, 3);
          let (server_stdout, server_stderr) = match File::create(&log_file_path)
            .and_then(|f| f.try_clone().map(|c| (f, c)))
          {
            Ok((out, err)) => (Stdio::from(out), Stdio::from(err)),
            Err(e) => {
              log_line!("[Startup] No se pudo crear server.log: {}", e);
              (Stdio::null(), Stdio::null())
            }
          };

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
          cmd.stdout(server_stdout);
          cmd.stderr(server_stderr);

          match cmd.spawn() {
            Ok(child) => {
              // Garantía del SO: si la app muere, node muere con ella.
              assign_to_job_object(&child);
              if let Ok(mut state) = app.state::<ServerState>().0.lock() {
                *state = Some(child);
              }
            }
            Err(e) => log_line!("[Startup] No se pudo iniciar el servidor local: {}", e),
          }
        } else {
          log_line!("[Startup] No se encontró server.js en {}", standalone_dir.display());
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
              log_line!("[Startup] server TCP never came up on port {}", port);
            }

            // 2) Gate de salud de DB: no navegar hasta que /api/health/db diga ok.
            //    Nunca bloquea más de ~60s: si el backend no sana, se navega igual
            //    y el error queda visible en server.log + health endpoint.
            if wait_for_db_health(port) {
              log_line!("[Startup] DB health ok, navigating webview");
            } else {
              log_line!("[Startup] DB health NOT ok after timeout — navigating anyway, check server.log and /api/health/db");
            }

            if let Some(window) = app_handle.get_webview_window("main") {
              match target_url.parse::<tauri::Url>() {
                Ok(url) => { let _ = window.navigate(url); }
                Err(e) => log_line!("[Startup] URL de navegación inválida: {}", e),
              }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clinpos_test_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Crea una base mínima con las tablas que exige `stage_restore`.
    fn make_clinpos_db(path: &Path, marker: &str, wal: bool) {
        let conn = Connection::open(path).unwrap();
        if wal {
            let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE Product (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE Sale (id INTEGER PRIMARY KEY);
             CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        conn.execute("INSERT INTO Product (name) VALUES (?1)", [marker]).unwrap();
    }

    fn first_product(path: &Path) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT name FROM Product LIMIT 1", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn vacuum_into_copies_wal_database_consistently() {
        let dir = scratch_dir("vacuum");
        let src = dir.join("src.db");
        make_clinpos_db(&src, "dato-en-wal", true);
        // Conexión viva con el WAL sin checkpoint: un fs::copy del .db perdería el dato.
        let live = Connection::open(&src).unwrap();
        live.execute("INSERT INTO Product (name) VALUES ('segundo')", []).unwrap();

        let dest = dir.join("copy.db");
        vacuum_into(&live, &dest).unwrap();

        let copy = Connection::open(&dest).unwrap();
        let count: i64 = copy.query_row("SELECT COUNT(*) FROM Product", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vacuum_into_overwrites_existing_destination() {
        let dir = scratch_dir("overwrite");
        let src = dir.join("src.db");
        make_clinpos_db(&src, "nuevo", false);
        let dest = dir.join("copy.db");
        fs::write(&dest, b"basura previa").unwrap();

        vacuum_into(&Connection::open(&src).unwrap(), &dest).unwrap();
        assert_eq!(first_product(&dest), "nuevo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_restore_rejects_invalid_files() {
        let dir = scratch_dir("reject");
        let pending = dir.join("x.restore_pending");

        let garbage = dir.join("garbage.db");
        fs::write(&garbage, b"esto no es sqlite, es solo texto de relleno largo").unwrap();
        assert!(stage_restore(&garbage, &pending).is_err());

        let other = dir.join("other.db");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE Foo (id INTEGER)").unwrap();
        let err = stage_restore(&other, &pending).unwrap_err();
        assert!(err.contains("falta la tabla"), "mensaje inesperado: {}", err);
        assert!(!pending.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_restore_is_applied_on_startup_with_safety_backup() {
        let dir = scratch_dir("apply");
        let target = dir.join("crm_prod.db");
        make_clinpos_db(&target, "datos-actuales", true);
        // Restos de WAL de la base vieja que no deben mezclarse con la restaurada.
        fs::write(dir.join("crm_prod.db-wal"), b"wal viejo").unwrap();
        fs::write(dir.join("crm_prod.db-shm"), b"shm viejo").unwrap();

        let source = dir.join("copia.db");
        make_clinpos_db(&source, "datos-de-la-copia", false);

        stage_restore(&source, &pending_restore_path(&target)).unwrap();
        // Hasta reiniciar, la base en uso no se toca.
        assert_eq!(first_product(&target), "datos-actuales");

        apply_pending_restores(&dir);

        assert_eq!(first_product(&target), "datos-de-la-copia");
        assert!(!pending_restore_path(&target).exists());
        assert!(!dir.join("crm_prod.db-wal").exists());
        assert!(!dir.join("crm_prod.db-shm").exists());
        let safety: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".pre-restore-"))
            .collect();
        assert_eq!(safety.len(), 1);
        assert_eq!(first_product(&safety[0].path()), "datos-actuales");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_log_file_keeps_previous_runs() {
        let dir = scratch_dir("rotate");
        let log = dir.join("server.log");
        for run in 1..=5 {
            rotate_log_file(&log, 3);
            fs::write(&log, format!("arranque {}", run)).unwrap();
        }
        assert_eq!(fs::read_to_string(&log).unwrap(), "arranque 5");
        assert_eq!(fs::read_to_string(dir.join("server.log.1")).unwrap(), "arranque 4");
        assert_eq!(fs::read_to_string(dir.join("server.log.2")).unwrap(), "arranque 3");
        assert_eq!(fs::read_to_string(dir.join("server.log.3")).unwrap(), "arranque 2");
        assert!(!dir.join("server.log.4").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Toca el Credential Manager real: `cargo test -- --ignored keyring_persists`.
    /// Un Entry recién creado debe ver lo guardado por otro (almacén persistente);
    /// con el almacén en memoria de keyring sin `windows-native` esto falla.
    #[test]
    #[ignore]
    fn keyring_persists_across_entries() {
        let service = "com.emidev.clinpos.test";
        let user = format!("persist_check_{}", std::process::id());
        Entry::new(service, &user).unwrap().set_password("valor-de-prueba").unwrap();
        let read = Entry::new(service, &user).unwrap().get_password();
        let _ = Entry::new(service, &user).unwrap().delete_credential();
        assert_eq!(read.unwrap(), "valor-de-prueba");
    }

    fn table_counts(conn: &Connection) -> Vec<(String, i64)> {
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_app_migrations' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        names
            .into_iter()
            .map(|n| {
                let c: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", n), [], |r| r.get(0)).unwrap();
                (n, c)
            })
            .collect()
    }

    /// Una base existente (copia de la plantilla real + datos) debe migrar sin
    /// perder ni una fila, quedar en WAL con los indices nuevos y poder
    /// migrarse otra vez sin efectos (idempotente).
    #[test]
    fn migrations_keep_all_rows_add_indexes_and_enable_wal() {
        let dir = scratch_dir("migrate");
        let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("prisma").join("crm_template.db");
        assert!(template.exists(), "falta prisma/crm_template.db");
        let db = dir.join("business_x.db");
        fs::copy(&template, &db).unwrap();
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute("INSERT OR REPLACE INTO Setting (key, value) VALUES ('test_key', 'test_value')", []).unwrap();
        }
        let before = table_counts(&Connection::open(&db).unwrap());

        run_migrations(&db);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(table_counts(&conn), before, "la migracion no debe cambiar la cantidad de filas");

        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let max: i32 = conn.query_row("SELECT MAX(version) FROM _app_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(max, MIGRATIONS.last().unwrap().version);
        for idx in ["Sale_saleDate_idx", "SaleItem_saleId_idx", "Product_categoryId_idx", "WebOrder_status_idx"] {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?1", [idx], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "falta el indice {}", idx);
        }
        let value: String = conn.query_row("SELECT value FROM Setting WHERE key='test_key'", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "test_value");
        drop(conn);

        run_migrations(&db);
        assert_eq!(table_counts(&Connection::open(&db).unwrap()), before);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Verifica una COPIA de una base real: `CLINPOS_TEST_DB=<ruta.db> cargo test
    /// -- --ignored migrates_real_copy`. Nunca apuntar a la base en uso.
    #[test]
    #[ignore]
    fn migrates_real_copy() {
        let Ok(src) = std::env::var("CLINPOS_TEST_DB") else {
            println!("omitido: definir CLINPOS_TEST_DB con la ruta de una COPIA de una base real");
            return;
        };
        let dir = scratch_dir("realcopy");
        let db = dir.join("copy.db");
        fs::copy(&src, &db).unwrap();
        let before = table_counts(&Connection::open(&db).unwrap());
        run_migrations(&db);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(table_counts(&conn), before);
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        println!("OK {} tablas, filas intactas, integrity_check ok, WAL", before.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_db_files_reads_every_business() {
        let dir = scratch_dir("profiles");
        fs::write(
            dir.join("store.json"),
            r#"{"version":1,"activeProfileId":"b1","profiles":[{"id":"legacy","dbFile":"crm_prod.db"},{"id":"b1","dbFile":"business_b1.db"}]}"#,
        )
        .unwrap();
        let files = profile_db_files(&dir);
        assert_eq!(files, vec![dir.join("crm_prod.db"), dir.join("business_b1.db")]);
        assert!(profile_db_files(&dir.join("no-existe")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_backups_keeps_only_latest() {
        let dir = scratch_dir("prune");
        for stamp in ["20260101", "20260102", "20260103", "20260104"] {
            fs::write(dir.join(format!("crm_prod.db.{}.bak", stamp)), b"x").unwrap();
        }
        fs::write(dir.join("otro.bak"), b"x").unwrap();
        prune_backups(&dir, "crm_prod.db.", 2);
        assert!(!dir.join("crm_prod.db.20260101.bak").exists());
        assert!(!dir.join("crm_prod.db.20260102.bak").exists());
        assert!(dir.join("crm_prod.db.20260103.bak").exists());
        assert!(dir.join("crm_prod.db.20260104.bak").exists());
        assert!(dir.join("otro.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
