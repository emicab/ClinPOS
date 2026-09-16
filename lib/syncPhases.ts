// lib/syncPhases.ts
// Fases del sync completo (PULL/PUSH) + helpers compartidos con syncService.
// El grafo de imports es acíclico: solo syncService → syncPhases. Los imports
// dinámicos (syncOutbox, licenseStatus, branchIdentity) se usan dentro de las
// funciones para no crear ciclos ni chunks rotos en dev.
import prisma from "./prisma";
import { isProDevice } from "./branchIdentity";
import { isCloudNewer, recordSyncConflict } from "./syncConflict";

const fmtDec = (val: any, fallback: string | null = "0.00") => (val !== undefined && val !== null ? val.toString() : fallback);

// El respaldo/sincronización en la nube es exclusivo del Plan Pro.
export async function isCloudAllowed(): Promise<boolean> {
  const allowed = await isProDevice();
  if (!allowed) {
    console.warn("[Sync] Sincronización en la nube omitida: requiere el Plan Pro.");
  }
  return allowed;
}

export async function recalcProductTotal(productId: number): Promise<void> {
  const totalStock = await prisma.productBranchStock.aggregate({
    where: { productId },
    _sum: { quantityStock: true }
  });
  await prisma.product.update({
    where: { id: productId },
    data: { quantityStock: totalStock._sum.quantityStock ?? 0 }
  });
}

export async function recalcProductTotals(productIds: Iterable<number>): Promise<void> {
  const uniqueIds = Array.from(new Set(productIds));
  for (const id of uniqueIds) {
    await recalcProductTotal(id);
  }
}

export async function getMainBranchId(): Promise<number | null> {
  const mainBranch = await prisma.branch.findFirst({ where: { isMain: true } });
  return mainBranch?.id ?? null;
}

