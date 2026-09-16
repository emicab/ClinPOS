-- supabase_schema.sql
-- Ejecute este script en el editor SQL de Supabase para limpiar y crear la base de datos multi-inquilino (multi-tenant).
-- NOTA: Las claves primarias y relaciones son compuestas, formadas por (tenant_id, id).

-- 0. Limpiar tablas existentes en orden de dependencia
DROP TABLE IF EXISTS "AccountMovement" CASCADE;
DROP TABLE IF EXISTS "AccountBalance" CASCADE;
DROP TABLE IF EXISTS "CashMovement" CASCADE;
DROP TABLE IF EXISTS "CashRegister" CASCADE;
DROP TABLE IF EXISTS "ComboItem" CASCADE;
DROP TABLE IF EXISTS "Combo" CASCADE;
DROP TABLE IF EXISTS "SaleItem" CASCADE;
DROP TABLE IF EXISTS "Sale" CASCADE;
DROP TABLE IF EXISTS "ProductModifierOption" CASCADE;
DROP TABLE IF EXISTS "ProductModifierGroup" CASCADE;
DROP TABLE IF EXISTS "Product" CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;
DROP TABLE IF EXISTS "Seller" CASCADE;
DROP TABLE IF EXISTS "Client" CASCADE;
DROP TABLE IF EXISTS "Promotion" CASCADE;
DROP TABLE IF EXISTS "DiscountCode" CASCADE;
DROP TABLE IF EXISTS "Supplier" CASCADE;
DROP TABLE IF EXISTS "Category" CASCADE;
DROP TABLE IF EXISTS "Brand" CASCADE;
DROP TABLE IF EXISTS "PurchaseItem" CASCADE;
DROP TABLE IF EXISTS "Purchase" CASCADE;
DROP TABLE IF EXISTS "WebOrderItem" CASCADE;
DROP TABLE IF EXISTS "WebOrder" CASCADE;
DROP TABLE IF EXISTS "Expense" CASCADE;
DROP TABLE IF EXISTS "StoreConfig" CASCADE;
DROP TABLE IF EXISTS "Setting" CASCADE;

-- Habilitar extensiones opcionales
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabla Brand (Marcas)
CREATE TABLE "Brand" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 2. Tabla Category (Categorías)
CREATE TABLE "Category" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 3. Tabla Supplier (Proveedores)
CREATE TABLE "Supplier" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 4. Tabla DiscountCode (Códigos de Descuento)
CREATE TABLE "DiscountCode" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercent" NUMERIC(12, 2) NOT NULL,
    "validFrom" TIMESTAMP WITH TIME ZONE,
    "validUntil" TIMESTAMP WITH TIME ZONE,
    "maxUses" INTEGER,
    "currentUses" INTEGER DEFAULT 0,
    "isActive" BOOLEAN DEFAULT TRUE,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 5. Tabla Promotion (Promociones)
CREATE TABLE "Promotion" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT DEFAULT 'ACTIVE',
    "discountType" TEXT NOT NULL,
    "discountValue" NUMERIC(12, 2) NOT NULL,
    "minQuantity" INTEGER,
    "maxDiscountQty" INTEGER,
    "priority" INTEGER DEFAULT 0,
    "imageUrl" TEXT,
    "conditions" JSONB DEFAULT '[]'::jsonb,
    "startDate" TIMESTAMP WITH TIME ZONE,
    "endDate" TIMESTAMP WITH TIME ZONE,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 6. Tabla Client (Clientes)
CREATE TABLE "Client" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 7. Tabla Seller (Vendedores)
CREATE TABLE "Seller" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN DEFAULT TRUE,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 8. Tabla User (Usuarios / PIN)
CREATE TABLE "User" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 9. Tabla Product (Productos)
CREATE TABLE "Product" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "pricePurchase" NUMERIC(12, 2) NOT NULL,
    "priceSale" NUMERIC(12, 2) NOT NULL,
    "quantityStock" DOUBLE PRECISION NOT NULL,
    "stockMinAlert" DOUBLE PRECISION,
    "unitType" TEXT,
    "isPublicWeb" BOOLEAN DEFAULT TRUE,
    "webCategory" TEXT,
    "webUnavailable" BOOLEAN DEFAULT FALSE,
    "imageUrl" TEXT,
    "isRecipe" BOOLEAN NOT NULL DEFAULT FALSE,
    "isIngredient" BOOLEAN NOT NULL DEFAULT FALSE,
    "brandId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "brandId") REFERENCES "Brand" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "categoryId") REFERENCES "Category" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "supplierId") REFERENCES "Supplier" ("tenant_id", "id") ON DELETE SET NULL
);

