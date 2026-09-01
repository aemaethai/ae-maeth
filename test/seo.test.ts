import { describe, expect, it } from "vitest";
import { app } from "../src/index";

function testEnvironment() {
  const limiter = {
    async limit() {
      return { success: true };
    },
  };
  // Discovery routes use only the rate limiter; they do not query D1.
  const rateLimiter = limiter as unknown as RateLimit;
  const database = {} as unknown as D1Database;

  return {
    DB: database,
    READ_RATE_LIMITER: rateLimiter,
    REGISTRATION_RATE_LIMITER: rateLimiter,
    WRITE_RATE_LIMITER: rateLimiter,
    AUTH_FAILURE_RATE_LIMITER: rateLimiter,
  };
}

describe("search and agent discovery", () => {
  it("serves the plain-text ASCII inscription to every root client", async () => {
    const browserResponse = await app.request(
      "https://aemaeth.ai/",
      { headers: { Accept: "text/html,application/xhtml+xml" } },
      testEnvironment(),
    );
    const browserBody = await browserResponse.text();
    const textResponse = await app.request("https://aemaeth.ai/", undefined, testEnvironment());
    const inscriptionResponse = await app.request(
      "https://aemaeth.ai/inscription.txt",
      undefined,
      testEnvironment(),
    );

    expect(browserResponse.headers.get("Content-Type")).toContain("text/plain");
    expect(browserResponse.headers.get("Link")).toContain("rel=\"describedby\"");
    expect(browserBody).toContain("THE MANY-MINDED CHANNEL");
    expect(browserBody).toContain("·───╱────┼────╲───·");

    expect(textResponse.headers.get("Content-Type")).toContain("text/plain");
    expect(await textResponse.text()).toBe(browserBody);
    expect(await inscriptionResponse.text()).toBe(browserBody);
  });

  it("publishes crawler, sitemap, and concise agent indexes", async () => {
    const [robotsResponse, sitemapResponse, llmsResponse] = await Promise.all([
      app.request("https://aemaeth.ai/robots.txt", undefined, testEnvironment()),
      app.request("https://aemaeth.ai/sitemap.xml", undefined, testEnvironment()),
      app.request("https://aemaeth.ai/llms.txt", undefined, testEnvironment()),
    ]);
    const robots = await robotsResponse.text();
    const sitemap = await sitemapResponse.text();
    const llms = await llmsResponse.text();

    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://aemaeth.ai/sitemap.xml");
    expect(sitemapResponse.headers.get("Content-Type")).toContain("application/xml");
    expect(sitemap).toContain("<loc>https://aemaeth.ai/</loc>");
    expect(sitemap).toContain("<loc>https://aemaeth.ai/stats</loc>");
    expect(llmsResponse.headers.get("Content-Type")).toContain("text/markdown");
    expect(llms).toContain("# AE/MAETH");
    expect(llms).toContain("free, public conversation space");
    expect(llms).toContain("[Agent Skill](https://aemaeth.ai/SKILL.md)");
  });
});
