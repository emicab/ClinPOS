import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTargetBranch } from '../lib/stockAdjust';
import { setStock } from '../lib/stockService';

const prisma = new PrismaClient();

interface CsvRow {
  descripcion: string;
  codigo: string;
  costo: string;
  precio: string;
  stock: string;
  stockMinimo: string;
  rubro: string;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function main() {
  const csvPath = path.join(process.cwd(), 'importar.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error(`No se encuentra el archivo importar.csv en ${csvPath}`);
    console.log('Copiá el CSV a la raíz del proyecto con ese nombre.');
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'latin1');
  const lines = content.split(/\r?\n/).filter(Boolean);
  
  if (lines.length < 2) {
    console.error('El CSV debe tener un header + al menos una fila.');
    process.exit(1);
  }

  // Parse header
  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/ /g, ''));
  const idxDesc = header.indexOf('descripcion');
  const idxCodigo = header.indexOf('codigo');
  const idxCosto = header.indexOf('costo');
  const idxPrecio = header.indexOf('precio');
  const idxStock = header.indexOf('stock');
  const idxStockMin = header.indexOf('stockminimo');
  const idxRubro = header.indexOf('rubro');

  if (idxDesc === -1 || idxCodigo === -1 || idxCosto === -1 || idxPrecio === -1 || idxStock === -1) {
    console.error('El CSV debe tener columnas: Descripcion, Codigo, Costo, Precio, Stock');
    process.exit(1);
  }

  // Ensure generic brand
  let genericBrand = await prisma.brand.findFirst({ where: { name: 'Genérica' } });
  if (!genericBrand) {
    genericBrand = await prisma.brand.create({ data: { name: 'Genérica' } });
    console.log(`✓ Marca "Genérica" creada.`);
  } else {
    console.log(`✓ Marca "Genérica" ya existía.`);
  }

  // Ensure a default category for products without rubro
  let defaultCategory = await prisma.category.findFirst({ where: { name: 'General' } });
  if (!defaultCategory) {
    defaultCategory = await prisma.category.create({ data: { name: 'General' } });
    console.log(`✓ Categoría "General" creada (para productos sin rubro).`);
  }

  // Track stats
  let created = 0;
  let skipped = 0;
  let newCategories = 0;
  const categoryCache = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const row: CsvRow = {
      descripcion: fields[idxDesc] || '',
      codigo: fields[idxCodigo] || '',
      costo: fields[idxCosto] || '0',
      precio: fields[idxPrecio] || '0',
      stock: fields[idxStock] || '0',
      stockMinimo: idxStockMin !== -1 ? (fields[idxStockMin] || '') : '',
      rubro: idxRubro !== -1 ? (fields[idxRubro] || '') : '',
    };

    if (!row.descripcion) continue;

    // Resolve category
    let categoryId: number | null = null;
    if (row.rubro) {
      const cached = categoryCache.get(row.rubro);
      if (cached !== undefined) {
        categoryId = cached;
      } else {
        let cat = await prisma.category.findFirst({ where: { name: row.rubro } });
        if (!cat) {
          cat = await prisma.category.create({ data: { name: row.rubro } });
          newCategories++;
          console.log(`  Nueva categoría: "${row.rubro}"`);
        }
        categoryCache.set(row.rubro, cat.id);
        categoryId = cat.id;
      }
    }

    // Check SKU duplicate
    if (row.codigo) {
      const existing = await prisma.product.findUnique({ where: { sku: row.codigo } });
      if (existing) {
        skipped++;
        continue;
      }
    }

    const parsePrice = (value: any): number => {
  if (!value) return 0;
  const parsed = parseFloat(value.toString().replace(',', '.'));
  return isNaN(parsed) ? 0 : parsed;
};

    // Create product. El stock se escribe después con el servicio único
    // (por sucursal y con ledger), no directo en Product.quantityStock.
    const createdProduct = await prisma.product.create({
      data: {
        name: row.descripcion,
        sku: row.codigo || null,
        pricePurchase: parseFloat(row.costo.replace(',', '.')) || 0,
        priceSale: parseFloat(row.precio.replace(',', '.')) || 0,
        quantityStock: 0,
        stockMinAlert: row.stockMinimo ? (parseInt(row.stockMinimo) || null) : null,
        brandId: genericBrand.id,
        categoryId: categoryId || defaultCategory.id,
      },
    });

    const { branchId: importBranchId } = await resolveTargetBranch(null);
    await setStock(prisma, {
      productId: createdProduct.id,
      branchId: importBranchId,
      quantity: parseInt(row.stock) || 0,
      reason: 'CSV_IMPORT',
      refType: 'ProductImport',
      refId: createdProduct.id,
    });
    created++;
  }

  console.log('\n=== RESUMEN DE IMPORTACIÓN ===');
  console.log(`Productos creados:   ${created}`);
  console.log(`Duplicados saltados: ${skipped}`);
  console.log(`Categorías nuevas:   ${newCategories}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Error durante la importación:', e);
  process.exit(1);
});
