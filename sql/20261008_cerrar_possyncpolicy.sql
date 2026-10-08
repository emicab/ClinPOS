-- ============================================================================
-- APLICADO el 2026-10-08 en Supabase (proyecto CRM) via apply_migration
-- "close_pos_sync_policy_public_catalog_readonly", con permiso explicito del usuario.
-- Verificado como rol anon: User, Setting, Sale, SaleItem, Client, Seller, Supplier, Brand,
-- Expense, Cash*, Account*, Purchase*, DiscountCode, ComboItem, WebOrder, PairingCode y
-- licenses ya NO son legibles; Product y el resto del catalogo son solo lectura
-- (Product=8514, Combo=17, Branch=13, ProductBranchStock=11882, ...); mpAccessToken
-- bloqueado y las columnas publicas de StoreConfig funcionan; service_role sigue leyendo
-- todo (User=13, licenses=10).
-- (Titulo original: cerrar PosSyncPolicy en Supabase)
-- Proyecto CRM (htroigemnwqiugieodmv)
-- ============================================================================
-- Hallazgo: la politica "PosSyncPolicy" (ALL para el rol anon, USING true) existe en
-- User, Setting, Sale, SaleItem, Client, Seller, Supplier, Brand, Expense, CashRegister,
-- CashMovement, AccountBalance/Movement, Purchase/PurchaseItem, DiscountCode, Product,
-- Combo, ComboItem, Promotion, Category. Con la clave anon (publica, viaja en el front de
-- clinstore) cualquiera puede leer o modificar los datos de TODOS los comercios, incluidos
-- los hashes de PIN (User.pinHash, SHA-256 sin sal de 4 digitos = recuperables) y Setting.
--
-- Por que es seguro para la operacion actual (verificado en el codigo):
--   * El sync del POS elige la clave en este orden: service_role (Setting o env) -> anon.
--     (lib/syncService.ts). service_role ignora RLS y grants: NO se ve afectado.
--   * Los instaladores de CI no traen ninguna clave; los compilados localmente traen la
--     service_role en el .env del bundle.
--   * El realtime de WebOrder ya depende de service_role (WebOrder no tiene politica para anon).
--   * clinstore solo usa anon para LEER el catalogo: se mantiene con politicas SELECT.
-- Impacto: un POS que sincronice SOLO con la clave anon deja de sincronizar (las ventas
-- locales siguen funcionando; el sync es respaldo). Debe configurarse supabase_service_role_key.
--
-- ANTES: confirmar que ningun POS en uso sincroniza con anon (log del POS:
--   "[Sync] Credencial efectiva: anon ..."). Probar en una rama de Supabase si se prefiere.
-- DESPUES: verificar como anon (ver bloque final) y recorrer una tienda /slug.
-- ============================================================================

BEGIN;

-- 1) Eliminar PosSyncPolicy en todas las tablas.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'PosSyncPolicy' LOOP
    EXECUTE format('DROP POLICY "PosSyncPolicy" ON public.%I', t.tablename);
  END LOOP;
END $$;

-- 2) RLS activado en todas las tablas de public que no lo tenian.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- 3) Sin permisos de tabla para los roles publicos (service_role no se ve afectado).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 4) Catalogo publico de la tienda (clinstore, clave anon): SOLO lectura.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Product','Combo','Promotion','Branch','ProductBranchStock','RecipeItem','Category','ProductModifierGroup','ProductModifierOption']
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS "catalogo_publico_lectura" ON public.%I', t);
    EXECUTE format('CREATE POLICY "catalogo_publico_lectura" ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;
END $$;

-- 5) StoreConfig: solo columnas publicas (el REVOKE ALL anterior tambien quita las de columna).
GRANT SELECT (
  id, tenant_id, slug, "businessSector", "businessName", description, "logoUrl",
  "bannerUrl", "primaryColor", "isWebActive", "whatsappPhone", "minStockBuffer",
  "allowPickup", "allowDelivery", "deliveryFee", "minDeliveryAmount", "mpPublicKey",
  lat, lng, "deliveryZones", "openingHours", "updatedAt"
) ON TABLE public."StoreConfig" TO anon, authenticated;
DROP POLICY IF EXISTS "catalogo_publico_storeconfig" ON public."StoreConfig";
CREATE POLICY "catalogo_publico_storeconfig" ON public."StoreConfig"
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;

-- ============================================================================
-- VERIFICACION (ejecutar despues; cada bloque debe cumplir lo indicado):
--   -- como anon NO debe poder leer ni escribir:
--   begin; set local role anon;
--     select 1 from "User" limit 1;      -- ERROR permission denied
--     select 1 from "Setting" limit 1;   -- ERROR permission denied
--     select 1 from "Sale" limit 1;      -- ERROR permission denied
--   rollback;
--   -- como anon SI debe leer el catalogo:
--   begin; set local role anon;
--     select count(*) from "Product"; select count(*) from "Combo"; select count(*) from "Branch";
--   rollback;
--
-- REVERSION DE EMERGENCIA (reabre el acceso; usar solo si el sync de un POS con clave anon
-- es imprescindible mientras se le configura service_role):
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
--   -- y recrear la politica por tabla:
--   -- CREATE POLICY "PosSyncPolicy" ON public."<Tabla>" FOR ALL TO anon USING (true) WITH CHECK (true);
-- ============================================================================
