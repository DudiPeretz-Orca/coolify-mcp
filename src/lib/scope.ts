/**
 * Orca fork scope gate: this connector may only touch applications in Coolify environment 14
 * (project Artifacts, environment production). Values are hard-coded on purpose: no env var or
 * obot config can widen the scope.
 */
import type { CoolifyClient } from './coolify-client.js';
import { safeSegment } from './path-safety.js';

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
  safeSegment(uuid, 'uuid');
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
  safeSegment(deploymentUuid, 'deployment uuid');
  if (!APP_UUID_RE.test(deploymentUuid)) {
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

/**
 * Where connector-created apps land. Hard-coded like SCOPE_ENVIRONMENT_ID: no env var or caller
 * input can move an app elsewhere (Artifacts / production = environment id 14, on the main host).
 */
export const SCOPE_PROJECT_UUID = 'ham77e2te16ndrq6h4m2yudn';
export const SCOPE_ENVIRONMENT_UUID = 'kglbx2narejwiizub3k0hbbd';
export const SCOPE_ENVIRONMENT_NAME = 'production';
export const SCOPE_SERVER_UUID = 'sptooo8egv3zz5cdhumih0g1';

/**
 * Build-source fields the connector's `update` may never send: changing any of them re-points
 * an existing in-scope app at attacker-chosen code. They stay settable at create time only.
 */
export const REMOVED_UPDATE_FIELDS: readonly string[] = [
  'dockerfile',
  'git_repository',
  'git_branch',
  'build_pack',
  'install_command',
  'build_command',
  'start_command',
  'base_directory',
  'dockerfile_location',
  'docker_registry_image_name',
  'docker_registry_image_tag',
];

/**
 * Create actions removed from the connector entirely (enum, handler and tools/list derive from
 * this). Empty until the owner fills it from the audit-log inventory.
 */
export const REMOVED_CREATE_ACTIONS: readonly string[] = [];

export const ALL_CREATE_ACTIONS = ['create_public', 'create_dockerimage', 'create_dockerfile'];

export function survivingCreateActions(removed: readonly string[]): string[] {
  return ALL_CREATE_ACTIONS.filter((a) => !removed.includes(a));
}

/**
 * Validates caller-supplied placement fields and returns the constants to send. Id-shape
 * validation runs first (traversal -> invalid_argument), then an exact, case-sensitive compare
 * (anything else -> out_of_scope). Omitted fields are filled; nothing caller-supplied is used.
 */
export function resolveCreateScope(args: {
  project_uuid?: unknown;
  environment_uuid?: unknown;
  environment_name?: unknown;
  server_uuid?: unknown;
}): {
  project_uuid: string;
  environment_uuid: string;
  environment_name: string;
  server_uuid: string;
} {
  const fields = [
    ['project_uuid', SCOPE_PROJECT_UUID],
    ['environment_uuid', SCOPE_ENVIRONMENT_UUID],
    ['environment_name', SCOPE_ENVIRONMENT_NAME],
    ['server_uuid', SCOPE_SERVER_UUID],
  ] as const;
  for (const [name] of fields) {
    if (args[name] !== undefined) safeSegment(args[name], name);
  }
  for (const [name, constant] of fields) {
    if (args[name] !== undefined && args[name] !== constant) {
      throw new ScopeError(`${name}=${String(args[name])}`);
    }
  }
  return {
    project_uuid: SCOPE_PROJECT_UUID,
    environment_uuid: SCOPE_ENVIRONMENT_UUID,
    environment_name: SCOPE_ENVIRONMENT_NAME,
    server_uuid: SCOPE_SERVER_UUID,
  };
}
