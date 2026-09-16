-- supabase_migration.sql
-- Migración segura: crea tablas faltantes y agrega columnas sin dropear nada.
-- Ejecutar en el editor SQL de Supabase.

-- 1. StoreConfig (si no existe)
CREATE TABLE IF NOT EXISTS "StoreConfig" (
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
    "minStockBuffer" DOUBLE PRECISION DEFAULT 0,
    "allowPickup" BOOLEAN DEFAULT TRUE,
    "allowDelivery" BOOLEAN DEFAULT TRUE,
    "deliveryFee" NUMERIC(12, 2) DEFAULT 0,
    "minDeliveryAmount" NUMERIC(12, 2) DEFAULT 0,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id")
);

-- 2. WebOrder (si no existe)
CREATE TABLE IF NOT EXISTS "WebOrder" (
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
    "notes" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "id")
);

-- 3. WebOrderItem (si no existe)
CREATE TABLE IF NOT EXISTS "WebOrderItem" (
    "tenant_id" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "webOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" NUMERIC(12, 2) NOT NULL,
    "subtotal" NUMERIC(12, 2) NOT NULL,
    PRIMARY KEY ("tenant_id", "id"),
    FOREIGN KEY ("tenant_id", "webOrderId") REFERENCES "WebOrder" ("tenant_id", "id") ON DELETE CASCADE,
    FOREIGN KEY ("tenant_id", "productId") REFERENCES "Product" ("tenant_id", "id") ON DELETE CASCADE
);

-- 4. Agregar columna mpFeeAmount a WebOrder si la tabla ya existía sin ella
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'WebOrder'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'WebOrder' AND column_name = 'mpFeeAmount'
        ) THEN
            ALTER TABLE "WebOrder" ADD COLUMN "mpFeeAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0;
        END IF;
    END IF;
END $$;

-- 5. Agregar columnas faltantes a StoreConfig si la tabla ya existía sin ellas
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'StoreConfig') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'id') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "id" INTEGER NOT NULL DEFAULT 1;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'mpAccessToken') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "mpAccessToken" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'mpPublicKey') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "mpPublicKey" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'mpFeePercent') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "mpFeePercent" NUMERIC(12, 2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'minDeliveryAmount') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "minDeliveryAmount" NUMERIC(12, 2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'businessSector') THEN
            ALTER TABLE "StoreConfig" ADD COLUMN "businessSector" TEXT DEFAULT 'GASTRONOMIA';
        END IF;
    END IF;
END $$;

-- 6. Deshabilitar RLS para las tablas nuevas (idempotente)
ALTER TABLE IF EXISTS "StoreConfig" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "WebOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "WebOrderItem" DISABLE ROW LEVEL SECURITY;

-- 6a. Crear tabla WebOrderStockAlert (alertas de rechazo por stock de pedidos web)
CREATE TABLE IF NOT EXISTS "WebOrderStockAlert" (
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
ALTER TABLE IF EXISTS "WebOrderStockAlert" DISABLE ROW LEVEL SECURITY;

-- 6b. Agregar columna branchId a WebOrder (sucursal que despacha/prepara)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'branchId') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "branchId" INTEGER;
    END IF;
END $$;

-- 6c. Agregar columnas de descuento/cupón a WebOrder
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'subtotalAmount') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'discountAmount') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "discountAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'deliveryFee') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "deliveryFee" NUMERIC(12, 2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'couponCode') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "couponCode" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrder' AND column_name = 'origin') THEN
        ALTER TABLE "WebOrder" ADD COLUMN "origin" TEXT;
    END IF;
END $$;

-- 7. Agregar columna imageUrl a Product, Combo y Promotion (para reflejar imágenes en la tienda)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'imageUrl') THEN
        ALTER TABLE "Product" ADD COLUMN "imageUrl" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Combo' AND column_name = 'imageUrl') THEN
        ALTER TABLE "Combo" ADD COLUMN "imageUrl" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Promotion' AND column_name = 'imageUrl') THEN
        ALTER TABLE "Promotion" ADD COLUMN "imageUrl" TEXT;
    END IF;
END $$;

-- 8. Agregar columna customDomain a StoreConfig (dominio personalizado de la tienda, ej. clinstore.com.ar)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StoreConfig' AND column_name = 'customDomain') THEN
        ALTER TABLE "StoreConfig" ADD COLUMN "customDomain" TEXT;
    END IF;
END $$;

