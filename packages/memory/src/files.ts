import { open, mkdir, rename, unlink, stat, readdir } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { type Readable } from "node:stream";
import { createHash } from "node:crypto";
import { exec } from "@secondbrain/ai";
import { type Config, randomUUID, fail } from "@secondbrain/shared";
import { type Database, one, enqueue } from "@secondbrain/database";
export function privatePath(c: Config, key: string) {
  if (
    !/^(audio|exports|staging)\/[0-9a-f-]{36}\.(webm|mp4|mp3|wav|ogg|zip|part)$/.test(
      key,
    )
  )
    fail(400, "INVALID_PATH", "Invalid storage key.");
  const root = resolve(c.DATA_DIR);
  return join(root, key);
}
export async function initStorage(c: Config) {
  for (const dir of ["audio", "exports", "staging", "secrets"])
    await mkdir(join(resolve(c.DATA_DIR), dir), {
      recursive: true,
      mode: 0o700,
    });
}
export async function openPrivate(c: Config, key: string) {
  return open(privatePath(c, key), constants.O_RDONLY | constants.O_NOFOLLOW);
}
export async function removePrivate(c: Config, key: string) {
  await unlink(privatePath(c, key)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
export async function captureAudio(
  db: Database,
  c: Config,
  stream: Readable,
  clientCaptureId: string,
  mime: string,
  assertComplete?: () => Promise<void>,
  io: { open: typeof open; rename: typeof rename } = { open, rename },
) {
  const id = randomUUID(),
    stage = `staging/${id}.part`;
  await initStorage(c);
  await db.query(
    `INSERT INTO upload_leases(storage_key,expires_at) VALUES($1,now()+interval '1 hour')`,
    [stage],
  );
  let finalKey: string | undefined,
    accepted = false;
  try {
    const f = await io.open(privatePath(c, stage), "wx", 0o600),
      digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const part of stream) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > c.MAX_UPLOAD_BYTES)
          fail(413, "UPLOAD_TOO_LARGE", "Upload too large");
        digest.update(chunk);
        await f.writeFile(chunk);
      }
      await f.sync();
    } finally {
      await f.close();
    }
    if ((stream as Readable & { truncated?: boolean }).truncated)
      fail(413, "UPLOAD_TOO_LARGE", "Recording exceeds the upload limit.");
    if (assertComplete) await assertComplete();
    if (!bytes) fail(422, "EMPTY_AUDIO", "The recording is empty.");
    let probe: any;
    try {
      const r = await exec(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          privatePath(c, stage),
        ],
        { timeout: 15000, maxBuffer: 1048576 },
      );
      probe = JSON.parse(r.stdout);
    } catch {
      fail(422, "INVALID_AUDIO", "This file is not supported audio.");
    }
    const duration = Number(probe.format?.duration),
      audio = probe.streams?.find((s: any) => s.codec_type === "audio");
    if (
      !audio ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > c.MAX_RECORDING_SECONDS
    )
      fail(
        422,
        "INVALID_AUDIO",
        "Audio must be valid and no longer than 30 minutes.",
      );
    const format = String(probe.format.format_name),
      ext = format.includes("webm")
        ? "webm"
        : format.includes("mp4") || format.includes("mov")
          ? "mp4"
          : format.includes("mp3")
            ? "mp3"
            : format.includes("wav")
              ? "wav"
              : format.includes("ogg")
                ? "ogg"
                : null;
    if (!ext)
      fail(422, "UNSUPPORTED_AUDIO", "Use WebM, MP4, MP3, WAV or Ogg audio.");
    const expectedMime: { [key: string]: string[] } = {
      webm: ["audio/webm", "video/webm"],
      mp4: ["audio/mp4", "video/mp4", "audio/x-m4a"],
      mp3: ["audio/mpeg", "audio/mp3"],
      wav: ["audio/wav", "audio/x-wav"],
      ogg: ["audio/ogg", "application/ogg"],
    };
    if (mime && !expectedMime[ext]?.includes(mime.split(";")[0]!))
      fail(
        422,
        "MEDIA_MISMATCH",
        "The file content does not match its audio type.",
      );
    finalKey = `audio/${id}.${ext}`;
    await io.rename(privatePath(c, stage), privatePath(c, finalKey));
    const dir = await io.open(join(resolve(c.DATA_DIR), "audio"), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const digestHex = digest.digest("hex");
    const result = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        clientCaptureId,
      ]);
      const old = await one(
        tx,
        "SELECT * FROM conversations WHERE client_capture_id=$1",
        [clientCaptureId],
      );
      if (old) {
        if (old.payload_sha256 !== digestHex || old.mode !== "audio")
          fail(
            409,
            "CAPTURE_CONFLICT",
            "That capture ID belongs to another recording.",
          );
        return {
          conversation: old,
          job: await one(
            tx,
            "SELECT * FROM processing_jobs WHERE conversation_id=$1 ORDER BY created_at LIMIT 1",
            [old.id],
          ),
          replay: true,
        };
      }
      const settings = (await one(tx, "SELECT * FROM app_settings"))!;
      if (settings.maintenance)
        fail(503, "MAINTENANCE", "Backup in progress. Try again shortly.");
      const conversation = (await one(
        tx,
        `INSERT INTO conversations(client_capture_id,payload_sha256,mode,capture_timezone,state) VALUES($1,$2,'audio',$3,'queued') RETURNING *`,
        [clientCaptureId, digestHex, settings.timezone],
      ))!;
      await tx.query(
        `INSERT INTO attachments(conversation_id,storage_key,sha256,media_type,byte_size,duration_ms,retain_until) VALUES($1,$2,$3,$4,$5,$6,now()+($7*interval '1 day'))`,
        [
          conversation.id,
          finalKey,
          digestHex,
          expectedMime[ext]![0],
          bytes,
          Math.round(duration * 1000),
          settings.audio_retention_days,
        ],
      );
      const job = await enqueue(
        tx,
        "transcribe",
        `transcribe:${conversation.id}:1`,
        conversation.id,
      );
      accepted = true;
      return { conversation, job, replay: false };
    });
    return result;
  } finally {
    await db.query("DELETE FROM upload_leases WHERE storage_key=$1", [stage]);
    await removePrivate(c, stage);
    if (finalKey && !accepted) await removePrivate(c, finalKey);
  }
}
export async function sweepFiles(db: Database, c: Config) {
  for (const dir of ["audio", "staging", "exports"])
    for (const name of await readdir(join(resolve(c.DATA_DIR), dir))) {
      const key = `${dir}/${name}`;
      let path: string;
      try {
        path = privatePath(c, key);
      } catch {
        continue;
      }
      const s = await stat(path);
      if (Date.now() - s.mtimeMs < 86400000) continue;
      const referenced = await one(
        db,
        `SELECT 1 FROM attachments WHERE storage_key=$1 AND state<>'purged' UNION ALL SELECT 1 FROM exports WHERE storage_key=$1 AND expires_at>now() AND invalidated_at IS NULL UNION ALL SELECT 1 FROM upload_leases WHERE storage_key=$1 AND expires_at>now() LIMIT 1`,
        [key],
      );
      if (!referenced) await removePrivate(c, key);
    }
}
