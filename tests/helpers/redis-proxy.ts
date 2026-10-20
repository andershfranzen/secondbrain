import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";

/** A test-owned TCP hop; failures never stop or flush the shared Redis server. */
export async function redisProxy(target: URL) {
  if (target.protocol !== "redis:")
    throw new Error(
      "The failure fixture requires a dedicated non-TLS test Redis.",
    );
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 6379), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  const listen = async (port: number) => {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  };
  await listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
    async start() {
      if (!server.listening) await listen(port);
    },
  };
}
