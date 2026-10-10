import { sha256 } from "./hash.js";

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

const WINDOW_MS = 60_000;
const SWEEP_THRESHOLD = 10_000;

/**
 * Fixed-window limiter keyed by a non-reversible digest of the caller's
 * bearer token (falling back to "anonymous"). Single-process by design:
 * behind multiple replicas the reverse proxy must enforce the shared limit.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly perMinute: number) {}

  check(request: Request, now: number = Date.now()): RateLimitVerdict {
    if (this.hits.size > SWEEP_THRESHOLD) {
      for (const [key, window] of this.hits) {
        if (window.resetAt <= now) this.hits.delete(key);
      }
    }
    const key = this.keyFor(request);
    const window = this.hits.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return { ok: true };
    }
    if (window.count >= this.perMinute) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
      };
    }
    window.count += 1;
    return { ok: true };
  }

  private keyFor(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "anonymous";
    return sha256(authorization).slice(0, 16);
  }
}
