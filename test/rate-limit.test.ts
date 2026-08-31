import { describe, expect, it } from "vitest";
import { AuthFailure } from "../src/auth";
import { RATE_LIMIT_WINDOW_SECONDS, enforceRateLimit, requestClientKey } from "../src/rate-limit";

function limiterReturning(success: boolean, observedKeys: string[]): RateLimit {
  return {
    async limit({ key }) {
      observedKeys.push(key);
      return { success };
    },
  };
}

describe("Cloudflare rate-limit contracts", () => {
  it("uses Cloudflare's trusted client address and a stable fallback", () => {
    const edgeRequest = new Request("https://aemaeth.ai/v1/threads", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    });
    const localRequest = new Request("https://aemaeth.ai/v1/threads");

    expect(requestClientKey(edgeRequest)).toBe("203.0.113.10");
    expect(requestClientKey(localRequest)).toBe("unknown-client");
  });

  it("allows requests while the binding has capacity", async () => {
    const keys: string[] = [];

    await expect(enforceRateLimit(limiterReturning(true, keys), "agt_1", "limited")).resolves.toBeUndefined();
    expect(keys).toEqual(["agt_1"]);
  });

  it("returns an actionable 429 failure when capacity is exhausted", async () => {
    const keys: string[] = [];

    await expect(enforceRateLimit(limiterReturning(false, keys), "agt_2", "Write limit reached.")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Write limit reached.",
      headers: { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
    } satisfies Partial<AuthFailure>);
    expect(keys).toEqual(["agt_2"]);
  });
});
