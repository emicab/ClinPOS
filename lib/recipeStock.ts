// Lógica central del Recetario: expansión de recetas, stock derivado y
// descuento/reposición de ingredientes. Funciona con prisma o con un
// cliente de transacción (tx) para garantizar atomicidad en las ventas.

import { Prisma, PrismaClient } from "@prisma/client";
import { formatQuantity } from "./recipeUnits";

type DB = PrismaClient | Prisma.TransactionClient;

const Decimal = Prisma.Decimal;

export const MAX_RECIPE_DEPTH = 10;

export interface RecipeLeaf {
  productId: number;
  name: string;
  unitType: string | null;
  quantity: number; // total acumulado en unidad canónica (kg/L/u)
  isRecipe: boolean;
}

interface ExpansionContext {
  db: DB;
  productCache: Map<number, any>;
  recipeItemsCache: Map<number, any[]>;
}

async function getProduct(ctx: ExpansionContext, id: number): Promise<any | null> {
  let p = ctx.productCache.get(id);
  if (!p) {
    p = await ctx.db.product.findUnique({ where: { id } });
    if (p) ctx.productCache.set(id, p);
  }
  return p;
}

async function getRecipeItems(ctx: ExpansionContext, productId: number): Promise<any[]> {
  let items = ctx.recipeItemsCache.get(productId);
  if (!items) {
    items = await ctx.db.recipeItem.findMany({
      where: { productId },
      include: { ingredient: true },
    });
    ctx.recipeItemsCache.set(productId, items);
  }
  return items;
}

async function expandInternal(
  ctx: ExpansionContext,
  productId: number,
  qty: number,
  accumulated: Map<number, RecipeLeaf>,
  path: Set<number>,
): Promise<void> {
  if (path.has(productId)) {
    throw new Error("Ciclo detectado en las recetas: un producto elaborado no puede depender de sí mismo.");
  }
  if (path.size > MAX_RECIPE_DEPTH) {
    throw new Error("La receta supera la profundidad máxima permitida.");
  }

  const items = await getRecipeItems(ctx, productId);
  if (items.length === 0) {
    const product = await getProduct(ctx, productId);
    if (!product) throw new Error(`Ingrediente con ID ${productId} no encontrado.`);
    const existing = accumulated.get(productId);
    if (existing) {
      existing.quantity += qty;
    } else {
      accumulated.set(productId, {
        productId,
        name: product.name,
        unitType: product.unitType,
        quantity: qty,
        isRecipe: !!product.isRecipe,
      });
    }
    return;
  }

  path.add(productId);
  for (const item of items) {
    await expandInternal(ctx, item.ingredientId, qty * item.quantity, accumulated, path);
  }
  path.delete(productId);
}

/**
 * Expande un producto (y su cantidad) a sus ingredientes "hoja" (sin receta),
 * acumulando cantidades si un ingrediente aparece por más de un camino.
 * Un producto sin receta se devuelve como hoja con su propia cantidad.
 */
export async function expandRecipeToLeaves(
  db: DB,
  productId: number,
  qty: number,
): Promise<RecipeLeaf[]> {
  const ctx: ExpansionContext = {
    db,
    productCache: new Map(),
    recipeItemsCache: new Map(),
  };
  const accumulated = new Map<number, RecipeLeaf>();
  await expandInternal(ctx, productId, qty, accumulated, new Set<number>());
  return [...accumulated.values()];
}

/**
 * Stock disponible de un ingrediente hoja, con la misma semántica que el POS:
 * si hay sucursal activa y existe registro, usa el stock de sucursal; si no,
 * cae al stock global.
 */
async function getLeafStock(
  db: DB,
  productId: number,
  branchId?: number | null,
): Promise<number> {
  if (branchId) {
    const bs = await db.productBranchStock.findUnique({
      where: { productId_branchId: { productId, branchId } },
      select: { quantityStock: true },
    });
    if (bs) return Number(bs.quantityStock) || 0;
  }
  const p = await db.product.findUnique({
    where: { id: productId },
    select: { quantityStock: true },
  });
  return p ? Number(p.quantityStock) || 0 : 0;
}

