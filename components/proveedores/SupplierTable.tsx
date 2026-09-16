// components/proveedores/SupplierTable.tsx
"use client";

import React, { useEffect, useState, useCallback } from 'react';
import type { Supplier } from '@/types';
import Button from '@/components/ui/Button';
import ConfirmationModal from '@/components/ui/ConfirmationModal';
import { Edit3, Trash2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';

const SupplierTable = () => {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<Supplier | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/proveedores');
      if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
      setSuppliers(await response.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar proveedores.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuppliers();
  }, [fetchSuppliers]);

  const handleOpenDeleteModal = (supplier: Supplier) => {
    setItemToDelete(supplier);
    setIsModalOpen(true);
  };
  
  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/proveedores/${itemToDelete.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'No se pudo eliminar el proveedor.');
      }
      setSuppliers(prev => prev.filter(s => s.id !== itemToDelete.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(itemToDelete.id);
        return next;
      });
      toast.success(`Proveedor "${itemToDelete.name}" eliminado.`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Ocurrió un error.');
    } finally {
      setIsModalOpen(false);
      setIsDeleting(false);
      setItemToDelete(null);
    }
  };

  const handleEdit = (supplierId: number) => {
    router.push(`/proveedores/${supplierId}/editar`);
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === suppliers.length && suppliers.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(suppliers.map((s) => s.id)));
    }
  };

  const handleConfirmBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsBatchDeleting(true);
    try {
      const response = await fetch('/api/proveedores/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.message || 'No se pudieron eliminar los proveedores.');
      }
      const deleted: string[] = Array.isArray(result.deleted) ? result.deleted : [];
      const deletedIds: number[] = Array.isArray(result.deletedIds) ? result.deletedIds : [];
      const skipped: { id: number; name: string; reason: string }[] = Array.isArray(result.skipped) ? result.skipped : [];
      // deletedIds es la fuente principal; fallback por nombre (único) por compatibilidad.
      const removedIds =
        deletedIds.length > 0
          ? new Set(deletedIds)
          : new Set(suppliers.filter((s) => deleted.includes(s.name)).map((s) => s.id));
      setSuppliers((prev) => prev.filter((s) => !removedIds.has(s.id)));
      setSelectedIds(new Set());
      if (deleted.length > 0) toast.success(`${deleted.length} proveedor(es) eliminado(s).`);
      skipped.forEach((s) => toast.error(`"${s.name}": ${s.reason}`, { duration: 6000 }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Ocurrió un error.');
    } finally {
      setIsBatchModalOpen(false);
      setIsBatchDeleting(false);
    }
  };

  if (loading) return <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-primary" /></div>;
  if (error) return <div className="text-center text-destructive p-4 bg-destructive/10 rounded-md">{error}</div>;

  return (
    <>
      <ConfirmationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Eliminar Proveedor"
        confirmText="Sí, Eliminar"
        isLoading={isDeleting}
      >
        ¿Estás seguro de que quieres eliminar al proveedor <strong className="text-foreground">"{itemToDelete?.name}"</strong>? Esta acción no se puede deshacer.
      </ConfirmationModal>

      <ConfirmationModal
        isOpen={isBatchModalOpen}
        onClose={() => setIsBatchModalOpen(false)}
        onConfirm={handleConfirmBatchDelete}
        title={`Eliminar ${selectedIds.size} Proveedor${selectedIds.size !== 1 ? 'es' : ''}`}
        confirmText="Sí, Eliminar"
        isLoading={isBatchDeleting}
      >
        ¿Estás seguro de que quieres eliminar los <strong className="text-foreground">{selectedIds.size} proveedores seleccionados</strong>? Los productos vinculados quedarán sin proveedor. Los que tengan compras asociadas se omitirán. Esta acción no se puede deshacer.
      </ConfirmationModal>

      {selectedIds.size > 0 && (
        <div className="mb-4 p-3 bg-background border border-border rounded-md flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} proveedor{selectedIds.size !== 1 ? 'es' : ''} seleccionado{selectedIds.size !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>
              Limpiar
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setIsBatchModalOpen(true)}>
              <Trash2 size={14} className="mr-1" /> Eliminar seleccionados
            </Button>
          </div>
        </div>
      )}

      <div className="bg-muted p-4 sm:p-6 rounded-lg shadow">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left">
            <thead className="border-b border-border">
              <tr>
                <th className="p-3 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={suppliers.length > 0 && selectedIds.size === suppliers.length}
                    onChange={toggleSelectAll}
                    aria-label="Seleccionar todos"
                    className="rounded border-border cursor-pointer"
                  />
                </th>
                <th className="p-3 text-sm font-semibold text-foreground">Nombre</th>
                <th className="p-3 text-sm font-semibold text-foreground">Contacto</th>
                <th className="p-3 text-sm font-semibold text-foreground">Email</th>
                <th className="p-3 text-sm font-semibold text-foreground">Teléfono</th>
                <th className="p-3 text-sm font-semibold text-foreground text-center">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.length === 0 && !loading ? (
                <tr><td colSpan={6} className="text-center text-foreground-muted py-8">No hay proveedores registrados.</td></tr>
              ) : (
                suppliers.map((supplier) => (
                  <tr key={supplier.id} className="border-b border-border last:border-b-0 hover:bg-background transition-colors">
                    <td className="p-3 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(supplier.id)}
                        onChange={() => toggleSelect(supplier.id)}
                        aria-label={`Seleccionar ${supplier.name}`}
                        className="rounded border-border cursor-pointer"
                      />
                    </td>
                    <td className="p-3 text-sm text-foreground font-medium">{supplier.name}</td>
                    <td className="p-3 text-sm text-foreground-muted">{supplier.contactPerson || '-'}</td>
                    <td className="p-3 text-sm text-foreground-muted">{supplier.email || '-'}</td>
                    <td className="p-3 text-sm text-foreground-muted">{supplier.phone || '-'}</td>
                    <td className="p-3 text-sm text-center">
                      <div className="flex justify-center items-center space-x-2">
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(supplier.id)} title="Editar"><Edit3 size={16} className="text-primary" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleOpenDeleteModal(supplier)} title="Eliminar"><Trash2 size={16} className="text-destructive" /></Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default SupplierTable;