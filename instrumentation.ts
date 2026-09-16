// La reparación del esquema se ejecuta desde /api/health/db.
// No importar Prisma desde instrumentation: Next analiza este archivo durante
// el build y puede compilarlo como Edge, donde no existen fs/path/crypto.
export async function register() {}
