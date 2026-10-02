import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single-user auth, optional by design: it's your journal on your box. Set
 * JOURNAL_PASSWORD to require a login; the session cookie is an HMAC of the
 * password so rotating the password invalidates sessions.
 */
export const AUTH_COOKIE = "journal_session";

/** Trim env value so accidental whitespace/newlines in Vercel dashboard paste still match. */
const configuredPassword = (): string => (process.env.JOURNAL_PASSWORD ?? "").trim();

export const passwordConfigured = (): boolean => Boolean(configuredPassword());

export const sessionToken = (): string =>
  createHmac("sha256", configuredPassword()).update("session-v1").digest("hex");

export const verifyPassword = (candidate: string): boolean => {
  const expected = Buffer.from(configuredPassword(), "utf8");
  const given = Buffer.from(candidate, "utf8");
  if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  // Accept a trimmed candidate so accidental spaces around typed input still match.
  const trimmed = candidate.trim();
  if (trimmed === candidate) return false;
  const trimmedGiven = Buffer.from(trimmed, "utf8");
  return (
    expected.length === trimmedGiven.length && timingSafeEqual(expected, trimmedGiven)
  );
};

export const verifySession = (token: string | undefined): boolean => {
  if (!passwordConfigured()) return true;
  if (!token) return false;
  const expected = Buffer.from(sessionToken(), "utf8");
  const given = Buffer.from(token, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
};
