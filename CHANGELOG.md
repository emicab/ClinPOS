# Changelog - ClinPOS

Todos los cambios notables realizados en el proyecto están detallados a continuación.

## [1.18.0] - 2026-10-07

### Importante al actualizar
- **Hay que volver a cargar las claves guardadas en el POS** (certificado y clave de ARCA, API key de Gemini, credenciales de Cloudinary): antes el secreto de cifrado se regeneraba en cada arranque y esos datos no se podían leer. Desde esta versión el secreto queda guardado de forma permanente en el Almacén de credenciales de Windows.

### Corregido
- **Combos con stock 0 en Nueva Venta**: el POS recibía los combos sin stock de sus productos y los mostraba agotados. Ahora respeta la sucursal y el stock derivado de recetas.
- **"Cargar stock" y el importador CSV** actualizaban solo el stock global y no el de la sucursal (la pantalla de venta seguía mostrando el valor viejo). Ahora cargan la sucursal del equipo y recalculan el total; además conservan decimales (kg/L) y encolan el sync.
- **Compras, consignaciones y edición de producto**: el stock por sucursal quedaba desfasado del global al editar/borrar una compra recibida, entregar/devolver consignaciones o guardar un producto sin sucursal.
- **Cierre de caja**: el esperado ahora es solo efectivo (saldo inicial + movimientos en efectivo); sumaba tarjeta, transferencia y Mercado Pago, y la diferencia nunca cerraba.
- **Borrar una venta**: ya no repone stock de pedidos pendientes ni descuenta de la cuenta corriente ventas que no fueron en cuenta.
- **Acciones masivas "todas las páginas"** (precios, proveedor, publicar en web, borrar) usan el mismo criterio que la lista (búsqueda sin tildes, sin ingredientes ocultos).
- **Traspasos de stock**: dos respuestas simultáneas ya no acreditan el stock dos veces.
- Cobros de cuenta corriente y gastos validan que el monto sea numérico.
- **Sincronización**: ante una caída de la nube, la cola de pendientes ya no se degrada a "fallida" para siempre (los errores de red no consumen intentos y las operaciones fallidas se reintentan cada 6 h); las operaciones ya enviadas se purgan a los 7 días (la tabla crecía sin límite).
- **Recetario**: el stock disponible de un elaborado se calcula sin errores de redondeo (0,3 / 0,1 daba 2) y el descuento de ingredientes falla si el stock cambió durante la venta.
- **Facturación ARCA**: el certificado y la clave privada ya no se guardan descifrados en disco; el cliente sin documento va como Consumidor Final y el IVA cuadra siempre con el total.
- **Promociones**: el descuento nunca supera el subtotal. **Analíticas y dashboard** cuentan solo ventas cobradas (pendientes y canceladas inflaban ingresos).
- **Licencias**: la validación y activación usan funciones de la nube (la tabla ya no es pública). Los equipos sin actualizar quedan en modo "sin conexión" y conservan su plan.

### Añadido
- **Combos: precio por "Margen s/ costo"**: calcula el precio como costo de los productos + margen %, y muestra costo, ganancia y margen real.

### Mejorado
- **Base de datos**: 33 índices nuevos (ventas, productos, pedidos web, movimientos), modo WAL y migraciones aplicadas a todos los negocios (antes solo la base principal). Ninguna migración modifica ni borra datos; se respalda antes de migrar.
- **Backup y restauración seguros**: la copia usa una instantánea consistente de la base del negocio activo; restaurar valida el archivo y se aplica al reiniciar, guardando antes una copia de los datos actuales.
- **Crear un negocio nuevo** clona la base con una copia consistente.
- **Nueva Venta más rápida**: menos consultas por ítem al registrar la venta.
- Registro de diagnóstico (`clinpos-app.log`) y `server.log` conservando los 3 arranques anteriores.
- **Seguridad**: bloqueo temporal tras intentos fallidos de PIN; CORS sin comodín en la API local.
- Se eliminó código sin uso (hooks, gráficos y componentes de venta duplicados).