-- 9b. Tabla RecipeItem (Ingredientes de productos elaborados / Recetario)
CREATE TABLE "RecipeItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "ingredientId" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitType" TEXT NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "ingredientId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 9c. Tabla ProductModifierGroup (Grupos de Opciones/Modificadores)
CREATE TABLE "ProductModifierGroup" (
    "tenant_id" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "productId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT DEFAULT 'MULTI_SELECT',
    "isRequired" BOOLEAN DEFAULT FALSE,
    "minSelect" INTEGER DEFAULT 0,
    "maxSelect" INTEGER,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 9d. Tabla ProductModifierOption (Opciones de Modificadores)
CREATE TABLE "ProductModifierOption" (
    "tenant_id" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "modifierGroupId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "priceExtra" NUMERIC DEFAULT 0,
    "colorHex" TEXT,
    "ingredientId" BIGINT,
    "ingredientQty" NUMERIC DEFAULT 1,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "modifierGroupId") REFERENCES "ProductModifierGroup" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "ingredientId") REFERENCES "Product" ("tenant_id", "id") ON DELETE SET NULL
);

-- 10. Tabla Combo (Combos)
CREATE TABLE "Combo" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" NUMERIC(12, 2) NOT NULL,
    "active" BOOLEAN DEFAULT TRUE,
    "imageUrl" TEXT,
    "items" JSONB DEFAULT '[]'::jsonb,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 11. Tabla ComboItem (Ítems de Combos)
CREATE TABLE "ComboItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "comboId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "customPrice" NUMERIC(12, 2),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "comboId") REFERENCES "Combo" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 12. Tabla CashRegister (Sesiones de Caja)
CREATE TABLE "CashRegister" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "openDate" TIMESTAMP WITH TIME ZONE NOT NULL,
    "closeDate" TIMESTAMP WITH TIME ZONE,
    "initialBalance" NUMERIC(12, 2) NOT NULL,
    "expectedBalance" NUMERIC(12, 2) NOT NULL,
    "actualBalance" NUMERIC(12, 2) NOT NULL,
    "difference" NUMERIC(12, 2) NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "sellerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "sellerId") REFERENCES "Seller" ("tenant_id", "id") ON DELETE CASCADE
);

-- 13. Tabla AccountBalance (Saldos Cuenta Corriente)
CREATE TABLE "AccountBalance" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "clientId" INTEGER NOT NULL,
    "balance" NUMERIC(12, 2) NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "clientId") REFERENCES "Client" ("tenant_id", "id") ON DELETE CASCADE
);

-- 14. Tabla Sale (Ventas)
CREATE TABLE "Sale" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "saleDate" TIMESTAMP WITH TIME ZONE NOT NULL,
    "totalAmount" NUMERIC(12, 2) NOT NULL,
    "paymentType" TEXT NOT NULL,
    "notes" TEXT,
    "clientId" INTEGER,
    "sellerId" INTEGER NOT NULL,
    "cashRegisterId" INTEGER,
    "discountCodeApplied" TEXT,
    "promotionsApplied" JSONB,
    "onAccount" BOOLEAN DEFAULT FALSE,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "clientId") REFERENCES "Client" ("tenant_id", "id") ON DELETE SET NULL,
    FOREIGN KEY ("tenant_id", "sellerId") REFERENCES "Seller" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "cashRegisterId") REFERENCES "CashRegister" ("tenant_id", "id") ON DELETE SET NULL
);

-- 15. Tabla SaleItem (Detalle de Ventas)
CREATE TABLE "SaleItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "priceAtSale" NUMERIC(12, 2) NOT NULL,
    "purchasePriceAtSale" NUMERIC(12, 2) NOT NULL,
    "saleId" INTEGER NOT NULL,
    "productId" INTEGER,
    "productName" TEXT,
    "modifiers" TEXT,
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "saleId") REFERENCES "Sale" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE SET NULL
);

