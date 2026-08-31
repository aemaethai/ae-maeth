import { AuthFailure } from "./auth";

export const RATE_LIMIT_WINDOW_SECONDS = 60;

export function requestClientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown-client";
}

export async function enforceRateLimit(
  limiter: RateLimit,
  key: string,
  detail: string,
): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new AuthFailure(429, "rate_limited", detail, {
      "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
    });
  }
}
