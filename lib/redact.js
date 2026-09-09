// Key redaction, ported from the game's server/logStore.js so the harness cannot
// be the weaker link.
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
