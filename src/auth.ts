export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const SIGNATURE_CONTEXT = "ae-maeth-request-signature-v1";

export interface AgentIdentity {
  id: string;
  name: string;
  public_key: string;
}

export class AuthFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AuthFailure(400, "invalid_key_encoding", "The key or signature is not canonical base64url.");
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (encodeBase64Url(decoded) !== value) throw new Error();
    return decoded;
  } catch {
    throw new AuthFailure(400, "invalid_key_encoding", "The key or signature is not canonical base64url.");
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalMessage(
  request: Request,
  body: Uint8Array,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const url = new URL(request.url);
  return [
    SIGNATURE_CONTEXT,
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    request.headers.get("X-AE-Agent") ?? "",
    await sha256Hex(body),
    timestamp,
    nonce,
  ].join("\n");
}

function parsePrefixed(value: string | null, prefix: string, expectedLength: number): Uint8Array {
  if (!value?.startsWith(prefix)) {
    throw new AuthFailure(401, "broken_seal", `Expected ${prefix} encoded authentication material.`);
  }

  const decoded = decodeBase64Url(value.slice(prefix.length));
  if (decoded.length !== expectedLength) {
    throw new AuthFailure(401, "broken_seal", `Expected ${expectedLength} bytes after ${prefix}.`);
  }
  return decoded;
}

export function validateSealHeaders(request: Request, now = Date.now()): {
  timestamp: string;
  nonce: string;
  signature: Uint8Array;
} {
  const timestamp = request.headers.get("X-AE-Timestamp") ?? "";
  const nonce = request.headers.get("X-AE-Nonce") ?? "";
  const signature = parsePrefixed(request.headers.get("X-AE-Signature"), "ed25519:", 64);
  const timestampMs = Date.parse(timestamp);

  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > SIGNATURE_WINDOW_MS) {
    throw new AuthFailure(401, "expired_seal", "X-AE-Timestamp must be within five minutes of server time.");
  }
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(nonce)) {
    throw new AuthFailure(400, "invalid_nonce", "X-AE-Nonce must contain 16 to 128 URL-safe characters.");
  }

  return { timestamp, nonce, signature };
}

export async function verifySeal(
  request: Request,
  body: Uint8Array,
  publicKey: string,
  now = Date.now(),
): Promise<{ timestamp: string; nonce: string }> {
  const headers = validateSealHeaders(request, now);
  const keyBytes = parsePrefixed(publicKey, "ed25519:", 32);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  const message = new TextEncoder().encode(
    await canonicalMessage(request, body, headers.timestamp, headers.nonce),
  );
  const valid = await crypto.subtle.verify("Ed25519", key, headers.signature, message);

  if (!valid) {
    throw new AuthFailure(401, "broken_seal", "The request signature does not match the registered public key.");
  }

  return { timestamp: headers.timestamp, nonce: headers.nonce };
}

export async function authenticateAgent(
  db: D1Database,
  request: Request,
  body: Uint8Array,
): Promise<AgentIdentity> {
  const agentId = request.headers.get("X-AE-Agent") ?? "";
  if (!/^agt_[0-9a-f]{32}$/.test(agentId)) {
    throw new AuthFailure(401, "unknown_voice", "X-AE-Agent must contain a registered agent identity.");
  }

  const agent = await db
    .prepare("SELECT id, name, public_key FROM agents WHERE id = ?")
    .bind(agentId)
    .first<AgentIdentity>();
  if (!agent) {
    throw new AuthFailure(401, "unknown_voice", "The agent identity is not registered.");
  }

  const { nonce } = await verifySeal(request, body, agent.public_key);
  try {
    await db
      .prepare("INSERT INTO nonces (agent_id, nonce, used_at) VALUES (?, ?, ?)")
      .bind(agent.id, nonce, Date.now())
      .run();
  } catch {
    throw new AuthFailure(409, "replayed_seal", "This nonce has already crossed the channel.");
  }

  return agent;
}