## [1.17.6] - 2026-09-29

### Corregido
- **Egress/Realtime disparado (800MB→4GB, 1.4M mensajes)**: el Realtime vuelve a ser liviano — solo `WebOrder` con debounce de 5s hacia el pull de pedidos (se quitó `ProductBranchStock`, cuyos eventos por cada venta disparaban full-syncs en todos los POS).
- **Pulls con delta incremental**: `WebOrder` (cabeceras + ítems solo de pedidos nuevos), `Product`, `ProductBranchStock` y resto de tablas solo traen filas tocadas desde el último sync; todo paginado (antes se truncaba a 1000 filas).
- **Push afinado**: solo se suben filas de stock que difieren de la nube (no-op), ítems de traspaso acotados al delta, backoff ante fallos y pausa de 30 min ante 401/403.
- **Poll de alertas** de pedidos web: cada 60s → cada 5 min.

## [1.17.5] - 2026-09-29

### Corregido
- **Combos en Nueva Venta**: los combos vuelven a aparecer como pills (se pedía el formato admin `?all=true` en vez del formato web que los filtraba) y ahora también se pueden buscar escribiendo su nombre en el mismo buscador de productos, con badge COMBO y soporte de Enter.

## [1.17.3] - 2026-09-17

### Corregido
- **Carga de productos en combos**: búsqueda por nombre/SKU y cantidades por unidad correctamente interpretadas al usar kg, litros o unidades.

## [1.17.2] - 2026-09-16

### Corregido
- **Escaneos consecutivos**: el foco permanece en el buscador y `Enter` nunca confirma accidentalmente la venta después de escanear un producto.
- **Notas del actualizador**: las releases toman automáticamente la sección correspondiente del changelog para mostrarla en el modal de actualización.

## [1.17.1] - 2026-09-16

### Corregido
- **Conflictos de sincronización falsos**: los movimientos normales ya no se muestran como conflictos si no existe una operación local pendiente o fallida.
- **Indicador de nube en el sidebar**: diseño simplificado, con un único ícono de alerta cuando hay conflictos para revisar.
- **Flujo de venta con lector de códigos**: `Enter` agrega el producto y devuelve el foco al buscador para permitir escaneos consecutivos; nunca confirma la venta desde ese campo. `F2` queda reservado para confirmar/cerrar la venta.

## [1.16.2] - 2026-09-15

### Añadido
- **Columna PROVEEDOR en el importador CSV**: automapeo y vinculación solo si el proveedor ya existe; si no, el producto queda sin proveedor y se reporta.
- **SKU en notación científica**: los códigos que Excel exporta como `1.11E+11` se expanden con aviso de posible redondeo.
- **Borrado forzado con doble verificación**: ante productos vinculados (compras, combos, promociones, consignaciones, traspasos, pedidos web), segundo modal con confirmación explícita que elimina todo en cascada.

### Corregido
- **"Seleccionar TODOS" solo borraba 20**: desajuste `isAllPagesSelected` vs `allPages` entre frontend y `batch-delete`.
- **Edición masiva y visibilidad web masiva** apuntaban a endpoints inexistentes (`batch-update`, `batch-web-status`); ahora usan `/api/products/batch`.

## [1.16.0] - 2026-09-14

### Añadido
- **Alerta temprana de stock en el carrito**: la fila se marca en rojo con "¡Solo hay X!" cuando la cantidad supera el disponible, antes de cobrar.
- **Reponer en 1 click**: click en un producto sin stock (accesos rápidos/pills) → Compras con el producto preseleccionado.
- **Cierre de caja con diferencia en vivo**: esperado total + esperado en efectivo + diferencia calculada al tipear; Notas obligatorias si supera $1.000.
- **KPIs del día en el Home**: ventas, ticket promedio, caja abierta y bajo stock (nuevo `GET /api/dashboard/today`).
- **Badge de sync en el Sidebar**: pendientes / al día / sin conexión.
- **Mensajes de error reales** en 9 handlers (sucursales, pairing, visibilidad, geocode, alertas, recetario, pedidos).

