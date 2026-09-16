# Changelog - ClinPOS

Todos los cambios notables realizados en el proyecto están detallados a continuación.

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
