// lib/productFilters.ts
// Criterio de selección de las acciones masivas con "seleccionar todas las
// páginas". Debe coincidir con lo que el usuario ve en la lista (GET
// /api/products): búsqueda sin tildes ni mayúsculas y sin los ingredientes
// ocultos del Recetario. Con `contains` de SQLite la búsqueda no ignoraba
// tildes y una acción masiva podía afectar productos distintos a los visibles.
import type { Prisma } from '@prisma/client';
import prisma from './prisma';

type Db = typeof prisma;

export interface BulkProductFilters {
  search?: string;
  brandId?: number | string;
  categoryId?: number | string;
  supplierId?: number | string;
  kind?: 'products' | 'ingredients' | 'all';
}

export function normalizeSearchText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export async function buildBulkProductWhere(
  db: Db,
  filters?: BulkProductFilters | null,
): Promise<Prisma.ProductWhereInput> {
  const where: Prisma.ProductWhereInput = {};

  const kind = filters?.kind ?? 'products';
  if (kind === 'ingredients') where.isIngredient = true;
  else if (kind === 'products') where.isIngredient = false;

  if (filters?.brandId) where.brandId = Number(filters.brandId);
  if (filters?.categoryId) where.categoryId = Number(filters.categoryId);
  if (filters?.supplierId) where.supplierId = Number(filters.supplierId);

  const search = typeof filters?.search === 'string' ? filters.search.trim() : '';
  if (search) {
    const query = normalizeSearchText(search);
    const candidates = await db.product.findMany({
      where,
      select: { id: true, name: true, sku: true },
    });
    const ids = candidates
      .filter(
        (p) =>
          normalizeSearchText(p.name).includes(query) ||
          normalizeSearchText(p.sku || '').includes(query),
      )
      .map((p) => p.id);
    return { id: { in: ids } };
  }

  return where;
}
