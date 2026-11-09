// test/helpers/api.ts
// Harness para invocar handlers de `pages/api` como los invoca Next, pero
// contra una base aislada.
//
// El handler importa `lib/prisma`, que es un Proxy con un PrismaClient cacheado
// en `globalThis.__clinposClients`. Para cambiar de base hay que:
//   1. desconectar y limpiar ese cache,
//   2. apuntar DATABASE_URL al archivo del test,
//   3. invalidar el cache del perfil activo y del flag de nube.
import type { NextApiRequest, NextApiResponse } from "next";
import { createTestDb, type TestDb } from "./db";
import { toFileUrl } from "./paths";
import { resetProfileCache } from "../../lib/prisma";
import { invalidateCloudPolicyCache } from "../../lib/cloudPolicy";

interface ClientCache {
  defaultClient: { $disconnect: () => Promise<void> } | null;
  clients: Map<string, { $disconnect: () => Promise<void> }>;
}

async function resetGlobalClients(): Promise<void> {
  const g = globalThis as any;
  const cache: ClientCache | undefined = g.__clinposClients;
  if (!cache) return;

  const all = [cache.defaultClient, ...cache.clients.values()].filter(
    (c): c is { $disconnect: () => Promise<void> } => Boolean(c),
  );
  await Promise.all(all.map((c) => c.$disconnect().catch(() => undefined)));

  // lib/prisma capturó este objeto al importarse: hay que mutarlo, no
  // reemplazarlo, o el proxy seguiría usando clientes ya desconectados.
  cache.defaultClient = null;
  cache.clients.clear();
}

/**
 * Crea una base aislada y hace que `lib/prisma` (y todo lo que lo importa)
 * apunte a ella. Devolver el `TestDb` permite consultar el estado final.
 */
export async function setupApi(label = "api"): Promise<TestDb> {
  const t = await createTestDb(label);

  await resetGlobalClients();
  process.env.DATABASE_URL = toFileUrl(t.file);
  resetProfileCache();
  invalidateCloudPolicyCache();

  return t;
}

/**
 * Desconecta el cliente global ANTES de borrar el archivo: en Windows un
 * SQLite abierto no se puede eliminar.
 */
export async function teardownApi(t: TestDb): Promise<void> {
  await resetGlobalClients();
  await t.cleanup();
}

export function mockReq(
  body: unknown,
  options: { method?: string; query?: Record<string, string> } = {},
): NextApiRequest {
  return {
    method: options.method ?? "POST",
    body,
    query: options.query ?? {},
    headers: {},
    cookies: {},
  } as unknown as NextApiRequest;
}

export interface MockRes extends NextApiResponse {
  statusCode: number;
  body: any;
}

export function mockRes(): MockRes {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  } as unknown as MockRes;

  return res;
}

/** Ejecuta el handler y devuelve la respuesta capturada. */
export async function callHandler(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>,
  req: NextApiRequest,
): Promise<MockRes> {
  const res = mockRes();
  await handler(req, res);
  return res;
}