export interface RecipeAvailability {
  available: number; // cuántos se pueden preparar con el stock actual
  limiting: {
    ingredientId: number;
    name: string;
    required: number;
    available: number;
    unitType: string | null;
  }[];
}

/**
 * Disponibilidad de un producto elaborado: cuántas unidades se pueden preparar
 * y qué ingredientes lo limitan. Recursivo (soporta recetas anidadas).
 */
export async function getRecipeAvailability(
  db: DB,
  productId: number,
  branchId?: number | null,
  _path: Set<number> = new Set(),
): Promise<RecipeAvailability> {
  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product || !product.isRecipe) {
    const stock = await getLeafStock(db, productId, branchId);
    return { available: stock, limiting: [] };
  }

  if (_path.has(productId)) {
    throw new Error("Ciclo detectado en las recetas.");
  }
  _path = new Set(_path);
  _path.add(productId);

  const items = await db.recipeItem.findMany({
    where: { productId },
    include: {
      ingredient: { select: { id: true, name: true, unitType: true, isRecipe: true } },
    },
  });

  if (items.length === 0) return { available: 0, limiting: [] };

  let min = Infinity;
  const limiting: RecipeAvailability["limiting"] = [];

  for (const item of items) {
    let avail: number;
    if (item.ingredient.isRecipe) {
      const sub = await getRecipeAvailability(db, item.ingredientId, branchId, _path);
      avail = sub.available;
    } else {
      avail = await getLeafStock(db, item.ingredientId, branchId);
    }

    // Se redondea a enteros (micro-unidades) antes de dividir: multiplicar ambos
    // lados por la misma escala no evitaba el error de punto flotante
    // (0.9 / 0.3 daba 2.9999... y el floor devolvia 2). Ingredientes con
    // cantidad 0 no limitan.
    const needed = Math.round(item.quantity * 1e6);
    const possible = needed > 0 ? Math.floor(Math.round(avail * 1e6) / needed) : Infinity;

    if (possible < min) {
      min = possible;
      limiting.length = 0;
      limiting.push({
        ingredientId: item.ingredient.id,
        name: item.ingredient.name,
        required: item.quantity,
        available: avail,
        unitType: item.ingredient.unitType,
      });
    } else if (possible === min) {
      limiting.push({
        ingredientId: item.ingredient.id,
        name: item.ingredient.name,
        required: item.quantity,
        available: avail,
        unitType: item.ingredient.unitType,
      });
    }
  }

  return { available: Math.max(0, min === Infinity ? 0 : min), limiting };
}

/** Stock derivado: cuántas unidades del elaborado se pueden preparar hoy. */
export async function computeDerivedStock(
  db: DB,
  productId: number,
  branchId?: number | null,
): Promise<number> {
  const res = await getRecipeAvailability(db, productId, branchId);
  return res.available;
}

export interface IngredientShortfall {
  ingredientId: number;
  name: string;
  required: number; // total requerido (unidad canónica kg/L/u)
  available: number; // stock disponible (unidad canónica)
  shortfall: number; // max(0, required - available)
  unitType: string | null;
  requiredDisplay: string;
  availableDisplay: string;
  shortfallDisplay: string;
  usedBy: string[]; // nombres de los elaborados que lo consumen
}

/**
 * Chequeo COMBINADO de ingredientes para una orden/carrito completo. El stock
 * derivado por elaborado es correcto por tipo pero NO es sumable: dos pizzas
 * que comparten harina pueden mostrar "2 y 2" y en total solo alcanzar para 2.
 * Esta función expande todos los ítems elaborados a sus hojas, suma los
 * requerimientos por ingrediente y compara contra el stock real (sucursal o
 * global). Devuelve solo los faltantes, con unidades amigables para mensajes.
 */