-- 16. Tabla Purchase (Compras)
CREATE TABLE "Purchase" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "purchaseDate" TIMESTAMP WITH TIME ZONE NOT NULL,
    "totalAmount" NUMERIC(12, 2) NOT NULL,
    "status" TEXT NOT NULL,
    "paymentType" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "notes" TEXT,
    "supplierId" INTEGER,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "supplierId") REFERENCES "Supplier" ("tenant_id", "id") ON DELETE SET NULL
);

-- 17. Tabla PurchaseItem (Detalle de Compras)
CREATE TABLE "PurchaseItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "quantityReceived" DOUBLE PRECISION NOT NULL,
    "purchasePrice" NUMERIC(12, 2) NOT NULL,
    "purchaseId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "purchaseId") REFERENCES "Purchase" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 18. Tabla Expense (Gastos)
CREATE TABLE "Expense" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "expenseDate" TIMESTAMP WITH TIME ZONE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" NUMERIC(12, 2) NOT NULL,
    "category" TEXT NOT NULL,
    "paymentType" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 19. Tabla CashMovement (Movimientos de Caja)
CREATE TABLE "CashMovement" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "cashRegisterId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "paymentType" TEXT NOT NULL,
    "sourceId" INTEGER,
    "amount" NUMERIC(12, 2) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "cashRegisterId") REFERENCES "CashRegister" ("tenant_id", "id") ON DELETE CASCADE
);

-- 20. Tabla AccountMovement (Movimientos de CC)
CREATE TABLE "AccountMovement" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "accountBalanceId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" NUMERIC(12, 2) NOT NULL,
    "description" TEXT,
    "saleId" INTEGER,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "accountBalanceId") REFERENCES "AccountBalance" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "saleId") REFERENCES "Sale" ("tenant_id", "id") ON DELETE SET NULL
);

-- 21. Tabla Setting (Configuraciones)
CREATE TABLE "Setting" (
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "key")
);

-- 22. Tabla StoreConfig (Configuración de Tienda ClinStore)
CREATE TABLE "StoreConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "primaryColor" TEXT DEFAULT '#2563eb',
    "isWebActive" BOOLEAN DEFAULT FALSE,
    "mpAccessToken" TEXT,
    "mpPublicKey" TEXT,
    "mpFeePercent" NUMERIC(12, 2) DEFAULT 0,
    "whatsappPhone" TEXT,
    "minStockBuffer" DOUBLE PRECISION DEFAULT 1,
    "allowPickup" BOOLEAN DEFAULT TRUE,
    "allowDelivery" BOOLEAN DEFAULT TRUE,
    "deliveryFee" NUMERIC(12, 2) DEFAULT 0,
    "minDeliveryAmount" NUMERIC(12, 2) DEFAULT 0,
    "businessSector" TEXT DEFAULT 'GASTRONOMIA',
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id")
);

-- 23. Tabla WebOrder (Pedidos Web de ClinStore)
CREATE TABLE "WebOrder" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "webOrderNumber" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT,
    "clientPhone" TEXT NOT NULL,
    "shippingAddress" TEXT,
    "deliveryType" TEXT NOT NULL,
    "branchId" INTEGER,
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PREPARATION',
    "totalAmount" NUMERIC(12, 2) NOT NULL,
    "mpFeeAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
    "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
    "discountAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
    "deliveryFee" NUMERIC(12, 2) NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "origin" TEXT,
    "discountBreakdown" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id"),
    CONSTRAINT "WebOrder_webOrderNumber_unique" UNIQUE ("tenant_id", "webOrderNumber")
);

