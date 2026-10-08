'use client';

import React, { useState } from 'react';
import { Database, Download, Upload, Cloud, RefreshCw, CheckCircle2, ShieldCheck, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';
import toast from 'react-hot-toast';

interface ConfigBackupTabProps {
  form: Record<string, string>;
  handleChange: (key: string, value: string) => void;
  handleManualSync: () => void;
  isSyncing: boolean;
  isPlanPro: boolean;
}

export default function ConfigBackupTab({
  form,
  handleManualSync,
  isSyncing,
  isPlanPro,
}: ConfigBackupTabProps) {
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const handleExportBackup = async () => {
    setIsBackingUp(true);
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        const res = await invoke<{ success: boolean; path?: string; error?: string; canceled?: boolean }>('backup_database');
        
        if (res.success) {
          toast.success(`Copia de seguridad exportada en: ${res.path}`);
        } else if (!res.canceled) {
          toast.error(res.error || 'Error al exportar copia de seguridad.');
        }
      } else {
        toast.error('La exportación directa de BD sólo está disponible en la app de escritorio.');
      }
    } catch {
      toast.error('Error al realizar copia de seguridad.');
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleImportBackup = async () => {
    if (!confirm('⚠️ ALERTA: Importar una copia de seguridad reemplazará todos los datos actuales de la base de datos. ¿Deseás continuar?')) {
      return;
    }

    setIsRestoring(true);
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        const res = await invoke<{ success: boolean; message?: string; error?: string; canceled?: boolean }>('restore_database');
        
        if (res.success) {
          // La restauración se aplica al reiniciar: la base en uso no se pisa.
          toast.success(res.message || 'Copia validada. Se aplicará al reiniciar ClinPOS.', { duration: 8000 });
          if (confirm('La copia se aplicará al reiniciar ClinPOS. ¿Querés cerrar la aplicación ahora? Después volvé a abrirla.')) {
            await invoke('exit_for_update');
          }
        } else if (!res.canceled) {
          toast.error(res.error || 'Error al restaurar base de datos.');
        }
      } else {
        toast.error('La importación directa de BD sólo está disponible en la app de escritorio.');
      }
    } catch {
      toast.error('Error al restaurar copia de seguridad.');
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Respaldo en Computadora */}
      <section className="bg-muted p-6 rounded-xl shadow space-y-4">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Database size={20} className="text-primary" /> Copia de Seguridad en la Computadora
        </h2>
        <p className="text-sm text-foreground-muted">
          Guardá un archivo de respaldo con todas tus ventas, clientes y productos para tener una copia protegida en tu equipo o pendrive.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="p-4 bg-background border border-border rounded-xl space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Download size={16} className="text-primary" /> Descargar Copia de Seguridad
            </h3>
            <p className="text-xs text-foreground-muted">
              Crea un archivo de respaldo seguro con toda la información de tu negocio.
            </p>
            <Button onClick={handleExportBackup} disabled={isBackingUp} variant="outline" className="w-full text-xs font-bold">
              {isBackingUp ? 'Guardando Copia...' : 'Descargar Copia de Seguridad'}
            </Button>
          </div>

          <div className="p-4 bg-background border border-border rounded-xl space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Upload size={16} className="text-amber-600" /> Recuperar Copia Guardada
            </h3>
            <p className="text-xs text-foreground-muted">
              Restaura la información de tu comercio desde un archivo de respaldo previamente guardado.
            </p>
            <Button onClick={handleImportBackup} disabled={isRestoring} variant="outline" className="w-full text-xs font-bold text-amber-600 border-amber-500/30 hover:bg-amber-500/10">
              {isRestoring ? 'Restaurando...' : 'Recuperar Copia Guardada'}
            </Button>
          </div>
        </div>
      </section>

      {/* Sincronización en la Nube Integrada */}
      <section className="bg-muted p-6 rounded-xl shadow space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Cloud size={20} className="text-primary" /> Respaldo Automático en la Nube ClinPOS
            </h2>
            <p className="text-sm text-foreground-muted mt-1">
              Tu información se respalda de forma segura en los servidores de ClinPOS para proteger tus ventas y clientes ante cualquier falla técnica.
            </p>
          </div>

          {isPlanPro && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/15 text-emerald-600 text-xs font-bold rounded-full shrink-0">
              <ShieldCheck size={14} /> Servicio Conectado
            </span>
          )}
        </div>

        {!isPlanPro ? (
          <div className="p-5 bg-background border border-amber-300/40 rounded-xl space-y-3">
            <div className="flex items-center gap-2 text-amber-600">
              <Sparkles size={18} />
              <p className="text-sm font-bold text-foreground">Función del Plan Pro</p>
            </div>
            <p className="text-xs text-foreground-muted">
              El respaldo automático en la nube es exclusivo del <strong className="text-foreground font-semibold">Plan Pro</strong>. Mientras tanto, podés seguir usando la copia de seguridad local en tu computadora.
            </p>
            <Button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.location.href = '/configuracion?tab=suscripciones';
                }
              }}
              className="font-bold text-xs px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white"
            >
              💳 Ver Plan Pro y Suscripción
            </Button>
          </div>
        ) : (
          <div className="p-5 bg-background border border-border rounded-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-foreground flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-500" /> Servidor Oficial Activo
                </p>
                {form.supabase_last_sync ? (
                  <p className="text-xs text-emerald-600 font-semibold mt-1">
                    Último respaldo exitoso en la nube: {new Date(form.supabase_last_sync).toLocaleString('es-AR')}
                  </p>
                ) : (
                  <p className="text-xs text-foreground-muted mt-1">
                    Conexión segura lista. Todavía no realizaste la primera sincronización manual.
                  </p>
                )}
              </div>

              <Button
                type="button"
                onClick={handleManualSync}
                disabled={isSyncing}
                className="shrink-0 font-bold text-xs px-5 py-2.5"
              >
                <RefreshCw size={15} className={`mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Guardando en la Nube...' : 'Guardar en la Nube Ahora'}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
