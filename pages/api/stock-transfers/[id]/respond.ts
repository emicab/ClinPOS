// pages/api/stock-transfers/[id]/respond.ts
// El local DESTINO acepta o rechaza un traspaso recibido.
// - accept: confirma la recepción. Puede ajustar las cantidades recibidas
//   (siempre <= lo enviado); la diferencia se repone al local de origen.
// - reject: rechaza todo el envío y se repone el stock completo al origen.
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../../lib/prisma';
import { handleApiError } from '../../../../lib/apiErrorHandler';
import { getEffectiveDeviceBranchId } from '../../../../lib/branchIdentity';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  const transferId = Number(req.query.id);
  const { action, items } = req.body;

  try {
    if (isNaN(transferId)) {
      res.status(400).json({ message: 'ID de traspaso inválido.' });
      return;
    }

    const deviceBranchId = await getEffectiveDeviceBranchId();
    if (deviceBranchId === null) {
      res.status(403).json({ message: 'No se pudo determinar tu local.' });
      return;
    }

    const transfer = await (prisma as any).stockTransfer.findUnique({
      where: { id: transferId },
      include: { items: true },
    });
    if (!transfer) {
      res.status(404).json({ message: 'Traspaso no encontrado.' });
      return;
    }
    if (transfer.targetBranchId !== deviceBranchId) {
      res.status(403).json({ message: 'Solo el local destino puede responder este traspaso.' });
      return;
    }
    if (transfer.status !== 'SENT') {
      res.status(409).json({ message: 'Este traspaso ya fue respondido o cancelado.' });
      return;
    }

    if (action === 'reject') {
      await prisma.$transaction(async (tx: any) => {
      // Reclamar el traspaso de forma atomica: si otra peticion lo respondio entre
      // la lectura y esta transaccion, no se acredita el stock dos veces.
      const claimed = await tx.stockTransfer.updateMany({
        where: { id: transferId, status: 'SENT' },
        data: { status: 'PROCESSING' },
      });
      if (claimed.count === 0) throw new Error('TRANSFER_ALREADY_RESPONDED');
        for (const item of transfer.items) {
          await tx.productBranchStock.upsert({
            where: {
              productId_branchId: { productId: item.productId, branchId: transfer.sourceBranchId },
            },
            update: { quantityStock: { increment: item.quantity } },
            create: { productId: item.productId, branchId: transfer.sourceBranchId, quantityStock: item.quantity },
          });
        }
        await tx.stockTransfer.update({
          where: { id: transferId },
          data: { status: 'REJECTED' },
        });
      });

      const productIds = transfer.items.map((i: any) => i.productId);
      await runPostSync(productIds, transferId);
      res.status(200).json({ success: true, status: 'REJECTED' });
      return;
    }

    if (action !== 'accept') {
      res.status(400).json({ message: 'Acción inválida. Usá "accept" o "reject".' });
      return;
    }

    // Ajuste de cantidades recibidas (mapa productId -> cantidad recibida)
    const receivedMap: Record<number, number> = {};
    if (Array.isArray(items)) {
      for (const it of items) {
        receivedMap[Number(it.productId)] = parseFloat(it.quantityReceived) || 0;
      }
    }
    for (const item of transfer.items) {
      const received = receivedMap[item.productId] ?? item.quantity;
      if (received < 0 || received > item.quantity) {
        const product = item.productName || `Producto #${item.productId}`;
        res.status(400).json({
          message: `La cantidad recibida de "${product}" no puede ser mayor a lo enviado (${item.quantity}).`,
        });
        return;
      }
      receivedMap[item.productId] = received;
    }

    await prisma.$transaction(async (tx: any) => {
      // Reclamar el traspaso de forma atomica: si otra peticion lo respondio entre
      // la lectura y esta transaccion, no se acredita el stock dos veces.
      const claimed = await tx.stockTransfer.updateMany({
        where: { id: transferId, status: 'SENT' },
        data: { status: 'PROCESSING' },
      });
      if (claimed.count === 0) throw new Error('TRANSFER_ALREADY_RESPONDED');
      for (const item of transfer.items) {
        const received = receivedMap[item.productId] ?? item.quantity;

        if (received > 0) {
          await tx.productBranchStock.upsert({
            where: {
              productId_branchId: { productId: item.productId, branchId: transfer.targetBranchId },
            },
            update: { quantityStock: { increment: received } },
            create: { productId: item.productId, branchId: transfer.targetBranchId, quantityStock: received },
          });
        }

        // Lo que no llegó (enviado - recibido) se repone al origen
        const difference = item.quantity - received;
        if (difference > 0) {
          await tx.productBranchStock.upsert({
            where: {
              productId_branchId: { productId: item.productId, branchId: transfer.sourceBranchId },
            },
            update: { quantityStock: { increment: difference } },
            create: { productId: item.productId, branchId: transfer.sourceBranchId, quantityStock: difference },
          });
        }

        await tx.stockTransferItem.update({
          where: {
            transferId_productId: { transferId, productId: item.productId },
          },
          data: { receivedQuantity: received },
        });
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'COMPLETED' },
      });
    });

    const productIds = transfer.items.map((i: any) => i.productId);
    await runPostSync(productIds, transferId);
    res.status(200).json({ success: true, status: 'COMPLETED' });
  } catch (error) {
    if (error instanceof Error && error.message === 'TRANSFER_ALREADY_RESPONDED') {
      res.status(409).json({ message: 'Este traspaso ya fue respondido o cancelado.' });
      return;
    }
    handleApiError(res, error, "responding stock transfer");
  }
}

async function runPostSync(productIds: number[], transferId: number) {
  try {
    const { enqueueOutbox } = await import('../../../../lib/syncOutbox');
    await enqueueOutbox('StockTransfer', 'UPSERT', String(transferId));
    for (const pid of productIds) {
      await enqueueOutbox('Product', 'UPSERT', String(pid));
      await enqueueOutbox('ProductBranchStock', 'UPSERT', String(pid));
    }
  } catch (enqErr) {
    console.error('[Traspasos] Error al encolar post-respuesta:', enqErr);
  }
}
