import { timingSafeEqual } from "node:crypto";

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";

export const STATIC_SCOPES: readonly string[] = ["obsidian"];

const STATIC_TOKEN_LIFETIME_SECONDS = 86_400;

/**
 * Bearer verifier for a single static token supplied through the environment.
 *
 * `AuthInfo.expiresAt` must be populated or the SDK bearer-auth helpers reject
 * every token (the v1 behavior is carried over in 2.x). The synthetic expiry
 * is a rolling 24-hour window because static tokens have no real lifetime.
 */
export function createStaticTokenVerifier(token: string): OAuthTokenVerifier {
  const expected = Buffer.from(token, "utf8");
  return {
    verifyAccessToken(presented: string): Promise<AuthInfo> {
      const actual = Buffer.from(presented, "utf8");
      const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!matches) {
        return Promise.reject(new OAuthError(OAuthErrorCode.InvalidToken, "Invalid bearer token."));
      }
      return Promise.resolve({
        token: presented,
        clientId: "static",
        scopes: [...STATIC_SCOPES],
        expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_LIFETIME_SECONDS
      });
    }
  };
}
