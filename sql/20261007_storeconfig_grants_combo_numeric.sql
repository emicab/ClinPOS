-- 20261007_storeconfig_grants_combo_numeric.sql
-- APLICADO en Supabase (proyecto CRM, htroigemnwqiugieodmv) el 2026-10-07 via
-- apply_migration "storeconfig_column_grants_and_combo_qty_numeric".
--
-- 1) StoreConfig: el REVOKE por columna de 20260810_hardening_stock_mp.sql NO tenia
--    efecto: anon/authenticated tenian GRANT a nivel de TABLA, que pisa al de columna,
--    asi que mpAccessToken, peyaWebhookSecret y rappiWebhookSecret seguian legibles y
--    modificables con la clave anon publica. Ahora se revoca la tabla completa y se
--    concede SELECT solo de las columnas publicas que usa clinstore.
--    Verificado como rol anon: secretos bloqueados, SELECT * bloqueado, UPDATE
--    bloqueado y las columnas de STORE_CONFIG_SELECT siguen funcionando.
--    service_role no se ve afectado.
--    Efecto colateral esperado (ya documentado en syncService.ts): un POS que
--    sincronice StoreConfig con la clave anon recibira 401; debe usar service_role.
--
-- 2) ComboItem.quantity integer -> numeric (el POS admite cantidades fraccionarias;
--    el sync fallaba con "invalid input syntax for type integer: 0.4"). Sin perdida
--    de datos (44 filas verificadas).
--
-- ROTAR igualmente mpAccessToken / peyaWebhookSecret / rappiWebhookSecret de los
-- comercios: estuvieron expuestos hasta hoy.

REVOKE ALL ON TABLE public."StoreConfig" FROM anon, authenticated;
GRANT SELECT (
  id, tenant_id, slug, "businessSector", "businessName", description, "logoUrl",
  "bannerUrl", "primaryColor", "isWebActive", "whatsappPhone", "minStockBuffer",
  "allowPickup", "allowDelivery", "deliveryFee", "minDeliveryAmount", "mpPublicKey",
  lat, lng, "deliveryZones", "openingHours", "updatedAt"
) ON TABLE public."StoreConfig" TO anon, authenticated;

ALTER TABLE public."ComboItem" ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

-- REVERSION DE EMERGENCIA (solo si un POS que sincroniza con la clave anon deja de
-- subir StoreConfig y no se puede pasar a service_role; REABRE la exposicion de secretos):
--   GRANT ALL ON TABLE public."StoreConfig" TO anon, authenticated;