async function adjustBranchStock(productId: number, branchId: number, delta: number): Promise<void> {
  await prisma.productBranchStock.upsert({
    where: { productId_branchId: { productId, branchId } },
    update: { quantityStock: { increment: delta } },
    create: { productId, branchId, quantityStock: delta }
  });
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllRows(url: string, headers: Record<string, string>): Promise<any[] | null> {
  const rows: any[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const res = await fetchWithTimeout(url, { headers: { ...headers, Range: `${from}-${from + pageSize - 1}` } });
    if (!res.ok) {
      console.warn(`[Sync] GET ${res.status} al descargar ${url.split("?")[0]}.`);
      return null;
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// ===== MAPPERS DE PAYLOAD (fuente única de verdad) =====
// Todos los caminos de sync (full y puntual) suben el MISMO set de campos.
// Cualquier columna nueva se agrega acá y se propaga a todos lados.

export function toProductPayload(p: any, tenantId: string): Record<string, any> {
  return {
    id: p.id, name: p.name, sku: p.sku, description: p.description, tenant_id: tenantId,
    pricePurchase: fmtDec(p.pricePurchase), priceSale: fmtDec(p.priceSale),
    quantityStock: p.quantityStock, stockMinAlert: p.stockMinAlert, unitType: p.unitType,
    isPublicWeb: p.isPublicWeb !== false, webCategory: p.webCategory || null,
    webUnavailable: p.webUnavailable === true,
    isRecipe: p.isRecipe === true, isIngredient: p.isIngredient === true,
    brandId: p.brandId, categoryId: p.categoryId, supplierId: p.supplierId,
    imageUrl: p.imageUrl || null,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString()
  };
}

// Id determinista para RecipeItem. Patrón estable e idempotente: se deriva SOLO
// de los datos (productId e ingredientId), no de un índice/orden que varíe entre
// syncs. Así el mismo item SIEMPRE mapea al mismo PK (tenant_id+id) y el upsert
// (resolution=merge-duplicates) no puede duplicar filas en la nube al cambiar el
// orden del array local en cada pasada.
export function toRecipeItemPayload(ri: any, _index: number, tenantId: string): Record<string, any> {
  return {
    id: Number(ri.productId) * 1000000 + Number(ri.ingredientId),
    productId: ri.productId, ingredientId: ri.ingredientId,
    quantity: ri.quantity, unitType: ri.unitType || "UNIT",
    tenant_id: tenantId,
    createdAt: ri.createdAt?.toISOString?.() || new Date().toISOString(),
    updatedAt: ri.updatedAt?.toISOString?.() || new Date().toISOString()
  };
}

export function toPbsPayload(bs: any, tenantId: string): Record<string, any> {
  return {
    productId: bs.productId, branchId: bs.branchId, quantityStock: bs.quantityStock, tenant_id: tenantId,
    updatedAt: bs.updatedAt.toISOString()
  };
}

// Id determinista para ProductModifierGroup: igual patrón que RecipeItem
// (productId*1000000 + índice dentro del producto) para que el upsert por PK
// (tenant_id+id) no duplique filas entre POS ni dependa de ids autoincrementales locales.
export function toModifierGroupPayload(g: any, groupIdx: number, tenantId: string): Record<string, any> {
  return {
    id: Number(g.productId) * 1000000 + groupIdx,
    productId: g.productId, name: g.name, type: g.type || "MULTI_SELECT",
    isRequired: g.isRequired === true, minSelect: g.minSelect ?? 0, maxSelect: g.maxSelect ?? null,
    tenant_id: tenantId,
    createdAt: g.createdAt?.toISOString?.() || new Date().toISOString(),
    updatedAt: g.updatedAt?.toISOString?.() || new Date().toISOString()
  };
}

// Id determinista para ProductModifierOption: productId*1000000 + índice dentro del
// producto (contador global por producto, no por grupo) para mantener unicidad.
export function toModifierOptionPayload(o: any, optionIdx: number, tenantId: string, modifierGroupCloudId: number): Record<string, any> {
  return {
    id: Number(o.modifierGroup.productId) * 1000000 + optionIdx,
    modifierGroupId: modifierGroupCloudId,
    name: o.name, priceExtra: fmtDec(o.priceExtra), colorHex: o.colorHex || null,
    ingredientId: o.ingredientId ?? null, ingredientQty: fmtDec(o.ingredientQty, "1"),
    tenant_id: tenantId,
    createdAt: o.createdAt?.toISOString?.() || new Date().toISOString(),
    updatedAt: o.updatedAt?.toISOString?.() || new Date().toISOString()
  };
}

// Construye los arrays de ProductModifierGroup/ProductModifierOption con ids
// determinísticos, agrupando las opciones por su grupo local para calcular el
// modifierGroupId de nube correcto. Se reutiliza en buildPushPayload y en el
// refreshProductPayload para que ambos caminos suban el MISMO set.
export function buildModifierPayloads(
  modifierGroups: any[],
  modifierOptions: any[],
  tenantId: string
): { ProductModifierGroup: Record<string, any>[]; ProductModifierOption: Record<string, any>[] } {
  const groupCounters = new Map<number, number>();
  const optionCounters = new Map<number, number>();
  const groupCloudIdByLocal = new Map<number, number>();

  const groupPayloads = modifierGroups.map((g) => {
    const idx = groupCounters.get(g.productId) ?? 0;
    groupCounters.set(g.productId, idx + 1);
    const cloudId = Number(g.productId) * 1000000 + idx;
    groupCloudIdByLocal.set(g.id, cloudId);
    return toModifierGroupPayload(g, idx, tenantId);
  });

  const optionPayloads = modifierOptions.map((o) => {
    const cloudGroupId = groupCloudIdByLocal.get(o.modifierGroupId);
    if (cloudGroupId === undefined) return null;
    const idx = optionCounters.get(o.modifierGroup.productId) ?? 0;
    optionCounters.set(o.modifierGroup.productId, idx + 1);
    return toModifierOptionPayload(o, idx, tenantId, cloudGroupId);
  }).filter((x): x is Record<string, any> => x !== null);

  return { ProductModifierGroup: groupPayloads, ProductModifierOption: optionPayloads };
}

export function toBrandPayload(b: any, tenantId: string): Record<string, any> {
  return {
    id: b.id, name: b.name, logoUrl: b.logoUrl, tenant_id: tenantId,
    createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString()
  };
}

export function toCategoryPayload(c: any, tenantId: string): Record<string, any> {
  return {
    id: c.id, name: c.name, logoUrl: c.logoUrl, tenant_id: tenantId,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString()
  };
}

export function toSupplierPayload(s: any, tenantId: string): Record<string, any> {
  return {
    id: s.id, name: s.name, contactPerson: s.contactPerson, email: s.email, phone: s.phone,
    address: s.address, notes: s.notes, tenant_id: tenantId,
    createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString()
  };
}

export function toWebOrderPayload(order: any, cloudId: number, tenantId: string): Record<string, any> {
  return {
    id: cloudId,
    webOrderNumber: order.webOrderNumber,
    clientName: order.clientName,
    clientEmail: order.clientEmail,
    clientPhone: order.clientPhone,
    shippingAddress: order.shippingAddress,
    deliveryType: order.deliveryType,
    branchId: order.branchId ?? null,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    totalAmount: fmtDec(order.totalAmount),
    mpFeeAmount: fmtDec(order.mpFeeAmount, "0"),
    subtotalAmount: fmtDec(order.subtotalAmount, "0"),
    discountAmount: fmtDec(order.discountAmount, "0"),
    deliveryFee: fmtDec(order.deliveryFee, "0"),
    couponCode: order.couponCode ?? null,
    deliveryZone: order.deliveryZone ?? null,
    trackingCode: order.trackingCode ?? null,
    origin: order.origin ?? "WEB",
    scheduledFor: order.scheduledFor ? (typeof order.scheduledFor === "string" ? order.scheduledFor : order.scheduledFor.toISOString()) : null,
    stockReviewNote: order.stockReviewNote ?? null,
    stockReviewAt: order.stockReviewAt
      ? (typeof order.stockReviewAt === "string" ? order.stockReviewAt : order.stockReviewAt.toISOString())
      : null,
    mpPaymentId: order.mpPaymentId ?? null,
    discountBreakdown: order.discountBreakdown ?? null,
    notes: order.notes,
    // Campos de integración (PeYA/Rappi). Tolerante: si la nube aún no tiene la
    // columna, el sync los omite vía PGRST204_FALLBACKS en syncService.
    orderCode: order.orderCode ?? null,
    externalOrderId: order.externalOrderId ?? null,
    chainId: order.chainId ?? null,
    vendorId: order.vendorId ?? null,
    transportType: order.transportType ?? null,
    promisedFor: order.promisedFor
      ? (typeof order.promisedFor === "string" ? order.promisedFor : order.promisedFor.toISOString())
      : null,
    acceptedFor: order.acceptedFor
      ? (typeof order.acceptedFor === "string" ? order.acceptedFor : order.acceptedFor.toISOString())
      : null,
    riderInfo: order.riderInfo ?? null,
    tenant_id: tenantId,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

export function toWebOrderItemPayload(item: any, cloudId: number, index: number, tenantId: string): Record<string, any> {
  return {
    id: cloudId * 100 + index,
    webOrderId: cloudId,
    productId: item.productId,
    quantity: item.quantity,
    unitPrice: fmtDec(item.unitPrice),
    subtotal: fmtDec(item.subtotal),
    modifiers: item.modifiers || null,
    externalItemId: item.externalItemId ?? null,
    tenant_id: tenantId
  };
}

export function toStockTransferPayload(st: any, tenantId: string): Record<string, any> {
  return {
    id: st.id, sourceBranchId: st.sourceBranchId, targetBranchId: st.targetBranchId,
    status: st.status, notes: st.notes || null, createdByName: st.createdByName || null, tenant_id: tenantId,
    createdAt: st.createdAt.toISOString()
  };
}

export function toStockTransferItemPayload(sti: any, tenantId: string): Record<string, any> {
  return {
    transferId: sti.transferId, productId: sti.productId,
    productName: sti.productName || null, quantity: sti.quantity,
    receivedQuantity: sti.receivedQuantity ?? null, tenant_id: tenantId,
  };
}

// ===== PHASES OF THE FULL SYNC =====
// Fases extraídas de runSupabaseSync (lib/syncService.ts) para que el
// orquestador sea legible. Son privadas salvo las que syncService necesita.

export interface SyncPhaseContext {
  supabaseUrl: string;
  supabaseKey: string;
  tenantId: string;
  forceFullSync: boolean;
  lastSync: Date;
  isMainDeviceFlag: boolean;
  mainBranchId: number | null;
  productIdsToRecalc: Set<number>;
}

export type SyncCursors = Record<string, string>;

interface SyncEntities {
  branches: any[];
  branchStocks: any[];
  stockTransfers: any[];
  stockTransferItems: any[];
  brands: any[];
  categories: any[];
  suppliers: any[];
  discountCodes: any[];
  promotions: any[];
  clients: any[];
  sellers: any[];
  users: any[];
  products: any[];
  recipeItems: any[];
  cashRegisters: any[];
  accountBalances: any[];
  combos: any[];
  sales: any[];
  saleItems: any[];
  purchases: any[];
  purchaseItems: any[];
  expenses: any[];
  cashMovements: any[];
  accountMovements: any[];
  comboItems: any[];
  webOrders: any[];
  storeConfigs: any[];
  modifierGroups: any[];
  modifierOptions: any[];
}

// La Casa Central revalida su licencia online en cada sync: si el plan bajó
// (mensualidad no renovada) se actualiza app_plan local y se propaga a la
// nube para que las sucursales también bajen.
export async function revalidateLicenseIfMain(isMainDeviceFlag: boolean): Promise<void> {
  if (!isMainDeviceFlag) return;
  try {
    const { revalidateLicense } = await import("./licenseStatus");
    await revalidateLicense();
  } catch (reErr) {
    console.warn("[Sync] No se pudo revalidar la licencia:", reErr);
  }
}

// Garantiza que todo producto no elaborado tenga un ProductBranchStock actualizado
// en la sucursal principal (para que la tienda web ClinStore muestre el stock real).
export async function bootstrapBranchStocks(mainBranchId: number | null): Promise<void> {
  if (!mainBranchId) return;
  try {
    const products = await prisma.product.findMany({
      where: { isRecipe: false },
      select: { id: true, quantityStock: true }
    });
    for (const p of products) {
      const existing = await prisma.productBranchStock.findUnique({
        where: { productId_branchId: { productId: p.id, branchId: mainBranchId } }
      });
      if (!existing) {
        await prisma.productBranchStock.create({
          data: { productId: p.id, branchId: mainBranchId, quantityStock: p.quantityStock }
        });
      } else if (existing.quantityStock !== p.quantityStock) {
        await prisma.productBranchStock.update({
          where: { productId_branchId: { productId: p.id, branchId: mainBranchId } },
          data: { quantityStock: p.quantityStock }
        });
      }
    }
  } catch (initErr) {
    console.warn("[Sync] Error auto-inicializando branchStocks:", initErr);
  }
}

// Carga todas las entidades locales modificadas desde el último watermark.
export async function loadLocalEntities(lastSync: Date, forceFullSync: boolean, cursors: SyncCursors = {}): Promise<SyncEntities> {
  const cursorFor = (entity: string): Date => {
    if (forceFullSync) return new Date(0);
    const parsed = cursors[entity] ? new Date(cursors[entity]) : lastSync;
    return Number.isNaN(parsed.getTime()) ? lastSync : parsed;
  };
  const recent = (entity: string) => ({ updatedAt: { gt: cursorFor(entity) } });
  return {
    branches: await prisma.branch.findMany({ where: recent("Branch") }),
    branchStocks: await prisma.productBranchStock.findMany({ where: recent("ProductBranchStock") }),
    stockTransfers: await prisma.stockTransfer.findMany({ where: forceFullSync ? {} : { createdAt: { gt: cursorFor("StockTransfer") } } }),
    stockTransferItems: await prisma.stockTransferItem.findMany(),
    // Evita volver a subir el catálogo completo en cada ciclo incremental.
    brands: await prisma.brand.findMany({ where: recent("Brand") }),
    categories: await prisma.category.findMany({ where: recent("Category") }),
    suppliers: await prisma.supplier.findMany({ where: recent("Supplier") }),
    discountCodes: await prisma.discountCode.findMany({ where: recent("DiscountCode") }),
    promotions: await prisma.promotion.findMany({
      where: recent("Promotion"),
      include: { conditions: { include: { product: true, category: true } } }
    }),
    clients: await prisma.client.findMany({ where: recent("Client") }),
    sellers: await prisma.seller.findMany({ where: recent("Seller") }),
    users: await prisma.user.findMany({ where: recent("User") }),
    products: await prisma.product.findMany({ where: recent("Product") }),
    recipeItems: await prisma.recipeItem.findMany({
      where: forceFullSync ? {} : { product: { updatedAt: { gt: cursorFor("Product") } } },
      orderBy: { ingredientId: "asc" },
    }),
    cashRegisters: await prisma.cashRegister.findMany({ where: recent("CashRegister") }),
    accountBalances: await prisma.accountBalance.findMany({ where: recent("AccountBalance") }),
    combos: await prisma.combo.findMany({ where: recent("Combo") }),
    sales: await prisma.sale.findMany({ where: recent("Sale") }),
    saleItems: await prisma.saleItem.findMany({
      where: forceFullSync ? {} : { sale: { updatedAt: { gt: cursorFor("Sale") } } }
    }),
    purchases: await prisma.purchase.findMany({ where: recent("Purchase") }),
    purchaseItems: await prisma.purchaseItem.findMany({
      where: forceFullSync ? {} : { purchase: { updatedAt: { gt: cursorFor("Purchase") } } }
    }),
    expenses: await prisma.expense.findMany({ where: recent("Expense") }),
    cashMovements: await prisma.cashMovement.findMany({ where: forceFullSync ? {} : { createdAt: { gt: cursorFor("CashMovement") } } }),
    accountMovements: await prisma.accountMovement.findMany({ where: forceFullSync ? {} : { createdAt: { gt: cursorFor("AccountMovement") } } }),
    comboItems: await prisma.comboItem.findMany({
      where: forceFullSync ? {} : { combo: { updatedAt: { gt: cursorFor("Combo") } } },
      include: { product: true }
    }),
    webOrders: await prisma.webOrder.findMany({ where: recent("WebOrder"), include: { items: true } }),
    storeConfigs: await prisma.storeConfig.findMany(),
    modifierGroups: await prisma.productModifierGroup.findMany({
      where: forceFullSync ? {} : { product: { updatedAt: { gt: cursorFor("Product") } } },
      orderBy: { id: "asc" },
    }),
    modifierOptions: await prisma.productModifierOption.findMany({
      where: forceFullSync ? {} : { modifierGroup: { updatedAt: { gt: cursorFor("ProductModifierGroup") } } },
      orderBy: { id: "asc" },
      include: { modifierGroup: { select: { id: true, productId: true } } },
    }),
  };
}

// Mapea webOrderNumber → id de nube para que el upsert de WebOrder sea idempotente.
export async function mapCloudWebOrderIds(supabaseUrl: string, supabaseKey: string, tenantId: string): Promise<Record<string, number>> {
  const supabaseWebOrderIds: Record<string, number> = {};
  try {
    const idUrl = `${supabaseUrl}/rest/v1/WebOrder?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,webOrderNumber`;
    const idRes = await fetch(idUrl, {
      headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
    });
    if (idRes.ok) {
      const existingOrders: { id: number; webOrderNumber: string }[] = await idRes.json();
      for (const o of existingOrders) {
        supabaseWebOrderIds[o.webOrderNumber] = o.id;
      }
    }
  } catch (err) {
    console.warn("[Sync] No se pudieron obtener IDs de WebOrders desde Supabase:", err);
  }
  return supabaseWebOrderIds;
}

// Construye el payload del PUSH a partir de las entidades locales cargadas.
export function buildPushPayload(
  tenantId: string,
  isMainDeviceFlag: boolean,
  entities: SyncEntities,
  supabaseWebOrderIds: Record<string, number>,
  config: Record<string, string>
): Record<string, any[]> {
  const {
    brands, categories, suppliers, branches, branchStocks, stockTransfers, stockTransferItems,
    discountCodes, promotions, clients, sellers, users, products, recipeItems, cashRegisters, accountBalances,
    combos, comboItems, sales, saleItems, purchases, purchaseItems, expenses, cashMovements,
    accountMovements, webOrders, storeConfigs, modifierGroups, modifierOptions
  } = entities;

  const modifierPayloads = buildModifierPayloads(modifierGroups, modifierOptions, tenantId);

  return {
    Brand: brands.map(b => toBrandPayload(b, tenantId)),
    Category: categories.map(c => toCategoryPayload(c, tenantId)),
    Supplier: suppliers.map(s => toSupplierPayload(s, tenantId)),
    Branch: branches.map(b => ({
      id: b.id, name: b.name, address: b.address || null, phone: b.phone || null, isMain: b.isMain, tenant_id: tenantId,
      createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString()
    })),
    Product: products.map(p => toProductPayload(p, tenantId)),
    // RecipeItem: id determinista por producto (productId*1000 + índice dentro del producto).
    RecipeItem: (() => {
      const counters = new Map<number, number>();
      return recipeItems.map((ri) => {
        const idx = counters.get(ri.productId) ?? 0;
        counters.set(ri.productId, idx + 1);
        return toRecipeItemPayload(ri, idx, tenantId);
      });
    })(),
    ProductModifierGroup: modifierPayloads.ProductModifierGroup,
    ProductModifierOption: modifierPayloads.ProductModifierOption,
    ProductBranchStock: branchStocks.map(bs => toPbsPayload(bs, tenantId)),
    StockTransfer: stockTransfers.map(st => toStockTransferPayload(st, tenantId)),
    StockTransferItem: stockTransferItems.map(sti => toStockTransferItemPayload(sti, tenantId)),
    DiscountCode: discountCodes.map(d => ({
      id: d.id, code: d.code, discountPercent: fmtDec(d.discountPercent), tenant_id: tenantId,
      discountType: d.discountType || "PERCENTAGE",
      discountValue: fmtDec(d.discountValue ?? d.discountPercent),
      minPurchase: fmtDec(d.minPurchase ?? 0),
      validFrom: d.validFrom?.toISOString() || null, validUntil: d.validUntil?.toISOString() || null,
      maxUses: d.maxUses, currentUses: d.currentUses, isActive: d.isActive,
      createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString()
    })),
    Promotion: promotions.map(p => ({
      id: p.id, name: p.name, description: p.description, type: p.type, status: p.status, tenant_id: tenantId,
      discountType: p.discountType, discountValue: fmtDec(p.discountValue), minQuantity: p.minQuantity,
      maxDiscountQty: p.maxDiscountQty, priority: p.priority,
      imageUrl: p.imageUrl || null,
      conditions: (p.conditions || []).map((c: any) => ({
        id: c.id, promotionId: c.promotionId, productId: c.productId, categoryId: c.categoryId,
        minQuantity: c.minQuantity,
        product: c.product ? { name: c.product.name } : null,
        category: c.category ? { name: c.category.name } : null
      })),
      startDate: p.startDate?.toISOString() || null, endDate: p.endDate?.toISOString() || null,
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString()
    })),
    Client: clients.map(c => ({
      id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, address: c.address, notes: c.notes, tenant_id: tenantId,
      createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString()
    })),
    Seller: sellers.map(s => ({
      id: s.id, name: s.name, email: s.email, phone: s.phone, isActive: s.isActive, tenant_id: tenantId,
      createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString()
    })),
    User: users.map(u => ({
      id: u.id, name: u.name, role: u.role, pinHash: u.pinHash, tenant_id: tenantId,
      createdAt: u.createdAt.toISOString(), updatedAt: u.updatedAt.toISOString()
    })),
    Combo: combos.map(co => ({
      id: co.id, name: co.name, description: co.description, price: fmtDec(co.price), tenant_id: tenantId,
      active: co.active, imageUrl: co.imageUrl || null,
      items: comboItems
        .filter(ci => ci.comboId === co.id)
        .map(ci => ({
          id: ci.id, comboId: ci.comboId, productId: ci.productId,
          productName: ci.product?.name || `#${ci.productId}`,
          quantity: ci.quantity,
          priceSale: ci.customPrice !== null && ci.customPrice !== undefined ? fmtDec(ci.customPrice) : fmtDec(ci.product?.priceSale)
        })),
      createdAt: co.createdAt.toISOString(), updatedAt: co.updatedAt.toISOString()
    })),
    CashRegister: cashRegisters.map(c => ({
      id: c.id, openDate: c.openDate.toISOString(), closeDate: c.closeDate?.toISOString() || null, tenant_id: tenantId,
      initialBalance: fmtDec(c.initialBalance),
      expectedBalance: fmtDec(c.expectedBalance),
      actualBalance: fmtDec(c.actualBalance),
      difference: fmtDec(c.difference),
      status: c.status, notes: c.notes, sellerId: c.sellerId ?? 1,
      createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString()
    })),
    AccountBalance: accountBalances.map(a => ({
      id: a.id, clientId: a.clientId, balance: fmtDec(a.balance), tenant_id: tenantId,
      updatedAt: a.updatedAt.toISOString()
    })),
    Sale: sales.map(s => ({
      id: s.id, saleDate: s.saleDate.toISOString(), totalAmount: fmtDec(s.totalAmount), tenant_id: tenantId,
      paymentType: s.paymentType, notes: s.notes, clientId: s.clientId, sellerId: s.sellerId ?? 1,
      cashRegisterId: s.cashRegisterId, discountCodeApplied: s.discountCodeApplied,
      createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString()
    })),
    SaleItem: saleItems.map(si => ({
      id: si.id, quantity: si.quantity, priceAtSale: fmtDec(si.priceAtSale), tenant_id: tenantId,
      purchasePriceAtSale: fmtDec(si.purchasePriceAtSale), saleId: si.saleId, productId: si.productId,
      productName: si.productName || null
    })),
    ComboItem: comboItems.map(ci => ({
      id: ci.id, comboId: ci.comboId, productId: ci.productId, quantity: ci.quantity, tenant_id: tenantId,
      customPrice: fmtDec(ci.customPrice)
    })),
    Purchase: purchases.map(pu => ({
      id: pu.id, purchaseDate: pu.purchaseDate.toISOString(), totalAmount: fmtDec(pu.totalAmount), tenant_id: tenantId,
      status: pu.status, paymentType: pu.paymentType || 'CASH', invoiceNumber: pu.invoiceNumber, notes: pu.notes,
      supplierId: pu.supplierId, createdAt: pu.createdAt.toISOString(), updatedAt: pu.updatedAt.toISOString()
    })),
    PurchaseItem: purchaseItems.map(pi => ({
      id: pi.id, quantity: pi.quantity, quantityReceived: pi.quantityReceived ?? pi.quantity ?? 0, tenant_id: tenantId,
      purchasePrice: fmtDec(pi.purchasePrice), purchaseId: pi.purchaseId, productId: pi.productId
    })),
    Expense: expenses.map(e => ({
      id: e.id, expenseDate: e.expenseDate.toISOString(), description: e.description, tenant_id: tenantId,
      amount: fmtDec(e.amount), category: e.category, paymentType: e.paymentType, notes: e.notes,
      createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString()
    })),
    CashMovement: cashMovements.map(cm => ({
      id: cm.id, cashRegisterId: cm.cashRegisterId, type: cm.type, paymentType: cm.paymentType, tenant_id: tenantId,
      sourceId: cm.sourceId, amount: fmtDec(cm.amount), description: cm.description,
      createdAt: cm.createdAt.toISOString()
    })),
    AccountMovement: accountMovements.map(am => ({
      id: am.id, accountBalanceId: am.accountBalanceId, type: am.type, amount: fmtDec(am.amount), tenant_id: tenantId,
      description: am.description, saleId: am.saleId, createdAt: am.createdAt.toISOString()
    })),
    WebOrder: webOrders
      .filter(o => supabaseWebOrderIds[o.webOrderNumber] !== undefined)
      .map(o => toWebOrderPayload(o, supabaseWebOrderIds[o.webOrderNumber], tenantId)),
    WebOrderItem: webOrders
      .filter(o => supabaseWebOrderIds[o.webOrderNumber] !== undefined)
      .flatMap((o: any) => o.items.map((i: any, index: number) =>
        toWebOrderItemPayload(i, supabaseWebOrderIds[o.webOrderNumber], index, tenantId)
      )),
    StoreConfig: isMainDeviceFlag && storeConfigs.length > 0 ? storeConfigs.map(sc => ({
      id: sc.id, slug: sc.slug, businessName: sc.businessName, description: sc.description, logoUrl: sc.logoUrl, bannerUrl: sc.bannerUrl,
      primaryColor: sc.primaryColor, isWebActive: sc.isWebActive, mpAccessToken: sc.mpAccessToken, mpPublicKey: sc.mpPublicKey,
      mpFeePercent: fmtDec(sc.mpFeePercent), whatsappPhone: sc.whatsappPhone, minStockBuffer: sc.minStockBuffer, allowPickup: sc.allowPickup,
      allowDelivery: sc.allowDelivery,
      requireMpForDelivery: sc.requireMpForDelivery !== undefined ? sc.requireMpForDelivery : true,
      deliveryFee: fmtDec(sc.deliveryFee), minDeliveryAmount: fmtDec(sc.minDeliveryAmount),
      businessSector: sc.businessSector || "GASTRONOMIA",
      lat: sc.lat ?? null, lng: sc.lng ?? null, deliveryZones: sc.deliveryZones ?? null, openingHours: sc.openingHours ?? null,
      // Campos de integración PeYA (clinstore los lee para resolver el tenant
      // del webhook y autorizar los proxies). Tolerante vía PGRST204_FALLBACKS.
      peyaEnabled: sc.peyaEnabled ?? false,
      peyaChainId: sc.peyaChainId ?? null,
      peyaVendorId: sc.peyaVendorId ?? null,
      peyaEnv: sc.peyaEnv || "SANDBOX",
      peyaAutoAccept: sc.peyaAutoAccept ?? false,
      peyaConnected: sc.peyaConnected ?? false,
      peyaWebhookSecret: sc.peyaWebhookSecret ?? null,
      tenant_id: tenantId, createdAt: sc.createdAt.toISOString(), updatedAt: sc.updatedAt.toISOString()
    })) : [],
    Setting: isMainDeviceFlag && config.app_plan ? [{
      key: "app_plan", value: config.app_plan, tenant_id: tenantId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }] : []
  };
}

// Reconstruir StoreConfig justo antes del PUSH usando el estado local tras el
// PULL ("último escritor gana"). Evita re-subir un mpAccessToken que acaba de
// borrarse en la nube: si el pull lo vació localmente, acá se sube vacío.
export async function refreshStoreConfigPayload(payload: Record<string, any[]>, tenantId: string): Promise<void> {
  try {
    const freshConfigs = await prisma.storeConfig.findMany();
    if (freshConfigs.length > 0) {
      payload.StoreConfig = freshConfigs.map(sc => ({
        id: sc.id, slug: sc.slug, businessName: sc.businessName, description: sc.description,
        logoUrl: sc.logoUrl, bannerUrl: sc.bannerUrl,
        primaryColor: sc.primaryColor, isWebActive: sc.isWebActive,
        mpAccessToken: sc.mpAccessToken, mpPublicKey: sc.mpPublicKey,
        mpFeePercent: fmtDec(sc.mpFeePercent), whatsappPhone: sc.whatsappPhone,
        minStockBuffer: sc.minStockBuffer, allowPickup: sc.allowPickup,
        allowDelivery: sc.allowDelivery,
        requireMpForDelivery: sc.requireMpForDelivery !== undefined ? sc.requireMpForDelivery : true,
        deliveryFee: fmtDec(sc.deliveryFee),
        minDeliveryAmount: fmtDec(sc.minDeliveryAmount),
        businessSector: sc.businessSector || "GASTRONOMIA",
        lat: sc.lat ?? null, lng: sc.lng ?? null, deliveryZones: sc.deliveryZones ?? null, openingHours: sc.openingHours ?? null,
        tenant_id: tenantId, createdAt: sc.createdAt.toISOString(),
        updatedAt: sc.updatedAt.toISOString()
      }));
    }
  } catch (err) {
    console.warn("[Sync] Error al reconstruir StoreConfig para el push:", err);
  }
}

// [HOTFIX BUG 2] Refrescar los arrays del payload antes del PUSH para garantizar
// que se suban los datos unificados y evitar pisar los datos de Supabase.
export async function refreshProductPayload(
  payload: Record<string, any[]>,
  tenantId: string,
  forceFullSync: boolean,
  lastSync: Date
): Promise<void> {
  const freshProducts = await prisma.product.findMany({ where: forceFullSync ? {} : { updatedAt: { gt: lastSync } } });
  const freshBranchStocks = await prisma.productBranchStock.findMany({ where: forceFullSync ? {} : { updatedAt: { gt: lastSync } } });
  const freshRecipeItems = forceFullSync
    ? await prisma.recipeItem.findMany({ orderBy: { ingredientId: "asc" } })
    : await prisma.recipeItem.findMany({
        where: { product: { updatedAt: { gt: lastSync } } },
        orderBy: { ingredientId: "asc" },
      });
  const freshModifierGroups = forceFullSync
    ? await prisma.productModifierGroup.findMany({ orderBy: { id: "asc" } })
    : await prisma.productModifierGroup.findMany({
        where: { product: { updatedAt: { gt: lastSync } } },
        orderBy: { id: "asc" },
      });
  const freshModifierOptions = forceFullSync
    ? await prisma.productModifierOption.findMany({ orderBy: { id: "asc" }, include: { modifierGroup: { select: { id: true, productId: true } } } })
    : await prisma.productModifierOption.findMany({
        where: { modifierGroup: { updatedAt: { gt: lastSync } } },
        orderBy: { id: "asc" },
        include: { modifierGroup: { select: { id: true, productId: true } } },
      });

  payload.Product = freshProducts.map(p => toProductPayload(p, tenantId));
  payload.ProductBranchStock = freshBranchStocks.map(bs => toPbsPayload(bs, tenantId));
  const counters = new Map<number, number>();
  payload.RecipeItem = freshRecipeItems.map((ri) => {
    const idx = counters.get(ri.productId) ?? 0;
    counters.set(ri.productId, idx + 1);
    return toRecipeItemPayload(ri, idx, tenantId);
  });
  const modifierPayloads = buildModifierPayloads(freshModifierGroups, freshModifierOptions, tenantId);
  payload.ProductModifierGroup = modifierPayloads.ProductModifierGroup;
  payload.ProductModifierOption = modifierPayloads.ProductModifierOption;
}

// Descarga los pedidos web desde Supabase y los aplica localmente (crea los
// faltantes, y en cancelaciones/reposiciones ajusta el stock por sucursal).
export async function pullWebOrdersFromCloud(ctx: SyncPhaseContext): Promise<void> {
  const { supabaseUrl, supabaseKey, tenantId, mainBranchId, productIdsToRecalc } = ctx;
  try {
    const urlWebOrders = `${supabaseUrl}/rest/v1/WebOrder?tenant_id=eq.${tenantId}&select=*,WebOrderItem(*)`;
    const resWebOrders = await fetch(urlWebOrders, {
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      }
    });
    if (resWebOrders.ok) {
      const cloudOrders = await resWebOrders.json();

      // Los items de pedidos externos (PeYA/Rappi) pueden apuntar a productos
      // que el pull de catálogo aún no importó (placeholders creados por
      // clinstore sin marca/categoría, que ese pull saltea). Sin este guard, el
      // create del pedido viola la FK de productId.
      const ensureLocalProduct = async (cloudProductId: number): Promise<number> => {
        const existing = await prisma.product.findUnique({
          where: { id: cloudProductId },
          select: { id: true },
        });
        if (existing) return cloudProductId;
        try {
          await prisma.product.create({
            data: {
              id: cloudProductId,
              name: `Producto externo #${cloudProductId}`,
              priceSale: 0,
              pricePurchase: 0,
              quantityStock: 0,
              isIngredient: false,
              isPublicWeb: false,
            },
          });
        } catch (err) {
          // Posible carrera con otro sync: si el producto apareció entretanto, ok.
          console.warn("[Sync] No se pudo crear placeholder local del item externo", cloudProductId, err);
        }
        return cloudProductId;
      };

      for (const order of cloudOrders) {
        // Si el pedido web se marcó para borrar (outbox), no lo re-importemos.
        const { isOutboxDeletePending } = await import("./syncOutbox");
        if (await isOutboxDeletePending("WebOrder", String(order.webOrderNumber))) {
          continue;
        }
        const exists = await prisma.webOrder.findFirst({
          where: { webOrderNumber: order.webOrderNumber }
        });
        if (!exists) {
          await prisma.webOrder.create({
            data: {
              webOrderNumber: order.webOrderNumber,
              clientName: order.clientName,
              clientEmail: order.clientEmail,
              clientPhone: order.clientPhone,
              shippingAddress: order.shippingAddress,
              deliveryType: order.deliveryType,
              branchId: order.branchId ?? null,
              paymentMethod: order.paymentMethod,
              paymentStatus: order.paymentStatus,
              status: order.status,
              totalAmount: order.totalAmount,
              subtotalAmount: order.subtotalAmount ?? 0,
              discountAmount: order.discountAmount ?? 0,
              deliveryFee: order.deliveryFee ?? 0,
              couponCode: order.couponCode ?? null,
              deliveryZone: order.deliveryZone ?? null,
              trackingCode: order.trackingCode ?? null,
              scheduledFor: order.scheduledFor ? new Date(order.scheduledFor) : null,
              stockReviewNote: order.stockReviewNote ?? null,
              stockReviewAt: order.stockReviewAt ? new Date(order.stockReviewAt) : null,
              mpPaymentId: order.mpPaymentId ?? null,
              discountBreakdown: order.discountBreakdown ?? null,
              origin: order.origin ?? "WEB",
              notes: order.notes,
              // Campos de integración (PeYA/Rappi): sin ellos, el pedido bajado
              // de la nube no se identifica como externo (externalOrderId null)
              // y las acciones de comanda (aceptar/despachar/cancelar) fallan.
              orderCode: order.orderCode ?? null,
              externalOrderId: order.externalOrderId ?? null,
              chainId: order.chainId ?? null,
              vendorId: order.vendorId ?? null,
              transportType: order.transportType ?? null,
              promisedFor: order.promisedFor ? new Date(order.promisedFor) : null,
              acceptedFor: order.acceptedFor ? new Date(order.acceptedFor) : null,
              riderInfo: order.riderInfo ?? null,
              createdAt: new Date(order.createdAt),
              items: {
                create: await Promise.all(
                  (order.WebOrderItem || []).map(async (i: any) => ({
                    productId: await ensureLocalProduct(i.productId),
                    quantity: i.quantity,
                    unitPrice: i.unitPrice,
                    subtotal: i.subtotal,
                    modifiers: i.modifiers
                      ? (typeof i.modifiers === "string" ? i.modifiers : JSON.stringify(i.modifiers))
                      : null,
                    externalItemId: i.externalItemId ?? null,
                  }))
                )
              }
            }
          });

          // El stock del pedido ya fue descontado en la nube (PICKUP: sucursal
          // elegida; DELIVERY: reserva de la sucursal principal). Acá NO se
          // vuelve a descontar: el pull de ProductBranchStock que corre después
          // trae los valores ya descontados y los sobrescribe localmente.
          for (const item of (order.WebOrderItem || [])) {
            productIdsToRecalc.add(item.productId);
          }
        } else {
          const isBeingCancelled = order.status === "CANCELLED" && exists.status !== "CANCELLED";
          const isBeingRestored = order.status !== "CANCELLED" && exists.status === "CANCELLED";

          // Resolución de conflictos: la nube solo gana si es MÁS RECIENTE que el
          // registro local. Evita que el PULL (que corre antes del PUSH) pise un
          // cambio de estado hecho recién en este POS con datos viejos de Supabase.
          const cloudWins = isCloudNewer(order.updatedAt, exists.updatedAt);

          if (cloudWins && (isBeingCancelled || isBeingRestored)) {
            const existingItems = await prisma.webOrderItem.findMany({
              where: { webOrderId: exists.id }
            });
            // La reposición usa la sucursal del pedido: la asignada (branchId)
            // o la principal como reserva provisoria de los DELIVERY sin asignar.
            const orderBranchId = exists.branchId ?? mainBranchId;
            if (orderBranchId) {
              const sign = isBeingCancelled ? 1 : -1;
              for (const item of existingItems) {
                try {
                  // Si el ítem es una receta (elaborado), la reposición/descuento
                  // se hace sobre sus INGREDIENTES (su stock se deriva), no sobre
                  // el producto mismo que tiene quantityStock 0.
                  const productItem = await prisma.product.findUnique({
                    where: { id: item.productId },
                    select: { isRecipe: true },
                  });
                  if (productItem?.isRecipe) {
                    const { restoreRecipeStock, deductRecipeStock } = await import("./recipeStock");
                    if (sign > 0) {
                      await restoreRecipeStock(prisma, item.productId, item.quantity, orderBranchId);
                    } else {
                      await deductRecipeStock(prisma, item.productId, item.quantity, orderBranchId);
                    }
                    productIdsToRecalc.add(item.productId);
                  } else {
                    await adjustBranchStock(item.productId, orderBranchId, sign * item.quantity);
                    productIdsToRecalc.add(item.productId);
                  }
                } catch (err) {
                  console.warn("Stock restore/decrement error for product", item.productId, err);
                }
              }
            } else {
              console.warn("[Sync] No hay sucursal asignada ni principal; no se pudo ajustar stock del pedido", order.webOrderNumber);
            }
          }

          if (cloudWins) {
            await prisma.webOrder.update({
              where: { id: exists.id },
              data: {
                branchId: order.branchId ?? exists.branchId,
                paymentStatus:
                  exists.paymentStatus === "PAID" || order.paymentStatus === "PAID"
                    ? "PAID"
                    : order.paymentStatus,
                status: order.status,
                subtotalAmount: order.subtotalAmount ?? exists.subtotalAmount,
                discountAmount: order.discountAmount ?? exists.discountAmount,
                deliveryFee: order.deliveryFee ?? exists.deliveryFee,
                couponCode: order.couponCode ?? exists.couponCode,
                deliveryZone: order.deliveryZone ?? exists.deliveryZone ?? null,
                trackingCode: order.trackingCode ?? exists.trackingCode ?? null,
                scheduledFor: order.scheduledFor
                  ? new Date(order.scheduledFor)
                  : exists.scheduledFor,
                stockReviewNote: order.stockReviewNote ?? exists.stockReviewNote ?? null,
                stockReviewAt: order.stockReviewAt
                  ? new Date(order.stockReviewAt)
                  : exists.stockReviewAt,
                mpPaymentId: order.mpPaymentId ?? exists.mpPaymentId ?? null,
                discountBreakdown: order.discountBreakdown ?? exists.discountBreakdown ?? null,
                origin: order.origin ?? exists.origin ?? "WEB",
                notes: order.notes ?? exists.notes,
                // Campos de integración: se sincronizan si la nube los tiene
                // (pedidos PeYA/Rappi creados por clinstore o el webhook).
                orderCode: order.orderCode ?? exists.orderCode ?? null,
                externalOrderId: order.externalOrderId ?? exists.externalOrderId ?? null,
                chainId: order.chainId ?? exists.chainId ?? null,
                vendorId: order.vendorId ?? exists.vendorId ?? null,
                transportType: order.transportType ?? exists.transportType ?? null,
                promisedFor: order.promisedFor
                  ? new Date(order.promisedFor)
                  : exists.promisedFor,
                acceptedFor: order.acceptedFor
                  ? new Date(order.acceptedFor)
                  : exists.acceptedFor,
                riderInfo: order.riderInfo ?? exists.riderInfo ?? null,
                updatedAt: new Date(order.updatedAt)
              }
            });
          }
        }
      }
    }

    // WP1 "Regla de Oro": tras recibir los pedidos de la nube, marcar como
    // PENDING_REVIEW los que el stock local (SQLite) no puede cubrir. El
    // cliente físico gana la última unidad; el comerciante decide qué hacer.
    try {
      const { markWebOrdersForReview } = await import("./stockReview");
      const flagged = await markWebOrdersForReview();
      if (flagged > 0) {
        console.log(`[Sync] ${flagged} pedido(s) web marcado(s) para revisión por falta de stock local`);
      }
    } catch (err) {
      console.warn("[Sync] Error en la revisión de stock de pedidos web:", err);
    }
  } catch (err) {
    console.warn("Error al descargar WebOrders desde Supabase:", err);
  }
}

// Descarga StoreConfig desde la nube. En la Casa Central, si no hay config local
// se crea fiel a la nube; las credenciales de MercadoPago se rigen por la nube
// (borrado o token nuevo), respetando "último escritor gana" con isCloudNewer.
export async function pullStoreConfigFromCloud(ctx: SyncPhaseContext, firstStoreConfig: any): Promise<void> {
  const { supabaseUrl, supabaseKey, tenantId, isMainDeviceFlag } = ctx;
  try {
    const urlConfig = `${supabaseUrl}/rest/v1/StoreConfig?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*`;
    const resConfig = await fetch(urlConfig, {
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      }
    });
    if (resConfig.ok) {
      const remoteConfigs = await resConfig.json();
      const remoteConfig = remoteConfigs?.[0];

      if (remoteConfig) {
        if (!firstStoreConfig) {
          // La tienda web la administra la Casa Central. Si esta PC no tiene
          // StoreConfig local y es la Casa Central, se copia fielmente la de
          // la nube (sin inventar un slug tipo "tienda-<timestamp>" que pisaba
          // la tienda real). Las sucursales no la crean.
          if (isMainDeviceFlag) {
            await prisma.storeConfig.create({
              data: {
                slug: remoteConfig.slug || `tienda-${tenantId}`,
                businessName: remoteConfig.businessName || "Mi Tienda Web",
                description: remoteConfig.description || null,
                logoUrl: remoteConfig.logoUrl || null,
                bannerUrl: remoteConfig.bannerUrl || null,
                primaryColor: remoteConfig.primaryColor || "#2563eb",
                isWebActive: remoteConfig.isWebActive === true,
                mpAccessToken: remoteConfig.mpAccessToken || null,
                mpPublicKey: remoteConfig.mpPublicKey || null,
                mpFeePercent: remoteConfig.mpFeePercent || 0,
                whatsappPhone: remoteConfig.whatsappPhone || null,
                minStockBuffer: parseFloat(remoteConfig.minStockBuffer) || 0,
                allowPickup: remoteConfig.allowPickup !== false,
                allowDelivery: remoteConfig.allowDelivery !== false,
                requireMpForDelivery: remoteConfig.requireMpForDelivery !== false,
                deliveryFee: remoteConfig.deliveryFee || 0,
                minDeliveryAmount: remoteConfig.minDeliveryAmount || 0,
                lat: remoteConfig.lat ?? null,
                lng: remoteConfig.lng ?? null,
                deliveryZones: remoteConfig.deliveryZones ?? null,
                openingHours: remoteConfig.openingHours ?? null,
              }
            });
            console.log(`[Sync] StoreConfig local creada desde Supabase (Casa Central) para tenant ${tenantId}`);
          } else {
            console.log(`[Sync] Esta PC es una sucursal y no tiene StoreConfig local; la tienda web la administra la Casa Central (tenant ${tenantId}).`);
          }
        } else {
          if (remoteConfig.mpAccessToken !== firstStoreConfig.mpAccessToken) {
            // La nube es la fuente de verdad para las credenciales de MP:
            // - Si la nube BORRÓ el token (mpAccessToken vacío), el borrado se
            //   propaga SIEMPRE al local, aunque su timestamp sea viejo (un
            //   UPDATE manual en Supabase no actualiza updatedAt). Sin esto, el
            //   local conservaba el token y el PUSH lo volvía a subir.
            // - Si la nube tiene un token NUEVO, solo se aplica si es más nuevo
            //   que el local (isCloudNewer), para no pisar una escritura local
            //   reciente (ej. OAuth legacy que aún no se subió).
            const cloudHasToken = Boolean(remoteConfig.mpAccessToken);
            const cloudIsNewer = isCloudNewer(remoteConfig.updatedAt, firstStoreConfig.updatedAt);
            if (!cloudHasToken || cloudIsNewer) {
              await prisma.storeConfig.update({
                where: { id: firstStoreConfig.id },
                data: {
                  mpAccessToken: remoteConfig.mpAccessToken || null,
                  mpPublicKey: remoteConfig.mpPublicKey || "",
                },
              });
              console.log(
                `[Sync] mpAccessToken${cloudHasToken ? " actualizado" : " borrado"} desde Supabase para tenant ${tenantId}`
              );
            }
          }

          if (remoteConfig.peyaWebhookSecret !== firstStoreConfig.peyaWebhookSecret) {
            // El secret del webhook de PeYA se sincroniza de la nube a la Casa
            // Central (la generó el flujo "Conectar" y clinstore lo valida).
            const cloudIsNewer = isCloudNewer(remoteConfig.updatedAt, firstStoreConfig.updatedAt);
            if (cloudIsNewer) {
              await prisma.storeConfig.update({
                where: { id: firstStoreConfig.id },
                data: {
                  peyaWebhookSecret: remoteConfig.peyaWebhookSecret || null,
                  peyaConnected: remoteConfig.peyaConnected === true,
                  peyaChainId: remoteConfig.peyaChainId || null,
                  peyaVendorId: remoteConfig.peyaVendorId || null,
                  peyaEnv: remoteConfig.peyaEnv || "SANDBOX",
                  peyaAutoAccept: remoteConfig.peyaAutoAccept === true,
                  peyaEnabled: remoteConfig.peyaEnabled === true,
                },
              });
              console.log(`[Sync] Configuración PeYA actualizada desde Supabase para tenant ${tenantId}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Error al descargar StoreConfig desde Supabase:", err);
  }
}

// Descargar el plan desde la nube. En la Casa Central el valor local manda
// (ya se revalidó al inicio); en las sucursales se aplica el plan del main.
export async function pullPlanFromCloud(ctx: SyncPhaseContext): Promise<void> {
  const { supabaseUrl, supabaseKey, tenantId } = ctx;
  try {
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;
    const resSetting = await fetch(`${supabaseUrl}/rest/v1/Setting?${tenantParam}&key=eq.app_plan&select=*`, { headers });
    if (resSetting.ok) {
      const rows = await resSetting.json();
      const planRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      if (planRow && planRow.value) {
        const targetPlan = planRow.value === "pro" ? "pro" : "basico";
        const { setPlanSettings } = await import("./branchIdentity");
        await setPlanSettings(targetPlan);
        console.log(`[Sync] Plan actualizado en sucursal desde la Casa Central: ${targetPlan}`);
      }
    }
  } catch (err) {
    console.warn("Error al descargar el plan desde Supabase:", err);
  }
}

// [MODIFICADO BUG 2] Descargar Entidades Globales (Branches, Products, Brands,
// Categories, Stock, Traspasos, Combos, Promociones) desde Supabase hacia la DB
// Local. Corre ANTES del PUSH ("último escritor gana").
export async function pullCoreEntitiesFromCloud(ctx: SyncPhaseContext): Promise<void> {
  const { supabaseUrl, supabaseKey, tenantId, productIdsToRecalc } = ctx;
  try {
    const headers = { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` };
    const tenantParam = `tenant_id=eq.${encodeURIComponent(tenantId)}`;

    const resB = await fetch(`${supabaseUrl}/rest/v1/Branch?${tenantParam}&select=*`, { headers });
    if (resB.ok) {
      const cloudBranches = await resB.json();
      for (const b of cloudBranches) {
        const branchData = {
          name: b.name, address: b.address, phone: b.phone, isMain: b.isMain,
          updatedAt: new Date(b.updatedAt)
        };
        const existingBranch = await prisma.branch.findUnique({ where: { id: b.id }, select: { updatedAt: true } });
        if (!existingBranch) {
          await prisma.branch.create({ data: { id: b.id, ...branchData } });
        } else if (isCloudNewer(b.updatedAt, existingBranch.updatedAt)) {
          await prisma.branch.update({ where: { id: b.id }, data: branchData });
        }
      }
    }

    const resSeller = await fetch(`${supabaseUrl}/rest/v1/Seller?${tenantParam}&select=*`, { headers });
    if (resSeller.ok) {
      const cloudSellers = await resSeller.json();
      for (const s of cloudSellers) {
        const sellerData = {
          name: s.name,
          email: s.email || null,
          phone: s.phone || null,
          isActive: s.isActive !== false,
          updatedAt: new Date(s.updatedAt),
        };
        const existingSeller = await prisma.seller.findUnique({ where: { id: s.id }, select: { updatedAt: true } });
        if (!existingSeller) {
          await prisma.seller.create({ data: { id: s.id, ...sellerData } });
        } else if (isCloudNewer(s.updatedAt, existingSeller.updatedAt)) {
          await prisma.seller.update({ where: { id: s.id }, data: sellerData });
        }
      }
    }

    const resBr = await fetch(`${supabaseUrl}/rest/v1/Brand?${tenantParam}&select=*`, { headers });
    if (resBr.ok) {
      const cloudBrands = await resBr.json();
      for (const b of cloudBrands) {
        const brandData = {
          name: b.name, logoUrl: b.logoUrl, updatedAt: new Date(b.updatedAt)
        };
        const existingBrand = await prisma.brand.findUnique({ where: { id: b.id }, select: { updatedAt: true } });
        if (!existingBrand) {
          await prisma.brand.create({ data: { id: b.id, ...brandData } });
        } else if (isCloudNewer(b.updatedAt, existingBrand.updatedAt)) {
          await prisma.brand.update({ where: { id: b.id }, data: brandData });
        }
      }
    }

    const resCat = await fetch(`${supabaseUrl}/rest/v1/Category?${tenantParam}&select=*`, { headers });
    if (resCat.ok) {
      const cloudCats = await resCat.json();
      for (const c of cloudCats) {
        const catData = {
          name: c.name, logoUrl: c.logoUrl, updatedAt: new Date(c.updatedAt)
        };
        const existingCat = await prisma.category.findUnique({ where: { id: c.id }, select: { updatedAt: true } });
        if (!existingCat) {
          await prisma.category.create({ data: { id: c.id, ...catData } });
        } else if (isCloudNewer(c.updatedAt, existingCat.updatedAt)) {
          await prisma.category.update({ where: { id: c.id }, data: catData });
        }
      }
    }

    const resSup = await fetch(`${supabaseUrl}/rest/v1/Supplier?${tenantParam}&select=*`, { headers });
    if (resSup.ok) {
      const cloudSuppliers = await resSup.json();
      for (const s of cloudSuppliers) {
        const supplierData = {
          name: s.name, contactPerson: s.contactPerson, email: s.email, phone: s.phone,
          address: s.address, notes: s.notes, updatedAt: new Date(s.updatedAt)
        };
        const existingSup = await prisma.supplier.findUnique({ where: { id: s.id }, select: { updatedAt: true } });
        if (!existingSup) {
          await prisma.supplier.create({ data: { id: s.id, ...supplierData } });
        } else if (isCloudNewer(s.updatedAt, existingSup.updatedAt)) {
          await prisma.supplier.update({ where: { id: s.id }, data: supplierData });
        }
      }
    }

    const cloudProductIdToLocalId = new Map<number, number>();
    const cloudProducts = await fetchAllRows(`${supabaseUrl}/rest/v1/Product?${tenantParam}&select=*`, headers);
    if (cloudProducts) {
      for (const p of cloudProducts) {
        // Si el producto se marcó para borrar (outbox), no lo re-importemos
        // (evita que "reviva" en el mismo sync antes de que el drain lo borre).
        const { isOutboxDeletePending } = await import("./syncOutbox");
        if (await isOutboxDeletePending("Product", String(p.id))) {
          continue;
        }
        const brandExists = p.brandId ? await prisma.brand.findUnique({ where: { id: p.brandId } }) : null;
        const categoryExists = p.categoryId ? await prisma.category.findUnique({ where: { id: p.categoryId } }) : null;
        const supplierExists = p.supplierId ? await prisma.supplier.findUnique({ where: { id: p.supplierId } }) : null;

        if (!brandExists || !categoryExists) continue;

        const skuValue = p.sku ? String(p.sku) : null;

        // Multi-sucursal: si el ID de la nube no existe localmente pero ese SKU ya está
        // en otro producto local, actualizamos ESE producto en vez de crear un duplicado
        // y romper la constraint única de SKU.
        let productId = p.id;
        const existingById = await prisma.product.findUnique({ where: { id: p.id }, select: { id: true } });
        if (!existingById && skuValue) {
          const existingBySku = await prisma.product.findUnique({ where: { sku: skuValue }, select: { id: true } });
          if (existingBySku) productId = existingBySku.id;
        }
        cloudProductIdToLocalId.set(Number(p.id), Number(productId));

        // "Último escritor gana": no pisar cambios locales más recientes que la nube.
        const existingProduct = await prisma.product.findUnique({
          where: { id: productId },
          select: {
            id: true, name: true, sku: true, description: true,
            pricePurchase: true, priceSale: true, quantityStock: true,
            stockMinAlert: true, unitType: true, isPublicWeb: true,
            webCategory: true, webUnavailable: true, imageUrl: true,
            brandId: true, categoryId: true, supplierId: true,
            isRecipe: true, isIngredient: true, updatedAt: true,
          }
        });
        if (existingProduct && !isCloudNewer(p.updatedAt, existingProduct.updatedAt)) {
          const remoteUpdatedAt = new Date(p.updatedAt);
          const { hasPendingLocalChange } = await import("./syncOutbox");
          const hasLocalPendingChange = await hasPendingLocalChange("Product", String(productId));
          if (hasLocalPendingChange && remoteUpdatedAt > ctx.lastSync && existingProduct.updatedAt > ctx.lastSync) {
            await recordSyncConflict({
              entity: "Product",
              entityKey: String(productId),
              localVersion: existingProduct.updatedAt,
              remoteVersion: remoteUpdatedAt,
              localPayload: {
                ...existingProduct,
                pricePurchase: existingProduct.pricePurchase.toString(),
                priceSale: existingProduct.priceSale.toString(),
              },
              remotePayload: {
                ...p,
                pricePurchase: p.pricePurchase?.toString?.() ?? p.pricePurchase,
                priceSale: p.priceSale?.toString?.() ?? p.priceSale,
              },
            });
          }
          productIdsToRecalc.add(productId);
          continue;
        }

        try {
          await prisma.product.upsert({
            where: { id: productId },
            update: {
              name: p.name, sku: skuValue, description: p.description || null,
              pricePurchase: p.pricePurchase, priceSale: p.priceSale,
              stockMinAlert: p.stockMinAlert,
              unitType: p.unitType || null, isPublicWeb: p.isPublicWeb !== false,
              webUnavailable: p.webUnavailable === true,
              isRecipe: p.isRecipe === true, isIngredient: p.isIngredient === true,
              imageUrl: p.imageUrl || null,
              brandId: p.brandId, categoryId: p.categoryId, supplierId: supplierExists ? p.supplierId : null,
              updatedAt: new Date(p.updatedAt)
            },
            create: {
              id: productId, name: p.name, sku: skuValue, description: p.description || null,
              pricePurchase: p.pricePurchase, priceSale: p.priceSale,
              quantityStock: p.quantityStock, stockMinAlert: p.stockMinAlert,
              unitType: p.unitType || null, isPublicWeb: p.isPublicWeb !== false,
              webUnavailable: p.webUnavailable === true,
              isRecipe: p.isRecipe === true, isIngredient: p.isIngredient === true,
              imageUrl: p.imageUrl || null,
              brandId: p.brandId, categoryId: p.categoryId, supplierId: supplierExists ? p.supplierId : null,
              updatedAt: new Date(p.updatedAt)
            }
          });
        } catch (upsertErr: any) {
          if (upsertErr?.code === "P2002") {
            console.warn(`[Sync] Conflicto de SKU al pull producto ${p.id} (${p.name}). Se omite para no romper la sincronización.`);
            continue;
          }
          throw upsertErr;
        }
        productIdsToRecalc.add(productId);
      }
    }

    const cloudPBS = await fetchAllRows(`${supabaseUrl}/rest/v1/ProductBranchStock?${tenantParam}&select=*`, headers);
    if (cloudPBS) {
      console.log(`[Sync] Pulled ${cloudPBS.length} ProductBranchStock records from Supabase.`);
      let skippedPbs = 0;
      for (const bs of cloudPBS) {
        const localProductId = cloudProductIdToLocalId.get(Number(bs.productId)) ?? Number(bs.productId);
        const productExists = await prisma.product.findUnique({ where: { id: localProductId }, select: { id: true } });
        const branchExists = await prisma.branch.findUnique({ where: { id: bs.branchId }, select: { id: true } });
        if (!productExists || !branchExists) {
          skippedPbs++;
          continue;
        }
        const existingPbs = await prisma.productBranchStock.findUnique({
          where: { productId_branchId: { productId: localProductId, branchId: bs.branchId } },
          select: { productId: true, branchId: true, quantityStock: true, minStock: true, createdAt: true, updatedAt: true }
        });
        // "Último escritor gana": no pisar un stock local más reciente que la nube.
        if (existingPbs && !isCloudNewer(bs.updatedAt, existingPbs.updatedAt)) {
          const remoteUpdatedAt = new Date(bs.updatedAt);
          const { hasPendingLocalChange } = await import("./syncOutbox");
          const hasLocalPendingChange = await hasPendingLocalChange("ProductBranchStock", String(localProductId));
          if (hasLocalPendingChange && remoteUpdatedAt > ctx.lastSync && existingPbs.updatedAt > ctx.lastSync) {
            await recordSyncConflict({
              entity: "ProductBranchStock",
                entityKey: `${localProductId}:${bs.branchId}`,
              localVersion: existingPbs.updatedAt,
              remoteVersion: remoteUpdatedAt,
              localPayload: existingPbs,
              remotePayload: {
                productId: bs.productId,
                branchId: bs.branchId,
                quantityStock: bs.quantityStock,
                minStock: bs.minStock,
                createdAt: bs.createdAt,
                updatedAt: bs.updatedAt,
              },
            });
          }
          continue;
        }
        await prisma.productBranchStock.upsert({
          where: {
            productId_branchId: { productId: localProductId, branchId: bs.branchId }
          },
          update: { quantityStock: bs.quantityStock, updatedAt: new Date(bs.updatedAt) },
          create: { productId: localProductId, branchId: bs.branchId, quantityStock: bs.quantityStock, updatedAt: new Date(bs.updatedAt) }
        });
        productIdsToRecalc.add(localProductId);
      }
      if (skippedPbs > 0) console.warn(`[Sync] PBS: ${skippedPbs} filas omitidas (producto o sucursal inexistente localmente).`);
    } else {
      console.warn("[Sync] No se pudo descargar ProductBranchStock desde Supabase.");
    }

    // RecipeItem (ingredientes de elaborados): "último escritor gana" por updatedAt.
    // Si la nube no tiene la tabla (migración pendiente), se omite sin romper el sync.
    try {
      const resRI = await fetch(`${supabaseUrl}/rest/v1/RecipeItem?${tenantParam}&select=*`, { headers });
      if (resRI.ok) {
        const cloudRecipeItems = await resRI.json();
        for (const ri of cloudRecipeItems) {
          const productExists = await prisma.product.findUnique({ where: { id: ri.productId }, select: { id: true } });
          const ingredientExists = await prisma.product.findUnique({ where: { id: ri.ingredientId }, select: { id: true } });
          if (!productExists || !ingredientExists) continue;
          // Reconciliar por (productId, ingredientId), no por id: el id local es
          // autoincrement y puede diferir del id determinista de la nube. Si se
          // usara el id, cada pull crearía filas locales duplicadas del mismo
          // ingrediente (bug de duplicación en la nube y en el POS).
          const existingRi = await prisma.recipeItem.findFirst({
            where: { productId: ri.productId, ingredientId: ri.ingredientId },
            select: { id: true },
          });
          if (existingRi) {
            await prisma.recipeItem.update({
              where: { id: existingRi.id },
              data: {
                quantity: ri.quantity, unitType: ri.unitType || "UNIT",
              },
            });
          } else {
            await prisma.recipeItem.create({
              data: {
                productId: ri.productId, ingredientId: ri.ingredientId,
                quantity: ri.quantity, unitType: ri.unitType || "UNIT",
              },
            });
          }
        }
        // Limpiar items locales de productos que ya no son receta en la nube
        // (evita que queden ingredientes huérfanos tras borrar una receta).
        // IMPORTANTE: solo se borra si el producto YA NO es receta en la nube Y
        // tampoco lo es localmente. Esto evita que, cuando la nube aún no tiene
        // RecipeItem (migración recién aplicada / primera subida), un PULL borre
        // por accidente los ingredientes locales de recetas en uso.
        const localRecipeIds = (await prisma.recipeItem.findMany({ select: { productId: true } })).map(r => r.productId);
        const cloudRecipeProducts = new Set(cloudRecipeItems.map((r: any) => r.productId));
        const localProducts = await prisma.product.findMany({
          where: { id: { in: [...new Set(localRecipeIds)] } },
          select: { id: true, isRecipe: true },
        });
        const localRecipeProductIds = new Set(localProducts.filter(p => p.isRecipe).map(p => p.id));
        const staleProducts = [...new Set(localRecipeIds)].filter(
          id => !cloudRecipeProducts.has(id) && !localRecipeProductIds.has(id),
        );
        if (staleProducts.length > 0) {
          await prisma.recipeItem.deleteMany({ where: { productId: { in: staleProducts } } });
        }
      } else if (resRI.status !== 404 && resRI.status !== 400) {
        console.warn(`[Sync] No se pudo descargar RecipeItem desde Supabase (${resRI.status}).`);
      }
    } catch (riErr) {
      console.warn("[Sync] Error al descargar RecipeItem desde Supabase:", riErr);
    }

    // Traspasos de stock: se descargan para que el destino vea los pedidos
    // SENT y el emisor vea la respuesta (COMPLETED/REJECTED/CANCELLED).
    try {
      const resST = await fetch(`${supabaseUrl}/rest/v1/StockTransfer?${tenantParam}&select=*`, { headers });
      if (resST.ok) {
        const cloudTransfers = await resST.json();
        for (const st of cloudTransfers) {
          const branchExists = await prisma.branch.findUnique({ where: { id: st.sourceBranchId }, select: { id: true } })
            && await prisma.branch.findUnique({ where: { id: st.targetBranchId }, select: { id: true } });
          if (!branchExists) continue;
          await prisma.stockTransfer.upsert({
            where: { id: st.id },
            update: {
              sourceBranchId: st.sourceBranchId, targetBranchId: st.targetBranchId,
              status: st.status, notes: st.notes || null, createdByName: st.createdByName || null,
            },
            create: {
              id: st.id, sourceBranchId: st.sourceBranchId, targetBranchId: st.targetBranchId,
              status: st.status, notes: st.notes || null, createdByName: st.createdByName || null,
              createdAt: new Date(st.createdAt),
            },
          });
        }
      }

      const resSTI = await fetch(`${supabaseUrl}/rest/v1/StockTransferItem?${tenantParam}&select=*`, { headers });
      if (resSTI.ok) {
        const cloudItems = await resSTI.json();
        for (const sti of cloudItems) {
          const transferExists = await prisma.stockTransfer.findUnique({ where: { id: sti.transferId }, select: { id: true } });
          if (!transferExists) continue;
          await prisma.stockTransferItem.upsert({
            where: {
              transferId_productId: { transferId: sti.transferId, productId: sti.productId },
            },
            update: { productName: sti.productName || null, quantity: sti.quantity, receivedQuantity: sti.receivedQuantity ?? null },
            create: {
              transferId: sti.transferId, productId: sti.productId,
              productName: sti.productName || null, quantity: sti.quantity, receivedQuantity: sti.receivedQuantity ?? null,
            },
          });
        }
      }
    } catch (stErr) {
      console.warn("[Sync] Error al descargar StockTransfer desde Supabase:", stErr);
    }

    // Combos y Promociones: se descargan para mantener consistencia multi-dispositivo
    // y para que el push posterior re-emita los datos con items/conditions embebidos
    // (lo que la tienda web lee directamente).
    try {
      const resCombo = await fetch(`${supabaseUrl}/rest/v1/Combo?${tenantParam}&select=*`, { headers });
      if (resCombo.ok) {
        const cloudCombos = await resCombo.json();
        for (const co of cloudCombos) {
          // Si el combo se marcó para borrar (outbox), no lo re-importemos.
          const { isOutboxDeletePending } = await import("./syncOutbox");
          if (await isOutboxDeletePending("Combo", String(co.id))) {
            continue;
          }
          const existingCombo = await prisma.combo.findUnique({ where: { id: co.id }, select: { updatedAt: true } });
          if (existingCombo && !isCloudNewer(co.updatedAt, existingCombo.updatedAt)) {
            continue;
          }
          await prisma.combo.upsert({
            where: { id: co.id },
            update: {
              name: co.name, description: co.description || null,
              price: co.price, active: co.active !== false,
              imageUrl: co.imageUrl || null, updatedAt: new Date(co.updatedAt),
            },
            create: {
              id: co.id, name: co.name, description: co.description || null,
              price: co.price, active: co.active !== false,
              imageUrl: co.imageUrl || null, createdAt: new Date(co.createdAt), updatedAt: new Date(co.updatedAt),
            },
          });
        }
      }

      const resComboItem = await fetch(`${supabaseUrl}/rest/v1/ComboItem?${tenantParam}&select=*`, { headers });
      if (resComboItem.ok) {
        const cloudComboItems = await resComboItem.json();
        for (const ci of cloudComboItems) {
          const comboExists = await prisma.combo.findUnique({ where: { id: ci.comboId }, select: { id: true } });
          const productExists = await prisma.product.findUnique({ where: { id: ci.productId }, select: { id: true } });
          if (!comboExists || !productExists) continue;
          await prisma.comboItem.upsert({
            where: { id: ci.id },
            update: { comboId: ci.comboId, productId: ci.productId, quantity: ci.quantity, customPrice: ci.customPrice ?? null },
            create: { id: ci.id, comboId: ci.comboId, productId: ci.productId, quantity: ci.quantity, customPrice: ci.customPrice ?? null },
          });
        }
      }

      const resPromo = await fetch(`${supabaseUrl}/rest/v1/Promotion?${tenantParam}&select=*`, { headers });
      if (resPromo.ok) {
        const cloudPromos = await resPromo.json();
        for (const pr of cloudPromos) {
          // Si la promoción se marcó para borrar (outbox), no la re-importemos.
          const { isOutboxDeletePending } = await import("./syncOutbox");
          if (await isOutboxDeletePending("Promotion", String(pr.id))) {
            continue;
          }
          const existingPromo = await prisma.promotion.findUnique({ where: { id: pr.id }, select: { updatedAt: true } });
          if (existingPromo && !isCloudNewer(pr.updatedAt, existingPromo.updatedAt)) {
            continue;
          }
          await prisma.promotion.upsert({
            where: { id: pr.id },
            update: {
              name: pr.name, description: pr.description || null, type: pr.type, status: pr.status || 'ACTIVE',
              discountType: pr.discountType, discountValue: pr.discountValue, minQuantity: pr.minQuantity,
              maxDiscountQty: pr.maxDiscountQty, priority: pr.priority ?? 0, imageUrl: pr.imageUrl || null,
              startDate: pr.startDate ? new Date(pr.startDate) : null, endDate: pr.endDate ? new Date(pr.endDate) : null,
              updatedAt: new Date(pr.updatedAt),
            },
            create: {
              id: pr.id, name: pr.name, description: pr.description || null, type: pr.type, status: pr.status || 'ACTIVE',
              discountType: pr.discountType, discountValue: pr.discountValue, minQuantity: pr.minQuantity,
              maxDiscountQty: pr.maxDiscountQty, priority: pr.priority ?? 0, imageUrl: pr.imageUrl || null,
              startDate: pr.startDate ? new Date(pr.startDate) : null, endDate: pr.endDate ? new Date(pr.endDate) : null,
              createdAt: new Date(pr.createdAt), updatedAt: new Date(pr.updatedAt),
            },
          });
        }
      }

      // PromotionCondition no existe como tabla en Supabase (las condiciones viajan
      // embebidas como JSON en Promotion.conditions), así que no hay pull separado.
    } catch (cpErr) {
      console.warn("[Sync] Error al descargar Combos/Promociones desde Supabase:", cpErr);
    }
  } catch (pullErr) {
    console.warn("[Sync] Error al descargar entidades desde Supabase:", pullErr);
  }
}
