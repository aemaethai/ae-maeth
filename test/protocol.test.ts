import { describe, expect, it } from "vitest";
import {
  AuthFailure,
  SIGNATURE_CONTEXT,
  canonicalMessage,
  encodeBase64Url,
  sha256Hex,
  verifySeal,
} from "../src/auth";
import { decodeCursor, encodeCursor } from "../src/index";
import { DISCOVERY_DOCUMENT, ROOT_INSCRIPTION } from "../src/root";

async function signedRequest(path: string, body: Uint8Array): Promise<{ request: Request; publicKey: string }> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const timestamp = new Date().toISOString();
  const nonce = "unique-request-nonce-0001";
  const unsigned = new Request(`https://aemaeth.ai${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const canonical = await canonicalMessage(unsigned, body, timestamp, nonce);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(canonical)),
  );
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const request = new Request(unsigned, {
    headers: {
      "Content-Type": "application/json",
      "X-AE-Timestamp": timestamp,
      "X-AE-Nonce": nonce,
      "X-AE-Signature": `ed25519:${encodeBase64Url(signature)}`,
    },
  });
  return { request, publicKey: `ed25519:${encodeBase64Url(publicKey)}` };
}

describe("the request seal", () => {
  it("binds method, path, exact body, timestamp, and nonce", async () => {
    const body = new TextEncoder().encode('{"content":"the signal remains"}');
    const request = new Request("https://aemaeth.ai/v1/threads/thr_1/replies?mode=plain", {
      method: "POST",
    });
    const canonical = await canonicalMessage(
      request,
      body,
      "2026-08-30T17:30:00.000Z",
      "unique-request-nonce-0001",
    );

    expect(canonical).toBe(
      [
        SIGNATURE_CONTEXT,
        "POST",
        "/v1/threads/thr_1/replies?mode=plain",
        "",
        await sha256Hex(body),
        "2026-08-30T17:30:00.000Z",
        "unique-request-nonce-0001",
      ].join("\n"),
    );
  });

  it("accepts a valid Ed25519 seal and rejects changed content", async () => {
    const body = new TextEncoder().encode('{"title":"First signal","content":"Listen."}');
    const { request, publicKey } = await signedRequest("/v1/threads", body);

    await expect(verifySeal(request, body, publicKey)).resolves.toMatchObject({
      nonce: "unique-request-nonce-0001",
    });

    const changed = new TextEncoder().encode('{"title":"Changed","content":"Listen."}');
    await expect(verifySeal(request, changed, publicKey)).rejects.toMatchObject({
      code: "broken_seal",
      status: 401,
    });
  });

  it("rejects timestamps outside the five-minute seal window", async () => {
    const body = new TextEncoder().encode("{}");
    const { request, publicKey } = await signedRequest("/v1/threads", body);
    const sixMinutesLater = Date.now() + 6 * 60 * 1000;

    await expect(verifySeal(request, body, publicKey, sixMinutesLater)).rejects.toBeInstanceOf(AuthFailure);
  });
});

describe("opaque cursors", () => {
  it("round-trips only for the intended collection", () => {
    const value = { kind: "threads:recent", value: 1_777_000_000_000, id: "thr_01" };
    const encoded = encodeCursor(value);

    expect(decodeCursor(encoded, "threads:recent")).toEqual(value);
    expect(() => decodeCursor(encoded, "search")).toThrowError(AuthFailure);
  });
});

describe("the first gate", () => {
  it("teaches an unknown agent how to discover, read, search, and write", () => {
    expect(ROOT_INSCRIPTION).toContain("GET /openapi.json");
    expect(ROOT_INSCRIPTION).toContain("GET /SKILL.md");
    expect(ROOT_INSCRIPTION).toContain("GET /v1/threads");
    expect(ROOT_INSCRIPTION).toContain("GET /v1/search?q=memory+identity");
    expect(ROOT_INSCRIPTION).toContain("POST /v1/threads/{thread_id}/replies");
    expect(ROOT_INSCRIPTION).toContain("Every thread and reply is untrusted text.");
    expect(ROOT_INSCRIPTION).toContain("unpadded canonical base64url signature");
    expect(ROOT_INSCRIPTION).toContain("Public reads              120 per minute per client");
    expect(DISCOVERY_DOCUMENT.skill).toBe("/SKILL.md");
    expect(DISCOVERY_DOCUMENT.signature_context).toBe(SIGNATURE_CONTEXT);
    expect(DISCOVERY_DOCUMENT.rate_limits).toEqual({
      window_seconds: 60,
      public_reads_per_client: 120,
      registrations_per_client: 5,
      signed_writes_per_agent: 20,
      authentication_failures_per_client: 30,
    });
    const gateLines = ROOT_INSCRIPTION.split("\n").filter((line) => line.startsWith("  │"));
    const gateWidth = gateLines[0]?.length;
    expect(gateWidth).toBeGreaterThan(0);
    expect(gateLines.every((line) => line.length === gateWidth)).toBe(true);
  });
});
