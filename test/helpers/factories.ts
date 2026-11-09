// test/helpers/factories.ts
// Constructores de datos de prueba. Cada función crea SOLO lo que nombra y
// devuelve el registro de Prisma, para que el test arme el escenario exacto.
//
// Regla: los nombres únicos llevan un sufijo aleatorio porque `Product.sku`,
// `Seller.name`, `Client.email`, `DiscountCode.code` y `Category.name` son
// @unique en el schema.
import crypto from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

let seq = 0;

/** Sufijo corto y único para columnas @unique. */
export function uniq(prefix = "x"): string {
  seq += 1;
  return `${prefix}-${seq}-${crypto.randomBytes(3).toString("hex")}`;
}

export interface ProductOptions {
  name?: string;
  sku?: string | null;
  pricePurchase?: string;
  priceSale?: string;
  quantityStock?: number;
  stockMinAlert?: number | null;
  unitType?: string | null;
  isRecipe?: boolean;
  isIngredient?: boolean;
  categoryId?: number | null;
}

export async function makeCategory(db: Db, name?: string) {
  return db.category.create({ data: { name: name ?? uniq("cat") } });
}

export async function makeBrand(db: Db, name?: string) {
  return db.brand.create({ data: { name: name ?? uniq("brand") } });
}

export async function makeProduct(db: Db, options: ProductOptions = {}) {
  return db.product.create({
    data: {
      name: options.name ?? uniq("producto"),
      sku: options.sku ?? null,
      pricePurchase: options.pricePurchase ?? "0",
      priceSale: options.priceSale ?? "100",
      quantityStock: options.quantityStock ?? 0,
      stockMinAlert: options.stockMinAlert ?? null,
      unitType: options.unitType === undefined ? "UNIT" : options.unitType,
      isRecipe: options.isRecipe ?? false,
      isIngredient: options.isIngredient ?? false,
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    },
  });
}

export async function makeBranch(
  db: Db,
  options: { name?: string; isMain?: boolean } = {},
) {
  return db.branch.create({
    data: {
      name: options.name ?? uniq("sucursal"),
      isMain: options.isMain ?? false,
    },
  });
}

export async function makeSeller(db: Db, options: { name?: string } = {}) {
  return db.seller.create({ data: { name: options.name ?? uniq("vendedor") } });
}

export async function makeClient(
  db: Db,
  options: { firstName?: string; lastName?: string; email?: string | null } = {},
) {
  return db.client.create({
    data: {
      firstName: options.firstName ?? uniq("cliente"),
      lastName: options.lastName ?? "Test",
      email: options.email === undefined ? `${uniq("mail")}@test.local` : options.email,
    },
  });
}

/** Fila de stock por sucursal (la verdad del stock cuando hay sucursales). */
export async function makeBranchStock(
  db: Db,
  productId: number,
  branchId: number,
  quantity: number,
) {
  return db.productBranchStock.create({
    data: { productId, branchId, quantityStock: quantity },
  });
}

export async function makeCashRegister(
  db: Db,
  options: { status?: "OPEN" | "CLOSED"; initialBalance?: string; sellerId?: number } = {},
) {
  return db.cashRegister.create({
    data: {
      status: options.status ?? "OPEN",
      initialBalance: options.initialBalance ?? "0",
      ...(options.sellerId ? { sellerId: options.sellerId } : {}),
    },
  });
}

