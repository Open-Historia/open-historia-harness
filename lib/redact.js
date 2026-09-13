// Key redaction, ported from Open Historia's server/logStore.js (© 2026 Nicholas
// Krol, AGPL-3.0-or-later) so the harness cannot be the weaker link.
//
// One choke point, deliberately. A key can reach disk here from provider
// settings, a request header, a URL query string or a pasted error message, and a
// redactor placed at any one of those eventually misses a path.
//
// Ordered widest-first: a bearer header wrapping a key must not be half-matched.

const REDACTIONS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]"],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, "[redacted-google-key]"],
  // Google also issues keys and tokens in an "AQ.<base64ish>" form. The AIza rule
  // above misses it entirely, which was found by testing a real key against this
  // redactor rather than by reading the docs.
  [/\bAQ\.[A-Za-z0-9_-]{20,}/g, "[redacted-google-key]"],
  // Google OAuth access tokens.
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "[redacted-google-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-github-token]"],
  [
    /("?\b(?:api[_-]?key|apikey|access[_-]?token|authorization|password|secret)"?\s*[:=]\s*"?)([^"\s,&}]{6,})/gi,
    "$1[redacted]",
  ],
  // The harness adds one the game does not need: Gemini takes its key as a query
  // parameter, so a recorded URL carries it in the clear.
  [/([?&]key=)[^&\s"]+/gi, "$1[redacted]"],
];

export const redact = (value) => {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (typeof text !== "string") return text;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
};

/** Redact inside a structure, preserving its shape. */
export const redactDeep = (value) => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /^(authorization|x-goog-api-key|x-api-key|api-key)$/i.test(key)
        ? "[redacted]"
        : redactDeep(entry);
    }
    return out;
  }
  return value;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Show the user's home folder as %USERPROFILE% (~ elsewhere) in text a report
 * may be pasted from. A reproduce command naming a Game export in Downloads
 * otherwise carries the user's name into a public issue.
 *
 * Matched only when a separator or the end follows, so "<home>-evil" is left
 * alone — the same prefix collision isInside guards against. Case-insensitive on
 * Windows, where C:\Users and c:\users are one folder.
 */
export const hideHomeDir = (
  text,
  { home = process.env.USERPROFILE || process.env.HOME || "", platform = process.platform } = {},
) => {
  if (!home || typeof text !== "string") return text;
  const windows = platform === "win32";
  const trimmed = home.replace(/[\\/]+$/, "");
  const pattern = escapeRegExp(trimmed).replace(/\\\\|\//g, "[\\\\/]");
  const flags = windows ? "gi" : "g";
  return text.replace(new RegExp(`${pattern}(?=[\\\\/]|$|["'\\s])`, flags), windows ? "%USERPROFILE%" : "~");
};

/** Strip the key from a provider URL before it is stored or printed. */
export const stripUrlKey = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("key")) parsed.searchParams.set("key", "[redacted]");
    return parsed.toString();
  } catch {
    return redact(String(url));
  }
};
