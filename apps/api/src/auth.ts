import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import argon2 from "argon2";
import {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { type Database, one } from "@secondbrain/database";
import { type Config, hash, fail, z } from "@secondbrain/shared";
export function auth(db: Database, c: Config) {
  const passwordFile = join(resolve(c.DATA_DIR), "secrets", "password.hash"),
    secure = c.APP_ORIGIN.startsWith("https://");
  let loginAttempts: number[] = [];
  const cookie = {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
  };
  async function passwordHash() {
    try {
      return (await readFile(passwordFile, "utf8")).trim();
    } catch {
      return c.AUTH_PASSWORD_HASH ?? "";
    }
  }
  async function verify(password: string) {
    const encoded = await passwordHash();
    try {
      return !!encoded && (await argon2.verify(encoded, password));
    } catch {
      return false;
    }
  }
  async function requireSession(req: FastifyRequest) {
    const token = req.cookies.sb_session;
    if (!token) fail(401, "UNAUTHENTICATED", "Please sign in.");
    const s = await one(
      db,
      `UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND expires_at>now() AND last_seen_at>now()-interval '7 days' RETURNING *`,
      [hash(token)],
    );
    if (!s)
      fail(401, "UNAUTHENTICATED", "Your session expired. Please sign in.");
    return s;
  }
  async function protect(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split("?")[0]!;
    if (
      path === "/health/live" ||
      path === "/health/ready" ||
      path === "/api/v1/auth/csrf"
    )
      return;
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (mutation && req.headers.origin !== c.APP_ORIGIN)
      fail(403, "ORIGIN_DENIED", "Request origin is not allowed.");
    if (path === "/api/v1/auth/login") {
      loginAttempts = loginAttempts.filter((t) => t > Date.now() - 60000);
      if (loginAttempts.length >= 60)
        fail(
          429,
          "LOGIN_RATE_LIMIT",
          "Too many sign-in attempts. Try again in a minute.",
        );
      loginAttempts.push(Date.now());
      const signed = req.unsignCookie(req.cookies.sb_preauth ?? ""),
        token = req.headers["x-csrf-token"];
      if (!signed.valid || !token || signed.value !== token)
        fail(403, "CSRF_DENIED", "Refresh the sign-in form and try again.");
      return;
    }
    const session = await requireSession(req);
    (req as any).session = session;
    if (mutation) {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || hash(token) !== session.csrf_token_hash)
        fail(403, "CSRF_DENIED", "Refresh the page and try again.");
      if (
        (await one(db, "SELECT maintenance FROM app_settings"))?.maintenance
      ) {
        reply.header("Retry-After", "30");
        fail(503, "MAINTENANCE", "A backup is in progress. Try again shortly.");
      }
    }
  }
  async function register(app: FastifyInstance) {
    app.get("/api/v1/auth/csrf", async (req, reply) => {
      const token = randomBytes(32).toString("hex");
      if (req.cookies.sb_session) {
        const s = await one(
          db,
          "SELECT id FROM sessions WHERE token_hash=$1 AND expires_at>now()",
          [hash(req.cookies.sb_session)],
        );
        if (s)
          await db.query("UPDATE sessions SET csrf_token_hash=$1 WHERE id=$2", [
            hash(token),
            s.id,
          ]);
      }
      reply.setCookie("sb_preauth", token, {
        ...cookie,
        signed: true,
        maxAge: 600,
      });
      reply.setCookie("sb_csrf", token, { ...cookie, httpOnly: false });
      return { token };
    });
    app.post(
      "/api/v1/auth/login",
      { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const { password } = z
          .strictObject({ password: z.string().min(1).max(1024) })
          .parse(req.body);
        if (!(await verify(password)))
          fail(401, "INVALID_LOGIN", "Incorrect password.");
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        await db.query(
          `INSERT INTO sessions(token_hash,csrf_token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')`,
          [hash(token), hash(csrf)],
        );
        reply
          .clearCookie("sb_preauth", { path: "/" })
          .setCookie("sb_session", token, { ...cookie, maxAge: 30 * 86400 })
          .setCookie("sb_csrf", csrf, {
            ...cookie,
            httpOnly: false,
            maxAge: 30 * 86400,
          });
        return reply.code(204).send();
      },
    );
    app.post("/api/v1/auth/logout", async (req, reply) => {
      await db.query("DELETE FROM sessions WHERE id=$1", [
        (req as any).session.id,
      ]);
      reply
        .clearCookie("sb_session", { path: "/" })
        .clearCookie("sb_csrf", { path: "/" });
      return reply.code(204).send();
    });
    app.post("/api/v1/auth/logout-all", async (req, reply) => {
      const body = z
        .strictObject({ password: z.string().max(1024) })
        .parse(req.body);
      if (!(await verify(body.password)))
        fail(401, "INVALID_LOGIN", "Incorrect password.");
      await db.query("DELETE FROM sessions");
      return reply
        .clearCookie("sb_session", { path: "/" })
        .clearCookie("sb_csrf", { path: "/" })
        .code(204)
        .send();
    });
    app.post("/api/v1/auth/password", async (req, reply) => {
      const body = z
        .strictObject({
          currentPassword: z.string().max(1024),
          newPassword: z.string().min(12).max(1024),
        })
        .parse(req.body);
      if (!(await verify(body.currentPassword)))
        fail(401, "INVALID_LOGIN", "Incorrect password.");
      await mkdir(join(resolve(c.DATA_DIR), "secrets"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        passwordFile + ".new",
        await argon2.hash(body.newPassword, { type: argon2.argon2id }),
        { mode: 0o600 },
      );
      await rename(passwordFile + ".new", passwordFile);
      await db.query("DELETE FROM sessions");
      return reply.clearCookie("sb_session", { path: "/" }).code(204).send();
    });
  }
  return { protect, register };
}
