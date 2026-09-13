"use client";

import React from 'react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { Filter, X, RefreshCw } from 'lucide-react';
import type { Brand, Category, Supplier, Branch } from '@/types';
import { CatalogSyncButton } from './CatalogSyncButton';

interface ProductFiltersProps {
  filters: { search: string; brandId: string; categoryId: string; supplierId: string; branchId?: string };
  brands: Brand[];
  categories: Category[];
  suppliers: Supplier[];
  branches?: Branch[];
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onClear: () => void;
  onExportCSV: () => void;
  onImportCSV: () => void;
  onTransferStock?: () => void;
  onSync?: () => void;
  isSyncing?: boolean;
}

const ProductFilters: React.FC<ProductFiltersProps> = ({
  filters, brands, categories, suppliers, branches, onChange, onClear, onExportCSV, onImportCSV, onTransferStock, onSync, isSyncing,
}) => (
  <div className="mb-6 p-4 border border-border rounded-md bg-background">
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-3 gap-2 flex-wrap">
      <h3 className="text-lg font-medium text-foreground flex items-center">
        <Filter size={18} className="mr-2 text-primary" /> Filtros y Búsqueda
      </h3>
      <div className="flex items-center space-x-2 flex-wrap gap-y-2">
        <CatalogSyncButton />
        {onTransferStock && (
          <Button onClick={onTransferStock} variant="primary" size="sm" className="text-xs">
            Remito Traspaso 🔁
          </Button>
        )}
        {onSync && (
          <Button onClick={onSync} variant="outline" size="sm" className="text-xs" disabled={isSyncing}>
            <RefreshCw size={14} className={`mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Sincronizando...' : 'Sincronizar con la Nube'}
          </Button>
        )}
        <Button onClick={onExportCSV} variant="outline" size="sm" className="text-xs">
          Exportar CSV
        </Button>
        <Button onClick={onImportCSV} variant="outline" size="sm" className="text-xs">
          Importar CSV
        </Button>
      </div>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      <Input name="search" placeholder="Buscar por nombre o SKU..." value={filters.search} onChange={onChange} />
      {branches && branches.length > 1 && (
        <Select name="branchId" value={filters.branchId || ""} onChange={onChange} aria-label="Filtrar por Sucursal">
          <option value="">Todas las Sucursales (Global)</option>
          {branches.map((b) => (
            <option key={b.id} value={String(b.id)}>
              📍 {b.name} {b.isMain ? "(Principal)" : ""}
            </option>
          ))}
        </Select>
      )}
      <Select name="brandId" value={filters.brandId} onChange={onChange} aria-label="Filtrar por Marca">
        <option value="">Todas las Marcas</option>
        {brands.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
      </Select>
      <Select name="categoryId" value={filters.categoryId} onChange={onChange} aria-label="Filtrar por Categoría">
        <option value="">Todas las Categorías</option>
        {categories.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
      </Select>
      <Select name="supplierId" value={filters.supplierId} onChange={onChange} aria-label="Filtrar por Proveedor">
        <option value="">Todos los Proveedores</option>
        {suppliers.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
      </Select>
    </div>
  </div>
);

export default ProductFilters;
