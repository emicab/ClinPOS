import React, { useState, useRef } from "react";
import Papa from "papaparse";
import toast from "react-hot-toast";
import { Upload, X, CheckCircle, AlertCircle, FileText } from "lucide-react";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";

interface CSVImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const SYSTEM_FIELDS = [
  { key: "name", label: "Nombre / Descripción (*)", required: true },
  { key: "sku", label: "SKU / Código", required: false },
  { key: "description", label: "Observaciones / Notas", required: false },
  { key: "pricePurchase", label: "Precio de Compra / Costo", required: false },
  { key: "priceSale", label: "Precio de Venta (*)", required: true },
  { key: "quantityStock", label: "Stock / Cantidad (*)", required: true },
  { key: "stockMinAlert", label: "Alerta Stock Mínimo", required: false },
  { key: "brandName", label: "Marca", required: false },
  { key: "categoryName", label: "Categoría / Rubro", required: false },
  { key: "supplierName", label: "Proveedor", required: false },
];

const readFileContent = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      const utf8 = new TextDecoder("utf-8").decode(buffer);
      resolve(
        utf8.includes("\uFFFD")
          ? new TextDecoder("windows-1252").decode(buffer)
          : utf8,
      );
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

/**
 * Normaliza un SKU preservándolo como texto.
 * Si Excel exportó el código en notación científica (ej. "1.11111E+11"),
 * lo expande a entero y avisa que el valor pudo perder precisión
 * (Excel redondea los dígitos al exportar así).
 * Devuelve { value, expanded } donde expanded indica que hubo conversión.
 */
const sanitizeSku = (raw: string): { value: string; expanded: boolean } => {
  const value = raw.trim();
  if (!value) return { value: "", expanded: false };
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return { value: num.toFixed(0), expanded: true };
    }
  }
  return { value, expanded: false };
};

const sanitizeNumeric = (raw: string): string => {
  let value = raw.trim().replace(/\s+/g, "").replace(/[^0-9.,-]/g, "");
  if (!value) return value;
  if (value.includes(",")) {
    const parts = value.split(",");
    const lastPart = parts[parts.length - 1];
    if (lastPart.includes(".")) {
      // La coma era separador de miles (formato 1,234.56)
      value = value.replace(/,/g, "");
    } else {
      // La coma es el separador decimal (formato 1.234,56 / 34000,56)
      const decimals = lastPart.replace(/\./g, "");
      const integer = parts.slice(0, -1).join("").replace(/\./g, "");
      value = `${integer}.${decimals}`;
    }
  }
  return value;
};