-- 9. Agregar columnas items (Combo) y conditions (Promotion) como JSONB para que la
--    tienda web lea el contenido de combos y las condiciones de promociones sin joins.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Combo' AND column_name = 'items') THEN
        ALTER TABLE "Combo" ADD COLUMN "items" JSONB DEFAULT '[]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Promotion' AND column_name = 'conditions') THEN
        ALTER TABLE "Promotion" ADD COLUMN "conditions" JSONB DEFAULT '[]'::jsonb;
    END IF;
END $$;

-- 10. SaleItem: permitir desvincular el producto (productId nullable) y guardar
--     el nombre del producto (productName) para conservar el historial al borrar.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'SaleItem' AND column_name = 'productName') THEN
        ALTER TABLE "SaleItem" ADD COLUMN "productName" TEXT;
    END IF;
END $$;
DO $$
BEGIN
    -- Backfill del nombre desde el producto (solo si hay columnas)
    UPDATE "SaleItem" si
    SET "productName" = p."name"
    FROM "Product" p
    WHERE si."productId" = p."id" AND si."productName" IS NULL;
END $$;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'SaleItem' AND column_name = 'productId' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE "SaleItem" ALTER COLUMN "productId" DROP NOT NULL;
    END IF;
END $$;

-- 11. Margen de stock mínimo por defecto = 1 (respaldo: la tienda nunca vende la
--     última unidad del local si el usuario no configura el margen).
DO $$
BEGIN
    UPDATE "StoreConfig" SET "minStockBuffer" = 1 WHERE "minStockBuffer" IS NULL;
END $$;

-- 12. RPC atómica de decremento de stock. Garantiza que ante dos pedidos web
--     simultáneos por el mismo producto, solo uno descuente el stock (el otro
--     recibe FALSE y el pedido se rechaza). Elimina la race condition por 1 unidad.
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

-- 13. Soporte de productos elaborados (Recetario) en la nube.
--     - Columnas isRecipe/isIngredient en Product (distinguen recetas e ingredientes).
--     - Tabla RecipeItem (vínculos receta → ingredient + cantidad).
--     - RPC decrement_recipe_stock para descontar INGREDIENTES de una venta web de receta.

-- 13a. Columnas isRecipe / isIngredient en Product
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'isRecipe') THEN
        ALTER TABLE "Product" ADD COLUMN "isRecipe" BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'isIngredient') THEN
        ALTER TABLE "Product" ADD COLUMN "isIngredient" BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- 13b. Tabla RecipeItem (si no existe)
