/** Minimal shape returned by the S3 GetBucketCors operation. */
export interface UploadCorsRule {
  AllowedOrigins?: string[];
  AllowedMethods?: string[];
  AllowedHeaders?: string[];
  ExposeHeaders?: string[];
}

export interface UploadCorsDiagnostics {
  allowed: boolean;
  originAllowed: boolean;
  putAllowed: boolean;
  contentTypeAllowed: boolean;
  etagExposed: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesOrigin(pattern: string, origin: string): boolean {
  if (pattern === '*') return true;
  if ((pattern.match(/\*/g) ?? []).length > 1) return false;
  const expression = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${expression}$`, 'i').test(origin);
}

/**
 * CORS values must be satisfied by one matching rule. Combining an allowed
 * origin from one rule with PUT/headers from unrelated rules can report a
 * false positive and let the browser fail later during preflight.
 */
export function inspectUploadCors(rules: UploadCorsRule[], origin: string): UploadCorsDiagnostics {
  let originAllowed = false;
  let putAllowed = false;
  let contentTypeAllowed = false;
  let etagExposed = false;
  let allowed = false;

  for (const rule of rules) {
    const originMatch = (rule.AllowedOrigins ?? []).some((pattern) => matchesOrigin(pattern, origin));
    const methodMatch = (rule.AllowedMethods ?? []).some((method) => method.toUpperCase() === 'PUT');
    const headersMatch = (rule.AllowedHeaders ?? []).some((header) => header === '*' || header.toLowerCase() === 'content-type');
    const etagMatch = (rule.ExposeHeaders ?? []).some((header) => header.toLowerCase() === 'etag');

    originAllowed ||= originMatch;
    putAllowed ||= methodMatch;
    contentTypeAllowed ||= headersMatch;
    etagExposed ||= originMatch && etagMatch;

    if (originMatch && methodMatch && headersMatch) {
      allowed = true;
      etagExposed = etagMatch;
      break;
    }
  }

  return { allowed, originAllowed, putAllowed, contentTypeAllowed, etagExposed };
}