const CSVImportModal: React.FC<CSVImportModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);

    try {
      const content = await readFileContent(selectedFile);
      Papa.parse(content, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.meta.fields) {
            setCsvHeaders(results.meta.fields);
            setCsvData(results.data);
            autoMapFields(results.meta.fields);
          } else {
            toast.error("No se pudieron detectar las cabeceras del CSV.");
          }
        },
        error: (error: Papa.ParseError) => {
          toast.error(`Error al leer CSV: ${error.message}`);
        },
      } as Papa.ParseConfig);
    } catch (err: any) {
      toast.error(`Error al leer el archivo: ${err.message}`);
    }
  };

  const autoMapFields = (headers: string[]) => {
    const initialMapping: Record<string, string> = {};
    const normalize = (h: string) =>
      h
        .toLowerCase()
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    const normalizedHeaders = headers.map((h) => normalize(h));

    const findHeader = (keywords: string[]) => {
      const normalizedKeywords = keywords.map((k) => normalize(k));
      for (const kw of normalizedKeywords) {
        const index = normalizedHeaders.findIndex((h) => h.includes(kw));
        if (index !== -1) return headers[index];
      }
      return "";
    };

    SYSTEM_FIELDS.forEach((field) => {
      let matched = "";
      switch (field.key) {
        case "name":
          matched = findHeader([
            "nombre",
            "descripción",
            "descripcion",
            "producto",
          ]);
          break;
        case "sku":
          matched = findHeader(["sku", "código", "codigo"]);
          break;
        case "description":
          matched = findHeader(["observación", "observacion", "nota"]);
          break;
        case "pricePurchase":
          matched = findHeader(["compra", "costo"]);
          break;
        case "priceSale":
          matched = findHeader(["venta", "precio"]);
          break;
        case "quantityStock":
          matched = findHeader(["stock", "cantidad"]);
          break;
        case "stockMinAlert":
          matched = findHeader(["mínimo", "minimo", "alerta"]);
          break;
        case "brandName":
          matched = findHeader(["marca"]);
          break;
        case "categoryName":
          matched = findHeader(["categoría", "categoria", "rubro"]);
          break;
        case "supplierName":
          matched = findHeader([
            "proveedor",
            "proveedores",
            // Tolerar typos comunes: falta una "e" (provedor/provedores,
            // provedoores) -> stems provee/proved los capturan igual
            "provedor",
            "provedores",
            "provedoores",
            "provee",
            "proved",
            "supplier",
            "suppliers",
          ]);
          break;
      }
      if (matched) initialMapping[field.key] = matched;
    });

    setMapping(initialMapping);
  };

  const handleMappingChange = (systemKey: string, csvHeader: string) => {
    setMapping((prev) => ({
      ...prev,
      [systemKey]: csvHeader,
    }));
  };

  const handleImport = async () => {
    // Validate required fields
    const missing = SYSTEM_FIELDS.filter((f) => f.required && !mapping[f.key]);
    if (missing.length > 0) {
      toast.error(
        `Faltan mapear campos obligatorios: ${missing.map((m) => m.label).join(", ")}`,
      );
      return;
    }

    setIsProcessing(true);

    // Transform data
    let skuExpandedCount = 0;
    const productsToImport = csvData
      .map((row) => {
        const product: any = {};
        SYSTEM_FIELDS.forEach((field) => {
          const csvCol = mapping[field.key];
          if (csvCol && row[csvCol] !== undefined) {
            let value = String(row[csvCol]).trim();

            // El SKU se preserva como texto; si viene en notación
            // científica (exportado por Excel) se expande con aviso.
            if (field.key === "sku") {
              const sanitized = sanitizeSku(value);
              value = sanitized.value;
              if (sanitized.expanded) skuExpandedCount++;
            }

            // Sanear números: normalizar separador decimal (coma -> punto) y quitar separadores de miles
            if (
              [
                "pricePurchase",
                "priceSale",
                "quantityStock",
                "stockMinAlert",
              ].includes(field.key)
            ) {
              value = sanitizeNumeric(value);
            }

            product[field.key] = value;
          }
        });
        return product;
      })
      .filter((p) => p.name); // Ignore completely empty parsed rows without name

    try {
      const res = await fetch("/api/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: productsToImport }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.message || "Error al importar productos");
      }

      toast.success(result.message, { duration: 5000 });
      if (skuExpandedCount > 0) {
        toast(
          `${skuExpandedCount} SKU(s) venían en notación científica (ej. 1.11E+11) y se expandieron. Verificá que coincidan: Excel pudo haber redondeado los dígitos. Para evitarlo, formateá la columna como Texto antes de exportar.`,
          { duration: 8000 },
        );
      }
      if (
        Array.isArray(result.createdSuppliers) &&
        result.createdSuppliers.length > 0
      ) {
        toast.success(
          `${result.createdSuppliers.length} proveedor(es) creados desde el CSV: ${result.createdSuppliers.slice(0, 5).join(", ")}${result.createdSuppliers.length > 5 ? "…" : ""}`,
          { duration: 8000 },
        );
      }
      if (
        Array.isArray(result.unlinkedSuppliers) &&
        result.unlinkedSuppliers.length > 0
      ) {
        toast(
          `${result.unlinkedSuppliers.length} producto(s) quedaron sin proveedor (valor omitido o inválido): ${result.unlinkedSuppliers.slice(0, 5).join(", ")}${result.unlinkedSuppliers.length > 5 ? "…" : ""}`,
          { duration: 8000 },
        );
      }
      onSuccess();
      handleClose();
    } catch (err: any) {
      toast.error(err.message || "Error inesperado durante la importación");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (!isProcessing) {
      setFile(null);
      setCsvHeaders([]);
      setCsvData([]);
      setMapping({});
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-background w-full max-w-2xl rounded-lg shadow-xl border border-border flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            Importar Productos desde CSV
          </h2>
          <button
            onClick={handleClose}
            disabled={isProcessing}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Step 1: File Selection */}
          {!file && (
            <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed border-border rounded-lg bg-muted/30">
              <Upload size={48} className="text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                Seleccioná tu archivo CSV
              </h3>
              <p className="text-sm text-foreground-muted mb-4 text-center">
                El archivo debe contener cabeceras en la primera fila.
              </p>
              <Button onClick={() => fileInputRef.current?.click()}>
                Buscar Archivo
              </Button>
              <input
                type="file"
                accept=".csv"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileChange}
              />
            </div>
          )}

          {/* Step 2: Mapping */}
          {file && csvHeaders.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-primary/10 border border-primary/20 rounded-md">
                <div className="flex items-center gap-3">
                  <FileText className="text-primary" />
                  <div>
                    <p className="font-medium text-foreground">{file.name}</p>
                    <p className="text-xs text-foreground-muted">
                      {csvData.length} filas detectadas
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFile(null)}
                  disabled={isProcessing}
                >
                  Cambiar archivo
                </Button>
              </div>

              <div className="bg-background border border-border rounded-md overflow-hidden">
                <div className="grid grid-cols-2 bg-muted p-3 border-b border-border">
                  <div className="font-semibold text-sm text-foreground">
                    Campo del Sistema
                  </div>
                  <div className="font-semibold text-sm text-foreground">
                    Columna de tu CSV
                  </div>
                </div>
                <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
                  {SYSTEM_FIELDS.map((field) => (
                    <div
                      key={field.key}
                      className="grid grid-cols-2 p-3 items-center gap-4"
                    >
                      <div className="text-sm font-medium flex items-center gap-2">
                        {field.label}
                        {field.required && !mapping[field.key] && (
                          <AlertCircle size={14} className="text-destructive" />
                        )}
                        {field.required && mapping[field.key] && (
                          <CheckCircle size={14} className="text-success" />
                        )}
                      </div>
                      <div>
                        <Select
                          value={mapping[field.key] || ""}
                          onChange={(e) =>
                            handleMappingChange(field.key, e.target.value)
                          }
                          disabled={isProcessing}
                        >
                          <option value="">-- Ignorar este campo --</option>
                          {csvHeaders.map((header) => (
                            <option key={header} value={header}>
                              {header}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {!mapping["supplierName"] && (
                <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-md">
                  <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-foreground-muted">
                    La columna de Proveedor quedó en “-- Ignorar este campo --”.
                    Si tu CSV trae proveedor (ej. columnas “proveedor”,
                    “proveedores” o “provedores”), seleccionala arriba en el
                    campo Proveedor, si no los productos se crearán sin
                    proveedor.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-border mt-4">
                <Button
                  variant="outline"
                  onClick={handleClose}
                  disabled={isProcessing}
                >
                  Cancelar
                </Button>
                <Button onClick={handleImport} disabled={isProcessing}>
                  {isProcessing ? "Procesando..." : "Confirmar e Importar"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CSVImportModal;