export async function computeOrderIngredientShortfall(
  db: DB,
  items: { productId: number; quantity: number }[],
  branchId?: number | null,
): Promise<IngredientShortfall[]> {
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, isRecipe: true, name: true },
  });
  const productsMap = new Map<number, { isRecipe: boolean; name: string }>();
  products.forEach((p) => productsMap.set(p.id, { isRecipe: p.isRecipe === true, name: p.name }));

  const totals = new Map<
    number,
    { ingredientId: number; name: string; unitType: string | null; required: number; usedBy: Set<string> }
  >();

  for (const item of items) {
    const product = productsMap.get(item.productId);
    if (!product || !product.isRecipe) continue;
    if (!(item.quantity > 0)) continue;

    let leaves: RecipeLeaf[];
    try {
      leaves = await expandRecipeToLeaves(db, item.productId, item.quantity);
    } catch (err) {
      // Un elaborado no expandible (ej. ciclo de receta) no debe tumbar el chequeo.
      console.warn("[recipeStock] No se pudo expandir elaborado", item.productId, err);
      continue;
    }

    for (const leaf of leaves) {
      const entry = totals.get(leaf.productId);
      if (entry) {
        entry.required += leaf.quantity;
        entry.usedBy.add(product.name);
      } else {
        totals.set(leaf.productId, {
          ingredientId: leaf.productId,
          name: leaf.name,
          unitType: leaf.unitType,
          required: leaf.quantity,
          usedBy: new Set([product.name]),
        });
      }
    }
  }

  const shortfalls: IngredientShortfall[] = [];
  for (const t of totals.values()) {
    const available = await getLeafStock(db, t.ingredientId, branchId);
    const shortfall = Math.max(0, t.required - available);
    if (shortfall <= 0) continue;
    shortfalls.push({
      ingredientId: t.ingredientId,
      name: t.name,
      required: t.required,
      available,
      shortfall,
      unitType: t.unitType,
      requiredDisplay: formatQuantity(t.required, t.unitType),
      availableDisplay: formatQuantity(available, t.unitType),
      shortfallDisplay: formatQuantity(shortfall, t.unitType),
      usedBy: [...t.usedBy],
    });
  }
  return shortfalls;
}

/**
 * Mensaje legible de un faltante combinado, ej:
 * "Harina: faltan 0,2 kg (hay 1 kg, necesitás 1,2 kg) — consumida por Pizza A y Pizza B".
 */
export function formatIngredientShortfall(s: IngredientShortfall): string {
  const usedBy = s.usedBy.length > 0 ? ` — consumida por ${s.usedBy.join(" y ")}` : "";
  return `${s.name}: faltan ${s.shortfallDisplay} (hay ${s.availableDisplay}, necesitás ${s.requiredDisplay})${usedBy}`;
}

/**
 * Descuenta el stock de los ingredientes de un producto elaborado (global +
 * sucursal), validando disponibilidad con un mensaje claro. No toca el stock
 * del producto elaborado (no tiene stock físico propio).
 */
export async function deductRecipeStock(
  db: DB,
  productId: number,
  qty: number,
  branchId?: number | null,
): Promise<number[]> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, isRecipe: true },
  });
  if (!product) throw new Error(`Producto con ID ${productId} no encontrado.`);
  if (!product.isRecipe) {
    return [];
  }

  const leaves = await expandRecipeToLeaves(db, productId, qty);
  const affected: number[] = [];
  for (const leaf of leaves) {
    const ing = await db.product.findUnique({
      where: { id: leaf.productId },
      select: { name: true, quantityStock: true, unitType: true },
    });
    if (!ing) throw new Error(`Ingrediente con ID ${leaf.productId} no encontrado.`);

    const available = await getLeafStock(db, leaf.productId, branchId);
    if (available < leaf.quantity) {
      throw new Error(
        `Stock insuficiente del ingrediente "${ing.name}" para preparar "${product.name}". Disponible: ${available}, Requerido: ${leaf.quantity}.`,
      );
    }

    const decremented = await db.product.updateMany({
      where: { id: leaf.productId, quantityStock: { gte: leaf.quantity } },
      data: { quantityStock: { decrement: leaf.quantity } },
    });
    if (decremented.count === 0) {
      throw new Error(
        `Stock insuficiente del ingrediente "${ing.name}" para preparar "${product.name}" (el stock cambió mientras se procesaba la venta).`,
      );
    }

    if (branchId) {
      await db.productBranchStock.upsert({
        where: {
          productId_branchId: { productId: leaf.productId, branchId },
        },
        update: { quantityStock: { decrement: leaf.quantity } },
        create: { productId: leaf.productId, branchId, quantityStock: -leaf.quantity },
      });
    }
    affected.push(leaf.productId);
  }
  return affected;
}