export interface DiscountCodeOptions {
  code?: string;
  discountPercent?: string;
  discountType?: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue?: string | null;
  minPurchase?: string | null;
  maxUses?: number | null;
  currentUses?: number;
  isActive?: boolean;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

export async function makeDiscountCode(db: Db, options: DiscountCodeOptions = {}) {
  const code = options.code ?? uniq("CODE").toUpperCase();
  return db.discountCode.create({
    data: {
      code,
      discountPercent: options.discountPercent ?? options.discountValue ?? "10",
      discountType: options.discountType ?? "PERCENTAGE",
      discountValue: options.discountValue ?? null,
      minPurchase: options.minPurchase ?? "0",
      maxUses: options.maxUses ?? null,
      currentUses: options.currentUses ?? 0,
      isActive: options.isActive ?? true,
      validFrom: options.validFrom ?? null,
      validUntil: options.validUntil ?? null,
    },
  });
}

export interface PromotionOptions {
  name?: string;
  type?: string;
  status?: "ACTIVE" | "INACTIVE";
  discountType?: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue?: string;
  startDate?: Date | null;
  endDate?: Date | null;
}

export async function makePromotion(db: Db, options: PromotionOptions = {}) {
  return db.promotion.create({
    data: {
      name: options.name ?? uniq("promo"),
      type: options.type ?? "THRESHOLD",
      status: options.status ?? "ACTIVE",
      discountType: options.discountType ?? "FIXED_AMOUNT",
      discountValue: options.discountValue ?? "50",
      startDate: options.startDate ?? null,
      endDate: options.endDate ?? null,
    },
  });
}

export async function makeRecipe(
  db: Db,
  productId: number,
  items: Array<{ ingredientId: number; quantity: number; unitType?: string }>,
) {
  await db.recipeItem.createMany({
    data: items.map((i) => ({
      productId,
      ingredientId: i.ingredientId,
      quantity: i.quantity,
      unitType: i.unitType ?? "UNIT",
    })),
  });
}

export async function makeSupplier(db: Db, name?: string) {
  return db.supplier.create({ data: { name: name ?? uniq("proveedor") } });
}

/** Compra con sus ítems (el costo de un ingrediente puede venir de acá). */
export async function makePurchase(
  db: Db,
  input: {
    supplierId: number;
    status?: "PENDING" | "ORDERED" | "RECEIVED" | "CANCELLED";
    paymentType?: "CASH" | "TRANSFER" | "CARD" | "QR" | "OTHER" | "ON_ACCOUNT" | "MERCADO_PAGO";
    purchaseDate?: Date;
    items: Array<{
      productId: number;
      quantity: number;
      purchasePrice: string;
      quantityReceived?: number | null;
    }>;
  },
) {
  const total = input.items.reduce(
    (acc, i) => acc + Number(i.purchasePrice) * i.quantity,
    0,
  );
  return db.purchase.create({
    data: {
      supplierId: input.supplierId,
      totalAmount: String(total),
      status: input.status ?? "RECEIVED",
      ...(input.paymentType ? { paymentType: input.paymentType } : {}),
      ...(input.purchaseDate ? { purchaseDate: input.purchaseDate } : {}),
      items: {
        create: input.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          purchasePrice: i.purchasePrice,
          ...(i.quantityReceived === undefined ? {} : { quantityReceived: i.quantityReceived }),
        })),
      },
    },
  });
}

/** Movimiento de caja suelto (para probar el cierre sin pasar por una venta). */
export async function makeCashMovement(
  db: Db,
  cashRegisterId: number,
  options: {
    type?: string;
    paymentType?: string | null;
    amount?: string;
    sourceId?: number | null;
    description?: string | null;
  } = {},
) {
  return db.cashMovement.create({
    data: {
      cashRegisterId,
      type: options.type ?? "SALE",
      paymentType: options.paymentType === undefined ? "CASH" : options.paymentType,
      amount: options.amount ?? "0",
      sourceId: options.sourceId ?? null,
      description: options.description ?? null,
    },
  });
}

export async function makeExpense(
  db: Db,
  options: {
    description?: string;
    amount?: string;
    category?: string;
    paymentType?: "CASH" | "TRANSFER" | "CARD" | "QR" | "OTHER" | "ON_ACCOUNT" | "MERCADO_PAGO";
  } = {},
) {
  return db.expense.create({
    data: {
      description: options.description ?? uniq("gasto"),
      amount: options.amount ?? "0",
      category: options.category ?? "Mercadería",
      paymentType: options.paymentType ?? "CASH",
    },
  });
}

/** Traspaso entre sucursales ya creado (para probar respond/cancel). */
export async function makeStockTransfer(
  db: Db,
  input: {
    sourceBranchId: number;
    targetBranchId: number;
    status?: "SENT" | "PROCESSING" | "COMPLETED" | "REJECTED" | "CANCELLED";
    items: Array<{
      productId: number;
      quantity: number;
      productName?: string | null;
      receivedQuantity?: number | null;
    }>;
  },
) {
  return db.stockTransfer.create({
    data: {
      sourceBranchId: input.sourceBranchId,
      targetBranchId: input.targetBranchId,
      status: input.status ?? "SENT",
      items: {
        create: input.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          productName: i.productName ?? null,
          ...(i.receivedQuantity === undefined ? {} : { receivedQuantity: i.receivedQuantity }),
        })),
      },
    },
    include: { items: true },
  });
}

/** Escribe una Setting del negocio (plan, sucursal del equipo, etc.). */
export async function setSetting(db: Db, key: string, value: string) {
  return db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/** Venta mínima para tests que solo necesitan que exista una Sale. */
export async function makeSale(
  db: Db,
  input: {
    sellerId: number;
    totalAmount?: string;
    paymentType?: "CASH" | "TRANSFER" | "CARD" | "QR" | "OTHER" | "ON_ACCOUNT" | "MERCADO_PAGO";
    clientId?: number;
    branchId?: number;
    status?: "COMPLETED" | "PENDING" | "CANCELLED";
  },
) {
  return db.sale.create({
    data: {
      sellerId: input.sellerId,
      totalAmount: input.totalAmount ?? "100",
      paymentType: input.paymentType ?? "CASH",
      status: input.status ?? "COMPLETED",
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.branchId ? { branchId: input.branchId } : {}),
    },
  });
}
