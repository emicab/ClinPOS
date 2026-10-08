import prisma from './prisma';
import fs from 'fs';
import path from 'path';
import { decryptText } from './encryption';

// Utilizaremos require para evitar problemas con los tipos y la carga de CommonJS del SDK de AFIP
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Afip = require('@afipsdk/afip.js');

interface ArcaConfig {
  enabled: boolean;
  cuit: string;
  pointOfSale: number;
  env: 'homologacion' | 'produccion';
  cert: string;
  key: string;
  ivaCondition: string;
}

/**
 * Obtiene la configuración de ARCA desde la base de datos
 */
export async function getArcaConfig(): Promise<ArcaConfig> {
  const settings = await prisma.setting.findMany();
  const configMap: Record<string, string> = {};
  for (const s of settings) {
    configMap[s.key] = s.value;
  }

  return {
    enabled: configMap.arcaEnabled === 'true',
    cuit: configMap.arcaCuit || '',
    pointOfSale: parseInt(configMap.arcaPointOfSale || '1', 10),
    env: (configMap.arcaEnv as 'homologacion' | 'produccion') || 'homologacion',
    cert: configMap.arcaCert || '',
    key: configMap.arcaKey || '',
    ivaCondition: configMap.arcaIvaCondition || 'RI',
  };
}

/**
 * Versiones anteriores dejaban el certificado y la clave privada ya descifrados
 * en <cwd>/scratch/.certs. Se eliminan si existen.
 */