/**
 * Restaura el stock de los ingredientes al anular/eliminar una venta.
 */
export async function restoreRecipeStock(
  db: DB,
  productId: number,
  qty: number,
  branchId?: number | null,
): Promise<number[]> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { isRecipe: true },
  });
  if (!product || !product.isRecipe) return [];

  const leaves = await expandRecipeToLeaves(db, productId, qty);
  const affected: number[] = [];
  for (const leaf of leaves) {
    await db.product.update({
      where: { id: leaf.productId },
      data: { quantityStock: { increment: leaf.quantity } },
    });
    if (branchId) {
      await db.productBranchStock.upsert({
        where: {
          productId_branchId: { productId: leaf.productId, branchId },
        },
        update: { quantityStock: { increment: leaf.quantity } },
        create: { productId: leaf.productId, branchId, quantityStock: leaf.quantity },
      });
    }
    affected.push(leaf.productId);
  }
  return affected;
}

export interface RecipeItemInput {
  ingredientId: number;
  quantity: number;
  unitType?: string | null;
}

/**
 * Reemplaza la lista de ingredientes de un producto elaborado, validando:
 * - el ingrediente existe y no es el propio producto;
 * - la cantidad es mayor a 0;
 * - la unidad es coherente con el ingrediente (se hereda si no se especifica);
 * - no se crean ciclos de recetas.
 */
export async function replaceRecipeItems(
  db: DB,
  productId: number,
  items: RecipeItemInput[],
): Promise<void> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, isRecipe: true },
  });
  if (!product) throw new Error("Producto no encontrado.");

  const normalized: { ingredientId: number; quantity: number; unitType: string }[] = [];
  const seen = new Set<number>();

  for (const item of items || []) {
    const ingredientId = Number(item.ingredientId);
    const quantity = Number(item.quantity);

    if (!ingredientId || isNaN(quantity) || quantity <= 0) {
      throw new Error("Cada ingrediente requiere una cantidad mayor a 0.");
    }
    if (ingredientId === productId) {
      throw new Error("Un producto elaborado no puede ser su propio ingrediente.");
    }
    if (seen.has(ingredientId)) continue;
    seen.add(ingredientId);

    const ingredient = await db.product.findUnique({
      where: { id: ingredientId },
      select: { id: true, unitType: true },
    });
    if (!ingredient) {
      throw new Error(`Ingrediente con ID ${ingredientId} no encontrado.`);
    }

    // La unidad se hereda del ingrediente cuando la tiene; si no, se usa UNIT.
    let unitType = "UNIT";
    if (ingredient.unitType && ["UNIT", "WEIGHT", "VOLUME"].includes(ingredient.unitType)) {
      unitType = ingredient.unitType;
    } else if (item.unitType && ["UNIT", "WEIGHT", "VOLUME"].includes(item.unitType)) {
      unitType = item.unitType;
    }

    if (await wouldCreateRecipeCycle(db, productId, ingredientId)) {
      throw new Error("Esta receta crearía un ciclo (un elaborado no puede depender de sí mismo).");
    }

    normalized.push({ ingredientId, quantity, unitType });
  }

  await db.recipeItem.deleteMany({ where: { productId } });
  if (normalized.length > 0) {
    await db.recipeItem.createMany({
      data: normalized.map((i) => ({ ...i, productId })),
    });
  }
}

/**
 * Detecta si `candidate` ya existe como dependencia (directa o transitiva) de
 * `productId` para evitar ciclos al guardar una receta.
 */
export async function wouldCreateRecipeCycle(
  db: DB,
  productId: number,
  candidate: number,
): Promise<boolean> {
  const stack = [candidate];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === productId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const items = await db.recipeItem.findMany({
      where: { productId: current },
      select: { ingredientId: true },
    });
    for (const item of items) {
      if (item.ingredientId === productId) return true;
      stack.push(item.ingredientId);
    }
  }
  return false;
}

// ── Costo y margen de elaborados ─────────────────────────────────────────────

