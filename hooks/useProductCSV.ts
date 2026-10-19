import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { exportToCSV, parseCSV } from '@/lib/csv';
import type { Product } from '@/types';

export function useProductCSV(fetchProducts: () => void) {
  const handleExportCSV = useCallback(async (products: Product[]) => {
    const headers = [
      { key: 'name', label: 'Nombre' },
      { key: 'sku', label: 'SKU' },
      { key: 'description', label: 'Descripción' },
      { key: 'pricePurchase', label: 'Precio Compra' },
      { key: 'priceSale', label: 'Precio Venta' },
      { key: 'quantityStock', label: 'Stock' },
      { key: 'stockMinAlert', label: 'Alerta Stock Mínimo' },
      { key: 'brandName', label: 'Marca' },
      { key: 'categoryName', label: 'Categoría' },
      { key: 'supplierName', label: 'Proveedor' },
    ];
    const dataToExport = products.map(p => ({
      ...p,
      brandName: p.brand?.name || '',
      categoryName: p.category?.name || '',
      supplierName: p.supplier?.name || '',
    }));
    try {
      const result = await exportToCSV('productos', dataToExport, headers);
      if (result.success) {
        toast.success('Productos exportados a CSV con éxito.');
      } else if (!result.canceled) {
        toast.error(`No se pudo exportar el CSV${result.error ? `: ${result.error}` : '.'}`);
      }
    } catch (err: any) {
      toast.error(`No se pudo exportar el CSV: ${err?.message || 'error desconocido'}`);
    }
  }, []);

  const handleImportCSV = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      try {
        const lines = parseCSV(text);
        if (lines.length < 2) {
          toast.error('El archivo CSV está vacío o no tiene formato válido.');
          return;
        }

        const rawHeaders = lines[0].map(h => h.trim());
        const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-záéíóúñ]/g, ''));

        const findCol = (aliases: string[]): number => {
          for (const a of aliases) {
            const clean = a.toLowerCase().replace(/[^a-záéíóúñ]/g, '');
            const idx = headers.indexOf(clean);
            if (idx !== -1) return idx;
          }
          return -1;
        };

        const nameIdx = findCol(['nombre', 'descripcion', 'producto', 'descripción']);
        const skuIdx = findCol(['sku', 'codigo', 'código', 'code']);
        const descIdx = findCol(['descripción', 'descripcion', 'observaciones', 'notas']);
        const pricePurchaseIdx = findCol(['preciocompra', 'preciocompra', 'costo', 'preciodecosto', 'cost']);
        const priceSaleIdx = findCol(['precioventa', 'precioventa', 'precio', 'price', 'preciodeventa']);
        const stockIdx = findCol(['stock', 'cantidad', 'existencia', 'quantity']);
        const stockMinIdx = findCol(['stockminimo', 'stockmínimo', 'alertastockmínimo', 'alertastockminimo', 'stockmin']);
        const brandIdx = findCol(['marca', 'brand', 'marc']);
        const categoryIdx = findCol(['categoría', 'categoria', 'rubro', 'category', 'categ']);

        if (nameIdx === -1 || priceSaleIdx === -1 || stockIdx === -1) {
          toast.error('No se encontraron columnas obligatorias. El CSV debe tener: Nombre/Descripción, Precio y Stock. Columnas detectadas: ' + rawHeaders.join(', '));
          return;
        }

        toast.loading('Importando productos...', { id: 'import-toast' });

        const [bRes, cRes] = await Promise.all([
          fetch('/api/brands'),
          fetch('/api/categories')
        ]);

        const currentBrands: any[] = await (bRes.ok ? bRes.json() : []);
        const currentCategories: any[] = await (cRes.ok ? cRes.json() : []);

        let successCount = 0;
        let errorCount = 0;
        let duplicateCount = 0;

        const categoryIdToName: Record<string, string> = {};

        for (let i = 1; i < lines.length; i++) {
          const row = lines[i];
          if (row.length <= 1) continue;

          const name = row[nameIdx]?.trim();
          if (!name) continue;

          const sku = skuIdx !== -1 ? row[skuIdx]?.trim() || null : null;
          const description = descIdx !== -1 ? row[descIdx]?.trim() || null : null;
          const pricePurchase = pricePurchaseIdx !== -1 ? row[pricePurchaseIdx]?.trim() || '' : '';
          const priceSale = parseFloat(row[priceSaleIdx]?.replace(',', '.'));
          const quantityStock = parseInt(row[stockIdx]) || 0;
          const stockMinAlert = stockMinIdx !== -1 ? parseInt(row[stockMinIdx]) || null : null;

          const rawIdRubro = row[6]?.trim();
          const rawRubro = categoryIdx !== -1 ? row[categoryIdx]?.trim() : '';

          if (rawIdRubro && rawRubro) {
            categoryIdToName[rawIdRubro] = rawRubro;
          }

          const resolvedCategory = rawRubro || (rawIdRubro ? categoryIdToName[rawIdRubro] : '') || 'General';
          const brandName = brandIdx !== -1 ? (row[brandIdx]?.trim() || 'Genérica') : 'Genérica';
          const categoryName = resolvedCategory;

          if (isNaN(priceSale)) { errorCount++; continue; }

          if (sku) {
            const dupRes = await fetch(`/api/products?search=${encodeURIComponent(sku)}`);
            if (dupRes.ok) {
              const dupData = await dupRes.json();
              const found = Array.isArray(dupData) ? dupData.find((p: any) => p.sku === sku) : dupData.data?.find((p: any) => p.sku === sku);
              if (found) { duplicateCount++; continue; }
            }
          }

          let brand = currentBrands.find((b: any) => b.name.toLowerCase() === brandName.toLowerCase());
          if (!brand) {
            const createRes = await fetch('/api/brands', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: brandName })
            });
            if (createRes.ok) {
              brand = await createRes.json();
              currentBrands.push(brand);
            } else {
              errorCount++;
              continue;
            }
          }

          let category = currentCategories.find((c: any) => c.name.toLowerCase() === categoryName.toLowerCase());
          if (!category) {
            const createRes = await fetch('/api/categories', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: categoryName })
            });
            if (createRes.ok) {
              category = await createRes.json();
              currentCategories.push(category);
            } else {
              errorCount++;
              continue;
            }
          }

          const productData = {
            name,
            sku,
            description,
            pricePurchase: pricePurchase || 0,
            priceSale,
            quantityStock,
            stockMinAlert,
            brandId: brand.id,
            categoryId: category.id
          };

          const pRes = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(productData)
          });

          if (pRes.ok) successCount++;
          else errorCount++;
        }

        toast.dismiss('import-toast');
        const parts = [`Creados: ${successCount}`];
        if (duplicateCount) parts.push(`Duplicados omitidos: ${duplicateCount}`);
        if (errorCount) parts.push(`Errores: ${errorCount}`);
        toast.success(`Importación finalizada. ${parts.join(' | ')}`);
        fetchProducts();
      } catch (err) {
        toast.dismiss('import-toast');
        toast.error('Error al procesar el archivo CSV.');
        console.error(err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [fetchProducts]);

  return { handleExportCSV, handleImportCSV };
}
