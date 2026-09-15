import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export async function POST(req: Request) {
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

        // Find or create Brand (case-insensitive approximation by using toLowerCase in SQL if needed, but SQLite is tricky. We'll just do exact match for now and fallback)
        let brand = null;
        if (brandName) {
            brand = await prisma.brand.findFirst({
              where: { name: brandName }
            });
            if (!brand) {
                brand = await prisma.brand.create({ data: { name: brandName } });
            }
        }

        // Find or create Category
        let category = null;
        if (categoryName) {
            category = await prisma.category.findFirst({
              where: { name: categoryName }
            });
            if (!category) {
                category = await prisma.category.create({ data: { name: categoryName } });
            }
        }

        // Get default brand/category if not provided
        if (!brand) {
            brand = await prisma.brand.findFirst({ where: { name: 'Genérica' }});
            if (!brand) brand = await prisma.brand.create({ data: { name: 'Genérica' }});
        }
        if (!category) {
            category = await prisma.category.findFirst({ where: { name: 'General' }});
            if (!category) category = await prisma.category.create({ data: { name: 'General' }});
        }

        // Proveedor: solo vincular si ya existe. Nunca se crea desde el
        // importador; si no existe, el producto queda sin proveedor y se
        // reporta en la respuesta.
        let supplier = null;
        const supplierLabel = typeof supplierName === 'string' ? supplierName.trim() : '';
        if (supplierLabel) {
            supplier = await prisma.supplier.findFirst({
              where: { name: supplierLabel }
            });
            if (!supplier && !unlinkedSuppliers.includes(supplierLabel)) {
                unlinkedSuppliers.push(supplierLabel);
            }
        }

        // Prepare product object
        const productPayload: Prisma.ProductCreateInput = {
            name,
            sku: sku || undefined,
            description: description || null,
            pricePurchase: pricePurchase ? Number(pricePurchase) : 0,
            priceSale: Number(priceSale),
            quantityStock: Number(quantityStock),
            stockMinAlert: stockMinAlert ? Number(stockMinAlert) : null,
            brand: { connect: { id: brand.id } },
            category: { connect: { id: category.id } },
            ...(supplier ? { supplier: { connect: { id: supplier.id } } } : {}),
        };

        if (sku) {
            const existingProduct = await prisma.product.findUnique({
                where: { sku }
            });

            if (existingProduct) {
                await prisma.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        name,
                        description: description || null,
                        pricePurchase: pricePurchase ? Number(pricePurchase) : 0,
                        priceSale: Number(priceSale),
                        // Ojo: Sobre-escribimos el stock con el valor del CSV.
                        // Si quisieras sumar, sería: quantityStock: { increment: Number(quantityStock) }
                        quantityStock: Number(quantityStock),
                        stockMinAlert: stockMinAlert ? Number(stockMinAlert) : null,
                        brand: { connect: { id: brand.id } },
                        category: { connect: { id: category.id } },
                        // Solo se vincula el proveedor si existe; si el CSV no
                        // trae uno válido no se toca el actual.
                        ...(supplier ? { supplier: { connect: { id: supplier.id } } } : {}),
                    }
                });
                updateCount++;
                continue;
            }
        }
        
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
        message: `Importación finalizada.\nCreados: ${successCount}\nActualizados: ${updateCount}\nErrores: ${errorCount}${unlinkedSuppliers.length > 0 ? `\nSin proveedor (no existe): ${unlinkedSuppliers.length}` : ''}`
    }, { status: 200 });

  } catch (error: any) {
    console.error("Import error:", error);
    return NextResponse.json(
      { message: error.message || 'Error interno del servidor al importar' },
      { status: 500 }
    );
  }
}