CREATE TABLE IF NOT EXISTS "RecipeItem" (
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

ALTER TABLE "RecipeItem" DISABLE ROW LEVEL SECURITY;

-- 13c. RPC atómica de decremento de stock de un elaborado: expande la receta
--      recursivamente hacia las hojas y descuenta cada INGREDIENTE (global + sucursal).
--      Valida disponibilidad de TODAS las hojas antes de descontar (sin descuento parcial).
--      Acepta p_branch_id; si se pasa, también descuenta ProductBranchStock de la hoja.
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
BEGIN
    -- Guarda: si el producto no tiene receta (sin ingredientes) no se puede
    -- preparar ni vender; nunca debe devolver TRUE sin haber descontado nada.
    IF NOT EXISTS (
        SELECT 1 FROM "RecipeItem" WHERE "tenant_id" = p_tenant_id AND "productId" = p_product_id
    ) THEN
        RETURN FALSE;
    END IF;

    -- Validación de stock de TODAS las hojas antes de descontar (todo o nada).

    -- Falta de stock de alguna hoja => no se descuenta nada (todo o nada).
    FOR _leaf IN
        SELECT "ingredientId", SUM("accQty") AS "needed"
        FROM (
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
            SELECT "ingredientId", "accQty"
            FROM "exp"
            -- Solo las hojas: las que NO tienen receta propia (no aparecen como productId en RecipeItem)
            WHERE "ingredientId" NOT IN (
                SELECT "productId" FROM "RecipeItem" WHERE "tenant_id" = p_tenant_id
            )
        ) "leaves"
        GROUP BY "ingredientId"
    LOOP
        v_needed := _leaf.needed * p_qty;

        -- Stock global
        IF NOT EXISTS (
            SELECT 1 FROM "Product"
            WHERE "tenant_id" = p_tenant_id AND "id" = _leaf."ingredientId" AND "quantityStock" >= v_needed
        ) THEN
            RETURN FALSE;
        END IF;

        -- Stock de sucursal (si aplica)
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

    -- Todo el stock existe: descontar cada hoja.
    FOR _leaf IN
        SELECT * FROM (
            WITH RECURSIVE "exp" AS (
                SELECT "productId", "quantity" AS "accQty", 1 AS "depth"
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

-- 14. Variantes y Modificadores (Opciones de Productos)
--     - businessSector en StoreConfig (rubro comercial de la tienda).
--     - Columnas modifiers en WebOrderItem / SaleItem (snapshot JSON de opciones).
--     - Tablas ProductModifierGroup / ProductModifierOption con PK compuesta (tenant_id, id).

-- 14a. Columna modifiers en WebOrderItem / SaleItem (si no existe)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'WebOrderItem' AND column_name = 'modifiers') THEN
        ALTER TABLE "WebOrderItem" ADD COLUMN "modifiers" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'SaleItem' AND column_name = 'modifiers') THEN
        ALTER TABLE "SaleItem" ADD COLUMN "modifiers" TEXT;
    END IF;
END $$;

-- 14b. Tabla ProductModifierGroup (si no existe)
CREATE TABLE IF NOT EXISTS "ProductModifierGroup" (
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

CREATE INDEX IF NOT EXISTS "ProductModifierGroup_productId_idx" ON "ProductModifierGroup"("tenant_id", "productId");

-- 14c. Tabla ProductModifierOption (si no existe)
CREATE TABLE IF NOT EXISTS "ProductModifierOption" (
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

CREATE INDEX IF NOT EXISTS "ProductModifierOption_modifierGroupId_idx" ON "ProductModifierOption"("tenant_id", "modifierGroupId");

-- 14d. RLS desactivado para sincronización directa (idempotente)
ALTER TABLE IF EXISTS "ProductModifierGroup" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ProductModifierOption" DISABLE ROW LEVEL SECURITY;

-- 15. Protocolo de sincronización v2: borrados durables y conflictos.
-- Estas tablas son idempotentes y no modifican datos existentes.
CREATE TABLE IF NOT EXISTS "SyncTombstone" (
    "tenant_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "deletedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "deviceId" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("tenant_id", "entity", "entityKey")
);

CREATE INDEX IF NOT EXISTS "SyncTombstone_deletedAt_idx"
    ON "SyncTombstone"("tenant_id", "deletedAt");

CREATE TABLE IF NOT EXISTS "SyncConflict" (
    "id" BIGSERIAL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "localVersion" TEXT,
    "remoteVersion" TEXT,
    "localPayload" JSONB,
    "remotePayload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "resolvedAt" TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx"
    ON "SyncConflict"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx"
    ON "SyncConflict"("tenant_id", "entity", "entityKey", "status");

-- Se mantiene deshabilitado en esta fase: antes de activar RLS hay que
-- migrar el cliente a autenticación por dispositivo/usuario.
ALTER TABLE "SyncTombstone" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncConflict" DISABLE ROW LEVEL SECURITY;

-- 16. Movimiento de stock idempotente y atómico.
-- El operation_id evita descontar dos veces cuando un cliente reintenta.
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
    p_tenant_id TEXT,
    p_operation_id TEXT,
    p_product_id INTEGER,
    p_delta NUMERIC,
    p_branch_id INTEGER DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    inserted_count INTEGER;
BEGIN
    INSERT INTO "SyncStockMovement" ("tenant_id", "operation_id", "productId", "branchId", "delta")
    VALUES (p_tenant_id, p_operation_id, p_product_id, p_branch_id, p_delta)
    ON CONFLICT ("tenant_id", "operation_id") DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;

    IF inserted_count = 0 THEN
        RETURN TRUE;
    END IF;

    UPDATE "Product"
    SET "quantityStock" = "quantityStock" + p_delta, "updatedAt" = NOW()
    WHERE "tenant_id" = p_tenant_id AND "id" = p_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Producto inexistente: %', p_product_id;
    END IF;

    IF p_branch_id IS NOT NULL THEN
        INSERT INTO "ProductBranchStock" ("tenant_id", "productId", "branchId", "quantityStock", "createdAt", "updatedAt")
        VALUES (p_tenant_id, p_product_id, p_branch_id, p_delta, NOW(), NOW())
        ON CONFLICT ("tenant_id", "productId", "branchId")
        DO UPDATE SET "quantityStock" = "ProductBranchStock"."quantityStock" + p_delta, "updatedAt" = NOW();
    END IF;

    RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION apply_stock_movement(TEXT, TEXT, INTEGER, NUMERIC, INTEGER) TO anon, authenticated;
