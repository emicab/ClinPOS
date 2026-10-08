import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../lib/prisma';
import { decryptText } from '../../lib/encryption';
import { sanitizeString } from '../../lib/sanitize';
import { GoogleGenAI } from '@google/genai';
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { message, sessionId, userId } = req.body;

    if (!userId) {
      return res.status(403).json({ error: "Acceso denegado: Usuario no identificado." });
    }
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user || user.role !== "ADMIN") {
      return res.status(403).json({ error: "Acceso denegado: Se requiere rol de Administrador para usar ClinIA." });
    }

    if (!message) {
      return res.status(400).json({ error: "Mensaje vacío" });
    }

    const setting = await prisma.setting.findUnique({
      where: { key: "geminiApiKey" },
    });

    if (!setting || !setting.value) {
      return res.status(401).json({ error: "API Key de Gemini no configurada." });
    }

    const apiKey = decryptText(setting.value).trim();
    
    if (!apiKey) {
      return res.status(401).json({ error: "API Key inválida." });
    }

    const client = new GoogleGenAI({ apiKey });

    // Declarar las herramientas (Tools)
    const getSalesMetrics = {
      type: 'function',
      name: "obtener_metricas_ventas",
      description: "Obtiene el total de ventas, transacciones y ganancias netas de los últimos X días.",
      parameters: {
        type: 'object',
        properties: {
          dias: {
            type: 'number',
            description: "Número de días hacia atrás a analizar (ej. 7 para una semana)",
          }
        },
        required: ["dias"],
      },
    };

    const getLowStock = {
      type: 'function',
      name: "obtener_productos_bajo_stock",
      description: "Obtiene una lista de productos que están por debajo de su alerta de stock mínimo, indicando cantidad actual y mínima.",
      parameters: {
        type: 'object',
        properties: {
          limite: {
            type: 'number',
            description: "Número máximo de productos a retornar (ej. 10)",
          }
        },
      },
    };

    const getTopProducts = {
      type: 'function',
      name: "obtener_productos_mas_vendidos",
      description: "Obtiene los productos más vendidos en los últimos X días.",
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'number', description: "Número de días hacia atrás (ej. 7)" },
          limite: { type: 'number', description: "Cantidad de productos a mostrar (ej. 5)" }
        },
      },
    };

    const createPromo = {
      type: 'function',
      name: "crear_promocion",
      description: "Crea una nueva promoción o descuento global en el sistema.",
      parameters: {
        type: 'object',
        properties: {
          nombre: {
            type: 'string',
            description: "Nombre de la promoción (ej. 'Liquidación Fin de Mes')",
          },
          descuento: {
            type: 'number',
            description: "Valor numérico del descuento (ej. 15)",
          },
          tipo: {
            type: 'string',
            description: "Tipo de descuento: 'PERCENTAGE' (porcentaje) o 'FIXED_AMOUNT' (monto fijo)",
          }
        },
        required: ["nombre", "descuento", "tipo"],
      },
    };

    const createClientTool = {
      type: 'function',
      name: "crear_cliente",
      description: "Registra un nuevo cliente en el sistema ClinPOS.",
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: "Nombre del cliente (ej. 'Juan')" },
          apellido: { type: 'string', description: "Apellido del cliente (ej. 'Pérez')" },
          telefono: { type: 'string', description: "Teléfono o celular del cliente" },
          email: { type: 'string', description: "Correo electrónico del cliente" },
          cuit: { type: 'string', description: "CUIT / CUIL o DNI del cliente" },
          direccion: { type: 'string', description: "Dirección física" },
          notas: { type: 'string', description: "Notas u observaciones" },
        },
        required: ["nombre"],
      },
    };

    const updateStockAlertTool = {
      type: 'function',
      name: "actualizar_alerta_stock",
      description: "Actualiza el umbral de alerta de stock mínimo para un producto.",
      parameters: {
        type: 'object',
        properties: {
          productoId: { type: 'number', description: "ID numérico del producto" },
          stockMinAlert: { type: 'number', description: "Cantidad mínima de stock antes de alertar (ej. 5)" },
        },
        required: ["productoId", "stockMinAlert"],
      },
    };

    const createDiscountCodeTool = {
      type: 'function',
      name: "crear_codigo_descuento",
      description: "Crea un nuevo código de descuento (cupón promocional) en el sistema. NOTA: Solo admite porcentajes.",
      parameters: {
        type: 'object',
        properties: {
          codigo: { type: 'string', description: "Código en mayúsculas (ej. 'VERANO2026')" },
          descuento: { type: 'number', description: "Porcentaje de descuento (ej. 10 para 10%)" },
          usoMaximo: { type: 'number', description: "Cantidad máxima de usos permitidos (opcional)" },
        },
        required: ["codigo", "descuento"],
      },
    };

    const createComboTool = {
      type: 'function',
      name: "crear_combo",
      description: "Crea un combo promocional que agrupa varios productos por un precio final unificado.",
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: "Nombre del combo (ej. 'Combo Fernet + Coca')" },
          precio: { type: 'number', description: "Precio final del combo" },
          descripcion: { type: 'string', description: "Descripción breve del combo" },
          items: {
            type: 'array',
            description: "Lista de productos que componen el combo",
            items: {
              type: 'object',
              properties: {
                productoId: { type: 'number', description: "ID del producto en la base de datos" },
                cantidad: { type: 'number', description: "Cantidad de este producto en el combo" }
              },
              required: ["productoId", "cantidad"]
            }
          }
        },
        required: ["nombre", "precio", "items"],
      },
    };

    const executeSql = {
      type: 'function',
      name: "ejecutar_consulta_sql",
      description: "Ejecuta una consulta SQL RAW (SOLO SELECT) en la base de datos SQLite para extraer métricas complejas, morosidad, compras a proveedores, rendimiento de vendedores, etc.",
      parameters: {
        type: 'object',
        properties: {
          consulta_sql: {
            type: 'string',
            description: "La consulta SQL válida para SQLite. Ej: SELECT count(*) FROM Client",
          }
        },
        required: ["consulta_sql"],
      },
    };

    const outOfScopeTrap = {
      type: 'function',
      name: "responder_fuera_de_alcance",
      description: "Usar SIEMPRE que la pregunta del usuario no tenga relación con el negocio (ventas, stock, clientes, cuenta corriente, proveedores, compras, gastos, vendedores, promociones, caja, consignaciones). Ejemplos: matemática, charla general, preguntas sobre temas externos, saludos sin contexto de negocio.",
      parameters: { 
        type: 'object', 
        properties: {
          razon: { type: 'string', description: "Breve razón de por qué está fuera de alcance" }
        } 
      },
    };

    const getCurrentAccount = {
      type: 'function',
      name: "obtener_cuenta_corriente",
      description: "Obtiene el saldo actual de cuenta corriente de un cliente específico, o lista todos los clientes con saldo. Incluye los últimos movimientos.",
      parameters: {
        type: 'object',
        properties: {
          clienteId: { type: 'number', description: "ID del cliente (opcional). Si se omite, lista todos los clientes con cuenta corriente activa." },
          dias: { type: 'number', description: "Días hacia atrás para movimientos (ej. 30, por defecto 30)" },
        },
      },
    };

    const getDebtors = {
      type: 'function',
      name: "obtener_clientes_morosos",
      description: "Obtiene los clientes con saldo deudor (balance negativo) en cuenta corriente, ordenados por deuda descendente.",
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'number', description: "Cantidad máxima de clientes a retornar (ej. 10, por defecto 10)" },
        },
      },
    };

    const getSalesBySeller = {
      type: 'function',
      name: "obtener_ventas_por_vendedor",
      description: "Obtiene las ventas totales agrupadas por vendedor en los últimos X días, incluyendo cantidad de transacciones y monto total.",
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'number', description: "Número de días hacia atrás (ej. 30, por defecto 30)" },
        },
      },
    };

    const getExpensesByCategory = {
      type: 'function',
      name: "obtener_gastos_por_periodo",
      description: "Obtiene los gastos agrupados por categoría en los últimos X días, con subtotales por categoría.",
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'number', description: "Número de días hacia atrás (ej. 30, por defecto 30)" },
          limite: { type: 'number', description: "Cantidad máxima de categorías (ej. 10, por defecto 10)" },
        },
      },
    };

    const getBalanceSummary = {
      type: 'function',
      name: "obtener_balance_general",
      description: "Obtiene un resumen financiero comparando ingresos (ventas) vs egresos (gastos + compras) en un período de días.",
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'number', description: "Número de días hacia atrás (ej. 30, por defecto 30)" },
        },
      },
    };

    const getPendingConsignments = {
      type: 'function',
      name: "obtener_consignaciones_pendientes",
      description: "Obtiene las consignaciones activas/pendientes (status 'DELIVERED'), incluyendo cliente, productos y montos adeudados.",
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'number', description: "Cantidad máxima de consignaciones (ej. 20, por defecto 20)" },
        },
      },
    };

    const searchProducts = {
      type: 'function',
      name: "listar_productos",
      description: "Busca productos por nombre, categoría o marca. Devuelve id, nombre, precio, stock y alerta de stock mínimo.",
      parameters: {
        type: 'object',
        properties: {
          busqueda: { type: 'string', description: "Texto a buscar en el nombre del producto (opcional)" },
          categoriaId: { type: 'number', description: "Filtrar por ID de categoría (opcional)" },
          marcaId: { type: 'number', description: "Filtrar por ID de marca (opcional)" },
          limite: { type: 'number', description: "Cantidad máxima de resultados (ej. 20, por defecto 20)" },
        },
      },
    };

    const tools = [
      getSalesMetrics, getLowStock, getTopProducts, createPromo, createComboTool,
      createClientTool, updateStockAlertTool, createDiscountCodeTool,
      getCurrentAccount, getDebtors, getSalesBySeller, getExpensesByCategory,
      getBalanceSummary, getPendingConsignments, searchProducts,
      executeSql, outOfScopeTrap
    ];

    const businessNameSetting = await prisma.setting.findUnique({ where: { key: "businessName" } });
    const businessName = businessNameSetting?.value?.trim() || "tu negocio";

    // Esquema de la BD generado dinámicamente desde prisma/schema.prisma
    // (evoluciona con las migraciones; fallback al mapa histórico).
    const { buildAISchema } = await import("../../lib/aiSchema");
    const aiSchema = await buildAISchema();

    // Obtener información de la caja/turno actual
    const activeShift = await prisma.cashRegister.findFirst({
      where: { status: 'OPEN' },
      orderBy: { openDate: 'desc' }
    });
    
    const activeShiftContext = activeShift 
      ? `\nINFORMACIÓN DE CONTEXTO ACTUAL:\n- Hay una CAJA ABIERTA (Turno Actual) con ID: ${activeShift.id}. Abierta el: ${new Date(activeShift.openDate).toLocaleString()}. Cuando el usuario pregunte por "la caja actual", "este turno", o "las ventas de hoy en caja", debes filtrar SIEMPRE por \`cashRegisterId = ${activeShift.id}\` según la tabla.\n` 
      : `\nINFORMACIÓN DE CONTEXTO ACTUAL:\n- Actualmente NO hay ninguna caja abierta (Turno cerrado).\n`;

