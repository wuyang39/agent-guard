/**
 * scrubSecrets — shared credential scrubbing for diagnostic/stderr/error text.
 *
 * Intended for any code path that may embed CLI stderr, provider error output,
 * or other external text in persistent records or user-visible messages.
 * Reuses the patterns validated by nativeGuardEventStore tests.
 *
 * Scrubbing is applied BEFORE truncation so that truncated secrets
 * don't bypass the pattern match.
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const AUTH_HEADER = /\b(authorization|cookie)\b\s*[:=]\s*[^\r\n,]+/gi;
const BEARER_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Bare word: api_key=, secret=, password=, gateway_token=, etc.
// Also catches embedded forms like client_secret, aws_secret_access_key
const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|token|secret|password|credential|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|auth[_-]?token|gateway[_-]?token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
// Env-var style all-caps: OPENAI_API_KEY=, OPENCLAW_GATEWAY_TOKEN=, etc.
const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:_(?:API[_-]?KEY|AUTH[_-]?TOKEN|SECRET[_-]?(?:ACCESS[_-]?)?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|GATEWAY[_-]?TOKEN)))\s*=\s*[^\s,;}]+/gi;

/**
 * Scrub credential-like patterns from a string. Safe for arbitrary text;
 * preserves diagnostic value by keeping structural words while redacting values.
 */
export function scrubSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(AUTH_HEADER, "$1=[REDACTED]")
    .replace(BEARER_TOKEN, "$1 [REDACTED]")
    .replace(ENV_SECRET, "$1=[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]");
}