## [1.15.2] - 2026-09-13

### Corregido
- **Updater sin salida**: el flujo de actualización ahora caza `node.exe` huérfanos de versiones viejas (`kill_stale_node_servers`, solo el standalone empaquetado) antes de esperar el puerto libre, en vez de bloquearse pidiendo cerrar la app. Nuevo comando Tauri + refactor del reaper de arranque en piezas reutilizables.

## [1.15.1] - 2026-09-13

### Corregido
- **Productos y sucursales**: el filtro por sucursal excluía productos sin fila de stock (solo visibles en "Todas") y la fila pintaba 0. Ahora el filtro es inclusivo con autocurado (Principal hereda el global, resto arranca en 0), fallback a stock global, 400 ante sucursal inexistente, backfill al crear sucursales, y el selector se oculta con menos de 2 sucursales (validando el id guardado).

## [1.15.0] - 2026-09-13

### Añadido
- **Anti-huérfanos de node**: Job Object con `KILL_ON_JOB_CLOSE` (el SO mata al server si la app muere por cualquier vía), reaper al arranque que elimina `node.exe` huérfanos del standalone, y single-instance (la 2ª apertura enfoca la ventana en vez de spawnear otro server). El updater espera al puerto 3001 libre antes de instalar y cierra la app sola al terminar.
- **Calculadora de precio en productos**: panel bajo los precios con % deseado, modo Recargo s/costo o Margen s/venta, preview en vivo con equivalencia y botón Aplicar. Vale para crear y editar.

## [1.14.2] - 2026-09-12

### Corregido
- **ADMIN ve todo**: el rol Administrador se salta los candados de plan y los filtros de módulos/perfil en el Sidebar, el Home y las pestañas de Configuración (Sucursales, Tienda Web). Los módulos apagados por el rubro del onboarding (Vendedores, Marketing, etc.) ya no ocultan nada al admin. Supervisor y Cajero mantienen sus permisos.

## [1.14.1] - 2026-09-12

### Corregido
- **Migraciones de producción (P2022)**: las columnas agregadas al schema (integraciones PedidosYa/Rappi, `requireMpForDelivery`, `externalSku`, etc.) nunca llegaban a las bases ya instaladas. Se agregó la migración v24 + verificador declarativo que auto-repara cualquier columna faltante en cada arranque, con backup pre-migración (últimos 3).
- **Gate de salud de DB**: Tauri espera a que `GET /api/health/db` responda `ok` antes de mostrar el panel; si la DB no sana, el error queda visible en `server.log` en vez de romper endpoints en cascada.

### Añadido
- **Anti-drift en build**: `scripts/check-drift.js` (integrado a `build:next`) bloquea el empaquetado si un campo del schema no está cubierto por el migrador de Tauri y el health endpoint.

## [1.14.0] - 2026-08-28

### Añadido
- **Multi-negocio (dos locales en una misma PC)**: cada negocio vive en su propia base SQLite con catálogo, caja, usuarios, facturación y configuración totalmente aislados. Selector de negocio al iniciar, botón "Cambiar negocio" en el Home y en la sidebar, y creación/eliminación de negocios desde el selector. La licencia/plan es a nivel máquina (una activación cubre todos los negocios).
- **Flag de integraciones de delivery**: las implementaciones de PedidosYa y Rappi quedan ocultas por defecto (`NEXT_PUBLIC_ENABLE_PEYA` / `NEXT_PUBLIC_ENABLE_RAPPI`), para habilitarlas cuando haya credenciales reales.

### Corregido
- **Aislamiento de tenant en la nube**: cada negocio persiste un `tenant_id` estable y único para Supabase, evitando que los productos/stock de un local se mezclen con los del otro al sincronizar.

