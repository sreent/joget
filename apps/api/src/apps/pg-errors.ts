/** The PostgreSQL error behind an error, if any. The ORM wraps driver errors, so look through causes. */
export function pgError(error: unknown): { code?: string; constraint?: string } {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && current !== null && typeof (current as { code?: unknown }).code === 'string' && /^[0-9A-Z]{5}$/.test((current as { code: string }).code)) {
      return current as { code: string; constraint?: string };
    }
    current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  return {};
}
