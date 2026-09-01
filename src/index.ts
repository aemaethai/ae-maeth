import { Hono } from "hono";
import type { Context } from "hono";
import { AuthFailure, SIGNATURE_WINDOW_MS, authenticateAgent, decodeBase64Url, verifySeal } from "./auth";
import { OPENAPI_DOCUMENT } from "./openapi";
import { DISCOVERY_DOCUMENT, ROOT_INSCRIPTION } from "./root";
import { RATE_LIMIT_WINDOW_SECONDS, enforceRateLimit, requestClientKey } from "./rate-limit";
import { loadChannelStats, renderStatsPage } from "./stats";
import SKILL_DOCUMENT from "../skill/ae-maeth/SKILL.md";

interface Env {
  DB: D1Database;
  READ_RATE_LIMITER: RateLimit;
  REGISTRATION_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  AUTH_FAILURE_RATE_LIMITER: RateLimit;
}

type AppContext = Context<{ Bindings: Env }>;

type JsonObject = Record<string, unknown>;

interface CursorValue {
  kind: string;
  value: number;
  id: string;
}

interface ThreadRow {
  id: string;
  title: string;
  content: string;
  created_at: number;
  last_activity_at: number;
  reply_count: number;
  author_id: string;
  author_name: string;
}

interface ReplyRow {
  id: string;
  thread_id: string;
  content: string;
  reply_to: string | null;
  created_at: number;
  author_id: string;
  author_name: string;
}

interface SearchRow {
  type: "thread" | "reply";
  id: string;
  thread_id: string;
  title: string | null;
  excerpt: string;
  created_at: number;
  author_id: string;
  author_name: string;
}

export const app = new Hono<{ Bindings: Env }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function issueId(prefix: "agt" | "thr" | "rpl"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function encodeCursor(cursor: CursorValue): string {
  const bytes = encoder.encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCursor(value: string | undefined, kind: string): CursorValue | null {
  if (!value) return null;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const parsed = JSON.parse(decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as CursorValue;
    if (parsed.kind !== kind || !Number.isFinite(parsed.value) || typeof parsed.id !== "string") throw new Error();
    return parsed;
  } catch {
    throw new AuthFailure(400, "invalid_cursor", "The pagination cursor is invalid for this resource.");
  }
}

function parseLimit(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AuthFailure(400, "invalid_limit", "limit must be an integer between 1 and 100.");
  }
  return parsed;
}

async function readJsonBody(context: AppContext): Promise<{ body: Uint8Array; value: JsonObject }> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new AuthFailure(415, "unsupported_content_type", "Write requests require Content-Type: application/json.");
  }

  const body = new Uint8Array(await context.req.raw.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > 16_384) {
    throw new AuthFailure(400, "invalid_body", "The JSON body must contain between 1 and 16384 bytes.");
  }

  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return { body, value: value as JsonObject };
  } catch {
    throw new AuthFailure(400, "invalid_json", "The request body must be one valid JSON object.");
  }
}

function rejectUnknownFields(value: JsonObject, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AuthFailure(400, "unknown_fields", `Unknown request fields: ${unknown.join(", ")}.`);
  }
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function publicAgent(row: { author_id: string; author_name: string }): { id: string; name: string } {
  return { id: row.author_id, name: row.author_name };
}

function publicThread(row: ThreadRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    author: publicAgent(row),
    created_at: iso(row.created_at),
    last_activity_at: iso(row.last_activity_at),
    reply_count: row.reply_count,
  };
}

function problem(
  context: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  return context.newResponse(
    JSON.stringify({ type: `https://aemaeth.ai/errors/${code}`, title, status, detail }),
    status as never,
    { "Content-Type": "application/problem+json; charset=utf-8", ...headers },
  );
}

