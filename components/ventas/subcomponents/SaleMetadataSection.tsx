import React from "react";
import { ClipboardList, User, CreditCard, X, Tag } from "lucide-react";
import { useState, useEffect } from "react";
import Select from "@/components/ui/Select";
import Input from "@/components/ui/Input";
import { Seller, Client, PaymentTypeEnum } from "@/types";
import { getPaymentTypeDisplay } from "@/lib/displayTexts";
import { SaleFormData } from "@/hooks/useSaleState";
import Button from "@/components/ui/Button";

interface SaleMetadataSectionProps {
  formData: SaleFormData;
  sellers: Seller[];
  clientSearchTerm: string;
  searchedClients: Client[];
  selectedClient: Client | null;
  clientInputRef: React.RefObject<HTMLInputElement | null>;
  isModuleEnabled: (modId: string) => boolean;
  handleFormChange: (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => void;
  setFormData: React.Dispatch<React.SetStateAction<SaleFormData>>;
  handleClientSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSelectClient: (client: Client) => void;
  handleClearClientSelection: () => void;
  config: Record<string, string>;
  invoiceType: "A" | "B" | "C" | "NONE";
  setInvoiceType: (type: "A" | "B" | "C" | "NONE") => void;
  clientCuit: string;
  setClientCuit: (cuit: string) => void;
  clientName: string;
  setClientName: (name: string) => void;
}

export const SaleMetadataSection: React.FC<SaleMetadataSectionProps> = ({
  formData,
  sellers,
  clientSearchTerm,
  searchedClients,
  selectedClient,
  clientInputRef,
  isModuleEnabled,
  handleFormChange,
  setFormData,
  handleClientSearchChange,
  handleSelectClient,
  handleClearClientSelection,
  config,
  invoiceType,
  setInvoiceType,
  clientCuit,
  setClientCuit,
  clientName,
  setClientName,
}) => {
  const [promotions, setPromotions] = useState<any[]>([]);
  const [isPromosModalOpen, setIsPromosModalOpen] = useState(false);

  useEffect(() => {
    if (formData.paymentType === PaymentTypeEnum.CARD) {
      fetch("/api/credit-card-promotions?activeOnly=true")
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data)) {
            setPromotions(data);
          }
        })
        .catch(() => setPromotions([]));
    } else {
      setPromotions([]);
      if (formData.creditCardPromotionId) {
        setFormData(prev => ({ ...prev, creditCardPromotionId: null }));
      }
    }
  }, [formData.paymentType]);

  const selectedPromotion = promotions.find(p => p.id === formData.creditCardPromotionId);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border pt-4">
      {/* Panel: Datos del Comprobante */}
      <div className="border border-border p-4 rounded-xl bg-muted/10 space-y-3">
        <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5 uppercase pb-1 border-b border-border/50">
          <ClipboardList size={14} className="text-primary" /> Datos de Venta
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-1">
            <Select
              label="Forma de Pago *"
              name="paymentType"
              value={formData.paymentType}
              onChange={handleFormChange}
              required
              className="text-xs rounded-xl h-9"
            >
              <option value="">Seleccionar...</option>
              {Object.values(PaymentTypeEnum).map((type) => {
                if (type === PaymentTypeEnum.ON_ACCOUNT && !formData.clientId) {
                  return null;
                }
                return (
                  <option key={type} value={type}>
                    {getPaymentTypeDisplay(type)}
                  </option>
                );
              })}
            </Select>
            {formData.paymentType === PaymentTypeEnum.CARD && promotions.length > 0 && (
              <div className="mt-2 animate-in fade-in slide-in-from-top-1">
                {selectedPromotion ? (
                  <div className="w-full flex flex-col p-2.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-300 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5 text-blue-800 text-[10px] font-bold uppercase tracking-wider">
                        <CreditCard size={12} />
                        Tarjeta Seleccionada
                      </div>
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, creditCardPromotionId: null }))}
                        className="text-[10px] text-red-500 font-bold hover:underline"
                      >
                        Quitar
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-white px-3 py-2 rounded-lg border border-blue-100">
                      <span className="font-bold text-slate-800 text-xs">{selectedPromotion.bank}</span>
                      <span className="text-blue-600 font-bold text-xs">{selectedPromotion.installments}</span>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsPromosModalOpen(true)}
                    className="w-full flex items-center justify-between p-2.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 hover:border-blue-300 rounded-xl transition-all shadow-sm group"
                  >
                    <div className="flex items-center gap-2 text-blue-800">
                      <div className="p-1.5 bg-blue-100 rounded-lg group-hover:bg-blue-200 transition-colors">
                        <CreditCard size={14} className="text-blue-700" />
                      </div>
                      <span className="text-xs font-bold uppercase tracking-wide">Ver promociones vigentes</span>
                    </div>
                    <div className="bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm">
                      {promotions.length}
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="sm:col-span-1">
            <Select
              label="Vendedor *"
              name="sellerId"
              value={formData.sellerId}
              onChange={handleFormChange}
              required
              className="text-xs rounded-xl h-9"
            >
              <option value="">
                {sellers.length > 0 ? "Seleccionar..." : "Sin vendedores configurados"}
              </option>
              {sellers.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>

          {isModuleEnabled("combos_promociones") && (
            <div className="sm:col-span-2">
              <Input
                label="Cupón de Descuento"
                name="discountCode"
                value={formData.discountCode}
                onChange={handleFormChange}
                placeholder="Ej: VERANO20"
                className="text-xs rounded-xl h-9"
              />
            </div>
          )}

          <div className="sm:col-span-2">
            <label
              htmlFor="notes"
              className="block text-[10px] font-bold text-foreground-muted mb-1 uppercase"
            >
              Observaciones
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={1}
              value={formData.notes}
              onChange={handleFormChange}
              placeholder="Notas internas de la operación..."
              className="block w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary placeholder:text-foreground-muted/50"
            />
          </div>
        </div>
      </div>

      {/* Panel: Datos del Cliente */}
      <div className="border border-border p-4 rounded-xl bg-muted/10 flex flex-col justify-between">
        <div>
          <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5 uppercase pb-1 border-b border-border/50 mb-3">
            <User size={14} className="text-primary" /> Datos del Cliente
          </h3>

          {isModuleEnabled("clientes") ? (
            !formData.clientId ? (
              <div className="relative">
                <Input
                  ref={clientInputRef}
                  label="Buscar Cliente (Opcional)"
                  name="clientSearch"
                  placeholder="Nombre, apellido o email..."
                  value={clientSearchTerm}
                  onChange={handleClientSearchChange}
                  autoComplete="off"
                  className="text-xs rounded-xl h-9 border-border"
                />
                {searchedClients.length > 0 && (
                  <ul className="absolute z-20 w-full bg-background border border-border rounded-xl shadow-lg max-h-40 overflow-y-auto mt-1 border-collapse text-xs">
                    {searchedClients.map((client) => (
                      <li
                        key={client.id}
                        onClick={() => handleSelectClient(client)}
                        className="px-3 py-2 hover:bg-muted cursor-pointer border-b border-border last:border-b-0 flex flex-col"
                      >
                        <span className="font-semibold text-foreground">
                          {client.firstName} {client.lastName || ""}
                        </span>
                        <span className="text-[10px] text-foreground-muted">
                          {client.email || "Sin email"} &middot;{" "}
                          {client.phone || "Sin tel"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              selectedClient && (
                <div className="bg-white border border-border p-3 rounded-xl shadow-sm space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-foreground text-sm">
                      {selectedClient.firstName} {selectedClient.lastName || ""}
                    </span>
                    <button
                      type="button"
                      onClick={handleClearClientSelection}
                      className="text-[10px] text-red-500 font-bold hover:underline"
                    >
                      Deseleccionar
                    </button>
                  </div>
                  {selectedClient.phone && (
                    <p className="text-foreground-muted">
                      <strong className="font-semibold text-foreground">
                        Teléfono:
                      </strong>{" "}
                      {selectedClient.phone}
                    </p>
                  )}
                  {selectedClient.address && (
                    <p className="text-foreground-muted">
                      <strong className="font-semibold text-foreground">
                        Domicilio:
                      </strong>{" "}
                      {selectedClient.address}
                    </p>
                  )}
                  <p className="text-foreground-muted">
                    <strong className="font-semibold text-foreground">
                      Condición IVA:
                    </strong>{" "}
                    Consumidor Final
                  </p>
                </div>
              )
            )
          ) : (
            <div className="bg-white/40 border border-border/60 p-3 rounded-xl text-xs space-y-1">
              <p className="font-bold text-foreground">Cliente Ocasional</p>
              <p className="text-foreground-muted">
                Condición IVA: Consumidor Final
              </p>
              <p className="text-[10px] text-foreground-muted/60 mt-1">
                Habilite el módulo de Clientes para registrar cuentas nominadas.
              </p>
            </div>
          )}
        </div>

        <div className="text-[9px] text-foreground-muted/50 mt-4 leading-normal">
          Utilice{" "}
          <kbd className="px-1.5 py-0.5 bg-muted border border-border font-mono rounded shadow-sm">
            F4
          </kbd>{" "}
          para vaciar la venta y empezar una nueva.
        </div>
      </div>

      {config.arcaEnabled === "true" && (
        <div className="md:col-span-2 border border-border p-4 rounded-xl bg-muted/10 space-y-3">
          <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5 uppercase pb-1 border-b border-border/50">
            Facturación Electrónica (ARCA / AFIP)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-end">
            <div>
              <Select
                label="Tipo de Comprobante"
                name="invoiceType"
                value={invoiceType}
                onChange={(e) => setInvoiceType(e.target.value as any)}
                className="text-xs rounded-xl h-9"
              >
                <option value="NONE">Ticket Común (No Fiscal)</option>
                {config.arcaIvaCondition === "MT" ? (
                  <option value="C">Factura C (Monotributo)</option>
                ) : (
                  <>
                    <option value="B">Factura B (Consumidor Final)</option>
                    <option value="A">Factura A (Responsable Inscripto)</option>
                  </>
                )}
              </Select>
            </div>
            {invoiceType === "A" && (
              <>
                <div>
                  <Input
                    label="CUIT Cliente *"
                    value={clientCuit}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setClientCuit(e.target.value)
                    }
                    placeholder="20123456789 (11 dígitos)"
                    className="text-xs rounded-xl h-9"
                    required
                  />
                </div>
                <div>
                  <Input
                    label="Razón Social Cliente *"
                    value={clientName}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setClientName(e.target.value)
                    }
                    placeholder="Nombre o Razón Social"
                    className="text-xs rounded-xl h-9"
                    required
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal de Promociones */}
      {isPromosModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden border border-border flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-gradient-to-r from-slate-50 to-white">
              <div className="flex items-center gap-3 text-slate-800">
                <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
                  <Tag size={20} />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Promociones con Tarjeta</h2>
                  <p className="text-xs text-slate-500">
                    Opciones de cuotas vigentes para ofrecer al cliente
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsPromosModalOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto custom-scrollbar bg-slate-50/50">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {promotions.map((promo) => (
                  <div 
                    key={promo.id} 
                    onClick={() => {
                      setFormData(prev => ({ ...prev, creditCardPromotionId: promo.id }));
                      setIsPromosModalOpen(false);
                    }}
                    className={`rounded-xl p-4 border shadow-sm transition-all group relative overflow-hidden cursor-pointer ${
                      formData.creditCardPromotionId === promo.id 
                        ? 'bg-blue-50 border-blue-400 ring-1 ring-blue-400' 
                        : 'bg-white border-slate-200 hover:shadow-md hover:border-blue-200'
                    }`}
                  >
                    <div className="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full -z-0 opacity-50 group-hover:bg-blue-100 transition-colors"></div>
                    <div className="relative z-10 flex flex-col h-full">
                      <div className="flex items-start justify-between mb-3">
                        <h3 className="font-bold text-slate-800 text-sm">
                          {promo.bank}
                        </h3>
                        <div className="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap">
                          Vigente
                        </div>
                      </div>

                      <div className="text-blue-600 font-bold text-lg mb-2 flex items-center gap-1.5">
                        <CreditCard size={16} />
                        {promo.installments}
                      </div>

                      {promo.notes && (
                        <p className="text-xs text-slate-500 mt-auto pt-3 border-t border-slate-100">
                          {promo.notes}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-white flex justify-end">
              <Button
                onClick={() => setIsPromosModalOpen(false)}
                variant="primary"
                className="rounded-xl px-6"
              >
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SaleMetadataSection;