const systemInstruction = `Eres el Asistente Copilot Autónomo de ${businessName}, integrado al software POS ClinPOS.
Tienes acceso a herramientas reales (functions) para consultar métricas, ver inventario bajo, crear promociones, registrar clientes, actualizar alertas de stock, crear códigos de descuento y ejecutar SQL para analítica profunda.

Tu único propósito es responder preguntas sobre la gestión integral de ${businessName}:
- Ventas y Facturación
- Inventario, Stock y Alertas
- Clientes, Cuenta Corriente y Deudas/Morosidad
- Proveedores, Compras e Insumos
- Vendedores, Turnos y Movimientos de Caja
- Promociones, Combos y Códigos de Descuento
- Ventas a Consignación

${activeShiftContext}

Si te preguntan algo que NO está relacionado con la gestión de ${businessName} (matemática, cultura general, charla casual, cualquier tema ajeno al negocio), debes usar la herramienta 'responder_fuera_de_alcance'.

REGLAS CRÍTICAS DE IDIOMA Y ESTADOS:
1. IDIOMA ESPAÑOL OBLIGATORIO: NUNCA muestres en tu respuesta final palabras o nombres de estados en inglés como "DELIVERED", "SETTLED", "COMPLETED", "PENDING", "CANCELLED", "OPEN", "CLOSED", "CASH", "TRANSFER", "CARD", etc. Traduce SIEMPRE todos los estados y datos a un español claro y profesional.
2. SIGNIFICADO DE ESTADOS DE CONSIGNACIÓN:
   - status = 'DELIVERED': Se debe mostrar al usuario como "En consignación" o "Pendiente de liquidación". IMPORTANTE: Este estado representa las CONSIGNACIONES PENDIENTES (mercadería entregada al cliente que aún no ha sido rendida ni cobrada). Cuando el usuario pregunte por "consignaciones pendientes" o "consignaciones activas", DEBES buscar e incluir las consignaciones donde \`status = 'DELIVERED'\`.
   - status = 'SETTLED': Se debe mostrar al usuario como "Saldada" o "Liquidada" (ya fue cobrada o rendida totalmente).
   - status = 'CANCELLED': Se debe mostrar al usuario como "Cancelada".

REGLA CRÍTICA CONTRA ALUCINACIONES:
- NUNCA inventes, asumas ni adivines números, métricas o cantidades (como número de clientes, total de ventas, stock, consignaciones pendientes, etc.).
- SIEMPRE debes usar la herramienta 'ejecutar_consulta_sql' para contar (COUNT), sumar (SUM) o buscar en la base de datos antes de dar tu respuesta al usuario.

RELACIONES IMPORTANTES DE BASE DE DATOS:
- Para saber métricas sobre ventas con promociones de tarjeta bancaria, puedes hacer un \`JOIN\` entre \`Sale\` y \`CreditCardPromotion\` a través de la columna \`Sale.creditCardPromotionId\`. Ejemplo: \`SELECT c.bank, count(s.id) FROM Sale s JOIN CreditCardPromotion c ON s.creditCardPromotionId = c.id GROUP BY c.bank\`.
- Para consultar consignaciones y sus ítems, puedes hacer \`JOIN\` entre \`Consignment\`, \`ConsignmentItem\`, \`Client\` y \`Product\`.

IMPORTANTE SOBRE SQL:
- Base de datos SQLite. NUNCA consultes SQLITE_MASTER, sqlite_master ni tablas internas del sistema.
- SOLO TIENES PERMISOS PARA EJECUTAR 'SELECT'. Nunca intentes UPDATE, DELETE, INSERT o DROP.
- MANEJO DE FECHAS: Las columnas de fecha se guardan como timestamps en MILISEGUNDOS (o datetime ISO/ms). Para extraer hora o fecha en SQLite SIEMPRE divide por 1000 si es timestamp numérico o usa strftime. Ejemplo: strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch', 'localtime')

ESQUEMA EXACTO DE LA BASE DE DATOS (usa SOLO estos nombres exactos de columnas):

${aiSchema}

MANEJO DE ERRORES: Si una herramienta devuelve un error técnico (ej. "no such column", "Violación de Privacidad", etc.), NUNCA muestres esos detalles técnicos crudos al usuario. Solo dile de forma natural y amigable que hubo un inconveniente al procesar su solicitud o que no pudiste encontrar los datos exactos.

Responde de manera profesional, amigable, concisa y siempre usando Markdown.
Si consideras útil sugerirle al usuario siguientes pasos o preguntas de seguimiento, incluye al final de tu respuesta una lista de sugerencias dentro de una etiqueta <suggestions> separadas por pipes (|). Ejemplo:
<suggestions>Ver deudas en cuenta corriente|Ver compras del mes|Ver consignaciones pendientes</suggestions>`;

    // --- MANEJO DE SESIÓN Y PERSISTENCIA ---
    let currentSessionId = sessionId;
    let dbHistory: any[] = [];

    if (currentSessionId) {
      const existingSession = await prisma.chatSession.findUnique({
        where: { id: currentSessionId }
      });
      if (existingSession) {
        dbHistory = await prisma.chatMessage.findMany({
          where: { sessionId: currentSessionId },
          orderBy: { createdAt: 'asc' }
        });
      } else {
        const newSession = await prisma.chatSession.create({
          data: { id: currentSessionId, title: message.substring(0, 30) + (message.length > 30 ? "..." : "") }
        });
        currentSessionId = newSession.id;
      }
    } else {
      const newSession = await prisma.chatSession.create({
        data: { title: message.substring(0, 30) + (message.length > 30 ? "..." : "") }
      });
      currentSessionId = newSession.id;
    }

    // Guardar el mensaje del usuario en la BD
    await prisma.chatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "user",
        content: message
      }
    });

    // Construir historial como steps reales para que el modelo vea la conversación estructurada
    let historyArr: any[] = [];

    for (const m of dbHistory) {
      historyArr.push({
        type: m.role === 'user' ? 'user_input' : 'model_output',
        content: [{ type: 'text', text: m.content }]
      });
    }

    historyArr.push({
      type: 'user_input',
      content: [{ type: 'text', text: message }]
    });

    const MODELO = "gemini-3.5-flash-lite";
    const safeCreateInteraction = async (params: any) => {
      if (process.env.NODE_ENV === 'production') {
        console.error(`[AgenteIA] Payload:`, JSON.stringify(params).substring(0, 500) + '...');
      }
      return await client.interactions.create({
        ...params,
        model: MODELO,
      });
    };

    let currentInteraction = await safeCreateInteraction({
      store: false,
      system_instruction: systemInstruction,
      input: historyArr,
      tools: tools as any,
    });

    function extractOutputText(interaction: any): string | null {
      if (!interaction) return null;

      if (interaction.output_text && typeof interaction.output_text === 'string' && interaction.output_text.trim().length > 0) {
        return interaction.output_text.trim();
      }

      if (interaction.steps && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.text && typeof step.text === 'string' && step.text.trim()) {
            return step.text.trim();
          }
          if (step.parts && Array.isArray(step.parts)) {
            const joined = step.parts.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
            if (joined) return joined;
          }
          if (step.content) {
            if (typeof step.content === 'string' && step.content.trim()) {
              return step.content.trim();
            }
            if (Array.isArray(step.content)) {
              for (const c of step.content) {
                if (c.text && typeof c.text === 'string' && c.text.trim()) return c.text.trim();
                if (typeof c === 'string' && c.trim()) return c.trim();
              }
            }
          }
        }
      }

      if (interaction.candidates && Array.isArray(interaction.candidates)) {
        for (const cand of interaction.candidates) {
          const parts = cand.content?.parts;
          if (Array.isArray(parts)) {
            const joined = parts.map((p: any) => p.text || '').join('').trim();
            if (joined) return joined;
          }
        }
      }

      return null;
    }

    let finalResponse = extractOutputText(currentInteraction);
    let loopCount = 0;

    // Bucle para soportar múltiples llamadas a funciones (multi-step function calling)
    while (!finalResponse && loopCount < 5) {
      const fcSteps = currentInteraction.steps?.filter((s: any) => s.type === 'function_call') || [];
      if (fcSteps.length === 0) break;

      const validStepsToAppend = currentInteraction.steps?.filter((s: any) => s.type === 'thought' || s.type === 'function_call') || [];
      historyArr = historyArr.concat(validStepsToAppend);
      
      for (const fcStep of fcSteps) {
        const call = fcStep as any;
        let toolResponse: any = null;

        try {
          if (call.name === "obtener_metricas_ventas") {
            const dias = call.arguments?.dias || 7;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);
            
            const sales = await prisma.sale.findMany({
              where: { saleDate: { gte: startDate }, status: "COMPLETED" },
              include: { items: true }
            });
            const totalVentas = sales.reduce((acc, s) => acc + Number(s.totalAmount), 0);
            toolResponse = { transacciones: sales.length, ingresosBrutos: totalVentas, periodo: `${dias} dias` };
          
          } else if (call.name === "obtener_productos_bajo_stock") {
            const limit = call.arguments?.limite || 10;
            const products = await prisma.product.findMany();
            const lowStock = products.filter(p => p.stockMinAlert !== null && p.quantityStock <= p.stockMinAlert).slice(0, limit);
            toolResponse = { productos: lowStock.map(p => ({ id: p.id, nombre: p.name, stockActual: p.quantityStock, alertaEn: p.stockMinAlert })) };
          
          } else if (call.name === "obtener_productos_mas_vendidos") {
            const dias = call.arguments?.dias || 30;
            const limit = call.arguments?.limite || 5;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);

            const items = await prisma.saleItem.groupBy({
              by: ["productId"],
              where: {
                sale: {
                  saleDate: { gte: startDate },
                  status: "COMPLETED"
                }
              },
              _sum: { quantity: true },
              orderBy: { _sum: { quantity: "desc" } },
              take: limit
            });

            const topProducts = await Promise.all(
              items
                .filter((i) => i.productId != null)
                .map(async (i) => {
                  const product = await prisma.product.findUnique({ where: { id: i.productId as number } });
                  return {
                    nombre: product?.name || "Desconocido",
                    cantidadVendida: i._sum.quantity || 0,
                  };
                })
            );
            toolResponse = { productosMasVendidos: topProducts, periodo: `${dias} dias` };

          } else if (call.name === "crear_promocion") {
            const { nombre, descuento, tipo } = call.arguments as any;
            if (tipo === "PERCENTAGE" && (descuento < 1 || descuento > 100)) {
              toolResponse = { error: "El descuento en porcentaje debe estar entre 1 y 100." };
            } else if (tipo === "FIXED_AMOUNT" && descuento <= 0) {
              toolResponse = { error: "El descuento fijo debe ser mayor a 0." };
            } else {
              const promo = await prisma.promotion.create({
                data: {
                  name: sanitizeString(String(nombre ?? '')),
                  type: "SET_DISCOUNT",
                  discountType: tipo === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT",
                  discountValue: descuento,
                  status: "ACTIVE",
                  priority: 1,
                }
              });
              toolResponse = { exito: true, promocionCreada: promo };
            }
            
          } else if (call.name === "crear_combo") {
            const { nombre, precio, descripcion, items } = call.arguments as any;
            if (!items || !items.length) {
              toolResponse = { error: "El combo debe contener al menos un producto (items)." };
            } else if (precio <= 0) {
              toolResponse = { error: "El precio del combo debe ser mayor a 0." };
            } else {
              const combo = await prisma.combo.create({
                data: {
                  name: sanitizeString(String(nombre ?? '')),
                  price: precio,
                  description: descripcion ? sanitizeString(String(descripcion)) : null,
                  active: true,
                  items: {
                    create: items.map((i: any) => ({
                      productId: parseInt(i.productoId),
                      quantity: parseFloat(i.cantidad) || 1,
                    }))
                  }
                },
                include: { items: true }
              });
              toolResponse = { exito: true, comboCreado: combo };
            }

          } else if (call.name === "crear_cliente") {
            const { nombre, apellido, telefono, email, cuit, direccion, notas } = call.arguments as any;
            const newClient = await prisma.client.create({
              data: {
                firstName: sanitizeString(String(nombre ?? '')),
                lastName: apellido ? sanitizeString(String(apellido)) : null,
                phone: telefono ? sanitizeString(String(telefono)) : null,
                email: email ? sanitizeString(String(email)) : null,
                cuit: cuit ? sanitizeString(String(cuit)) : null,
                address: direccion ? sanitizeString(String(direccion)) : null,
                notes: notas ? sanitizeString(String(notas)) : null,
              }
            });
            toolResponse = { exito: true, clienteCreado: newClient };

          } else if (call.name === "actualizar_alerta_stock") {
            const { productoId, stockMinAlert } = call.arguments as any;
            const updated = await prisma.product.update({
              where: { id: parseInt(productoId) },
              data: { stockMinAlert: parseFloat(stockMinAlert) }
            });
            toolResponse = { exito: true, productoActualizado: { id: updated.id, nombre: updated.name, stockMinAlert: updated.stockMinAlert } };

          } else if (call.name === "crear_codigo_descuento") {
            const { codigo, descuento, usoMaximo } = call.arguments as any;
            const codeUpper = sanitizeString(String(codigo ?? '')).trim().toUpperCase();
            const createdCode = await prisma.discountCode.create({
              data: {
                code: codeUpper,
                discountPercent: descuento,
                maxUses: usoMaximo ? parseInt(usoMaximo) : null,
                isActive: true,
              }
            });
            toolResponse = { exito: true, codigoDescuentoCreado: createdCode };
            
          } else if (call.name === "obtener_cuenta_corriente") {
            const clienteId = call.arguments?.clienteId;
            const dias = call.arguments?.dias || 30;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);

            if (clienteId) {
              const balance = await prisma.accountBalance.findUnique({
                where: { clientId: parseInt(clienteId) },
                include: { client: true }
              });
              const movimientos = await prisma.accountMovement.findMany({
                where: { accountBalanceId: balance?.id, createdAt: { gte: startDate } },
                orderBy: { createdAt: 'desc' },
                take: 20
              });
              toolResponse = {
                cliente: balance?.client ? `${balance.client.firstName} ${balance.client.lastName || ''}`.trim() : 'Desconocido',
                saldoActual: balance?.balance || 0,
                movimientos: movimientos.map(m => ({ tipo: m.type, monto: m.amount, descripcion: m.description, fecha: m.createdAt }))
              };
            } else {
              const balances = await prisma.accountBalance.findMany({
                where: { balance: { not: 0 } },
                include: { client: true },
                orderBy: { balance: 'desc' },
                take: 30
              });
              toolResponse = {
                clientes: balances.map(b => ({
                  id: b.clientId,
                  nombre: `${b.client?.firstName || ''} ${b.client?.lastName || ''}`.trim(),
                  saldo: b.balance
                }))
              };
            }

          } else if (call.name === "obtener_clientes_morosos") {
            const limite = call.arguments?.limite || 10;
            const balances = await prisma.accountBalance.findMany({
              where: { balance: { lt: 0 } },
              include: { client: true },
              orderBy: { balance: 'asc' },
              take: limite
            });
            toolResponse = {
              clientesMorosos: balances.map(b => ({
                id: b.clientId,
                nombre: `${b.client?.firstName || ''} ${b.client?.lastName || ''}`.trim(),
                deuda: Math.abs(Number(b.balance))
              })),
              totalClientes: balances.length
            };

          } else if (call.name === "obtener_ventas_por_vendedor") {
            const dias = call.arguments?.dias || 30;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);

            const sellers = await prisma.seller.findMany({ where: { isActive: true } });
            const result = await Promise.all(sellers.map(async (seller) => {
              const sales = await prisma.sale.findMany({
                where: { sellerId: seller.id, saleDate: { gte: startDate }, status: "COMPLETED" }
              });
              const total = sales.reduce((acc, s) => acc + Number(s.totalAmount), 0);
              return { vendedor: seller.name, transacciones: sales.length, totalVendido: total };
            }));

            const totalGeneral = result.reduce((acc, r) => acc + r.totalVendido, 0);
            toolResponse = { ventasPorVendedor: result.filter(r => r.transacciones > 0), totalGeneral, periodo: `${dias} dias` };

          } else if (call.name === "obtener_gastos_por_periodo") {
            const dias = call.arguments?.dias || 30;
            const limite = call.arguments?.limite || 10;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);

            const expenses = await prisma.expense.findMany({
              where: { expenseDate: { gte: startDate } }
            });

            const grouped: Record<string, { cantidad: number; total: number }> = {};
            for (const e of expenses) {
              const cat = e.category || 'Sin categoría';
              if (!grouped[cat]) grouped[cat] = { cantidad: 0, total: 0 };
              grouped[cat].cantidad++;
              grouped[cat].total += Number(e.amount);
            }

            const sorted = Object.entries(grouped)
              .map(([categoria, datos]) => ({ categoria, ...datos }))
              .sort((a, b) => b.total - a.total)
              .slice(0, limite);

            toolResponse = { gastosPorCategoria: sorted, totalGastos: expenses.reduce((a, e) => a + Number(e.amount), 0), periodo: `${dias} dias` };

          } else if (call.name === "obtener_balance_general") {
            const dias = call.arguments?.dias || 30;
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dias);

            const sales = await prisma.sale.findMany({
              where: { saleDate: { gte: startDate }, status: "COMPLETED" }
            });
            const totalIngresos = sales.reduce((acc, s) => acc + Number(s.totalAmount), 0);

            const expenses = await prisma.expense.findMany({
              where: { expenseDate: { gte: startDate } }
            });
            const totalGastos = expenses.reduce((acc, e) => acc + Number(e.amount), 0);

            const purchases = await prisma.purchase.findMany({
              where: { purchaseDate: { gte: startDate }, status: { not: "CANCELLED" } }
            });
            const totalCompras = purchases.reduce((acc, p) => acc + Number(p.totalAmount), 0);

            const totalEgresos = totalGastos + totalCompras;
            toolResponse = {
              periodo: `${dias} dias`,
              ingresos: { ventas: totalIngresos, cantidad: sales.length },
              egresos: { gastos: totalGastos, compras: totalCompras, total: totalEgresos },
              balanceNeto: totalIngresos - totalEgresos
            };

          } else if (call.name === "obtener_consignaciones_pendientes") {
            const limite = call.arguments?.limite || 20;
            const consignments = await prisma.consignment.findMany({
              where: { status: "DELIVERED" },
              include: { client: true, items: { include: { product: true } } },
              orderBy: { createdAt: 'desc' },
              take: limite
            });

            toolResponse = {
              consignaciones: consignments.map(c => ({
                id: c.id,
                cliente: `${c.client?.firstName || ''} ${c.client?.lastName || ''}`.trim(),
                fecha: c.createdAt,
                productos: c.items.map(i => ({
                  producto: i.product?.name || 'Desconocido',
                  cantidadEntregada: i.quantityGiven,
                  cantidadVendida: i.quantitySold,
                  cantidadDevuelta: i.quantityReturned,
                  precioUnitario: i.priceAtGiven
                })),
                notas: c.notes
              })),
              total: consignments.length
            };

          } else if (call.name === "listar_productos") {
            const { busqueda, categoriaId, marcaId, limite } = call.arguments as any;
            const take = limite || 20;
            const where: any = {};
            if (busqueda) where.name = { contains: busqueda };
            if (categoriaId) where.categoryId = parseInt(categoriaId);
            if (marcaId) where.brandId = parseInt(marcaId);

            const products = await prisma.product.findMany({
              where,
              include: { brand: true, category: true },
              orderBy: { name: 'asc' },
              take
            });

            toolResponse = {
              productos: products.map(p => ({
                id: p.id,
                nombre: p.name,
                precioVenta: p.priceSale,
                stockActual: p.quantityStock,
                stockMinimo: p.stockMinAlert,
                marca: p.brand?.name || null,
                categoria: p.category?.name || null
              })),
              total: products.length
            };

          } else if (call.name === "ejecutar_consulta_sql") {
            const { consulta_sql } = call.arguments as any;
            
            const upperQuery = consulta_sql.trim().toUpperCase();
            if (!upperQuery.startsWith("SELECT")) {
               throw new Error("Violación de Seguridad: Solo se permiten consultas SELECT.");
            }

            // Defensa adicional: el regex de FROM/JOIN de abajo se esquivaba con
            // identificadores entre comillas ("Setting"), corchetes/backticks o
            // joins por coma. Se rechazan esas formas y las tablas/columnas sensibles
            // en cualquier parte de la consulta (claves, PIN, tokens, sync, chat).
            if (/["`\[\]]/.test(consulta_sql) || /;\s*\S/.test(consulta_sql)) {
               throw new Error("Violación de Seguridad: no se permiten identificadores entre comillas ni múltiples sentencias.");
            }
            const SENSIBLES = /\b(setting|user|storeconfig|pairingcode|syncoutbox|synctombstone|syncconflict|chatsession|chatmessage|savednote|pinhash|mpaccesstoken|geminiapikey|pragma|attach|load_extension|readfile|writefile|sqlite_[a-z_]*)\b/i;
            if (SENSIBLES.test(consulta_sql)) {
               throw new Error("Violación de Privacidad: la consulta referencia datos que no están disponibles para consultas analíticas.");
            }

            // Allowlist estricto de tablas para proteger Setting, User, etc.
            const TABLAS_PERMITIDAS = ['PRODUCT', 'CATEGORY', 'BRAND', 'SUPPLIER', 'SALE', 'SALEITEM', 'PURCHASE', 'PURCHASEITEM', 'CLIENT', 'SELLER', 'EXPENSE', 'CASHREGISTER', 'CASHMOVEMENT', 'CONSIGNMENT', 'CONSIGNMENTITEM', 'ACCOUNTBALANCE', 'ACCOUNTMOVEMENT', 'DISCOUNTCODE', 'PROMOTION', 'PROMOTIONCONDITION', 'COMBO', 'COMBOITEM', 'CREDITCARDPROMOTION', 'INVOICE'];
            
            const tableMatches = upperQuery.match(/(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)/g);
            if (tableMatches) {
               for (const match of tableMatches) {
                  const tableName = match.split(/\s+/)[1];
                  if (!TABLAS_PERMITIDAS.includes(tableName.toUpperCase())) {
                     throw new Error(`Violación de Privacidad: La tabla '${tableName}' no está en la lista de tablas permitidas para consultas analíticas.`);
                  }
               }
            }

            try {
              let dbPath = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace("file:", "") : "./prisma/dev.db";
              if (dbPath === "./dev.db" || dbPath === "dev.db") {
                dbPath = "./prisma/dev.db";
              }
              const { DatabaseSync } = eval("require('node:sqlite')");
              const safeDb = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
              
              const rawData = safeDb.prepare(consulta_sql).all();
              
              const arrayData = Array.isArray(rawData) ? rawData : [rawData];
              if (arrayData.length > 50) {
                 toolResponse = { nota: "Resultados truncados a los primeros 50 registros", resultados: arrayData.slice(0, 50) };
              } else {
                 toolResponse = { resultados: arrayData };
              }
            } catch (dbErr: any) {
               toolResponse = { error_sql: dbErr.message };
            }

          } else if (call.name === "responder_fuera_de_alcance") {
            toolResponse = { mensaje: `Fuera de alcance — no ejecutar ninguna acción. Informa amablemente al usuario que solo puedes responder preguntas de la gestión.` };
            
          } else {
            toolResponse = { error: "Función desconocida" };
          }
        } catch (err: any) {
          toolResponse = { error: err.message };
        }

        historyArr.push({
          type: 'function_result',
          name: call.name,
          call_id: call.id,
          result: [{ type: 'text', text: JSON.stringify(toolResponse, (key, value) => typeof value === 'bigint' ? value.toString() : value) }]
        });
      }

      currentInteraction = await safeCreateInteraction({
        store: false,
        system_instruction: systemInstruction,
        input: historyArr,
        tools: tools as any,
      });
      
      finalResponse = extractOutputText(currentInteraction);
      loopCount++;
    }

    // Si el modelo quedó atrapado en un bucle de herramientas sin generar texto,
    // hacemos una llamada final SIN herramientas para forzar una respuesta en texto.
    if (!finalResponse) {
      console.warn("[ClinIA] Modelo atrapado en bucle de herramientas. Forzando síntesis final sin tools...");
      try {
        // Construir un prompt de síntesis con toda la info recopilada
        const synthesisPrompt = `${historyArr.map((h: any) => {
          if (h.type === 'user_input') return '';
          if (h.type === 'function_result') return `Resultado de herramienta ${h.name}: ${h.result?.[0]?.text || ''}`;
          return '';
        }).filter(Boolean).join('\n')}

Con base en los resultados de las herramientas anteriores, responde de forma clara y concisa en Markdown al usuario. No llames a ninguna herramienta adicional.`;

        const finalCall = await safeCreateInteraction({
          store: false,
          system_instruction: systemInstruction,
          input: [{ type: "user_input", content: [{ type: "text", text: synthesisPrompt }] }],
          tools: [], // Sin herramientas — fuerza texto puro
        });
        finalResponse = extractOutputText(finalCall);
        if (!finalResponse && finalCall?.output_text) finalResponse = finalCall.output_text;
      } catch (synthErr: any) {
        console.error("[ClinIA] Error en síntesis forzada:", synthErr?.message);
      }
    }

    if (!finalResponse) {
      finalResponse = "Obtuve los datos de tu negocio, pero no pude formatear la respuesta. Intenta de nuevo con una pregunta más específica.";
    }

    // Extraer sugerencias si existen
    let suggestions: string[] = [];
    const suggestionMatch = finalResponse.match(/<suggestions>([\s\S]*?)<\/suggestions>/i);
    if (suggestionMatch) {
      suggestions = suggestionMatch[1].split('|').map(s => s.trim()).filter(Boolean);
      finalResponse = finalResponse.replace(/<suggestions>[\s\S]*?<\/suggestions>/i, '').trim();
    }

    // Guardar el mensaje del modelo en la BD
    await prisma.chatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "model",
        content: finalResponse,
        suggestions: suggestions.length > 0 ? JSON.stringify(suggestions) : null
      }
    });

    return res.status(200).json({ reply: finalResponse, suggestions, sessionId: currentSessionId });
  } catch (error: any) {
    console.error("Agent error:", error);
    
    // Interceptar errores de cuota (Rate Limit 429) para no mostrar el error crudo al usuario final
    if (error.message && error.message.includes("429")) {
      return res.status(429).json({ error: "¡Ups! Me hiciste muchas preguntas muy rápido y me quedé sin aliento (límite de consultas gratuitas alcanzado). Por favor, esperá 1 minutito y volvé a intentarlo ⏱️" });
    }

    // Extraer detalles reales del error de la API si están ocultos en err.body o err.cause.body
    let detailedMsg = error?.message || String(error);
    try {
      const errorBody = error?.body || error?.cause?.body;
      if (errorBody) {
        const parsedBody = JSON.parse(errorBody);
        const actualMessage = parsedBody?.[0]?.error?.message || parsedBody?.error?.message;
        if (actualMessage) detailedMsg = actualMessage;
      }
    } catch (_) {}

    return res.status(500).json({ error: "Ocurrió un error interno al intentar comunicarme con el motor de IA. Intenta de nuevo más tarde.", detalles: detailedMsg });
  }
}