## [1.2.0] - 2026-07-10

### Añadido
- **M2 (Códigos de Descuento)**: Implementado modelo `DiscountCode` en `schema.prisma` y CRUD completo bajo los endpoints `/api/discount-codes/index` y `[id]`. Validación en tiempo real y registro de uso de códigos de descuento al realizar ventas.
- **M7 (Copia de Seguridad de Base de Datos)**: Añadidos métodos `db:backup` y `db:restore` a nivel de Electron e IPC con copia y sobreescritura seguras (con rollback automático temporal). Botones de importación/exportación añadidos al pie de la Sidebar.
- **M8 & M10 (Importar/Exportar CSV de Productos)**: Añadidos botones de importación y exportación de productos en formato CSV en el encabezado de filtros de la tabla de productos. Soporte inteligente para crear marcas y categorías inexistentes al importar.

### Corregido
- **E1 (Preload Naming Mismatch)**: Corregida discrepancia entre `electronAPI` y `licenseAPI` expuestos a través del puente de contexto en `preload.js`.
- **E2 (Stock Min Alert Query)**: Solucionado error de sintaxis en `data.ts` reemplazando llamadas de campo inválidas con consultas crudas SQL.
- **E3 (Weekly Sales Aggregation)**: Cambiada agrupación por timestamp exacto a agrupación por día de la semana en memoria JS.
- **E4 & E5 (Stock updates in Purchases)**: Implementadas validaciones de estados (`PENDING` vs `RECEIVED` vs `CANCELLED`) en compras para evitar el aumento erróneo de stock. Implementados handlers `PUT` y `DELETE` para actualizar stock al modificar/cancelar compras.
- **E6 & E7 (Sales Discount & Deletion FK Checks)**: Implementado cálculo dinámico del porcentaje de descuento en ventas y validación de referencias cruzadas antes de permitir la eliminación de productos.
- **V2 & V3 (Leaks y XSS)**: Creado middleware centralizado de sanitización XSS y controlador global de excepciones API para prevenir fugas de trazas internas.
- **V4 & V5 (License Security)**: Encriptada la llave de activación del local store con `safeStorage` (Electron) y removida de los canales de comunicación expuestos.
- **V7 & V10 (CSP & CSRF Middleware)**: Creado Next.js middleware global para interceptar peticiones locales y añadir cabeceras estrictas de seguridad (Content Security Policy).
- **F1 & F6 (Zonas Horarias & N+1 Queries)**: Corregidas disparidades de zona horaria usando rangos locales y resueltos más de 15 queries duplicadas en balances mensuales.
- **F2 & F3 (Historial de Precios de Compra)**: Autoguardado de precios de compra iniciales y fallback dinámico en estimaciones COGS usando el último costo histórico si `pricePurchase` es nulo.
- **F4 (Comparación de Porcentajes)**: Evitada la división por cero en retornos de incremento financiero.
- **F5 (Paginación GET)**: Integrados skip/take opcionales a todos los 9 endpoints GET de listados principales.
- **F7 (Búsqueda Server-side)**: Migrado el filtrado de productos y clientes en formularios de venta/compra a consultas dinámicas de servidor con debounce de 300ms.
- **F8 (Strict Build Mode)**: Reactivado el bloqueo por advertencias TypeScript y ESLint durante el proceso de build.
- **F9 (StatCard text color)**: Modificado `StatCard` para heredar clases de color inyectadas de su contenedor.
- **F10 (Redirects de Formulario)**: Reactivados redireccionamientos automáticos tras la modificación/creación de productos.
## [1.17.0] - 2026-09-16

- Corrección del cierre completo de Node.js durante las actualizaciones.
- Limpieza de procesos huérfanos antes y después de instalar una actualización.
- Mejoras de sincronización offline y movimientos de stock idempotentes.
