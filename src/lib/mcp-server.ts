/**
 * Coolify MCP Server
 * Consolidated tools for efficient token usage
 */

import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  CoolifyClient,
  type ServerSummary,
  type ProjectSummary,
  type ApplicationSummary,
  type DatabaseSummary,
  type ServiceSummary,
} from './coolify-client.js';
import { DeployerClient } from './deployer-client.js';
import { InvalidArgumentError, SAFE_SEGMENT_RE, safeSegment } from './path-safety.js';
import {
  APP_UUID_RE,
  REMOVED_CREATE_ACTIONS,
  REMOVED_UPDATE_FIELDS,
  ScopeError,
  assertAppInScope,
  assertDeploymentInScope,
  resolveCreateScope,
  survivingCreateActions,
} from './scope.js';
import { DomainError, validateCreateDomain } from './domain-guard.js';
import type {
  CoolifyConfig,
  BuildPack,
  ResponseAction,
  ResponsePagination,
  Deployment,
  DeploymentEssential,
  DeployTriggerResponse,
} from '../types/coolify.js';

const _require = createRequire(import.meta.url);
export const VERSION: string = _require('../../package.json').version;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Id-like tool input: restricted to path-safe characters so it fails before the handler runs. */
const safeId = (): z.ZodString =>
  z.string().regex(SAFE_SEGMENT_RE, 'invalid_argument: must match ' + SAFE_SEGMENT_RE.source);

/** Rejected path segments and scope failures are tool errors (isError), never silent successes. */
function argumentErrorResult(error: unknown): ToolResult | undefined {
  if (error instanceof InvalidArgumentError || error instanceof ScopeError) {
    return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  }
  return undefined;
}

/**
 * Run a scope check before a handler. Returns an `isError` result (text starts with
 * `out_of_scope`) when the check fails, or undefined when the handler may proceed.
 * Every gated handler must call this before any write.
 */
async function denyUnlessInScope(check: () => Promise<void>): Promise<ToolResult | undefined> {
  try {
    await check();
    return undefined;
  } catch (error) {
    return (
      argumentErrorResult(error) ?? {
        content: [
          {
            type: 'text' as const,
            text: `out_of_scope: scope check failed (${error instanceof Error ? error.message : String(error)})`,
          },
        ],
        isError: true,
      }
    );
  }
}

/** Wrap handler with error handling */
function wrap<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return fn()
    .then((result) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }))
    .catch(
      (error) =>
        argumentErrorResult(error) ?? {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        },
    );
}

const TRUNCATION_PREFIX = '...[truncated]...\n';

interface LogEntry {
  output?: string;
  timestamp?: string;
  type?: string;
  hidden?: boolean;
  command?: string | null;
}

export interface TruncatedLogsResult {
  logs: string;
  total: number;
  showing_start: number;
  showing_end: number;
}

/**
 * Truncate logs by entry count with pagination support.
 * Handles both JSON array format (Coolify deployment logs) and plain text.
 * Page 1 = most recent entries, page 2 = next older batch, etc.
 * Exported for testing.
 */
export function truncateLogs(
  logs: string,
  lineLimit: number = 200,
  charLimit: number = 50000,
  page: number = 1,
): TruncatedLogsResult {
  // Try parsing as JSON array (Coolify deployment log format)
  let lines: string[];
  let total: number;
  try {
    const entries: LogEntry[] = JSON.parse(logs);
    if (Array.isArray(entries)) {
      const visible = entries.filter((e) => !e.hidden);
      total = visible.length;
      const end = total - (page - 1) * lineLimit;
      const start = Math.max(0, end - lineLimit);
      const slice = visible.slice(start, end);
      lines = slice.map((e) => `[${e.timestamp ?? ''}] ${e.output ?? ''}`);
    } else {
      const allLines = logs.split('\n');
      total = allLines.length;
      const end = total - (page - 1) * lineLimit;
      const start = Math.max(0, end - lineLimit);
      lines = allLines.slice(start, end);
    }
  } catch {
    // Plain text logs — split by newlines
    const allLines = logs.split('\n');
    total = allLines.length;
    const end = total - (page - 1) * lineLimit;
    const start = Math.max(0, end - lineLimit);
    lines = allLines.slice(start, end);
  }

  const end = total - (page - 1) * lineLimit;
  const start = Math.max(0, end - lineLimit);
  let result = lines.join('\n');

  // Safety net: limit by characters
  if (result.length > charLimit) {
    const prefixLen = TRUNCATION_PREFIX.length;
    result = TRUNCATION_PREFIX + result.slice(-(charLimit - prefixLen));
  }

  return {
    logs: result,
    total,
    showing_start: start + 1,
    showing_end: Math.min(end, total),
  };
}

// =============================================================================
// Action Generators for HATEOAS-style responses
// =============================================================================

/** Generate contextual actions for an application based on its status */
export function getApplicationActions(uuid: string, status?: string): ResponseAction[] {
  const actions: ResponseAction[] = [
    { tool: 'application_logs', args: { uuid }, hint: 'View logs' },
  ];
  const s = (status || '').toLowerCase();
  if (s.includes('running')) {
    actions.push({
      tool: 'control',
      args: { resource: 'application', action: 'restart', uuid },
      hint: 'Restart',
    });
    actions.push({
      tool: 'control',
      args: { resource: 'application', action: 'stop', uuid },
      hint: 'Stop',
    });
  } else {
    actions.push({
      tool: 'control',
      args: { resource: 'application', action: 'start', uuid },
      hint: 'Start',
    });
  }
  return actions;
}

