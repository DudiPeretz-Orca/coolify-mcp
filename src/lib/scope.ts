/**
 * Orca fork scope gate: this connector may only touch applications in Coolify environment 14
 * (project Artifacts, environment production). Values are hard-coded on purpose: no env var or
 * obot config can widen the scope.
 */
import type { CoolifyClient } from './coolify-client.js';

export const SCOPE_ENVIRONMENT_ID = 14;

/** The artifact deployer must never be managed through this connector, whatever env it reports. */
export const DENIED_APP_UUIDS: ReadonlySet<string> = new Set(['pvaqszi5ivm0dnk7nhwegjnd']);

/** Coolify application/deployment uuids. Also keeps path separators out of request URLs. */
export const APP_UUID_RE = /^[a-z0-9]{24}$/;

export class ScopeError extends Error {
  constructor(uuid: string) {
    super(
      `out_of_scope: this connector only manages apps in Artifacts/production; use the Coolify dashboard (${uuid})`,
    );
    this.name = 'ScopeError';
  }
}

export async function assertAppInScope(
  client: Pick<CoolifyClient, 'getApplication'>,
  uuid: string,
): Promise<void> {
  if (typeof uuid !== 'string') throw new ScopeError(String(uuid));
  if (DENIED_APP_UUIDS.has(uuid.trim().toLowerCase())) throw new ScopeError(uuid);
  if (!APP_UUID_RE.test(uuid)) throw new ScopeError(uuid);
  let environmentId: unknown;
  try {
    environmentId = (await client.getApplication(uuid)).environment_id;
  } catch {
    // Fail closed: if we cannot prove the app is in scope, it is not.
    throw new ScopeError(uuid);
  }
  if (typeof environmentId !== 'number' || environmentId !== SCOPE_ENVIRONMENT_ID) {
    throw new ScopeError(uuid);
  }
}

export async function assertDeploymentInScope(
  client: Pick<CoolifyClient, 'getDeployment' | 'getApplication'>,
  deploymentUuid: string,
): Promise<void> {
  if (typeof deploymentUuid !== 'string' || !APP_UUID_RE.test(deploymentUuid)) {
    throw new ScopeError(String(deploymentUuid));
  }
  let appUuid: unknown;
  try {
    appUuid = (await client.getDeployment(deploymentUuid)).application_uuid;
  } catch {
    throw new ScopeError(deploymentUuid);
  }
  if (typeof appUuid !== 'string' || appUuid === '') throw new ScopeError(deploymentUuid);
  await assertAppInScope(client, appUuid);
}
