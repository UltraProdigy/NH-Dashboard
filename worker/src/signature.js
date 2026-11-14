function hexToBytes(hex) {
  if (hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify X-Hub-Signature-256 over the raw body.
 *
 * `crypto.subtle.verify` is used rather than recomputing the digest and
 * comparing strings: a plain `===` on hex leaks how many leading characters
 * matched, which is enough to forge a signature one byte at a time. Verify is
 * constant-time by construction.
 *
 * The body must be the exact bytes GitHub signed, so it is read as text and
 * parsed only after the signature checks out — never `await request.json()`
 * first and re-serialize, which would reorder keys and change the digest.
 */
export async function verifySignature(secret, header, rawBody) {
  if (!header || !header.startsWith("sha256=")) return false;

  const signature = hexToBytes(header.slice(7));
  if (!signature || signature.length !== 32) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(rawBody));
}