/** Generate contextual actions for a deployment */
export function getDeploymentActions(
  uuid: string,
  status: string,
  appUuid?: string,
): ResponseAction[] {
  const actions: ResponseAction[] = [];
  if (status === 'in_progress' || status === 'queued') {
    actions.push({ tool: 'deployment', args: { action: 'cancel', uuid }, hint: 'Cancel' });
  }
  if (appUuid) {
    actions.push({ tool: 'get_application', args: { uuid: appUuid }, hint: 'View app' });
    actions.push({ tool: 'application_logs', args: { uuid: appUuid }, hint: 'App logs' });
  }
  return actions;
}

/** Generate pagination info for list endpoints */
export function getPagination(
  tool: string,
  page?: number,
  perPage?: number,
  count?: number,
): ResponsePagination | undefined {
  const p = page ?? 1;
  const pp = perPage ?? 50;
  if (!count || count < pp) {
    return p > 1 ? { prev: { tool, args: { page: p - 1, per_page: pp } } } : undefined;
  }
  return {
    ...(p > 1 && { prev: { tool, args: { page: p - 1, per_page: pp } } }),
    next: { tool, args: { page: p + 1, per_page: pp } },
  };
}

/** Wrap handler with error handling and HATEOAS actions */
function wrapWithActions<T>(
  fn: () => Promise<T>,
  getActions?: (result: T) => ResponseAction[],
  getPaginationFn?: (result: T) => ResponsePagination | undefined,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return fn()
    .then((result) => {
      const actions = getActions?.(result) ?? [];
      const pagination = getPaginationFn?.(result);
      const response: Record<string, unknown> = { data: result };
      if (actions.length > 0) response._actions = actions;
      if (pagination) response._pagination = pagination;
      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
    })
    .catch(
      (error) =>
        argumentErrorResult(error) ?? {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        },
    );
}

// =============================================================================
// Deploy wait/poll helpers (#238)
// =============================================================================

/** Deployment statuses that end a run — polling stops once one of these is hit. */
const TERMINAL_DEPLOYMENT_STATUSES: ReadonlySet<string> = new Set([
  'finished',
  'failed',
  'cancelled',
]);

const DEFAULT_DEPLOY_TIMEOUT_SECONDS = 300;
const DEPLOY_POLL_INTERVAL_MS = 5000;

function isTerminalDeploymentStatus(status: string): boolean {
  return TERMINAL_DEPLOYMENT_STATUSES.has(status);
}

/** Isolated so tests can drive polling with jest fake timers instead of real waits. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durationSeconds(createdAt?: string, updatedAt?: string): number | undefined {
  if (!createdAt || !updatedAt) return undefined;
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * Small, safe projection returned by `deploy` when `wait: true`.
 * Built from essential fields + a bounded log tail only — never the raw
 * upstream deployment object, which can carry server/application secrets
 * (see #232).
 */
interface DeployWaitResult {
  status: string;
  deployment_uuid: string;
  application_uuid?: string;
  commit?: string;
  created_at?: string;
  updated_at?: string;
  duration_seconds?: number;
  timed_out?: boolean;
  logs_tail?: string;
  logs_meta?: { total_entries: number; showing: string };
  next_action?: string;
  additional_deployment_uuids?: string[];
}

export class CoolifyMcpServer extends McpServer {
  private readonly client: CoolifyClient;
  private readonly deployer?: DeployerClient;
  private readonly removedCreateActions: readonly string[];

  /** `options.removedCreateActions` exists so tests can prove the enum/handler derive from the list. */
  constructor(config: CoolifyConfig, options?: { removedCreateActions?: readonly string[] }) {
    super({ name: 'coolify', version: VERSION });
    this.removedCreateActions = options?.removedCreateActions ?? REMOVED_CREATE_ACTIONS;
    this.client = new CoolifyClient(config);
    this.deployer = config.deployerUrl ? new DeployerClient(config.deployerUrl) : undefined;
    this.registerTools();
  }

  async connect(transport: Transport): Promise<void> {
    await super.connect(transport);
  }

  /**
   * Poll a single deployment until it reaches a terminal status or the
   * timeout elapses. Uses `getDeployment`'s no-logs projection
   * (`DeploymentEssential`) while polling, and only fetches logs (once,
   * truncated) if the deployment failed.
   */
  private async pollDeployment(uuid: string, timeoutSeconds: number): Promise<DeployWaitResult> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current = (await this.client.getDeployment(uuid)) as DeploymentEssential;

    while (!isTerminalDeploymentStatus(current.status) && Date.now() < deadline) {
      await sleep(DEPLOY_POLL_INTERVAL_MS);
      current = (await this.client.getDeployment(uuid)) as DeploymentEssential;
    }

    if (!isTerminalDeploymentStatus(current.status)) {
      return {
        status: current.status,
        deployment_uuid: uuid,
        application_uuid: current.application_uuid,
        timed_out: true,
        next_action: `Still "${current.status}" after ${timeoutSeconds}s — poll \`deployment\` (action: "get", uuid: "${uuid}") to keep watching.`,
      };
    }

