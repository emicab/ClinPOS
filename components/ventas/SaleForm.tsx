"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import { useSaleState } from "@/hooks/useSaleState";
import { SaleInputSection } from "./subcomponents/SaleInputSection";
import { SaleMetadataSection } from "./subcomponents/SaleMetadataSection";
import { SaleCartTable } from "./subcomponents/SaleCartTable";
import { SaleTotalsPanel } from "./subcomponents/SaleTotalsPanel";
import { SaleQuickAccess } from "./subcomponents/SaleQuickAccess";
import WeightModal from "@/components/ventas/WeightModal";
import UnitTypeModal from "@/components/ventas/UnitTypeModal";
import { getPaymentTypeDisplay } from "@/lib/displayTexts";
import { formatCurrency } from "@/lib/formatCurrency";
import CajaModal from "./CajaModal";

const SaleForm = () => {
  const router = useRouter();
  const {
    isModuleEnabled,
    formData,
    clientSearchTerm,
    searchedClients,
    productSearchTerm,
    searchedProducts,
    searchedCombos,
    recentProducts,
    categoryProducts,
    isLoadingCategoryProducts,
    selectedClient,
    sellers,
    combos,
    isLoading,
    isFetchingInitialData,
    lastCreatedSale,
    setLastCreatedSale,
    showCajaModal,
    setShowCajaModal,
    isOpeningCaja,
    setIsOpeningCaja,
    showUnitTypeModal,
    setShowUnitTypeModal,
    pendingUnitTypeProduct,
    setPendingUnitTypeProduct,
    showWeightModal,
    setShowWeightModal,
    weightInputValue,
    pendingWeightProduct,
    setPendingWeightProduct,
    pendingWeightUnitType,
    productInputRef,
    clientInputRef,
    submitButtonRef,
    validDiscountCode,
    comboDiscount,
    totals,
    appliedPromotion,
    clearCart,
    handleClientSearchChange,
    handleSelectClient,
    handleClearClientSelection,
    handleProductSearchChange,
    handleProductKeyDown,
    handleSelectProduct,
    handleWeightConfirm,
    handleConfirmUnitType,
    handleItemDetailChange,
    handleRemoveItem,
    handleFormChange,
    setFormData,
    handleSelectCombo,
    handleSubmit,
    handleSaveOrder,
    handleOpenCajaFromSale,
    config,
    invoiceType,
    setInvoiceType,
    clientCuit,
    setClientCuit,
    clientName,
    setClientName,
  } = useSaleState();

  const handleCloseSuccessModal = React.useCallback(() => {
    setLastCreatedSale(null);
    setTimeout(() => {
      productInputRef.current?.focus();
    }, 100);
  }, [setLastCreatedSale, productInputRef]);

  React.useEffect(() => {
    if (!lastCreatedSale) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCloseSuccessModal();
        return;
      }
      if (e.key === "Enter") {
        const activeElement = document.activeElement;
        if (activeElement?.id === "ws-phone-input") {
          e.preventDefault();
          const sendBtn = document.getElementById("ws-send-btn");
          if (sendBtn) sendBtn.click();
          return;
        }
        e.preventDefault();
        handleCloseSuccessModal();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lastCreatedSale, handleCloseSuccessModal]);

  if (isFetchingInitialData) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 size={24} className="animate-spin text-primary mr-2" />{" "}
        Cargando datos...
      </div>
    );
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        noValidate
        className="font-sans grid grid-cols-1 lg:grid-cols-3 gap-6 items-start"
      >
        {/* COLUMNA IZQUIERDA (2/3 de pantalla): Operación, Carrito y Detalles */}
        <div className="lg:col-span-2 space-y-5 bg-white border border-border p-5 rounded-2xl shadow-sm flex flex-col">
          {/* Fila de Entrada: Código / Búsqueda */}
          <SaleInputSection
            productSearchTerm={productSearchTerm}
            searchedProducts={searchedProducts}
            searchedCombos={searchedCombos}
            productInputRef={productInputRef}
            handleProductSearchChange={handleProductSearchChange}
            handleProductKeyDown={handleProductKeyDown}
            handleSelectProduct={handleSelectProduct}
            handleSelectCombo={handleSelectCombo}
          />

          {/* Listado de Combos y Recientes (Opcional, en base a módulos) */}
          {combos.length > 0 && (
            // Una sola fila con scroll horizontal: con muchos combos una grilla que envuelve
            // empujaba hacia abajo el resto de la pantalla de venta.
            <div className="flex items-center gap-2 py-1">
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                Combos
              </span>
              <div className="flex gap-1.5 overflow-x-auto pb-1 min-w-0">
                {combos.map((combo) => (
                  <button
                    key={combo.id}
                    type="button"
                    onClick={() => handleSelectCombo(combo)}
                    title={`${combo.name} (${formatCurrency(Number(combo.price))})`}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold border border-amber-400/40 bg-amber-500/5 text-amber-700 hover:bg-amber-100/50 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {combo.name}{" "}
                    <span className="opacity-80">({formatCurrency(Number(combo.price))})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Paneles de Metadatos: Datos de Venta y Cliente */}
          <SaleMetadataSection
            formData={formData}
            sellers={sellers}
            clientSearchTerm={clientSearchTerm}
            searchedClients={searchedClients}
            selectedClient={selectedClient}
            clientInputRef={clientInputRef}
            isModuleEnabled={isModuleEnabled}
            handleFormChange={handleFormChange}
            setFormData={setFormData}
            handleClientSearchChange={handleClientSearchChange}
            handleSelectClient={handleSelectClient}
            handleClearClientSelection={handleClearClientSelection}
            config={config}
            invoiceType={invoiceType}
            setInvoiceType={setInvoiceType}
            clientCuit={clientCuit}
            setClientCuit={setClientCuit}
            clientName={clientName}
            setClientName={setClientName}
          />

          {/* Carrito de Compras Inline */}
          <SaleCartTable
            items={formData.items}
            handleItemDetailChange={handleItemDetailChange}
            handleRemoveItem={handleRemoveItem}
            clearCart={clearCart}
          />
        </div>

        {/* COLUMNA DERECHA (1/3 de pantalla): Totales y Catálogo Rápido */}
        <div className="lg:col-span-1 space-y-5">
          {/* Panel de Totales */}
          <SaleTotalsPanel
            items={formData.items}
            totals={totals}
            comboDiscount={comboDiscount}
            appliedPromotion={appliedPromotion}
            validDiscountCode={validDiscountCode}
            isLoading={isLoading}
            onSaveOrder={handleSaveOrder}
          />

          {/* Quick-Add Panel */}
          <SaleQuickAccess
            isLoadingCategoryProducts={isLoadingCategoryProducts}
            recentProducts={recentProducts}
            categoryProducts={categoryProducts}
            handleSelectProduct={handleSelectProduct}
          />
        </div>

        {/* Ref de submit oculto para compatibilidad con shortcuts */}
        <button ref={submitButtonRef} type="submit" className="hidden" />
      </form>

      {/* Modales */}
      <WeightModal
        isOpen={showWeightModal}
        productName={pendingWeightProduct?.name || ""}
        unitType={pendingWeightUnitType}
        initialValue={weightInputValue}
        maxStock={pendingWeightProduct?.quantityStock}
        onConfirm={handleWeightConfirm}
        onCancel={() => {
          setShowWeightModal(false);
          setPendingWeightProduct(null);
          productInputRef.current?.focus();
        }}
      />

      <UnitTypeModal
        isOpen={showUnitTypeModal}
        productName={pendingUnitTypeProduct?.name || ""}
        onConfirm={handleConfirmUnitType}
        onCancel={() => {
          setShowUnitTypeModal(false);
          setPendingUnitTypeProduct(null);
        }}
      />

      <CajaModal
        isOpen={showCajaModal}
        sellers={sellers}
        isOpening={isOpeningCaja}
        onOpen={(sellerId, initialBalance) =>
          handleOpenCajaFromSale(sellerId, initialBalance)
        }
        onCancel={() => {
          setShowCajaModal(false);
          productInputRef.current?.focus();
          setIsOpeningCaja(false);
        }}
      />

      {lastCreatedSale && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 cursor-pointer"
          onClick={handleCloseSuccessModal}
        >
          <div
            className="bg-white border border-border w-full max-w-md rounded-2xl shadow-xl overflow-hidden p-6 space-y-4 text-center cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto h-12 w-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2.5"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 12.75l6 6 9-13.5"
                />
              </svg>
            </div>

            <div className="space-y-1">
              <h3 className="text-lg font-bold text-foreground">
                {(lastCreatedSale as any).status === 'PENDING' ? "¡Pedido Guardado!" : "¡Venta Registrada!"}
              </h3>
              <p className="text-xs text-foreground-muted">
                El {(lastCreatedSale as any).status === 'PENDING' ? "pedido" : "comprobante de venta"} N°{" "}
                <strong>#{lastCreatedSale.id}</strong> se ha {(lastCreatedSale as any).status === 'PENDING' ? "guardado" : "registrado"} con éxito.
              </p>
            </div>

            <div className="bg-slate-50 border border-border rounded-xl p-4 space-y-1.5 text-xs text-left">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Cliente:</span>
                <span className="font-semibold text-foreground text-right truncate max-w-[200px]">
                  {lastCreatedSale.client
                    ? `${lastCreatedSale.client.firstName} ${lastCreatedSale.client.lastName || ""}`.trim()
                    : "Consumidor Final"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Importe Total:</span>
                <span className="font-bold text-primary font-mono text-sm">
                  $
                  {parseFloat(lastCreatedSale.totalAmount).toLocaleString(
                    "es-AR",
                    { minimumFractionDigits: 2 },
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Método de Pago:</span>
                <span className="font-semibold text-foreground uppercase text-[10px]">
                  {getPaymentTypeDisplay(lastCreatedSale.paymentType)}
                </span>
              </div>
            </div>

            {/* Compartir por WhatsApp */}
            <div className="space-y-2 pt-2 border-t border-border">
              <div className="text-xs text-left font-bold text-foreground flex items-center gap-1.5">
                <svg
                  className="h-4 w-4 text-emerald-600 shrink-0"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.73-1.464L0 24zm6.59-4.846c1.6.95 3.198 1.451 4.937 1.452 5.466 0 9.909-4.444 9.913-9.91.002-2.651-1.02-5.143-2.877-7.001C16.808 1.838 14.321.815 11.99.815c-5.474 0-9.919 4.444-9.924 9.91-.001 1.89.504 3.734 1.466 5.361l-.961 3.507 3.577-.938zm11.567-7.643c-.307-.154-1.82-.9-2.1-.1-.28.1-.56.56-.687.7-.128.14-.256.155-.563.002-.307-.154-1.3-.478-2.477-1.528-.915-.815-1.532-1.822-1.712-2.129-.18-.308-.019-.475.135-.629.138-.138.307-.359.461-.539.154-.18.205-.308.307-.513.102-.206.051-.385-.026-.539-.077-.154-.687-1.657-.942-2.27-.249-.598-.5-.517-.687-.527-.179-.009-.385-.01-.59-.01-.205 0-.539.077-.82.385-.282.308-1.077 1.051-1.077 2.562 0 1.512 1.102 2.973 1.256 3.178.154.205 2.169 3.313 5.253 4.643.734.316 1.307.505 1.753.647.737.234 1.407.2 1.938.12.593-.09 1.82-.743 2.076-1.461.256-.718.256-1.333.179-1.461-.077-.128-.282-.205-.59-.359z" />
                </svg>
                Compartir ticket por WhatsApp
              </div>
              <div className="flex gap-2">
                <input
                  type="tel"
                  placeholder="Número de celular (ej: 1112345678)"
                  className="flex-1 text-xs border border-border rounded-xl px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                  defaultValue={lastCreatedSale.client?.phone || ""}
                  id="ws-phone-input"
                />
                <button
                  id="ws-send-btn"
                  type="button"
                  onClick={() => {
                    const phoneEl = document.getElementById(
                      "ws-phone-input",
                    ) as HTMLInputElement;
                    const phoneVal = phoneEl
                      ? phoneEl.value.replace(/\D/g, "")
                      : "";
                    if (!phoneVal) {
                      toast.error("Ingrese un número de teléfono.");
                      return;
                    }
                    const finalPhone = phoneVal.startsWith("54")
                      ? phoneVal
                      : "549" + phoneVal;
                    const clientName = lastCreatedSale.client
                      ? `${lastCreatedSale.client.firstName} ${lastCreatedSale.client.lastName || ""}`.trim()
                      : "Cliente";
                    
                    let message = `Hola ${clientName}! 👋\n\nTe adjuntamos el detalle de tu compra N° #${lastCreatedSale.id}:\n\n`;
                    lastCreatedSale.items.forEach((item: any) => {
                        message += `- ${item.quantity}x ${item.product?.name || item.productName || 'Producto'} ($${parseFloat(item.priceAtSale).toLocaleString("es-AR", { minimumFractionDigits: 2 })})\n`;
                    });
                    
                    if (lastCreatedSale.discountCodeApplied) {
                        message += `\nDescuento aplicado: ${lastCreatedSale.discountCodeApplied}`;
                    }
                    
                    message += `\n\n*TOTAL: $${parseFloat(lastCreatedSale.totalAmount).toLocaleString("es-AR", { minimumFractionDigits: 2 })}*\n\n¡Muchas gracias por elegirnos!`;

                    // Dynamic import to avoid SSR crash
                    import('@tauri-apps/plugin-shell').then(({ open }) => {
                      open(`https://wa.me/${finalPhone}?text=${encodeURIComponent(message)}`);
                    }).catch(() => {
                      window.open(`https://wa.me/${finalPhone}?text=${encodeURIComponent(message)}`, '_blank');
                    });
                  }}
                  className="px-3.5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl active:scale-[0.97] transition-all cursor-pointer border-0"
                >
                  Enviar
                </button>
              </div>
            </div>

            <div className="pt-4 border-t border-border flex justify-end gap-2 text-xs">
              <Button
                variant="outline"
                className="rounded-xl border-emerald-600/30 text-emerald-700 hover:bg-emerald-50"
                onClick={() => router.push(`/ventas/${lastCreatedSale.id}`)}
              >
                Ver Detalles
              </Button>
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={handleCloseSuccessModal}
              >
                Nueva Venta
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SaleForm;
