-- 20261007_licenses_restrict_update_columns.sql
-- APLICADO en Supabase (proyecto CRM) el 2026-10-07 via apply_migration
-- "licenses_restrict_public_update_columns".
--
-- Problema: la politica activate_license permitia UPDATE a cualquiera (USING true,
-- WITH CHECK true) sobre TODAS las columnas de "licenses", y select_license lee todas
-- las filas. Con la clave anon publica se podia extender expires_at, reactivar
-- is_active o subir max_activations de cualquier licencia.
--
-- Cambio: el UPDATE del rol publico queda limitado a las columnas que el POS escribe al
-- activar (pages/api/license/activate.ts): hardware_id, activations_count, updated_at.
-- crm-admin usa service_role y no se ve afectado. SELECT no se modifica (el POS valida
-- la licencia leyendo la tabla).
-- Verificado como rol anon: expires_at / is_active / max_activations bloqueados;
-- activacion y lectura permitidas.
--
-- Pendiente (decision de arquitectura): select_license sigue exponiendo todas las
-- claves de licencia; requiere reemplazar la lectura directa por una funcion RPC que
-- valide una clave concreta.

REVOKE UPDATE ON TABLE public.licenses FROM anon, authenticated;
GRANT UPDATE (hardware_id, activations_count, updated_at) ON TABLE public.licenses TO anon, authenticated;

-- REVERSION: GRANT UPDATE ON TABLE public.licenses TO anon, authenticated;
