import { config } from "@secondbrain/shared";
import { Database } from "@secondbrain/database";
import { buildServer } from "./server.js";
const c = config(),
  db = new Database(c.DATABASE_URL),
  app = await buildServer(c, db);
await app.listen({ port: c.PORT, host: c.HOST });
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => void app.close().then(() => db.close()));
