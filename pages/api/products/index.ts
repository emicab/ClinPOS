// pages/api/products/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/prisma';
import { Prisma } from '@prisma/client';
type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;
import { handleApiError } from '../../../lib/apiErrorHandler';
import { sanitizeString } from '../../../lib/sanitize';
import { resolveDbForRequest } from '../../../lib/requestDb';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    const { search, brandId, categoryId, supplierId, publicOnly, isPublicWeb, kind } = req.query;

    const whereClause: Prisma.ProductWhereInput = {};

    // Filtro por tipo: products (default, excluye ingredientes) | ingredients | all
    const kindValue = String(kind || 'products');
    if (kindValue === 'ingredients') {
      whereClause.isIngredient = true;
    } else if (kindValue === 'products') {
      whereClause.isIngredient = false;
    }
    // 'all' no agrega filtro

    // Filtro por visibilidad en la Tienda Web
    if (publicOnly === 'true' || isPublicWeb === 'true') {
      whereClause.isPublicWeb = true;
    }

    // Filtro por ID de Marca
    if (brandId && typeof brandId === 'string' && brandId !== '') {
        const parsedBrandId = parseInt(brandId);
        if (!isNaN(parsedBrandId)) {
            whereClause.brandId = parsedBrandId;
        }
    }

    // Filtro por ID de Categoría
    if (categoryId && typeof categoryId === 'string' && categoryId !== '') {
        const parsedCategoryId = parseInt(categoryId);
        if (!isNaN(parsedCategoryId)) {
            whereClause.categoryId = parsedCategoryId;
        }
    }

    // Filtro por ID de Proveedor
    if (supplierId && typeof supplierId === 'string' && supplierId !== '') {
        const parsedSupplierId = parseInt(supplierId);
        if (!isNaN(parsedSupplierId)) {
            whereClause.supplierId = parsedSupplierId;
        }
    }

    // Filtro por Sucursal (branchId). Inclusivo: los productos SIN filas de
    // stock (legados / globales) aparecen en toda sucursal. El autocurado de
    // filas faltantes ocurre más abajo, tras el fetch.
    const { branchId } = req.query;
    let parsedBranchId: number | null = null;
    if (branchId && typeof branchId === 'string' && branchId !== '') {
        const n = parseInt(branchId);
        if (!isNaN(n)) parsedBranchId = n;
    }
    if (parsedBranchId !== null) {
        whereClause.OR = [
          { branchStocks: { some: { branchId: parsedBranchId } } },
          { branchStocks: { none: {} } },
        ];
    }

    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string) || 50, 5000) : 50;

    try {
      const db = await resolveDbForRequest(req);
      // Sucursal inexistente → 400 explícito en vez de lista vacía confusa.
      // Se trae isMain para el backfill: solo la Principal hereda el stock
      // global; las demás arrancan en 0 (el físico vive en la Principal).
      let branchIsMain = false;
      if (parsedBranchId !== null) {
        const branch = await db.branch.findUnique({
          where: { id: parsedBranchId },
          select: { id: true, isMain: true },
        });
        if (!branch) {
          return res.status(400).json({ message: 'La sucursal indicada no existe.' });
        }
        branchIsMain = branch.isMain === true;
      }
      // 1. Obtener productos aplicando filtros base (marca, categoría, proveedor)
      let products: any[] = await db.product.findMany({
        where: whereClause,
        include: {
          brand: true,
          category: true,
          supplier: true,
          branchStocks: {
            include: {
              branch: true,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
      });

      // Calcular stock reservado (pedidos pendientes)
      const pendingWhere: any = { sale: { status: 'PENDING' } };
      const pendingSalesAggregate = await db.saleItem.groupBy({
        by: ['productId'],
        _sum: { quantity: true },
        where: pendingWhere
      });
      const reservedMap = new Map();
      pendingSalesAggregate.forEach(agg => reservedMap.set(agg.productId, agg._sum?.quantity || 0));

      products = products.map(p => ({
         ...p,
         reservedQuantity: reservedMap.get(p.id) || 0
      }));

      // Stock derivado para productos elaborados (Recetario): se calcula a
      // partir del stock de sus ingredientes, respetando la sucursal activa.
      // Se exponen además los ingredientes limitantes (recipeAvailability) para
      // que la UI aclare que el número es "por tipo" y compartido entre variantes.
      const recipeIds = products.filter((p: any) => p.isRecipe).map((p: any) => p.id);
      if (recipeIds.length > 0) {
        const branchIdParam = req.query.branchId as string | undefined;
        const branchId = branchIdParam && !isNaN(parseInt(branchIdParam))
          ? parseInt(branchIdParam)
          : null;
        const { getRecipeAvailability } = await import("../../../lib/recipeStock");
        const { formatQuantity } = await import("../../../lib/recipeUnits");
        const derivedMap = new Map<number, number>();
        const availabilityMap = new Map<number, any>();
        for (const rid of recipeIds) {
          try {
            const av = await getRecipeAvailability(db, rid, branchId);
            derivedMap.set(rid, av.available);
            availabilityMap.set(rid, {
              available: av.available,
              limiting: (av.limiting || []).map((l) => ({
                ingredientId: l.ingredientId,
                name: l.name,
                available: l.available,
                availableDisplay: formatQuantity(l.available, l.unitType),
              })),
            });
          } catch {
            derivedMap.set(rid, 0);
          }
        }
        const derivedProducts: any[] = [];
        for (const p of products) {
          if (!p.isRecipe) {
            derivedProducts.push(p);
            continue;
          }
          // Sobrescribir el stock por sucursal con el valor derivado (la UI
          // lee branchStocks cuando filtra por sucursal). El quantityStock
          // global también queda derivado según la sucursal activa.
          let branchStocks = p.branchStocks;
          if (Array.isArray(branchStocks)) {
            branchStocks = await Promise.all(
              branchStocks.map(async (bs: any) => {
                try {
                  const derived = await getRecipeAvailability(db, p.id, bs.branchId);
                  return { ...bs, quantityStock: derived.available };
                } catch {
                  return bs;
                }
              }),
            );
          }
          derivedProducts.push({
            ...p,
            quantityStock: derivedMap.get(p.id) ?? 0,
            branchStocks,
            recipeAvailability: availabilityMap.get(p.id) || { available: 0, limiting: [] },
          });
        }
        products = derivedProducts;
      }

      // Autocurado: crear las filas de stock faltantes para la sucursal
      // pedida. La Principal hereda el stock global; las demás arrancan en 0
      // (si no, el global —que es suma de filas— se duplicaría). Idempotente.
      if (parsedBranchId !== null) {
        const missing = products.filter((p: any) =>
          !(p.branchStocks || []).some((bs: any) => bs.branchId === parsedBranchId),
        );
        if (missing.length > 0) {
          try {
            // Sin skipDuplicates (no existe en SQLite): `missing` ya viene
            // filtrado en memoria, y la carrera residual cae en el catch.
            await db.productBranchStock.createMany({
              data: missing.map((p: any) => ({
                productId: p.id,
                branchId: parsedBranchId as number,
                quantityStock: branchIsMain ? Number(p.quantityStock) || 0 : 0,
              })),
            });
            const rows = await db.productBranchStock.findMany({
              where: {
                branchId: parsedBranchId,
                productId: { in: missing.map((p: any) => p.id) },
              },
            });
            const rowByProduct = new Map(rows.map((r: any) => [r.productId, r]));
            products = products.map((p: any) =>
              rowByProduct.has(p.id)
                ? { ...p, branchStocks: [...(p.branchStocks || []), rowByProduct.get(p.id)] }
                : p,
            );
          } catch (e) {
            console.warn('[Products] backfill de stock por sucursal falló:', e);
          }
        }
      }

      // Helper para normalizar texto (pasar a minúsculas y remover acentos/diacríticos)
      const normalizeText = (text: string) => {
        return text
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      };

      // 2. Filtrar en memoria por búsqueda de texto de forma totalmente insensible
      if (search && typeof search === 'string' && search.trim() !== '') {
        const queryNormalized = normalizeText(search);
        products = products.filter(p => {
          const nameNormalized = normalizeText(p.name);
          const skuNormalized = normalizeText(p.sku || '');
          return nameNormalized.includes(queryNormalized) || skuNormalized.includes(queryNormalized);
        });
      }

      const total = products.length;

      // 3. Paginación en memoria si corresponde
      if (page !== undefined) {
        const skip = (page - 1) * limit;
        products = products.slice(skip, skip + limit);
        
        res.status(200).json({
          data: products,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          }
        });
      } else {
        res.status(200).json(products);
      }
    } catch (error) {
      handleApiError(res, error, "fetching products");
    }
  } else if (req.method === 'POST') {
    const {
        pricePurchase, priceSale, quantityStock, stockMinAlert,
        brandId, categoryId, supplierId, unitType, imageUrl, isRecipe, recipeItems, isIngredient
    } = req.body;
    let {
        name, sku, description
    } = req.body;

    const isRecipeProduct = isRecipe === true || isRecipe === 'true';
    const isIngredientProduct = isIngredient === true || isIngredient === 'true';

    if (isRecipeProduct && isIngredientProduct) {
        return res.status(400).json({ message: 'Un producto no puede ser elaborado e ingrediente a la vez.' });
    }

    // --- Validación de los datos de entrada ---
    if (!name) {
        return res.status(400).json({ message: 'El nombre es obligatorio.' });
    }
    if (quantityStock === undefined || isNaN(parseFloat(quantityStock))) {
        return res.status(400).json({ message: 'El stock inicial es obligatorio.' });
    }
    // El precio de venta no aplica a ingredientes (se fuerzan a 0 y quedan ocultos).
    if (!isIngredientProduct && priceSale === undefined) {
        return res.status(400).json({ message: 'El precio de venta es obligatorio.' });
    }
    // La categoría aplica a productos vendibles (simples y elaborados); los
    // ingredientes no la usan. La marca es opcional para todos.
    if (!isIngredientProduct && !categoryId) {
        return res.status(400).json({ message: 'La categoría es obligatoria.' });
    }

    // Validar y convertir los campos numéricos antes de usarlos
    const priceSaleNum = isIngredientProduct ? 0 : parseFloat(priceSale);
    const quantityStockNum = parseFloat(quantityStock);
    const brandIdInt = brandId ? parseInt(brandId) : NaN;
    const categoryIdInt = isIngredientProduct ? NaN : parseInt(categoryId);

    if (isNaN(priceSaleNum) || isNaN(quantityStockNum)) {
        return res.status(400).json({ message: 'Precio de Venta o Stock tienen un formato numérico inválido.' });
    }
    if (!isIngredientProduct && brandId && isNaN(brandIdInt)) {
        return res.status(400).json({ message: 'La marca tiene un formato inválido.' });
    }
    if (!isIngredientProduct && isNaN(categoryIdInt)) {
        return res.status(400).json({ message: 'La categoría tiene un formato inválido.' });
    }

    // Validar el precio de compra opcional
    let pricePurchaseDecimal: Decimal | null = null;
    if (pricePurchase !== undefined && pricePurchase !== null && pricePurchase !== '') {
        const pricePurchaseNum = parseFloat(pricePurchase);
        if (isNaN(pricePurchaseNum)) {
             return res.status(400).json({ message: 'El Precio de Compra tiene un formato numérico inválido.' });
        }
        pricePurchaseDecimal = new Decimal(pricePurchaseNum);
    }

    name = sanitizeString(name);
    if (sku) sku = sanitizeString(sku);
    if (description) description = sanitizeString(description);

    // Validar unitType
    const validUnitTypes = [null, 'UNIT', 'WEIGHT', 'VOLUME'];
    const resolvedUnitType = validUnitTypes.includes(unitType) ? (unitType || null) : null;

    try {
      // Determinar la sucursal para asignar el stock inicial
      let targetBranchId: number | null = req.body.branchId ? parseInt(req.body.branchId) : null;
      if (!targetBranchId || isNaN(targetBranchId)) {
        const mainBranch = await prisma.branch.findFirst({ where: { isMain: true } });
        targetBranchId = mainBranch?.id || null;
      }

      const newProduct = await prisma.product.create({
        data: {
          name: name.trim(),
          sku: sku ? sku.trim() : null,
          description: description ? description.trim() : null,
          imageUrl: imageUrl ? imageUrl.trim() : null,
          pricePurchase: pricePurchaseDecimal || new Decimal(0),
          priceSale: new Decimal(priceSaleNum),
          quantityStock: isRecipeProduct ? 0 : quantityStockNum,
          stockMinAlert: stockMinAlert ? parseFloat(stockMinAlert) : null,
          unitType: resolvedUnitType,
          // Default oculto: nada se publica en la tienda web sin decisión explícita.
          // Los ingredientes nunca se publican.
          isPublicWeb: isIngredientProduct ? false : (req.body.isPublicWeb === true || req.body.isPublicWeb === 'true'),
          webCategory: req.body.webCategory ? String(req.body.webCategory).trim() : null,
          isRecipe: isRecipeProduct,
          isIngredient: isIngredientProduct,
          ...(!isIngredientProduct && !isNaN(brandIdInt) ? { brand: { connect: { id: brandIdInt } } } : {}),
          ...(!isIngredientProduct && !isNaN(categoryIdInt) ? { category: { connect: { id: categoryIdInt } } } : {}),
          ...(supplierId ? { supplier: { connect: { id: parseInt(supplierId) } } } : {}),
        },
        include: {
            brand: true,
            category: true,
            supplier: true,
        }
      });

      // Stock inicial por sucursal (los elaborados no tienen stock físico propio).
      if (targetBranchId && !isRecipeProduct) {
        await prisma.productBranchStock.upsert({
          where: { productId_branchId: { productId: newProduct.id, branchId: targetBranchId } },
          update: { quantityStock: quantityStockNum },
          create: { productId: newProduct.id, branchId: targetBranchId, quantityStock: quantityStockNum },
        });
      }

      // Guardar los ingredientes de la receta de forma atómica con el producto.
      if (isRecipeProduct && Array.isArray(recipeItems) && recipeItems.length > 0) {
        const { replaceRecipeItems, recordCostSnapshot } = await import("../../../lib/recipeStock");
        await replaceRecipeItems(prisma, newProduct.id, recipeItems);
        await recordCostSnapshot(prisma, newProduct.id, "recipe_save");
      }
      // Fire-and-forget: encolar la creación en el outbox. El sync real lo sube
      // (auto-sync periódico / manual), sin bloquear la respuesta.
      try {
        const { enqueueOutbox } = await import("../../../lib/syncOutbox");
        await enqueueOutbox("Product", "UPSERT", String(newProduct.id));
        if (targetBranchId && !isRecipeProduct) {
          await enqueueOutbox("ProductBranchStock", "UPSERT", String(newProduct.id));
        }
      } catch (enqErr) {
        console.error("[Products] Error al encolar producto en outbox:", enqErr);
      }

      res.status(201).json(newProduct);
    } catch (error: unknown) {
      handleApiError(res, error, "creating product");
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}