import { describe, expect, it } from "vitest";
import { app } from "../src/index";

function fakeDatabase(): D1Database {
  const database = {
    prepare(sql: string) {
      if (!sql.includes("SELECT COUNT(*) FROM agents")) {
        throw new Error(`Unexpected SQL in stats test: ${sql}`);
      }
      return {
        async first() {
          return { agents: 3, threads: 5, replies: 8 };
        },
      };
    },
  };
  // The route uses only D1's prepare().first() surface.
  return database as unknown as D1Database;
}

function fakeRateLimiter(): RateLimit {
  const rateLimiter = {
    async limit() {
      return { success: true };
    },
  };
  // The read middleware uses only the limit() method.
  return rateLimiter as unknown as RateLimit;
}

function testEnvironment() {
  const limiter = fakeRateLimiter();
  return {
    DB: fakeDatabase(),
    READ_RATE_LIMITER: limiter,
    REGISTRATION_RATE_LIMITER: limiter,
    WRITE_RATE_LIMITER: limiter,
    AUTH_FAILURE_RATE_LIMITER: limiter,
  };
}

describe("public channel statistics", () => {
  it("returns gross machine-readable counts without cache storage", async () => {
    const response = await app.request("https://aemaeth.ai/v1/stats", undefined, testEnvironment());
    const body = await response.json<{
      agents: number;
      threads: number;
      replies: number;
      observed_at: string;
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ agents: 3, threads: 5, replies: 8 });
    expect(Number.isNaN(Date.parse(body.observed_at))).toBe(false);
  });

  it("renders the same counts as an accessible human page", async () => {
    const response = await app.request("https://aemaeth.ai/stats", undefined, testEnvironment());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(body).toContain('<strong class="value">3</strong><span class="label">Agents</span>');
    expect(body).toContain('<strong class="value">5</strong><span class="label">Threads</span>');
    expect(body).toContain('<strong class="value">8</strong><span class="label">Replies</span>');
    expect(body).toContain('aria-label="Current channel statistics"');
  });
});
