"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, Plus, RotateCcw, History, ArrowUpRight } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatCurrency';
import { formatDate } from '@/lib/formatDate';
import { getPaymentTypeDisplay } from '@/lib/displayTexts';

interface Movement {
  id: number;
  type: string;
  paymentType: string | null;
  amount: string;
  description: string | null;
  createdAt: string;
}

interface SellerBrief {
  id: number;
  name: string;
}

interface Register {
  id: number;
  openDate: string;
  closeDate: string | null;
  initialBalance: string;
  expectedBalance: string | null;
  actualBalance: string | null;
  difference: string | null;
  status: string;
  notes: string | null;
  movements: Movement[];
  seller: SellerBrief | null;
}

const typeDisplay: Record<string, string> = {
  SALE: 'Venta',
  EXPENSE: 'Gasto',
  WITHDRAWAL: 'Retiro',
  DEPOSIT: 'Depósito',
  ADJUSTMENT: 'Ajuste',
};

// Diferencia a partir de la cual el motivo en Notas es obligatorio al cerrar.
const DIF_UMBRAL_CIERRE = 1000;

export default function CajaPage() {
  const [openRegister, setOpenRegister] = useState<Register | null>(null);
  const [history, setHistory] = useState<Register[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [initialBalance, setInitialBalance] = useState('0');
  const [actualBalance, setActualBalance] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sellers, setSellers] = useState<SellerBrief[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const [cajaRes, sellersRes] = await Promise.all([
        fetch('/api/caja'),
        fetch('/api/vendedores'),
      ]);
      if (cajaRes.ok) {
        const data = await cajaRes.json();
        setOpenRegister(data.open);
        setHistory(data.history);
      }
      if (sellersRes.ok) {
        setSellers(await sellersRes.json());
      }
    } catch {
      toast.error('Error al cargar datos de caja.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleOpenRegister = async () => {
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/caja', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialBalance: parseFloat(initialBalance) || 0, sellerId: selectedSellerId || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
      }
      toast.success('Caja abierta exitosamente.');
      setShowOpenModal(false);
      fetchData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Esperado en efectivo físico: inicial + movimientos CASH (solo ese medio
  // se cuenta billete en mano; el resto deja rastro digital).
  const expectedCash =
    openRegister == null
      ? null
      : parseFloat(openRegister.initialBalance || '0') +
        openRegister.movements
          .filter((m) => m.paymentType === 'CASH')
          .reduce((s, m) => s + parseFloat(m.amount || '0'), 0);

  const closeDiff =
    openRegister == null || actualBalance === ''
      ? null
      : parseFloat(actualBalance) - parseFloat(openRegister.expectedBalance || '0');
  const notesRequired =
    closeDiff !== null && !isNaN(closeDiff) && Math.abs(closeDiff) > DIF_UMBRAL_CIERRE;

  const handleCloseRegister = async () => {
    if (!openRegister || !actualBalance) return;
    if (notesRequired && !closeNotes.trim()) {
      toast.error(
        `La diferencia supera los ${formatCurrency(DIF_UMBRAL_CIERRE)}: escribí el motivo en Notas para cerrar la caja.`,
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/caja/${openRegister.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualBalance: parseFloat(actualBalance), notes: closeNotes || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
      }
      toast.success('Caja cerrada exitosamente.');
      setShowCloseModal(false);
      setActualBalance('');
      setCloseNotes('');
      fetchData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderDesgloseClose = () => {
    const breakdown: Record<string, { income: number; expense: number }> = {};
    openRegister?.movements.forEach(m => {
      const method = getPaymentTypeDisplay(m.paymentType) || 'Sin medio';
      const amount = parseFloat(m.amount);
      if (!breakdown[method]) breakdown[method] = { income: 0, expense: 0 };
      if (amount >= 0) breakdown[method].income += amount;
      else breakdown[method].expense += Math.abs(amount);
    });
    return (
      <div className="bg-background p-3 rounded-lg space-y-2">
        <p className="text-xs text-foreground-muted font-medium">Desglose por medio de pago</p>
        {Object.entries(breakdown).length === 0 ? (
          <p className="text-sm text-foreground-muted">Sin movimientos</p>
        ) : (
          Object.entries(breakdown).map(([method, { income, expense }]) => (
            <div key={method} className="flex items-center justify-between text-sm">
              <span className="text-foreground">{method}</span>
              <span className="font-medium text-foreground">
                {income > 0 && <span className="text-success">+{formatCurrency(income)}</span>}
                {income > 0 && expense > 0 && <span> / </span>}
                {expense > 0 && <span className="text-destructive">-{formatCurrency(expense)}</span>}
              </span>
            </div>
          ))
        )}
        <hr className="border-border" />
        <div className="flex items-center justify-between text-sm font-semibold">
          <span className="text-foreground">Total movimientos</span>
          <span className={openRegister!.movements.reduce((s, m) => s + parseFloat(m.amount), 0) >= 0 ? 'text-success' : 'text-destructive'}>
            {formatCurrency(openRegister!.movements.reduce((s, m) => s + parseFloat(m.amount), 0))}
          </span>
        </div>
      </div>
    );
  };

  const renderDesglose = () => {
    const breakdown: Record<string, { income: number; expense: number }> = {};
    openRegister?.movements.forEach(m => {
      const method = getPaymentTypeDisplay(m.paymentType) || 'Sin medio';
      const amount = parseFloat(m.amount);
      if (!breakdown[method]) breakdown[method] = { income: 0, expense: 0 };
      if (amount >= 0) breakdown[method].income += amount;
      else breakdown[method].expense += Math.abs(amount);
    });
    return (
      <div className="bg-background p-4 rounded-lg mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Object.entries(breakdown).map(([method, { income, expense }]) => (
          <div key={method} className="flex flex-col">
            <span className="text-xs text-foreground-muted">{method}</span>
            <div className="text-sm font-medium">
              {income > 0 && <span className="text-success">+{formatCurrency(income)}</span>}
              {income > 0 && expense > 0 && <span> / </span>}
              {expense > 0 && <span className="text-destructive">-{formatCurrency(expense)}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-foreground-muted">Cargando...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div id="caja-header" className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold text-foreground">Caja</h1>
        {!openRegister ? (
          <Button onClick={() => setShowOpenModal(true)}>
            <Plus size={16} className="mr-2" /> Abrir Caja
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setShowCloseModal(true)}>
            <RotateCcw size={16} className="mr-2" /> Cerrar Caja
          </Button>
        )}
      </div>

      {openRegister ? (
        <div className="bg-muted p-6 rounded-xl shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Wallet size={20} className="text-primary" /> Caja Abierta
            </h2>
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-success/20 text-success">Abierta</span>
          </div>
          <p className="text-sm text-foreground-muted">Abierta el: {formatDate(openRegister.openDate)} {openRegister.seller ? <span className="ml-2">Vendedor: <strong>{openRegister.seller.name}</strong></span> : null}</p>
          <div id="caja-balances" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-background p-4 rounded-lg">
              <p className="text-xs text-foreground-muted mb-1">Saldo Inicial</p>
              <p className="text-xl font-bold text-foreground">{formatCurrency(openRegister.initialBalance)}</p>
            </div>
            <div className="bg-background p-4 rounded-lg">
              <p className="text-xs text-foreground-muted mb-1">Movimientos</p>
              <p className="text-xl font-bold text-foreground">{openRegister.movements.length}</p>
            </div>
            <div className="bg-background p-4 rounded-lg">
              <p className="text-xs text-foreground-muted mb-1">Total Movimientos</p>
              <p className="text-xl font-bold text-foreground">
                {formatCurrency(openRegister.movements.reduce((sum, m) => sum + parseFloat(m.amount), 0))}
              </p>
            </div>
          </div>

          {openRegister.movements.length > 0 && (
            <div>
              {/* Desglose por medio de pago */}
              {renderDesglose()}

              <h3 className="text-sm font-medium text-foreground-muted mb-2">Últimos Movimientos</h3>
              <div className="overflow-x-auto border border-border rounded-lg">
                <table className="w-full text-left text-sm">
                  <thead className="bg-background">
                    <tr>
                      <th className="p-2 text-foreground-muted">Tipo</th>
                      <th className="p-2 text-foreground-muted">Medio</th>
                      <th className="p-2 text-foreground-muted text-right">Monto</th>
                      <th className="p-2 text-foreground-muted">Descripción</th>
                      <th className="p-2 text-foreground-muted">Hora</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openRegister.movements.slice(0, 10).map((m) => (
                      <tr key={m.id} className="border-t border-border">
                        <td className="p-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            m.type === 'SALE' ? 'bg-success/20 text-success' :
                            m.type === 'EXPENSE' ? 'bg-destructive/20 text-destructive' :
                            'bg-primary/20 text-primary'
                          }`}>{typeDisplay[m.type] || m.type}</span>
                        </td>
                        <td className="p-2 text-foreground">{getPaymentTypeDisplay(m.paymentType)}</td>
                        <td className={`p-2 text-right font-medium ${parseFloat(m.amount) >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {formatCurrency(m.amount)}
                        </td>
                        <td className="p-2 text-foreground-muted">{m.description || '-'}</td>
                        <td className="p-2 text-foreground-muted">{new Date(m.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-muted p-12 rounded-xl shadow text-center">
          <Wallet size={48} className="mx-auto text-foreground-muted mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">No hay caja abierta</h2>
          <p className="text-foreground-muted mb-6">Abra una caja para comenzar a registrar movimientos.</p>
          <Button onClick={() => setShowOpenModal(true)}>
            <Plus size={16} className="mr-2" /> Abrir Caja
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <div className="bg-muted p-6 rounded-xl shadow">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
            <History size={20} className="text-primary" /> Últimos Cierres
          </h2>
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-left text-sm">
              <thead className="bg-background">
                <tr>
                  <th className="p-2 text-foreground-muted">Fecha</th>
                  <th className="p-2 text-foreground-muted text-right">Esperado</th>
                  <th className="p-2 text-foreground-muted text-right">Real</th>
                  <th className="p-2 text-foreground-muted text-right">Diferencia</th>
                  <th className="p-2 text-foreground-muted">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="p-2 text-foreground">{r.closeDate ? formatDate(r.closeDate) : '-'}</td>
                    <td className="p-2 text-right text-foreground">{r.expectedBalance ? formatCurrency(r.expectedBalance) : '-'}</td>
                    <td className="p-2 text-right text-foreground">{r.actualBalance ? formatCurrency(r.actualBalance) : '-'}</td>
                    <td className={`p-2 text-right font-medium ${
                      r.difference && parseFloat(r.difference) !== 0 ? 'text-destructive' : 'text-success'
                    }`}>
                      {r.difference ? formatCurrency(r.difference) : '-'}
                    </td>
                    <td className="p-2">
                      <Link href={`/caja/${r.id}`} className="text-primary hover:underline inline-flex items-center gap-1">
                        Ver <ArrowUpRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showOpenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowOpenModal(false)}>
          <div className="bg-muted text-foreground rounded-lg shadow-xl w-full max-w-md m-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Abrir Caja</h3>
            <div className="space-y-4">
              <Input label="Saldo Inicial ($)" type="number" step="0.01" value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} />
              <Select label="Vendedor *" value={selectedSellerId} onChange={(e) => setSelectedSellerId(e.target.value)} required>
                <option value="">Selecciona un vendedor</option>
                {sellers.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
              </Select>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button type="button" variant="outline" onClick={() => setShowOpenModal(false)} disabled={isSubmitting}>Cancelar</Button>
              <Button type="button" variant="primary" onClick={handleOpenRegister} disabled={isSubmitting}>
                {isSubmitting ? 'Abriendo...' : 'Abrir Caja'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showCloseModal && openRegister && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCloseModal(false)}>
          <div className="bg-muted text-foreground rounded-lg shadow-xl w-full max-w-lg m-4 p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Cerrar Caja</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-background p-3 rounded-lg">
                  <p className="text-xs text-foreground-muted">Saldo Inicial</p>
                  <p className="text-lg font-bold">{formatCurrency(openRegister.initialBalance)}</p>
                </div>
                <div className="bg-background p-3 rounded-lg">
                  <p className="text-xs text-foreground-muted">Esperado total</p>
                  <p className="text-lg font-bold">{openRegister.expectedBalance ? formatCurrency(openRegister.expectedBalance) : '-'}</p>
                </div>
                <div className="bg-background p-3 rounded-lg">
                  <p className="text-xs text-foreground-muted">Esperado en efectivo</p>
                  <p className="text-lg font-bold">{expectedCash !== null && !isNaN(expectedCash) ? formatCurrency(expectedCash) : '-'}</p>
                </div>
              </div>

              {renderDesgloseClose()}

              <Input label="Saldo Real en Caja ($) *" type="number" step="0.01" value={actualBalance} onChange={(e) => setActualBalance(e.target.value)} required />
              {closeDiff !== null && !isNaN(closeDiff) && actualBalance !== '' && (
                <p className={`text-sm font-bold ${closeDiff === 0 ? 'text-emerald-600' : closeDiff > 0 ? 'text-amber-600' : 'text-destructive'}`}>
                  Diferencia: {closeDiff > 0 ? '+' : ''}{formatCurrency(closeDiff)}
                  {closeDiff !== 0 && ' (esperado vs real)'}
                  {closeDiff === 0 && ' — caja cuadrada ✔'}
                </p>
              )}
              <Input label={notesRequired ? 'Notas (obligatorio por diferencia) *' : 'Notas (opcional)'} type="text" value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button type="button" variant="outline" onClick={() => setShowCloseModal(false)} disabled={isSubmitting}>Cancelar</Button>
              <Button type="button" variant="primary" onClick={handleCloseRegister} disabled={isSubmitting || !actualBalance}>
                {isSubmitting ? 'Cerrando...' : 'Cerrar Caja'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
