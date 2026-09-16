import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export async function POST(req: Request) {
  const normalizeName = (s: unknown) =>
    typeof s === 'string'
      ? s
          .trim()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
      : '';

  // Búsqueda insensible a mayúsculas/tildes/espacios (SQLite no soporta
  // mode:'insensitive' en Prisma): primero intento exacto, luego fallback
  // comparando normalizado en memoria para no crear duplicados.
  const findByNameInsensitive = async (
    model: { findFirst: (args: any) => Promise<any>; findMany: (args?: any) => Promise<any[]> },
    label: string,
  ) => {
    const trimmed = typeof label === 'string' ? label.trim() : '';
    if (!trimmed) return null;
    const exact = await model.findFirst({ where: { name: trimmed } });
    if (exact) return exact;
    const normalized = normalizeName(trimmed);
    const all = await model.findMany({ select: { id: true, name: true } });
    return all.find((r: any) => normalizeName(r.name) === normalized) ?? null;
  };

  // Valores del CSV que no son proveedores reales: se tratan como vacío
  // (sin vínculo, sin crear). Comparación normalizada: minúsculas, sin
  // tildes, sin espacios extra. Cubre typos como "SIN PROVEDOR".
  const SUPPLIER_PLACEHOLDERS = new Set([
    'sin proveedor',
    'sin provedor',
    'sin proveedore',
    'sin provedores',
    's/p',
    'n/a',
    'na',
    's/d',
    '-',
    '—',
    'ninguno',
    'ninguna',
    'vacio',
    'vacia',
  ]);

  const isSupplierPlaceholder = (label: string) => {
    const n = normalizeName(label).replace(/\s+/g, ' ').trim();
    if (!n) return true;
    if (SUPPLIER_PLACEHOLDERS.has(n)) return true;
    // "sin proveedor..." con agregados (ej. "sin proveedor -") se omite igual
    if (n === 'sin proveedor' || n.startsWith('sin proveedor ') || n.startsWith('sin provedor ')) return true;
    return false;
  };

  try {
    const data = await req.json();
    const { products } = data; // Array of mapped products

    if (!Array.isArray(products) || products.length === 0) {
      return NextResponse.json({ message: 'No hay productos para importar' }, { status: 400 });
    }

    let successCount = 0;
    let updateCount = 0;
    let errorCount = 0;
    const unlinkedSuppliers: string[] = [];
    const createdSuppliers: string[] = [];

    for (const productData of products) {
      try {
        const {
          name,
          sku,
          description,
          pricePurchase,
          priceSale,
          quantityStock,
          stockMinAlert,
          brandName,
          categoryName,
          supplierName,
        } = productData;

        // Marca / Categoría / Proveedor se resuelven SOLO con lo que trae
        // la fila (find-or-create insensible, sin duplicar "Acme"/"acme").
        // Si la fila no trae el campo, queda null y NO se toca en el update.
        // Los placeholders de proveedor ("SIN PROVEEDOR", "N/A", "-") se
        // tratan como vacío: sin vínculo y sin crear.
        const resolveLinked = async (
          model: { findFirst: (args: any) => Promise<any>; findMany: (args?: any) => Promise<any[]>; create: (args: any) => Promise<any> },
          raw: unknown,
          opts?: { onCreate?: (created: any) => void },
        ) => {
          const label = typeof raw === 'string' ? raw.trim() : '';
          if (!label) return null;
          let found = await findByNameInsensitive(model, label);
          if (!found) {
            try {
              found = await model.create({ data: { name: label } });
            } catch (e: any) {
              // Carrera contra unique(name): re-buscar en vez de fallar la fila.
              if (e?.code === 'P2002') {
                found = await findByNameInsensitive(model, label);
              } else {
                throw e;
              }
            }
            if (found) opts?.onCreate?.(found);
          }
          return found;
        };

        const brand = await resolveLinked(prisma.brand, brandName);
        const category = await resolveLinked(prisma.category, categoryName);

        let supplier = null;
        const supplierLabel = typeof supplierName === 'string' ? supplierName.trim() : '';
        if (supplierLabel && !isSupplierPlaceholder(supplierLabel)) {
            supplier = await resolveLinked(prisma.supplier, supplierLabel, {
              onCreate: (created: any) => {
                if (created && !createdSuppliers.includes(created.name)) {
                  createdSuppliers.push(created.name);
                }
              },
            });
            if (!supplier && !unlinkedSuppliers.includes(supplierLabel)) {
                unlinkedSuppliers.push(supplierLabel);
            }
        }

        // Numéricos: solo se aplican si la fila trae valor parseable.
        // Celda vacía = conservar el valor actual (nunca 0 ni NaN).
        const numOrUndefined = (raw: unknown): number | undefined => {
          if (raw === undefined || raw === null) return undefined;
          const s = String(raw).trim();
          if (!s) return undefined;
          const n = Number(s);
          return Number.isFinite(n) ? n : undefined;
        };

        if (sku) {
            const existingProduct = await prisma.product.findUnique({
                where: { sku }
            });

            if (existingProduct) {
                // UPDATE PARCIAL: solo los campos presentes en la fila.
                const updateData: Prisma.ProductUpdateInput = { name };
                if ('description' in productData) {
                    updateData.description = description || null;
                }
                const pp = numOrUndefined(pricePurchase);
                if (pp !== undefined) updateData.pricePurchase = pp;
                const ps = numOrUndefined(priceSale);
                if (ps !== undefined) updateData.priceSale = ps;
                // Ojo: Sobre-escribimos el stock con el valor del CSV.
                // Si quisieras sumar, sería: quantityStock: { increment: ... }
                const qs = numOrUndefined(quantityStock);
                if (qs !== undefined) updateData.quantityStock = qs;
                if ('stockMinAlert' in productData) {
                    updateData.stockMinAlert = numOrUndefined(stockMinAlert) ?? null;
                }
                if (brand) updateData.brand = { connect: { id: brand.id } };
                if (category) updateData.category = { connect: { id: category.id } };
                // Se vincula el proveedor (existente o recién creado);
                // si la fila no trae uno válido no se toca el actual.
                if (supplier) updateData.supplier = { connect: { id: supplier.id } };

                await prisma.product.update({
                    where: { id: existingProduct.id },
                    data: updateData,
                });
                updateCount++;
                continue;
            }
        }

        // CREATE: marca/categoría caen a los defaults si la fila no los trae.
        let createBrand = brand;
        if (!createBrand) {
            createBrand = await prisma.brand.findFirst({ where: { name: 'Genérica' }});
            if (!createBrand) createBrand = await prisma.brand.create({ data: { name: 'Genérica' }});
        }
        let createCategory = category;
        if (!createCategory) {
            createCategory = await prisma.category.findFirst({ where: { name: 'General' }});
            if (!createCategory) createCategory = await prisma.category.create({ data: { name: 'General' }});
        }

        // Prepare product object
        const productPayload: Prisma.ProductCreateInput = {
            name,
            sku: sku || undefined,
            description: description || null,
            pricePurchase: numOrUndefined(pricePurchase) ?? 0,
            priceSale: numOrUndefined(priceSale) ?? 0,
            quantityStock: numOrUndefined(quantityStock) ?? 0,
            stockMinAlert: numOrUndefined(stockMinAlert) ?? null,
            brand: { connect: { id: createBrand.id } },
            category: { connect: { id: createCategory.id } },
            ...(supplier ? { supplier: { connect: { id: supplier.id } } } : {}),
        };

        await prisma.product.create({
            data: productPayload
        });
        successCount++;
        
      } catch (err) {
        console.error("Error importing row:", err);
        errorCount++;
      }
    }

    return NextResponse.json({
        successCount,
        updateCount,
        errorCount,
        unlinkedSuppliers,
        createdSuppliers,
        message: `Importación finalizada.\nCreados: ${successCount}\nActualizados: ${updateCount}\nErrores: ${errorCount}${createdSuppliers.length > 0 ? `\nProveedores creados: ${createdSuppliers.length}` : ''}${unlinkedSuppliers.length > 0 ? `\nSin proveedor: ${unlinkedSuppliers.length}` : ''}`
    }, { status: 200 });

  } catch (error: any) {
    console.error("Import error:", error);
    return NextResponse.json(
      { message: error.message || 'Error interno del servidor al importar' },
      { status: 500 }
    );
  }
}