    if (current.status === 'failed') {
      const withLogs = (await this.client.getDeployment(uuid, {
        includeLogs: true,
      })) as Deployment;
      const tail = withLogs.logs ? truncateLogs(withLogs.logs, 30, 10_000) : undefined;
      return {
        status: current.status,
        deployment_uuid: uuid,
        application_uuid: current.application_uuid,
        commit: current.commit,
        created_at: current.created_at,
        updated_at: current.updated_at,
        duration_seconds: durationSeconds(current.created_at, current.updated_at),
        logs_tail: tail?.logs,
        logs_meta: tail
          ? {
              total_entries: tail.total,
              showing: `${tail.showing_start}-${tail.showing_end} of ${tail.total}`,
            }
          : undefined,
        next_action: `Deployment failed. See logs_tail above, or \`deployment\` (action: "get", uuid: "${uuid}", lines: N) for more.`,
      };
    }

    return {
      status: current.status,
      deployment_uuid: uuid,
      application_uuid: current.application_uuid,
      commit: current.commit,
      created_at: current.created_at,
      updated_at: current.updated_at,
      duration_seconds: durationSeconds(current.created_at, current.updated_at),
    };
  }

  /**
   * Trigger a deploy and wait for it to finish. A tag can resolve to
   * multiple applications, so `deployByTagOrUuid` may return several
   * `deployment_uuid`s — only the first is polled; any others are
   * surfaced under `additional_deployment_uuids` for the caller to check
   * separately via `deployment get`.
   */
  private async triggerAndWaitForDeploy(
    tagOrUuid: string,
    force: boolean | undefined,
    timeoutSeconds: number,
  ): Promise<DeployWaitResult | DeployTriggerResponse> {
    const triggered = await this.client.deployByTagOrUuid(tagOrUuid, force);
    const [first, ...rest] = triggered.deployments ?? [];

    if (!first?.deployment_uuid) {
      // Nothing to poll against — hand back the trigger response as-is.
      return triggered;
    }

    const result = await this.pollDeployment(first.deployment_uuid, timeoutSeconds);
    const additional = rest.map((d) => d.deployment_uuid).filter((u): u is string => !!u);
    if (additional.length > 0) {
      result.additional_deployment_uuids = additional;
    }
    return result;
  }

  private registerTools(): void {
    // =========================================================================
    // Meta (1 tool)
    // =========================================================================
    this.tool('get_version', 'Coolify API version', {}, async () =>
      wrap(() => this.client.getVersion()),
    );

    // =========================================================================
    // Infrastructure Overview (1 tool)
    // =========================================================================
    this.tool(
      'get_infrastructure_overview',
      'Overview of all resources with counts',
      {},
      async () =>
        wrap(async () => {
          const results = await Promise.allSettled([
            this.client.listServers({ summary: true }),
            this.client.listProjects({ summary: true }),
            this.client.listApplications({ summary: true }),
            this.client.listDatabases({ summary: true }),
            this.client.listServices({ summary: true }),
          ]);
          const extract = <T>(r: PromiseSettledResult<T>): T | [] =>
            r.status === 'fulfilled' ? r.value : [];
          const [servers, projects, applications, databases, services] = [
            extract(results[0]) as ServerSummary[],
            extract(results[1]) as ProjectSummary[],
            extract(results[2]) as ApplicationSummary[],
            extract(results[3]) as DatabaseSummary[],
            extract(results[4]) as ServiceSummary[],
          ];
          const errors = results
            .map((r, i) =>
              r.status === 'rejected'
                ? `${['servers', 'projects', 'applications', 'databases', 'services'][i]}: ${r.reason}`
                : null,
            )
            .filter(Boolean);
          return {
            summary: {
              servers: servers.length,
              projects: projects.length,
              applications: applications.length,
              databases: databases.length,
              services: services.length,
            },
            servers,
            projects,
            applications,
            databases,
            services,
            ...(errors.length > 0 && { errors }),
          };
        }),
    );

    // =========================================================================
    // Diagnostics (2 tools)
    // =========================================================================
    this.tool(
      'diagnose_app',
      'App diagnostics by UUID/name/domain',
      { query: z.string() },
      async ({ query }) => {
        // Resolve first (name/domain -> uuid), then gate the resolved uuid. A resolution
        // failure is not a scope decision, so it keeps its normal error.
        let uuid: string;
        try {
          uuid = await this.client.resolveApplicationUuid(query);
        } catch (error) {
          return wrap(() => Promise.reject(error));
        }
        const denied = await denyUnlessInScope(() => assertAppInScope(this.client, uuid));
        if (denied) return denied;
        return wrap(() => this.client.diagnoseApplication(uuid));
      },
    );

    this.tool('find_issues', 'Scan infrastructure for problems', {}, async () =>
      wrap(() => this.client.findInfrastructureIssues()),
    );

    // =========================================================================
    // Servers (1 tool)
    // =========================================================================
    this.tool(
      'list_servers',
      'List servers (summary)',
      { page: z.number().optional(), per_page: z.number().optional() },
      async ({ page, per_page }) =>
        wrap(() => this.client.listServers({ page, per_page, summary: true })),
    );

    // =========================================================================
    // Projects (1 tool - consolidated CRUD)
    // =========================================================================
    this.tool(
      'projects',
      'Manage projects: list/get/create (update and delete unavailable — use the Coolify dashboard)',
      {
        action: z.enum(['list', 'get', 'create']),
        uuid: safeId().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        page: z.number().optional(),
        per_page: z.number().optional(),
      },
      async ({ action, uuid, name, description, page, per_page }) => {
        switch (action) {
          case 'list':
            return wrap(() => this.client.listProjects({ page, per_page, summary: true }));
          case 'get':
            if (!uuid)
              return { content: [{ type: 'text' as const, text: 'Error: uuid required' }] };
            return wrap(() => this.client.getProject(uuid));
          case 'create':
            if (!name)
              return { content: [{ type: 'text' as const, text: 'Error: name required' }] };
            return wrap(() => this.client.createProject({ name, description }));
        }
      },
    );

    // =========================================================================
    // Environments (1 tool - consolidated CRUD)
    // =========================================================================
    this.tool(
      'environments',
      'Manage environments: list/get/create (delete unavailable — use the Coolify dashboard) (get includes dragonfly/keydb/clickhouse DBs missing from API)',
      {
        action: z.enum(['list', 'get', 'create']),
        project_uuid: safeId(),
        name: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ action, project_uuid, name, description }) => {
        switch (action) {
          case 'list':
            return wrap(() => this.client.listProjectEnvironments(project_uuid));
          case 'get':
            if (!name)
              return { content: [{ type: 'text' as const, text: 'Error: name required' }] };
            // Use enhanced method that includes missing DB types (#88)
            return wrap(() => this.client.getProjectEnvironmentWithDatabases(project_uuid, name));
          case 'create':
            if (!name)
              return { content: [{ type: 'text' as const, text: 'Error: name required' }] };
            return wrap(() =>
              this.client.createProjectEnvironment(project_uuid, { name, description }),
            );
        }
      },
    );

    // =========================================================================
    // Applications (3 tools)
    // =========================================================================
    this.tool(
      'list_applications',
      'List apps (summary)',
      { page: z.number().optional(), per_page: z.number().optional() },
      async ({ page, per_page }) =>
        wrapWithActions(
          () => this.client.listApplications({ page, per_page, summary: true }),
          undefined,
          (result) =>
            getPagination('list_applications', page, per_page, (result as unknown[]).length),
        ),
    );

    // Hoisted so the `update` handler can build its PATCH body from exactly these keys.
    // `custom_docker_run_options` (raw `docker run` flags: --privileged, --cap-add, --device)
    // is deliberately NOT part of this shape and must never be added: it would let any
    // connector user run a privileged container on the shared host.
    // Also deliberately absent (do not re-add): `custom_labels` (raw Traefik labels could hijack
    // other apps' hostnames), and `github_app_uuid` / `private_key_uuid` plus the create_github /
    // create_key actions that need them (they would use shared team git credentials).
    const applicationShape = {
      action: z.enum([
        ...survivingCreateActions(this.removedCreateActions),
        'update',
      ] as unknown as [string, ...string[]]),
      uuid: safeId().optional(),
      // Create fields. The four placement fields are optional and, when given, must equal the
      // scope constants (see resolveCreateScope); `destination_uuid` is intentionally absent.
      project_uuid: z.string().optional(),
      server_uuid: z.string().optional(),
      git_repository: z.string().optional(),
      git_branch: z.string().optional(),
      environment_name: z.string().optional(),
      environment_uuid: z.string().optional(),
      build_pack: z.string().optional(),
      ports_exposes: z.string().optional(),
      // Docker image fields
      docker_registry_image_name: z.string().optional(),
      docker_registry_image_tag: z.string().optional(),
      // Dockerfile fields (create_dockerfile)
      dockerfile: z.string().optional(),
      // Update fields
      name: z.string().optional(),
      description: z.string().optional(),
      fqdn: z.string().optional(),
      domains: z.string().optional(),
      instant_deploy: z.boolean().optional(),
      // Health check fields
      health_check_enabled: z.boolean().optional(),
      health_check_path: z.string().optional(),
      health_check_port: z.number().optional(),
      health_check_host: z.string().optional(),
      health_check_method: z.string().optional(),
      health_check_return_code: z.number().optional(),
      health_check_scheme: z.string().optional(),
      health_check_response_text: z.string().optional(),
      health_check_interval: z.number().optional(),
      health_check_timeout: z.number().optional(),
      health_check_retries: z.number().optional(),
      health_check_start_period: z.number().optional(),
      // Build configuration fields (accepted on create_public/github/key + update;
      // create_dockerimage ignores these — pre-built image, no build step)
      base_directory: z.string().optional(),
      publish_directory: z.string().optional(),
      install_command: z.string().optional(),
      build_command: z.string().optional(),
      start_command: z.string().optional(),
      dockerfile_location: z.string().optional(),
      watch_paths: z.string().optional(),
      // Update-only: Coolify strips dockerfile_target_build on every create endpoint
      // (controller $allowedFields line 1014) but accepts on PATCH (line 2497).
      dockerfile_target_build: z.string().optional(),
    };
    // Update never sends build-source fields (REMOVED_UPDATE_FIELDS) nor create-time placement.
    const NEVER_UPDATABLE = [
      'action',
      'uuid',
      'project_uuid',
      'server_uuid',
      'environment_uuid',
      'environment_name',
      ...REMOVED_UPDATE_FIELDS,
    ];
    const UPDATABLE_APPLICATION_FIELDS = Object.keys(applicationShape).filter(
      (k) => !NEVER_UPDATABLE.includes(k),
    );

    this.tool(
      'application',
      'Manage app: create/update (delete unavailable — use the Coolify dashboard)',
      applicationShape,
      async (args) => {
        const { action, uuid } = args;
        let placement: ReturnType<typeof resolveCreateScope> | undefined;
        let validatedDomains: string | undefined;
        let validatedFqdn: string | undefined;
        if (action !== 'update') {
          if (!survivingCreateActions(this.removedCreateActions).includes(action)) {
            return {
              content: [{ type: 'text' as const, text: `Error: unsupported action ${action}` }],
              isError: true,
            };
          }
          try {
            placement = resolveCreateScope(args);
          } catch (error) {
            const denied = argumentErrorResult(error);
            if (denied) return denied;
            throw error;
          }
          // One application-list fetch per create call, only when a domain was supplied.
          // Coolify returns the whole list when no page params are sent, so no paging loop.
          let appsFetched: Promise<string[]> | undefined;
          const takenHosts = (): Promise<string[]> =>
            (appsFetched ??= this.client.listApplications().then((apps) => {
              if (!Array.isArray(apps)) throw new Error('application list unavailable');
              return (apps as Array<{ fqdn?: string | null }>).flatMap((a) =>
                (a.fqdn ?? '')
                  .split(',')
                  .map((u) => u.trim())
                  .filter(Boolean)
                  .map((u) => {
                    try {
                      return new URL(u).hostname.toLowerCase();
                    } catch {
                      return u.toLowerCase();
                    }
                  }),
              );
            }));
          try {
            validatedDomains = await validateCreateDomain(args.domains, takenHosts);
            validatedFqdn = await validateCreateDomain(args.fqdn, takenHosts);
          } catch (error) {
            if (error instanceof DomainError) {
              return {
                content: [{ type: 'text' as const, text: error.message }],
                isError: true,
              };
            }
            // Fail closed: if existing hosts cannot be read, nothing is created.
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `invalid_domain: could not verify host availability (${error instanceof Error ? error.message : String(error)})`,
                },
              ],
              isError: true,
            };
          }
        }
        switch (action) {
          case 'create_public':
            if (
              !args.git_repository ||
              !args.git_branch ||
              !args.build_pack ||
              !args.ports_exposes
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: git_repository, git_branch, build_pack, ports_exposes required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationPublic({
                project_uuid: placement!.project_uuid,
                server_uuid: placement!.server_uuid,
                git_repository: args.git_repository!,
                git_branch: args.git_branch!,
                build_pack: args.build_pack! as BuildPack,
                ports_exposes: args.ports_exposes!,
                environment_name: placement!.environment_name,
                environment_uuid: placement!.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: validatedFqdn,
                domains: validatedDomains,
                base_directory: args.base_directory,
                publish_directory: args.publish_directory,
                install_command: args.install_command,
                build_command: args.build_command,
                start_command: args.start_command,
                dockerfile_location: args.dockerfile_location,
                watch_paths: args.watch_paths,
                health_check_enabled: args.health_check_enabled,
                health_check_path: args.health_check_path,
                health_check_port: args.health_check_port,
                health_check_host: args.health_check_host,
                health_check_method: args.health_check_method,
                health_check_return_code: args.health_check_return_code,
                health_check_scheme: args.health_check_scheme,
                health_check_response_text: args.health_check_response_text,
                health_check_interval: args.health_check_interval,
                health_check_timeout: args.health_check_timeout,
                health_check_retries: args.health_check_retries,
                health_check_start_period: args.health_check_start_period,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_dockerimage':
            if (!args.docker_registry_image_name || !args.ports_exposes) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: docker_registry_image_name, ports_exposes required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationDockerImage({
                project_uuid: placement!.project_uuid,
                server_uuid: placement!.server_uuid,
                docker_registry_image_name: args.docker_registry_image_name!,
                ports_exposes: args.ports_exposes!,
                docker_registry_image_tag: args.docker_registry_image_tag,
                environment_name: placement!.environment_name,
                environment_uuid: placement!.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: validatedFqdn,
                domains: validatedDomains,
                // Build-config fields (base_directory, install_command, etc.)
                // are intentionally NOT forwarded: /applications/dockerimage is
                // for pre-built registry images and has no build step.
                health_check_enabled: args.health_check_enabled,
                health_check_path: args.health_check_path,
                health_check_port: args.health_check_port,
                health_check_host: args.health_check_host,
                health_check_method: args.health_check_method,
                health_check_return_code: args.health_check_return_code,
                health_check_scheme: args.health_check_scheme,
                health_check_response_text: args.health_check_response_text,
                health_check_interval: args.health_check_interval,
                health_check_timeout: args.health_check_timeout,
                health_check_retries: args.health_check_retries,
                health_check_start_period: args.health_check_start_period,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_dockerfile':
            if (!args.dockerfile) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: dockerfile required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationDockerfile({
                project_uuid: placement!.project_uuid,
                server_uuid: placement!.server_uuid,
                dockerfile: args.dockerfile!,
                dockerfile_location: args.dockerfile_location,
                ports_exposes: args.ports_exposes,
                base_directory: args.base_directory,
                environment_name: placement!.environment_name,
                environment_uuid: placement!.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: validatedFqdn,
                domains: validatedDomains,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'update': {
            if (!uuid)
              return { content: [{ type: 'text' as const, text: 'Error: uuid required' }] };
            const presentRemoved = REMOVED_UPDATE_FIELDS.filter(
              (f) => (args as Record<string, unknown>)[f] !== undefined,
            );
            if (presentRemoved.length > 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `invalid_argument: cannot update ${presentRemoved.join(', ')}: this connector cannot change build sources or domains; use the Coolify dashboard`,
                  },
                ],
                isError: true,
              };
            }
            // Allowlist, not a spread: only schema-declared fields can reach the PATCH body,
            // even if a caller bypasses zod validation.
            const updateData = Object.fromEntries(
              Object.entries(args).filter(
                ([k, v]) => UPDATABLE_APPLICATION_FIELDS.includes(k) && v !== undefined,
              ),
            );
            const denied = await denyUnlessInScope(() => assertAppInScope(this.client, uuid));
            if (denied) return denied;
            return wrap(() => this.client.updateApplication(uuid, updateData));
          }
          default:
            return {
              content: [{ type: 'text' as const, text: `Error: unsupported action ${action}` }],
              isError: true,
            };
        }
      },
    );

    // =========================================================================
    // Artifact deployer (1 tool) — strict schema: unknown keys are rejected
    // rather than silently dropped.
    // =========================================================================
    // One predicate for the append payload rules, used by the schema refinement and
    // by the handler, so validation and dispatch cannot disagree.
    const appendPayload = (a: {
      text?: string;
      b64?: string;
      sha256?: string;
    }): { hasB64: boolean; error?: string } => {
      const hasText = a.text !== undefined && a.text !== '';
      const hasB64 = a.b64 !== undefined && a.b64 !== '';
      if (hasText === hasB64) {
        return {
          hasB64,
          error: "append requires exactly one of 'text' or ('b64' + 'sha256')",
        };
      }
      if (hasB64 !== (a.sha256 !== undefined && a.sha256 !== '')) {
        return { hasB64, error: "append requires both 'b64' and 'sha256' together" };
      }
      return { hasB64 };
    };

    this.registerTool(
      'artifact',
      {
        description:
          'Deploy a static artifact via the artifact deployer: begin → append text parts (~20KB) or upload_url for binary files (sandbox uploads the bytes) → commit → status',
        inputSchema: z
          .object({
            action: z.enum(['begin', 'append', 'upload_url', 'commit', 'status']),
            name: z.string().optional(),
            owner: z.string().optional(),
            mode: z.enum(['create', 'update']).optional(),
            // Ids are interpolated into deployer URL paths; restrict the charset so
            // `.`/`..` can never address other routes.
            upload_id: z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,64}$/)
              .optional(),
            path: z.string().optional(),
            index: z.number().int().nonnegative().optional(),
            total: z.number().int().positive().optional(),
            text: z.string().optional(),
            // Path B parts: sandbox code produces b64 + sha256; the deployer rejects a
            // part whose bytes do not match. 349,528 base64 chars = 256 KB decoded.
            // The 2 MB-per-file Path B cap is enforced by the deployer only (this
            // proxy is stateless).
            b64: z
              .string()
              .min(1)
              .max(349_528)
              .optional()
              .describe('append only: base64 of one part (<=256 KB decoded); requires sha256'),
            sha256: z
              .string()
              .min(1)
              .regex(/^[0-9a-f]{64}$/)
              .optional()
              .describe(
                'append with b64: lowercase hex sha256 of the decoded part bytes; upload_url: of the whole file',
              ),
            size: z
              .number()
              .int()
              .positive()
              .max(10_485_760)
              .optional()
              .describe('upload_url only: file size in bytes (<=10 MB)'),
            deployment_uuid: z
              .string()
              .regex(/^[A-Za-z0-9]{1,64}$/)
              .optional(),
          })
          .strict()
          .superRefine((a, ctx) => {
            if (a.action !== 'append') return;
            const { error } = appendPayload(a);
            if (error) ctx.addIssue({ code: 'custom', message: error });
          }),
      },
      async (args) => {
        const errorResult = (text: string): ToolResult => ({
          content: [{ type: 'text' as const, text }],
          isError: true,
        });
        // Same shape as wrap(), but failures carry isError so the model can tell
        // them from successes.
        const run = (fn: () => Promise<unknown>): Promise<ToolResult> =>
          fn().then(
            (result) => ({
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }),
            (error) =>
              errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`),
          );

        const required = {
          begin: ['name', 'owner', 'mode'],
          append: ['upload_id', 'index', 'total'],
          upload_url: ['upload_id', 'path', 'size', 'sha256'],
          commit: ['upload_id'],
          status: ['deployment_uuid'],
        } as const;
        const missing = required[args.action].filter((k) => {
          const v = (args as Record<string, unknown>)[k];
          return v === undefined || v === '';
        });
        if (missing.length > 0) {
          return errorResult(`Error: ${args.action} requires: ${missing.join(', ')}`);
        }
        // The schema refinement already rejects bad combinations; re-check so a
        // direct handler call cannot bypass it.
        const payload = args.action === 'append' ? appendPayload(args) : { hasB64: false };
        if ('error' in payload && payload.error) {
          return errorResult(`Error: ${payload.error}`);
        }
        const deployer = this.deployer;
        if (!deployer) {
          return errorResult('Error: DEPLOYER_URL not configured');
        }
        // Required fields were verified present above, hence the `!` assertions.
        switch (args.action) {
          case 'begin':
            return run(() =>
              deployer.begin({ name: args.name!, owner: args.owner!, mode: args.mode! }),
            );
          case 'append':
            return run(() => {
              const part = {
                path: args.path ?? 'index.html',
                index: args.index!,
                total: args.total!,
              };
              return deployer.append(
                args.upload_id!,
                payload.hasB64
                  ? { ...part, b64: args.b64!, sha256: args.sha256! }
                  : { ...part, text: args.text! },
              );
            });
          case 'upload_url':
            return run(() =>
              deployer.uploadUrl(args.upload_id!, {
                path: args.path!,
                size: args.size!,
                sha256: args.sha256!,
              }),
            );
          case 'commit':
            return run(() => deployer.commit(args.upload_id!));
          case 'status':
            return run(() => deployer.status(args.deployment_uuid!));
        }
      },
    );

    this.tool(
      'application_logs',
      'Get app logs',
      { uuid: safeId(), lines: z.number().optional() },
      async ({ uuid, lines }) => {
        const denied = await denyUnlessInScope(() => assertAppInScope(this.client, uuid));
        if (denied) return denied;
        return wrap(() => this.client.getApplicationLogs(uuid, lines));
      },
    );

    // =========================================================================
    // Resource Control (1 tool - start/stop/restart for all types)
    // =========================================================================
    this.tool(
      'control',
      'Start/stop/restart an application (databases and services are not controllable from this connector)',
      {
        resource: z.enum(['application']),
        action: z.enum(['start', 'stop', 'restart']),
        uuid: safeId(),
      },
      async ({ resource, action, uuid }) => {
        // Defence in depth: the schema already restricts this, but a caller that bypasses
        // validation must still not reach database/service control.
        if (resource !== 'application') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: control only supports resource=application',
              },
            ],
          };
        }
        const denied = await denyUnlessInScope(() => assertAppInScope(this.client, uuid));
        if (denied) return denied;
        const methods: Record<string, (u: string) => Promise<unknown>> = {
          start: (u) => this.client.startApplication(u),
          stop: (u) => this.client.stopApplication(u),
          restart: (u) => this.client.restartApplication(u),
        };

        const getControlActions = (): ResponseAction[] => {
          const actions: ResponseAction[] = [
            { tool: 'application_logs', args: { uuid }, hint: 'View logs' },
            { tool: 'get_application', args: { uuid }, hint: 'Check status' },
          ];
          actions.push({
            tool: 'control',
            args: { resource: 'application', action: action === 'stop' ? 'start' : 'stop', uuid },
            hint: action === 'stop' ? 'Start' : 'Stop',
          });
          return actions;
        };

        return wrapWithActions(() => methods[action](uuid), getControlActions);
      },
    );

    // =========================================================================
    // Environment Variables (1 tool - consolidated)
    // =========================================================================
    this.tool(
      'env_vars',
      "Manage env vars for an application. Values are always masked (returned as '***') to avoid leaking secrets to MCP clients. Set is_buildtime=false (and/or is_runtime=true) for runtime-only vars to avoid Dockerfile ARG issues with multiline values like PEM keys.",
      {
        resource: z.enum(['application']),
        action: z.enum(['list', 'create', 'update', 'delete', 'bulk_update']),
        uuid: safeId(),
        key: z.string().optional(),
        value: z.string().optional(),
        env_uuid: safeId().optional(),
        is_buildtime: z.boolean().optional(),
        is_runtime: z.boolean().optional(),
        data: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
              is_preview: z.boolean().optional(),
              is_buildtime: z.boolean().optional(),
              is_runtime: z.boolean().optional(),
              is_literal: z.boolean().optional(),
              is_multiline: z.boolean().optional(),
              is_shown_once: z.boolean().optional(),
            }),
          )
          .optional(),
      },
      async ({ resource, action, uuid, key, value, env_uuid, is_buildtime, is_runtime, data }) => {
        // Defence in depth: the schema already restricts this, but a caller that bypasses
        // validation must still not reach service/database env vars.
        if (resource !== 'application') {
          return {
            content: [
              { type: 'text' as const, text: 'Error: env_vars only supports resource=application' },
            ],
          };
        }
        // Validate every path-bound id before the scope lookup so a bad one costs zero requests.
        const denied = await denyUnlessInScope(async () => {
          if (env_uuid !== undefined) safeSegment(env_uuid, 'env_uuid');
          await assertAppInScope(this.client, uuid);
        });
        if (denied) return denied;
        switch (action) {
          case 'list':
            // No reveal option: plaintext values never leave through this connector.
            return wrap(() => this.client.listApplicationEnvVars(uuid, { summary: true }));
          case 'create':
            if (!key || !value)
              return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
            return wrap(() =>
              this.client.createApplicationEnvVar(uuid, {
                key,
                value,
                is_buildtime,
                is_runtime,
              }),
            );
          case 'update':
            if (!key || !value)
              return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
            return wrap(() =>
              this.client.updateApplicationEnvVar(uuid, {
                key,
                value,
                is_buildtime,
                is_runtime,
              }),
            );
          case 'delete':
            if (!env_uuid)
              return { content: [{ type: 'text' as const, text: 'Error: env_uuid required' }] };
            return wrap(() => this.client.deleteApplicationEnvVar(uuid, env_uuid));
          case 'bulk_update':
            if (!data)
              return { content: [{ type: 'text' as const, text: 'Error: data array required' }] };
            return wrap(() => this.client.bulkUpdateApplicationEnvVars(uuid, { data }));
        }
      },
    );

    // =========================================================================
    // Deployments (3 tools)
    // =========================================================================
    this.tool(
      'list_deployments',
      'List deployments (summary)',
      { page: z.number().optional(), per_page: z.number().optional() },
      async ({ page, per_page }) =>
        wrapWithActions(
          () => this.client.listDeployments({ page, per_page, summary: true }),
          undefined,
          (result) =>
            getPagination('list_deployments', page, per_page, (result as unknown[]).length),
        ),
    );

    this.tool(
      'deploy',
      'Deploy an application by UUID',
      {
        tag_or_uuid: z
          .string()
          .regex(APP_UUID_RE, 'invalid_argument: must be a 24-char lowercase uuid'),
        force: z.boolean().optional(),
        wait: z
          .boolean()
          .optional()
          .describe(
            'Wait for the deployment to reach a terminal status (finished/failed/cancelled) instead of returning immediately, polling every ~5s. If tag_or_uuid matches multiple applications (a tag can trigger several deployments), only the first is watched — the rest are returned under additional_deployment_uuids for you to check separately via `deployment get`. On failure the response includes a bounded log tail. Default false (fire-and-forget, unchanged response).',
          ),
        timeout_seconds: z
          .number()
          .optional()
          .describe(
            'Max seconds to poll when wait is true before giving up and returning the current status plus a next-action hint (default 300). Ignored when wait is false.',
          ),
      },
      async ({ tag_or_uuid, force, wait, timeout_seconds }) => {
        const denied = await denyUnlessInScope(() => assertAppInScope(this.client, tag_or_uuid));
        if (denied) return denied;
        if (!wait) {
          return wrapWithActions(
            () => this.client.deployByTagOrUuid(tag_or_uuid, force),
            () => [{ tool: 'list_deployments', args: {}, hint: 'Check deployment status' }],
          );
        }
        return wrapWithActions(
          () =>
            this.triggerAndWaitForDeploy(
              tag_or_uuid,
              force,
              timeout_seconds ?? DEFAULT_DEPLOY_TIMEOUT_SECONDS,
            ),
          (result) =>
            'deployment_uuid' in result
              ? getDeploymentActions(result.deployment_uuid, result.status, result.application_uuid)
              : [],
        );
      },
    );

    this.tool(
      'deployment',
      'Manage deployment: get/cancel/list_for_app. Logs excluded by default on all actions — for get use `lines` (paginated tail), for list_for_app use `include_logs: true` to include raw build-log blobs.',
      {
        action: z.enum(['get', 'cancel', 'list_for_app']),
        uuid: safeId(),
        lines: z.number().optional(), // Include logs truncated to last N entries (omit for no logs)
        page: z.number().optional(), // Log page (1=most recent, 2=older, etc.)
        max_chars: z.number().optional(), // Limit log output to last N chars (default: 50000)
        include_logs: z.boolean().optional(), // list_for_app only: include raw build logs (default false; upstream returns ~30KB per deployment)
      },
      async ({ action, uuid, lines, page, max_chars, include_logs }) => {
        const denied = await denyUnlessInScope(() =>
          action === 'list_for_app'
            ? assertAppInScope(this.client, uuid)
            : assertDeploymentInScope(this.client, uuid),
        );
        if (denied) return denied;
        switch (action) {
          case 'get':
            // If lines param specified, include logs and truncate
            if (lines !== undefined) {
              const p = page ?? 1;
              const ll = lines;
              return wrapWithActions(
                async () => {
                  const deployment = await this.client.getDeployment(uuid, {
                    includeLogs: true,
                  });
                  if (deployment.logs) {
                    const result = truncateLogs(deployment.logs, ll, max_chars ?? 50000, p);
                    deployment.logs = result.logs;
                    return {
                      ...deployment,
                      logs_meta: {
                        total_entries: result.total,
                        showing: `${result.showing_start}-${result.showing_end} of ${result.total}`,
                      },
                    };
                  }
                  return { ...deployment, logs_meta: undefined };
                },
                (dep) => getDeploymentActions(dep.uuid, dep.status, dep.application_uuid),
                (dep) => {
                  const total = dep.logs_meta?.total_entries ?? 0;
                  const hasOlder = p * ll < total;
                  const pagination: ResponsePagination = {};
                  if (hasOlder)
                    pagination.next = {
                      tool: 'deployment',
                      args: { action: 'get', uuid, lines: ll, page: p + 1 },
                    };
                  if (p > 1)
                    pagination.prev = {
                      tool: 'deployment',
                      args: { action: 'get', uuid, lines: ll, page: p - 1 },
                    };
                  return Object.keys(pagination).length > 0 ? pagination : undefined;
                },
              );
            }
            // Otherwise return essential info without logs
            return wrapWithActions(
              () => this.client.getDeployment(uuid),
              (dep) => getDeploymentActions(dep.uuid, dep.status, dep.application_uuid),
            );
          case 'cancel':
            return wrap(() => this.client.cancelDeployment(uuid));
          case 'list_for_app':
            return wrap(() =>
              this.client.listApplicationDeployments(uuid, { includeLogs: include_logs }),
            );
        }
      },
    );
  }
}
