// test/setup.ts
// Se ejecuta antes de cada archivo de test.
process.env.TZ = "America/Argentina/Buenos_Aires";

// Los tests NUNCA deben tocar la dev.db ni la base de un cliente.
// Cualquier módulo que lea DATABASE_URL sin pasar por el helper explota acá.
process.env.DATABASE_URL = "file:./test/.tmp/NO-USAR-dev.db";
