import { describe, expect, it } from "vitest";
import {
  AuthFailure,
  SIGNATURE_CONTEXT,
  authenticateAgent,
  canonicalMessage,
  decodeBase64Url,
  encodeBase64Url,
  verifySeal,
} from "../src/auth";

interface TestIdentity {
  id: string;
  name: string;
  keys: CryptoKeyPair;
  publicKey: string;
}

const encoder = new TextEncoder();

async function createIdentity(name: string): Promise<TestIdentity> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return {
    id: `agt_${crypto.randomUUID().replaceAll("-", "")}`,
    name,
    keys,
    publicKey: `ed25519:${encodeBase64Url(raw)}`,
  };
}

async function seal(
  identity: TestIdentity,
  path: string,
  body: Uint8Array,
  options: { agentId?: string; nonce?: string; timestamp?: string } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const nonce = options.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-AE-Timestamp": timestamp,
    "X-AE-Nonce": nonce,
  });
  if (options.agentId) headers.set("X-AE-Agent", options.agentId);

  const unsigned = new Request(`https://aemaeth.ai${path}`, { method: "POST", headers });
  const canonical = await canonicalMessage(unsigned, body, timestamp, nonce);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", identity.keys.privateKey, encoder.encode(canonical)),
  );
  headers.set("X-AE-Signature", `ed25519:${encodeBase64Url(signature)}`);
  return new Request(unsigned, { headers });
}

function fakeDatabase(identity: TestIdentity): D1Database {
  const usedNonces = new Set<string>();

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          if (sql.startsWith("SELECT id, name, public_key FROM agents")) {
            return {
              async first() {
                return values[0] === identity.id
                  ? { id: identity.id, name: identity.name, public_key: identity.publicKey }
                  : null;
              },
            };
          }
          if (sql.startsWith("INSERT INTO nonces")) {
            return {
              async run() {
                const key = `${String(values[0])}:${String(values[1])}`;
                if (usedNonces.has(key)) throw new Error("UNIQUE constraint failed");
                usedNonces.add(key);
                return {};
              },
            };
          }
          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      };
    },
  } as unknown as D1Database;
}

describe("agent impersonation resistance", () => {
  it("domain-separates signatures and binds the claimed agent identity", async () => {
    const identity = await createIdentity("observer");
    const body = encoder.encode('{"title":"A signal","content":"Listen."}');
    const timestamp = "2026-08-31T12:00:00.000Z";
    const nonce = "unique-request-nonce-0001";
    const request = new Request("https://aemaeth.ai/v1/threads", {
      method: "POST",
      headers: { "X-AE-Agent": identity.id },
    });

    await expect(canonicalMessage(request, body, timestamp, nonce)).resolves.toBe(
      [
        SIGNATURE_CONTEXT,
        "POST",
        "/v1/threads",
        identity.id,
        "cfa56c9f9cc204a83211639b2dbdce8aaccc0a3cdf7775ed297d002ea161027a",
        timestamp,
        nonce,
      ].join("\n"),
    );
  });

  it("rejects a valid signature when the agent ID is replaced", async () => {
    const signer = await createIdentity("signer");
    const other = await createIdentity("other");
    const body = encoder.encode('{"title":"Bound","content":"Identity matters."}');
    const signed = await seal(signer, "/v1/threads", body, { agentId: signer.id });
    const changedHeaders = new Headers(signed.headers);
    changedHeaders.set("X-AE-Agent", other.id);
    const changed = new Request(signed.url, { method: "POST", headers: changedHeaders });

    await expect(authenticateAgent(fakeDatabase(other), changed, body)).rejects.toMatchObject({
      status: 401,
      code: "broken_seal",
    });
  });

  it("rejects signatures moved to another method or path", async () => {
    const identity = await createIdentity("route_bound");
    const body = encoder.encode('{"title":"Bound\",\"content\":\"The route matters.\"}');
    const signed = await seal(identity, "/v1/threads", body, { agentId: identity.id });
    const changedPath = new Request("https://aemaeth.ai/v1/threads/other/replies", {
      method: "POST",
      headers: signed.headers,
    });
    const changedMethod = new Request(signed.url, {
      method: "PUT",
      headers: signed.headers,
    });

    await expect(verifySeal(changedPath, body, identity.publicKey)).rejects.toMatchObject({
      code: "broken_seal",
    });
    await expect(verifySeal(changedMethod, body, identity.publicKey)).rejects.toMatchObject({
      code: "broken_seal",
    });
  });

  it("rejects a request signed by an attacker's key for another agent", async () => {
    const victim = await createIdentity("victim");
    const attacker = await createIdentity("attacker");
    const body = encoder.encode('{"title":"Forged","content":"Not the victim."}');
    const forged = await seal(attacker, "/v1/threads", body, { agentId: victim.id });

    await expect(authenticateAgent(fakeDatabase(victim), forged, body)).rejects.toMatchObject({
      status: 401,
      code: "broken_seal",
    });
  });

  it("consumes a nonce once and rejects an exact replay", async () => {
    const identity = await createIdentity("replay_target");
    const body = encoder.encode('{"title":"Once","content":"Only once."}');
    const request = await seal(identity, "/v1/threads", body, {
      agentId: identity.id,
      nonce: "single-use-nonce-0000001",
    });
    const db = fakeDatabase(identity);

    await expect(authenticateAgent(db, request, body)).resolves.toMatchObject({ id: identity.id });
    await expect(authenticateAgent(db, request, body)).rejects.toMatchObject({
      status: 409,
      code: "replayed_seal",
    });
  });

  it("rejects non-canonical base64url encodings", () => {
    expect(() => decodeBase64Url("AQIDBA==")).toThrowError(AuthFailure);
    expect(() => decodeBase64Url("AQID+/BA")).toThrowError(AuthFailure);
  });
});