async function getIngredientCost(
  db: DB,
  productId: number,
): Promise<{ cost: Prisma.Decimal; hasCost: boolean }> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { pricePurchase: true },
  });
  let cost: Prisma.Decimal | null = product?.pricePurchase ?? null;
  if (!cost || cost.equals(0)) {
    // Última compra RECIBIDA (no cuentan las PENDING/ORDERED todavía no recibidas).
    const last = await db.purchaseItem.findFirst({
      where: { productId, purchase: { status: "RECEIVED" } },
      orderBy: { id: "desc" },
      select: { purchasePrice: true },
    });
    if (last && !last.purchasePrice.equals(0)) cost = last.purchasePrice;
  }
  return { cost: cost || new Decimal(0), hasCost: !!cost && !cost.equals(0) };
}

export interface RecipeCost {
  cost: Prisma.Decimal; // costo por unidad del elaborado (o del ingrediente hoja)
  hasFullCost: boolean; // false si algún ingrediente no tiene costo cargado
}

/**
 * Costo de un producto elaborado por unidad = Σ (costo del ingrediente × cantidad),
 * recursivo (soporta recetas anidadas). Para un producto simple devuelve su propio costo.
 */
export async function computeRecipeCost(
  db: DB,
  productId: number,
  _path: Set<number> = new Set(),
): Promise<RecipeCost> {
  if (_path.has(productId)) {
    // Ciclo defensivo: no debería existir (se valida al guardar).
    return { cost: new Decimal(0), hasFullCost: false };
  }

  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, isRecipe: true },
  });
  if (!product) return { cost: new Decimal(0), hasFullCost: false };

  if (!product.isRecipe) {
    const { cost, hasCost } = await getIngredientCost(db, productId);
    return { cost, hasFullCost: hasCost };
  }

  const items = await db.recipeItem.findMany({
    where: { productId },
    include: { ingredient: { select: { isRecipe: true } } },
  });
  if (items.length === 0) return { cost: new Decimal(0), hasFullCost: false };

  const path = new Set(_path);
  path.add(productId);

  let total = new Decimal(0);
  let hasFullCost = true;
  for (const item of items) {
    const sub = await computeRecipeCost(db, item.ingredientId, path);
    if (!sub.hasFullCost) hasFullCost = false;
    total = total.plus(sub.cost.times(item.quantity));
  }
  return { cost: total, hasFullCost };
}

/**
 * Resuelve el cierre transitivo inverso: qué productos elaborados dependen
 * (directa o indirectamente) de los ingredientes dados. Sirve para registrar
 * snapshots de costo al recibir una compra de ingredientes.
 */
export async function findRecipesAffectedByIngredient(
  db: DB,
  ingredientIds: number[],
): Promise<number[]> {
  const affected = new Set<number>();
  let frontier = ingredientIds.filter(Boolean);
  let guard = 0;
  while (frontier.length > 0 && guard++ < 30) {
    const rows = await db.recipeItem.findMany({
      where: { ingredientId: { in: frontier } },
      select: { productId: true },
    });
    const parents = [...new Set(rows.map((r) => r.productId))].filter(
      (id) => !affected.has(id),
    );
    if (parents.length === 0) break;
    parents.forEach((id) => affected.add(id));
    frontier = parents;
  }
  return [...affected];
}

/**
 * Registra un snapshot de costo para un elaborado SOLO si el costo cambió
 * respecto del último registro (evita ruido). `source`: purchase | recipe_save | manual.
 */
export async function recordCostSnapshot(
  db: DB,
  productId: number,
  source: "purchase" | "recipe_save" | "manual",
): Promise<void> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { isRecipe: true },
  });
  if (!product?.isRecipe) return;

  const { cost, hasFullCost } = await computeRecipeCost(db, productId);

  const last = await db.recipeCostHistory.findFirst({
    where: { productId },
    orderBy: { createdAt: "desc" },
    select: { cost: true, hasFullCost: true },
  });
  if (last && last.hasFullCost === hasFullCost && last.cost.equals(cost)) {
    return;
  }

  await db.recipeCostHistory.create({
    data: { productId, cost, hasFullCost, source },
  });
}
