// redact.ts — scrub a credential from error text before it reaches the agent
// transcript. One meaning, one threshold: every credential here is a long
// opaque string, so a short value is skipped — it occurs in ordinary text, and
// mangling the message is worse than the leak risk.

const MIN_SECRET_LENGTH = 8;

export function redactSecret(text: string, secret: string | null | undefined): string {
  return secret && secret.length >= MIN_SECRET_LENGTH ? text.split(secret).join("[redacted]") : text;
}
