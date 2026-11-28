/** Small helpers for turning untrusted model output into clean strings. */

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length > 0);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Shortens text to `maxLength` characters, ending with an ellipsis when cut. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Lowercase `a-z0-9-` identifier, safe for ids and file names. */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}
