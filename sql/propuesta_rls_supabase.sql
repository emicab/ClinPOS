-- ============================================================================
-- SUPERADA: lo propuesto aqui quedo aplicado (StoreConfig, licencias por RPC y cierre de
-- PosSyncPolicy: ver 20261007_*.sql y 20261008_cerrar_possyncpolicy.sql). Se conserva como historial.
-- PROPUESTA PARCIALMENTE APLICADA (2026-10-07): lo de StoreConfig ya esta aplicado en
-- sql/20261007_storeconfig_grants_combo_numeric.sql. El resto NO se aplico porque:
--   * Existe la politica "PosSyncPolicy" (ALL para el rol anon) en User, Setting, Sale,
--     SaleItem, Product, Client, CashRegister, etc.: el POS esta DISEÑADO para sincronizar
--     con la clave anon. Cerrarla rompe el sync de todo POS que no use service_role, y
--     hoy cualquiera con la clave anon puede leer/modificar User (pinHash) y Setting
--     (claves cifradas). Cerrarlo exige antes migrar el sync del POS a service_role o a
--     un JWT por comercio (decision de arquitectura).
--   * Pasos 1-4 de abajo deben revisarse con eso en mente (el REVOKE de escritura en
--     TODAS las tablas rompe PosSyncPolicy).
-- ============================================================================
-- PROPUESTA (NO EJECUTADA): cerrar el acceso publico a las tablas de Supabase
-- Proyecto: CRM (htroigemnwqiugieodmv)
-- ============================================================================
-- Problema detectado: 14 tablas con RLS desactivado y GRANT total (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE) para los roles `anon` y `authenticated`. La clave anon
-- viaja en el front de clinstore (publica), asi que cualquiera puede leer o borrar
-- Product, ProductBranchStock, DiscountCode, PairingCode, Promotion, etc. y leer
-- StoreConfig.mpAccessToken / peyaWebhookSecret / rappiWebhookSecret.
--
-- Como usa Supabase cada componente (verificado en el codigo):
--   * clinstore (lecturas de catalogo, SSR y cliente): clave anon -> SOLO SELECT de
--       Product, Combo, Promotion, Branch, ProductBranchStock, RecipeItem, Category,
--       ProductModifierGroup, ProductModifierOption y StoreConfig (lista de columnas
--       STORE_CONFIG_SELECT, sin secretos).
--   * clinstore (escrituras, webhooks, pedidos): supabaseAdmin con service_role.
--   * ClinPOS (sync): service_role.
--   service_role IGNORA RLS, asi que nada de lo anterior se rompe.
--
-- ANTES DE EJECUTAR:
--   1. Confirmar que NINGUN ClinPOS sincroniza con la clave anon (en el log del POS:
--      "Credencial efectiva: anon" -> con anon el sync dejara de funcionar).
--   2. Probar primero en una rama de Supabase (create_branch) o en un proyecto de
--      pruebas, y recorrer la tienda (/slug, producto, pedido).
--   3. Despues de aplicarlo: ROTAR mpAccessToken, peyaWebhookSecret y
--      rappiWebhookSecret de los comercios (se asumen expuestos).
-- ============================================================================

BEGIN;

-- 1) Quitar escritura/borrado a los roles publicos en TODAS las tablas de public.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2) Activar RLS en las 14 tablas que lo tenian desactivado.
ALTER TABLE public."Category"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DiscountCode"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Promotion"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Product"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Combo"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StoreConfig"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Branch"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProductBranchStock"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StockTransfer"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StockTransferItem"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PairingCode"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RecipeItem"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProductModifierGroup"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProductModifierOption" ENABLE ROW LEVEL SECURITY;

-- 3) Tablas internas SIN politicas para anon/authenticated (solo service_role):
--    DiscountCode, PairingCode, StockTransfer, StockTransferItem.
REVOKE SELECT ON public."DiscountCode", public."PairingCode",
                 public."StockTransfer", public."StockTransferItem"
  FROM anon, authenticated;

-- 4) Catalogo publico de la tienda: SOLO lectura para anon.
--    (Los datos de un comercio son publicos por diseno: cada tienda vive en /slug.)
-- OJO Product: clinstore lee TODOS los productos del comercio (incluidos los
-- ingredientes no publicos, para derivar el stock de los elaborados) con
-- select("*"), asi que la politica no puede filtrar por "isPublicWeb". Eso expone
-- tambien "pricePurchase" (costo). Mejora recomendada en una 2da etapa: que
-- clinstore pida columnas explicitas y aqui aplicar REVOKE SELECT + GRANT
-- SELECT (columnas sin costo), igual que StoreConfig.
CREATE POLICY "catalogo_publico_product" ON public."Product"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_combo" ON public."Combo"
  FOR SELECT TO anon, authenticated USING (active = true);

CREATE POLICY "catalogo_publico_promotion" ON public."Promotion"
  FOR SELECT TO anon, authenticated USING (status = 'ACTIVE');

CREATE POLICY "catalogo_publico_branch" ON public."Branch"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_branchstock" ON public."ProductBranchStock"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_recipeitem" ON public."RecipeItem"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_category" ON public."Category"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_modgroup" ON public."ProductModifierGroup"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "catalogo_publico_modoption" ON public."ProductModifierOption"
  FOR SELECT TO anon, authenticated USING (true);

-- 5) StoreConfig: lectura publica SOLO de las columnas que usa la tienda
--    (STORE_CONFIG_SELECT en clinstore/lib/catalogData.ts). Los secretos
--    (mpAccessToken, peyaWebhookSecret, rappiWebhookSecret, ...) quedan fuera.
CREATE POLICY "catalogo_publico_storeconfig" ON public."StoreConfig"
  FOR SELECT TO anon, authenticated USING (true);

REVOKE SELECT ON public."StoreConfig" FROM anon, authenticated;
GRANT SELECT (
  id, tenant_id, slug, "businessSector", "businessName", description, "logoUrl",
  "bannerUrl", "primaryColor", "isWebActive", "whatsappPhone", "minStockBuffer",
  "allowPickup", "allowDelivery", "deliveryFee", "minDeliveryAmount", "mpPublicKey",
  lat, lng, "deliveryZones", "openingHours", "updatedAt"
) ON public."StoreConfig" TO anon, authenticated;

COMMIT;

-- ============================================================================
-- Verificacion posterior (debe devolver 0 filas de escritura y sin tablas sin RLS):
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema='public' AND grantee IN ('anon','authenticated')
--      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
--   SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;
--
-- Reversion de emergencia (reabre el acceso; solo si la tienda deja de cargar):
--   ALTER TABLE public."<Tabla>" DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT ON public."StoreConfig" TO anon, authenticated;
-- ============================================================================
