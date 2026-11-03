/** Domain validation for connector-created apps: only one clean https host in the tools zone. */
export const ZONE_HOST_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.tools\.orca-internal\.net$/;

export const BUILTIN_RESERVED_LABELS = ['coolify', 'deployer', 'test-artifact'];

/** Read per call so a changed RESERVED_LABELS applies without restart. */
export function reservedLabels(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.RESERVED_LABELS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_RESERVED_LABELS, ...extra]);
}

export class DomainError extends Error {
  constructor(message: string) {
    super(`invalid_domain: ${message}`);
    this.name = 'DomainError';
  }
}

export async function validateCreateDomain(
  raw: string | undefined,
  takenHosts: () => Promise<string[]>,
): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (raw.includes(',') || /\s/.test(raw)) {
    throw new DomainError('exactly one URL is allowed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('not a valid URL');
  }
  if (url.protocol !== 'https:') throw new DomainError('scheme must be https');
  if (url.port || /^https:\/\/[^/?#@]*:\d*(?:[/?#]|$)/i.test(raw))
    throw new DomainError('port is not allowed');
  if (url.username || url.password) throw new DomainError('userinfo is not allowed');
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    throw new DomainError('query and fragment are not allowed');
  }
  if (url.pathname !== '/') throw new DomainError('path is not allowed');
  const host = url.hostname.toLowerCase();
  const m = ZONE_HOST_RE.exec(host);
  if (!m) throw new DomainError('host must be <label>.tools.orca-internal.net (single label)');
  if (reservedLabels().has(m[1])) throw new DomainError(`label '${m[1]}' is reserved`);
  const taken = new Set((await takenHosts()).map((h) => h.toLowerCase()));
  if (taken.has(host) || taken.has(`www.${host}`)) {
    throw new DomainError(`host '${host}' is already in use`);
  }
  return `https://${host}`;
}
