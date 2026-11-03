/**
 * Orca fork: env_vars must not set variables whose KEY changes how an app is built, started or
 * loaded (build-pack command overrides, builder/daemon endpoints, dynamic-loader and
 * interpreter start-up hooks). Those belong in the Coolify dashboard, not the connector.
 *
 * Hard-coded on purpose: no environment override, nothing configurable.
 * NODE_OPTIONS and PYTHONPATH are deliberately NOT denied: they have legitimate uses.
 * Delete and list are not guarded, so a dangerous key that is already set can be removed
 * through the connector but never changed.
 */
export const DENIED_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /^NIXPACKS_/i,
  /^BUILDKIT_/i,
  /^DOCKER_/i,
  /^COMPOSE_/i,
  /^LD_/i,
  /^GIT_CONFIG_/i,
  /^GIT_SSH/i,
  /^BASH_ENV$/i,
  /^ENV$/i,
  /^PYTHONSTARTUP$/i,
  /^GIT_EXEC_PATH$/i,
];

/** Coolify documents no key rule; this accepts ordinary names incl. lower-case and dotted ones. */
export const ENV_KEY_SHAPE_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;

export class EnvKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvKeyError';
  }
}

/** Throws EnvKeyError (message starts `invalid_argument:`) unless the key is acceptable. */
export function assertEnvKeyAllowed(key: unknown): void {
  if (typeof key !== 'string' || !ENV_KEY_SHAPE_RE.test(key)) {
    const shown = typeof key === 'string' ? JSON.stringify(key.slice(0, 64)) : typeof key;
    throw new EnvKeyError(
      `invalid_argument: env var key ${shown} is not valid; it must match ${ENV_KEY_SHAPE_RE.source}`,
    );
  }
  if (DENIED_ENV_KEY_PATTERNS.some((re) => re.test(key))) {
    throw new EnvKeyError(
      `invalid_argument: env var key ${key} is not allowed; variables that affect how an app is built or started must be set in the Coolify dashboard`,
    );
  }
}
