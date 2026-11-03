/**
 * Orca fork: env_vars must not set variables whose KEY changes how an app is built, started or
 * loaded (build-pack command overrides, builder/daemon endpoints, dynamic-loader and
 * interpreter start-up hooks, runtime option variables that can run code with no file on disk).
 *
 * Hard-coded on purpose: no environment override, nothing configurable.
 * NODE_OPTIONS and the Java option variables ARE denied: they can load code from a data: URL or
 * an agent option with nothing on disk. PYTHONPATH, PYTHONHOME, PERL5OPT and RUBYOPT are
 * deliberately NOT denied: they only load code from a file that must already exist on disk.
 * Delete and list are not guarded, so a dangerous key that is already set can be removed
 * through the connector but never changed.
 */
export const DENIED_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /^NIXPACKS_/i,
  /^RAILPACK_/i,
  /^BUILDKIT_/i,
  /^BUILDX_/i,
  /^DOCKER_/i,
  /^COMPOSE_/i,
  /^LD_/i,
  /^GIT_CONFIG_/i,
  /^GIT_SSH/i,
  /^BASH_ENV$/i,
  /^ENV$/i,
  /^PYTHONSTARTUP$/i,
  /^GIT_EXEC_PATH$/i,
  /^NODE_OPTIONS$/i,
  /^JAVA_TOOL_OPTIONS$/i,
  /^JDK_JAVA_OPTIONS$/i,
  /^_JAVA_OPTIONS$/i,
];

/** Coolify documents no key rule; this accepts ordinary names incl. lower-case and dotted ones. */
export const ENV_KEY_SHAPE_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;

export class EnvKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvKeyError';
  }
}

/** Matches the key as given and with every '.' and '-' read as '_' (NIXPACKS-X, nixpacks.x). */
function isDeniedKey(key: string): boolean {
  const normalised = key.replace(/[.-]/g, '_');
  return DENIED_ENV_KEY_PATTERNS.some((re) => re.test(key) || re.test(normalised));
}

/** Throws EnvKeyError (message starts `invalid_argument:`) unless the key is acceptable. */
export function assertEnvKeyAllowed(key: unknown): void {
  if (typeof key !== 'string' || !ENV_KEY_SHAPE_RE.test(key)) {
    const shown = typeof key === 'string' ? JSON.stringify(key.slice(0, 64)) : typeof key;
    throw new EnvKeyError(
      `invalid_argument: env var key ${shown} is not valid; it must match ${ENV_KEY_SHAPE_RE.source}`,
    );
  }
  if (isDeniedKey(key)) {
    throw new EnvKeyError(
      `invalid_argument: env var key ${key} is not allowed; variables that affect how an app is built or started must be set in the Coolify dashboard`,
    );
  }
}

const ASSIGNMENT_LINE_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

/**
 * Values are written into env files line by line, so control characters and embedded
 * assignments are refused. The value itself is never echoed in the error.
 */
export function assertEnvValueAllowed(value: unknown, isMultiline: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new EnvKeyError(`invalid_argument: ${field} must be a string`);
  }
  if (/[\r\0]/.test(value)) {
    throw new EnvKeyError(`invalid_argument: ${field} must not contain CR or NUL characters`);
  }
  if (value.includes('\n') && isMultiline !== true) {
    throw new EnvKeyError(
      `invalid_argument: ${field} contains a newline; set is_multiline to true for multi-line values`,
    );
  }
  for (const line of value.split('\n')) {
    const m = ASSIGNMENT_LINE_RE.exec(line);
    if (m && isDeniedKey(m[2])) {
      throw new EnvKeyError(
        `invalid_argument: ${field} contains a line that assigns a variable that must be set in the Coolify dashboard`,
      );
    }
  }
}