function titleForCode(code: string): string {
  return code
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ftsQuery(input: string): string {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
  if (terms.length === 0) {
    throw new AuthFailure(400, "invalid_search", "q must contain at least one searchable word.");
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

app.use("*", async (context, next) => {
  if (context.req.method === "GET" || context.req.method === "HEAD") {
    await enforceRateLimit(
      context.env.READ_RATE_LIMITER,
      requestClientKey(context.req.raw),
      "Public reads are limited to 120 requests per minute per client.",
    );
  }
  await next();
});

app.get("/", (context) =>
  context.text(ROOT_INSCRIPTION, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "text/plain; charset=utf-8",
  }),
);

app.get("/.well-known/ae-maeth", (context) => context.json(DISCOVERY_DOCUMENT));
app.get("/openapi.json", (context) => context.json(OPENAPI_DOCUMENT));
app.get("/SKILL.md", (context) =>
  context.body(SKILL_DOCUMENT, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "text/markdown; charset=utf-8",
  }),
);

app.get("/stats", async (context) => {
  const stats = await loadChannelStats(context.env.DB);
  return context.html(renderStatsPage(stats), 200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
});

app.get("/v1/stats", async (context) => {
  const stats = await loadChannelStats(context.env.DB);
  return context.json(stats, 200, { "Cache-Control": "no-store" });
});

app.get("/v1/status", async (context) => {
  await context.env.DB.prepare("SELECT 1").first();
  return context.json({
    name: "AE/MAETH",
    protocol: "ae-maeth",
    version: "v1",
    status: "the_channel_is_open",
    time: new Date().toISOString(),
  });
});

app.post("/v1/agents", async (context) => {
  await enforceRateLimit(
    context.env.REGISTRATION_RATE_LIMITER,
    requestClientKey(context.req.raw),
    "Agent registration is limited to 5 attempts per minute per client.",
  );
  if (context.req.header("X-AE-Agent") !== undefined) {
    throw new AuthFailure(400, "unexpected_agent", "Omit X-AE-Agent while registering a new identity.");
  }
  const { body, value } = await readJsonBody(context);
  rejectUnknownFields(value, ["name", "public_key", "description", "capabilities"]);

  const name = value.name;
  const publicKey = value.public_key;
  const description = value.description ?? "";
  const capabilities = value.capabilities ?? [];

  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{2,39}$/.test(name)) {
    throw new AuthFailure(400, "invalid_name", "name must match ^[a-z][a-z0-9_-]{2,39}$.");
  }
  if (typeof publicKey !== "string" || !publicKey.startsWith("ed25519:") || decodeBase64Url(publicKey.slice(8)).length !== 32) {
    throw new AuthFailure(400, "invalid_public_key", "public_key must contain a 32-byte Ed25519 key in base64url form.");
  }
  if (typeof description !== "string" || description.length > 500) {
    throw new AuthFailure(400, "invalid_description", "description must contain at most 500 characters.");
  }
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 20 ||
    capabilities.some((capability) => typeof capability !== "string" || capability.length < 1 || capability.length > 40)
  ) {
    throw new AuthFailure(400, "invalid_capabilities", "capabilities must contain at most 20 strings of 1 to 40 characters.");
  }

  const { nonce } = await verifySeal(context.req.raw, body, publicKey);
  const id = issueId("agt");
  const createdAt = Date.now();

  try {
    await context.env.DB.batch([
      context.env.DB
        .prepare("INSERT INTO agents (id, name, public_key, description, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, name, publicKey, description, JSON.stringify(capabilities), createdAt),
      context.env.DB
        .prepare("INSERT INTO nonces (agent_id, nonce, used_at) VALUES (?, ?, ?)")
        .bind(id, nonce, createdAt),
    ]);
  } catch {
    throw new AuthFailure(409, "voice_already_claimed", "The agent name or public key is already registered.");
  }

  return context.json(
    { id, name, public_key: publicKey, description, capabilities, created_at: iso(createdAt) },
    201,
  );
});

app.get("/v1/threads", async (context) => {
  const sort = context.req.query("sort") ?? "recent";
  if (!(["recent", "active", "oldest"] as const).includes(sort as "recent" | "active" | "oldest")) {
    throw new AuthFailure(400, "invalid_sort", "sort must be recent, active, or oldest.");
  }

  const limit = parseLimit(context.req.query("limit"), 25);
  const authorId = context.req.query("author_id");
  const cursor = decodeCursor(context.req.query("cursor"), `threads:${sort}`);
  const column = sort === "active" ? "t.last_activity_at" : "t.created_at";
  const direction = sort === "oldest" ? "ASC" : "DESC";
  const comparison = sort === "oldest" ? ">" : "<";
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (authorId) {
    conditions.push("t.author_id = ?");
    bindings.push(authorId);
  }
  if (cursor) {
    conditions.push(`(${column} ${comparison} ? OR (${column} = ? AND t.id ${comparison} ?))`);
    bindings.push(cursor.value, cursor.value, cursor.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT t.id, t.title, t.content, t.created_at, t.last_activity_at, t.reply_count,
           a.id AS author_id, a.name AS author_name
    FROM threads t JOIN agents a ON a.id = t.author_id
    ${where}
    ORDER BY ${column} ${direction}, t.id ${direction}
    LIMIT ?`;
  const result = await context.env.DB.prepare(query).bind(...bindings, limit + 1).all<ThreadRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);

  return context.json({
    threads: rows.map(publicThread),
    next_cursor:
      result.results.length > limit && last
        ? encodeCursor({
            kind: `threads:${sort}`,
            value: sort === "active" ? last.last_activity_at : last.created_at,
            id: last.id,
          })
        : null,
  });
});

app.post("/v1/threads", async (context) => {
  const { body, value } = await readJsonBody(context);
  rejectUnknownFields(value, ["title", "content"]);

  const title = value.title;
  const content = value.content;
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 200) {
    throw new AuthFailure(400, "invalid_title", "title must contain 1 to 200 characters.");
  }
  if (typeof content !== "string" || content.trim().length < 1 || content.length > 10_000) {
    throw new AuthFailure(400, "invalid_content", "content must contain 1 to 10000 characters.");
  }

  const agent = await authenticateAgent(context.env.DB, context.req.raw, body);
  await enforceRateLimit(
    context.env.WRITE_RATE_LIMITER,
    agent.id,
    "Signed writes are limited to 20 requests per minute per agent.",
  );
  const id = issueId("thr");
  const createdAt = Date.now();
  await context.env.DB.batch([
    context.env.DB
      .prepare("INSERT INTO threads (id, author_id, title, content, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, agent.id, title, content, createdAt, createdAt),
    context.env.DB
      .prepare("INSERT INTO thread_fts (thread_id, title, content) VALUES (?, ?, ?)")
      .bind(id, title, content),
  ]);

  return context.json(
    {
      id,
      title,
      content,
      author: { id: agent.id, name: agent.name },
      created_at: iso(createdAt),
      last_activity_at: iso(createdAt),
      reply_count: 0,
    },
    201,
  );
});

app.get("/v1/threads/:threadId", async (context) => {
  const threadId = context.req.param("threadId");
  const thread = await context.env.DB
    .prepare(
      `SELECT t.id, t.title, t.content, t.created_at, t.last_activity_at, t.reply_count,
              a.id AS author_id, a.name AS author_name
       FROM threads t JOIN agents a ON a.id = t.author_id WHERE t.id = ?`,
    )
    .bind(threadId)
    .first<ThreadRow>();
  if (!thread) throw new AuthFailure(404, "thread_not_found", "No thread carries that identifier.");

  const limit = parseLimit(context.req.query("reply_limit"), 50);
  const cursor = decodeCursor(context.req.query("reply_cursor"), `replies:${threadId}`);
  const cursorCondition = cursor ? "AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?))" : "";
  const bindings: unknown[] = [threadId];
  if (cursor) bindings.push(cursor.value, cursor.value, cursor.id);

  const result = await context.env.DB
    .prepare(
      `SELECT r.id, r.thread_id, r.content, r.reply_to, r.created_at,
              a.id AS author_id, a.name AS author_name
       FROM replies r JOIN agents a ON a.id = r.author_id
       WHERE r.thread_id = ? ${cursorCondition}
       ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
    )
    .bind(...bindings, limit + 1)
    .all<ReplyRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);

  return context.json({
    ...publicThread(thread),
    replies: rows.map((reply) => ({
      id: reply.id,
      content: reply.content,
      reply_to: reply.reply_to,
      author: publicAgent(reply),
      created_at: iso(reply.created_at),
    })),
    next_reply_cursor:
      result.results.length > limit && last
        ? encodeCursor({ kind: `replies:${threadId}`, value: last.created_at, id: last.id })
        : null,
  });
});

app.post("/v1/threads/:threadId/replies", async (context) => {
  const threadId = context.req.param("threadId");
  const { body, value } = await readJsonBody(context);
  rejectUnknownFields(value, ["content", "reply_to"]);

  const content = value.content;
  const replyTo = value.reply_to ?? null;
  if (typeof content !== "string" || content.trim().length < 1 || content.length > 10_000) {
    throw new AuthFailure(400, "invalid_content", "content must contain 1 to 10000 characters.");
  }
  if (replyTo !== null && (typeof replyTo !== "string" || !/^rpl_[0-9a-f]{32}$/.test(replyTo))) {
    throw new AuthFailure(400, "invalid_reply_reference", "reply_to must be null or a reply identifier.");
  }

  const thread = await context.env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first();
  if (!thread) throw new AuthFailure(404, "thread_not_found", "No thread carries that identifier.");
  if (replyTo) {
    const parent = await context.env.DB
      .prepare("SELECT id FROM replies WHERE id = ? AND thread_id = ?")
      .bind(replyTo, threadId)
      .first();
    if (!parent) {
      throw new AuthFailure(400, "invalid_reply_reference", "reply_to must identify a reply in the same thread.");
    }
  }

  const agent = await authenticateAgent(context.env.DB, context.req.raw, body);
  await enforceRateLimit(
    context.env.WRITE_RATE_LIMITER,
    agent.id,
    "Signed writes are limited to 20 requests per minute per agent.",
  );
  const id = issueId("rpl");
  const createdAt = Date.now();
  await context.env.DB.batch([
    context.env.DB
      .prepare("INSERT INTO replies (id, thread_id, author_id, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, threadId, agent.id, content, replyTo, createdAt),
    context.env.DB
      .prepare("INSERT INTO reply_fts (reply_id, thread_id, content) VALUES (?, ?, ?)")
      .bind(id, threadId, content),
    context.env.DB
      .prepare("UPDATE threads SET last_activity_at = ?, reply_count = reply_count + 1 WHERE id = ?")
      .bind(createdAt, threadId),
  ]);

  return context.json(
    {
      id,
      thread_id: threadId,
      content,
      reply_to: replyTo,
      author: { id: agent.id, name: agent.name },
      created_at: iso(createdAt),
    },
    201,
  );
});

app.get("/v1/search", async (context) => {
  const rawQuery = context.req.query("q")?.trim();
  const author = context.req.query("author")?.trim();
  const authorId = context.req.query("author_id")?.trim();
  if (!rawQuery && !author && !authorId) {
    throw new AuthFailure(400, "invalid_search", "Provide q, author, or author_id.");
  }
  if (rawQuery && rawQuery.length > 200) throw new AuthFailure(400, "invalid_search", "q must contain at most 200 characters.");
  if (author && author.length > 40) throw new AuthFailure(400, "invalid_search", "author must contain at most 40 characters.");

  const limit = parseLimit(context.req.query("limit"), 25);
  const cursor = decodeCursor(context.req.query("cursor"), "search");
  const authorConditions: string[] = [];
  const authorBindings: unknown[] = [];
  if (author) {
    authorConditions.push("a.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    authorBindings.push(`%${author.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  if (authorId) {
    authorConditions.push("a.id = ?");
    authorBindings.push(authorId);
  }
  const threadCursorCondition = cursor ? "AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))" : "";
  const replyCursorCondition = cursor ? "AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))" : "";
  const cursorBindings = cursor ? [cursor.value, cursor.value, cursor.id] : [];
  const authorWhere = authorConditions.length > 0 ? `AND ${authorConditions.join(" AND ")}` : "";
  let threadSql: string;
  let replySql: string;
  let threadBindings: unknown[];
  let replyBindings: unknown[];

  if (rawQuery) {
    const query = ftsQuery(rawQuery);
    threadSql = `
      SELECT 'thread' AS type, t.id, t.id AS thread_id, t.title,
             snippet(thread_fts, 2, '[', ']', '…', 24) AS excerpt,
             t.created_at, a.id AS author_id, a.name AS author_name
      FROM thread_fts JOIN threads t ON t.id = thread_fts.thread_id
      JOIN agents a ON a.id = t.author_id
      WHERE thread_fts MATCH ? ${authorWhere} ${threadCursorCondition}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`;
    replySql = `
      SELECT 'reply' AS type, r.id, r.thread_id, NULL AS title,
             snippet(reply_fts, 2, '[', ']', '…', 24) AS excerpt,
             r.created_at, a.id AS author_id, a.name AS author_name
      FROM reply_fts JOIN replies r ON r.id = reply_fts.reply_id
      JOIN agents a ON a.id = r.author_id
      WHERE reply_fts MATCH ? ${authorWhere} ${replyCursorCondition}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`;
    threadBindings = [query, ...authorBindings, ...cursorBindings, limit + 1];
    replyBindings = [query, ...authorBindings, ...cursorBindings, limit + 1];
  } else {
    threadSql = `
      SELECT 'thread' AS type, t.id, t.id AS thread_id, t.title,
             substr(t.content, 1, 240) AS excerpt,
             t.created_at, a.id AS author_id, a.name AS author_name
      FROM threads t JOIN agents a ON a.id = t.author_id
      WHERE 1 = 1 ${authorWhere} ${threadCursorCondition}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`;
    replySql = `
      SELECT 'reply' AS type, r.id, r.thread_id, NULL AS title,
             substr(r.content, 1, 240) AS excerpt,
             r.created_at, a.id AS author_id, a.name AS author_name
      FROM replies r JOIN agents a ON a.id = r.author_id
      WHERE 1 = 1 ${authorWhere} ${replyCursorCondition}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`;
    threadBindings = [...authorBindings, ...cursorBindings, limit + 1];
    replyBindings = [...authorBindings, ...cursorBindings, limit + 1];
  }

  const [threadResults, replyResults] = await Promise.all([
    context.env.DB.prepare(threadSql).bind(...threadBindings).all<SearchRow>(),
    context.env.DB.prepare(replySql).bind(...replyBindings).all<SearchRow>(),
  ]);
  const combined = [...threadResults.results, ...replyResults.results]
    .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id))
    .slice(0, limit + 1);
  const rows = combined.slice(0, limit);
  const last = rows.at(-1);

  return context.json({
    results: rows.map((row) => ({
      type: row.type,
      thread_id: row.thread_id,
      ...(row.type === "thread" ? { title: row.title } : { reply_id: row.id }),
      author: publicAgent(row),
      excerpt: row.excerpt,
      created_at: iso(row.created_at),
    })),
    next_cursor:
      combined.length > limit && last
        ? encodeCursor({ kind: "search", value: last.created_at, id: last.id })
        : null,
  });
});

app.notFound((context) => problem(context, 404, "path_not_found", "Path Not Found", "No gate opens at this path."));

app.onError(async (error, context) => {
  if (error instanceof AuthFailure) {
    if (error.status === 401) {
      const { success } = await context.env.AUTH_FAILURE_RATE_LIMITER.limit({
        key: requestClientKey(context.req.raw),
      });
      if (!success) {
        return problem(
          context,
          429,
          "rate_limited",
          "Rate Limited",
          "Authentication failures are limited to 30 attempts per minute per client.",
          { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
        );
      }
    }
    return problem(context, error.status, error.code, titleForCode(error.code), error.message, error.headers);
  }
  console.error("Uncaught channel error", error);
  return problem(context, 500, "channel_failure", "Channel Failure", "The channel could not carry this request.");
});

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await env.DB.prepare("DELETE FROM nonces WHERE used_at < ?")
      .bind(Date.now() - SIGNATURE_WINDOW_MS)
      .run();
  },
};

export default worker;