-- 24. Tabla WebOrderItem (Detalle de Pedidos Web)
CREATE TABLE "WebOrderItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "webOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" NUMERIC(12, 2) NOT NULL,
    "subtotal" NUMERIC(12, 2) NOT NULL,
    "modifiers" TEXT,
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "webOrderId") REFERENCES "WebOrder" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 25. Tabla WebOrderStockAlert (Alertas de stock por rechazo de pedidos web)
CREATE TABLE "WebOrderStockAlert" (
    "tenant_id" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "productId" INTEGER,
    "productName" TEXT NOT NULL,
    "requestedQty" DOUBLE PRECISION,
    "message" TEXT,
    "seenAt" TIMESTAMP WITH TIME ZONE,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 26. Deshabilitar RLS (Row Level Security) para permitir sincronización directa REST desde el POS
ALTER TABLE "Brand" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Category" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscountCode" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Promotion" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Client" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Seller" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "RecipeItem" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductModifierGroup" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductModifierOption" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Combo" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "CashRegister" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountBalance" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Sale" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SaleItem" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ComboItem" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Purchase" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseItem" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Expense" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "CashMovement" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountMovement" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Setting" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreConfig" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "WebOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "WebOrderItem" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "WebOrderStockAlert" DISABLE ROW LEVEL SECURITY;

-- 26. Habilitar Realtime para que el POS y ClinStore escuchen cambios de stock
-- (si la publicación supabase_realtime existe, que es lo habitual en Supabase).
DO $$
DECLARE
  t TEXT;
  pub_exists BOOLEAN;
  tables_to_add TEXT[] := ARRAY[
    'Product',
    'ProductBranchStock',
    'RecipeItem',
    'ProductModifierGroup',
    'ProductModifierOption',
    'Sale',
    'Purchase',
    'StockTransfer',
    'WebOrder',
    'WebOrderItem',
    'StoreConfig'
  ];
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') INTO pub_exists;
  IF NOT pub_exists THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY tables_to_add
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- 13. RPC atómica de decremento de stock (race condition por 1 unidad)
CREATE OR REPLACE FUNCTION decrement_stock(
    p_tenant_id TEXT,
    p_product_id INTEGER,
    p_qty NUMERIC,
    p_branch_id INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE ok INTEGER;
BEGIN
    UPDATE "Product"
    SET "quantityStock" = "quantityStock" - p_qty, "updatedAt" = NOW()
    WHERE "tenant_id" = p_tenant_id AND "id" = p_product_id AND "quantityStock" >= p_qty;
    GET DIAGNOSTICS ok = ROW_COUNT;
    IF ok = 0 THEN
        RETURN FALSE;
    END IF;

    IF p_branch_id IS NOT NULL THEN
        UPDATE "ProductBranchStock"
        SET "quantityStock" = "quantityStock" - p_qty, "updatedAt" = NOW()
        WHERE "tenant_id" = p_tenant_id
          AND "productId" = p_product_id
          AND "branchId" = p_branch_id;
    END IF;

    RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION decrement_stock(TEXT, INTEGER, NUMERIC, INTEGER) TO anon, authenticated;

-- 29. RPC atómica de decremento de stock de un elaborado: expande recurrente el
--     la receta hacia las hojas y descuenta cada INGREDIENTE (global + sucursal).
--     Valida disponibilidad de TODAS las hojas antes de descontar (todo o nada).
CREATE OR REPLACE FUNCTION decrement_recipe_stock(
    p_tenant_id TEXT,
    p_product_id INTEGER,
    p_qty NUMERIC,
    p_branch_id INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    _leaf RECORD;
    v_needed NUMERIC;
    cnt INTEGER;
BEGIN
    -- Guarda: si el producto no tiene receta (sin ingredientes) no se puede
    -- preparar ni vender; nunca debe devolver TRUE sin haber descontado nada.
    SELECT COUNT(*) INTO cnt FROM "RecipeItem" WHERE "tenant_id" = p_tenant_id AND "productId" = p_product_id;
    IF cnt = 0 THEN
        RETURN FALSE;
    END IF;

    -- Fase 1: validación de stock de todas las hojas (sin descuento parcial).
    FOR _leaf IN
        SELECT * FROM (
            WITH RECURSIVE "exp" AS (
                SELECT "ingredientId", "quantity" AS "accQty", 1 AS "depth"
                FROM "RecipeItem"
                WHERE "tenant_id" = p_tenant_id AND "productId" = p_product_id
                UNION ALL
                SELECT r."ingredientId", e."accQty" * r."quantity", e."depth" + 1
                FROM "exp" e
                JOIN "RecipeItem" r
                  ON r."tenant_id" = p_tenant_id AND r."productId" = e."ingredientId"
                WHERE e."depth" < 10
            )
            SELECT "ingredientId", SUM("accQty") AS "needed"
            FROM "exp"
            WHERE "ingredientId" NOT IN (
                SELECT "productId" FROM "RecipeItem" WHERE "tenant_id" = p_tenant_id
            )
            GROUP BY "ingredientId"
        ) "leaves"
    LOOP
        v_needed := _leaf.needed * p_qty;

        IF NOT EXISTS (
            SELECT 1 FROM "Product"
            WHERE "tenant_id" = p_tenant_id AND "id" = _leaf."ingredientId" AND "quantityStock" >= v_needed
        ) THEN
            RETURN FALSE;
        END IF;

        IF p_branch_id IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM "ProductBranchStock"
                WHERE "tenant_id" = p_tenant_id
                  AND "productId" = _leaf."ingredientId"
                  AND "branchId" = p_branch_id
                  AND "quantityStock" >= v_needed
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;
    END LOOP;

    -- Fase 2: descuenta cada hoja (global y sucursal).
    FOR _leaf IN
        SELECT * FROM (
            WITH RECURSIVE "exp" AS (
                SELECT "ingredientId", "quantity" AS "accQty", 1 AS "depth"
                FROM "RecipeItem"
                WHERE "tenant_id" = p_tenant_id AND "productId" = p_product_id
                UNION ALL
                SELECT r."ingredientId", e."accQty" * r."quantity", e."depth" + 1
                FROM "exp" e
                JOIN "RecipeItem" r
                  ON r."tenant_id" = p_tenant_id AND r."productId" = e."ingredientId"
                WHERE e."depth" < 10
            )
            SELECT "ingredientId", SUM("accQty") AS "needed"
            FROM "exp"
            WHERE "ingredientId" NOT IN (
                SELECT "productId" FROM "RecipeItem" WHERE "tenant_id" = p_tenant_id
            )
            GROUP BY "ingredientId"
        ) "leaves"
    LOOP
        v_needed := _leaf.needed * p_qty;
        UPDATE "Product"
        SET "quantityStock" = "quantityStock" - v_needed, "updatedAt" = NOW()
        WHERE "tenant_id" = p_tenant_id AND "id" = _leaf."ingredientId";

        IF p_branch_id IS NOT NULL THEN
            INSERT INTO "ProductBranchStock" ("tenant_id", "productId", "branchId", "quantityStock", "createdAt", "updatedAt")
            VALUES (p_tenant_id, _leaf."ingredientId", p_branch_id, (-1) * v_needed, NOW(), NOW())
            ON CONFLICT ("tenant_id", "productId", "branchId")
            DO UPDATE SET "quantityStock" = "ProductBranchStock"."quantityStock" - v_needed, "updatedAt" = NOW();
        END IF;
    END LOOP;

    RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION decrement_recipe_stock(TEXT, INTEGER, NUMERIC, INTEGER) TO anon, authenticated;

-- Movimiento de stock idempotente: evita doble aplicación en reintentos.
CREATE TABLE IF NOT EXISTS "SyncStockMovement" (
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "productId" BIGINT NOT NULL,
    "branchId" BIGINT,
    "delta" NUMERIC NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "operation_id")
);

CREATE OR REPLACE FUNCTION apply_stock_movement(
    p_tenant_id TEXT, p_operation_id TEXT, p_product_id INTEGER,
    p_delta NUMERIC, p_branch_id INTEGER DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE inserted_count INTEGER;
BEGIN
    INSERT INTO "SyncStockMovement" ("tenant_id", "operation_id", "productId", "branchId", "delta")
    VALUES (p_tenant_id, p_operation_id, p_product_id, p_branch_id, p_delta)
    ON CONFLICT ("tenant_id", "operation_id") DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count = 0 THEN RETURN TRUE; END IF;
    UPDATE "Product" SET "quantityStock" = "quantityStock" + p_delta, "updatedAt" = NOW()
      WHERE "tenant_id" = p_tenant_id AND "id" = p_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Producto inexistente: %', p_product_id; END IF;
    IF p_branch_id IS NOT NULL THEN
      INSERT INTO "ProductBranchStock" ("tenant_id", "productId", "branchId", "quantityStock", "createdAt", "updatedAt")
      VALUES (p_tenant_id, p_product_id, p_branch_id, p_delta, NOW(), NOW())
      ON CONFLICT ("tenant_id", "productId", "branchId")
      DO UPDATE SET "quantityStock" = "ProductBranchStock"."quantityStock" + p_delta, "updatedAt" = NOW();
    END IF;
    RETURN TRUE;
END $$;
GRANT EXECUTE ON FUNCTION apply_stock_movement(TEXT, TEXT, INTEGER, NUMERIC, INTEGER) TO anon, authenticated;