function removeLegacyPlaintextCerts() {
  try {
    const certsDir = path.join(process.cwd(), 'scratch', '.certs');
    if (fs.existsSync(certsDir)) {
      fs.rmSync(certsDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * Inicializa e instancia el SDK de AFIP/ARCA
 */
export async function getAfipInstance(config: ArcaConfig) {
  if (!config.cuit) {
    throw new Error('El CUIT de ARCA no está configurado.');
  }

  const options: any = {
    CUIT: parseInt(config.cuit.replace(/\D/g, ''), 10),
    production: config.env === 'produccion',
  };

  // @afipsdk/afip.js recibe el certificado y la clave como texto PEM (no como
  // rutas). Antes se escribian descifrados en scratch/.certs y quedaban en disco
  // para siempre: ahora solo viven en memoria.
  if (config.cert && config.key) {
    options.cert = decryptText(config.cert).trim();
    options.key = decryptText(config.key).trim();
    removeLegacyPlaintextCerts();
  } else if (config.env === 'produccion') {
    throw new Error('Certificados de producción no provistos.');
  }

  return new Afip(options);
}

/**
 * Retorna el código numérico de comprobante de AFIP
 */
export function getAfipInvoiceTypeCode(type: string): number {
  switch (type.toUpperCase()) {
    case 'A': return 1;    // Factura A
    case 'B': return 6;    // Factura B
    case 'C': return 11;   // Factura C
    case 'NCA': return 3;  // Nota de Crédito A
    case 'NCB': return 8;  // Nota de Crédito B
    case 'NCC': return 13; // Nota de Crédito C
    default: throw new Error(`Tipo de comprobante no soportado: ${type}`);
  }
}

/**
 * Retorna la condición de IVA del cliente según el código de AFIP
 */
export function getAfipDocType(cuitOrDni: string): number {
  const clean = cuitOrDni.replace(/\D/g, '');
  if (clean.length === 11) {
    return 80; // CUIT
  } else if (clean.length === 8 || clean.length === 7) {
    return 96; // DNI
  }
  return 99; // Sin identificar (Consumidor Final)
}

/**
 * Solicita el CAE a ARCA y registra la Factura en la base de datos
 */
export async function createElectronicInvoice(
  saleId: number,
  invoiceType: 'A' | 'B' | 'C' | 'NCA' | 'NCB' | 'NCC',
  customClientCuit?: string,
  customClientName?: string
) {
  const config = await getArcaConfig();
  if (!config.enabled) {
    throw new Error('La facturación electrónica está desactivada en la configuración.');
  }

  // Buscar detalles de la venta
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: {
      items: {
        include: { product: true }
      },
      client: true,
    }
  });

  if (!sale) {
    throw new Error(`No se encontró la venta con ID ${saleId}`);
  }

  // Verificar si ya tiene una factura
  const existingInvoice = await prisma.invoice.findUnique({
    where: { saleId }
  });
  if (existingInvoice) {
    return existingInvoice;
  }

  const afip = await getAfipInstance(config);

  // Sin documento informado: Consumidor Final (99, nro 0). Antes se enviaba DNI (96)
  // con numero 0 si el cliente tenia telefono o email, y ARCA lo rechaza.
  const docType = customClientCuit
    ? getAfipDocType(customClientCuit)
    : 99;

  const docNumber = customClientCuit 
    ? parseInt(customClientCuit.replace(/\D/g, ''), 10) 
    : 0;

  const cbteTipo = getAfipInvoiceTypeCode(invoiceType);
  const ptoVta = config.pointOfSale;

  // Obtener último número de factura autorizado para este punto de venta y tipo
  const lastVoucher = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
  const nextNumber = lastVoucher + 1;

  // Importes en pesos con 2 decimales exactos (ARCA exige neto + IVA = total).
  const totalAmount = Math.round(Number(sale.totalAmount) * 100) / 100;
  
  // Para simplificar, consideramos servicios / bienes según corresponda. Concepto: 1 (Bienes)
  const concepto = 1; 

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // AAAAMMDD

  // Detalle del IVA (AFIP WSFEv1 requiere desglosar IVA o enviarlo con alícuotas agrupadas)
  // Nota: Por defecto, si el emisor es Monotributista (Factura C), el IVA no se discrimina (se envía sin IVA en el array de alícuotas).
  // Si es Responsable Inscripto (Factura A o B):
  // Factura B a Consumidor Final: El total ya incluye IVA, pero AFIP requiere enviar el array de alícuotas detallado.
  // Simplificación de cálculo de IVA (ejemplo asumiendo alícuota estándar 21%):
  // En una app real de producción, el IVA debería tomarse del modelo Product.
  const isC = invoiceType === 'C' || invoiceType === 'NCC';
  
  let ImpIVA = 0;
  let ImpNeto = totalAmount;
  let ivaArray: any[] = [];

  if (!isC) {
    // Supongamos tasa del 21% para todo como base (se puede parametrizar)
    // ImpNeto + ImpIVA = totalAmount
    // ImpNeto * 1.21 = totalAmount
    ImpNeto = Math.round((totalAmount / 1.21) * 100) / 100;
    // El IVA se obtiene por diferencia para que ImpNeto + ImpIVA == ImpTotal siempre.
    ImpIVA = Math.round((totalAmount - ImpNeto) * 100) / 100;

    ivaArray = [
      {
        Id: 5, // 21%
        BaseImp: ImpNeto,
        Importe: ImpIVA
      }
    ];
  }

  const data: any = {
    CantReg: 1,
    PtoVta: ptoVta,
    CbteTipo: cbteTipo,
    Concepto: concepto,
    DocTipo: docType,
    DocNro: docNumber,
    CbteDesde: nextNumber,
    CbteHasta: nextNumber,
    CbteFch: dateStr,
    ImpTotal: totalAmount,
    ImpTotConc: 0,
    ImpNeto: ImpNeto,
    ImpOpEx: 0,
    ImpTrib: 0,
    ImpIVA: ImpIVA,
    MonId: 'PES',
    MonCotiz: 1,
  };

  if (ivaArray.length > 0) {
    data.Iva = ivaArray;
  }

  // Llamar a la API de AFIP
  const res = await afip.ElectronicBilling.createVoucher(data);

  if (!res || !res.CAE) {
    throw new Error('AFIP/ARCA no retornó un CAE válido para la factura.');
  }

  // Guardar factura en base de datos
  const invoice = await prisma.invoice.create({
    data: {
      saleId: sale.id,
      cae: res.CAE,
      caeExpiration: new Date(
        res.CAEFchVto.slice(0, 4) + '-' + res.CAEFchVto.slice(4, 6) + '-' + res.CAEFchVto.slice(6, 8)
      ),
      invoiceType,
      invoiceNumber: nextNumber,
      pointOfSale: ptoVta,
      clientCuit: customClientCuit || null,
      clientName: customClientName || sale.client?.firstName || 'Consumidor Final',
      xmlRequest: JSON.stringify(data),
      xmlResponse: JSON.stringify(res),
    }
  });

  return invoice;
}
