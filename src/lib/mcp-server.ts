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

/** Wrap handler with error handling */
function wrap<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return fn()
    .then((result) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }))
    .catch((error) => ({
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }));
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
    .catch((error) => ({
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }));
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

  constructor(config: CoolifyConfig) {
    super({ name: 'coolify', version: VERSION });
    this.client = new CoolifyClient(config);
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
      async ({ query }) => wrap(() => this.client.diagnoseApplication(query)),
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
      'Manage projects: list/get/create/update (delete unavailable — use the Coolify dashboard)',
      {
        action: z.enum(['list', 'get', 'create', 'update']),
        uuid: z.string().optional(),
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
          case 'update':
            if (!uuid)
              return { content: [{ type: 'text' as const, text: 'Error: uuid required' }] };
            return wrap(() => this.client.updateProject(uuid, { name, description }));
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
        project_uuid: z.string(),
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

    this.tool(
      'application',
      'Manage app: create/update (delete unavailable — use the Coolify dashboard)',
      {
        action: z.enum([
          'create_public',
          'create_github',
          'create_key',
          'create_dockerimage',
          'create_dockerfile',
          'update',
        ]),
        uuid: z.string().optional(),
        // Create fields
        project_uuid: z.string().optional(),
        server_uuid: z.string().optional(),
        github_app_uuid: z.string().optional(),
        private_key_uuid: z.string().optional(),
        destination_uuid: z.string().optional(),
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
        custom_docker_run_options: z.string().optional(),
        custom_labels: z.string().optional(),
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
      },
      async (args) => {
        const { action, uuid } = args;
        switch (action) {
          case 'create_public':
            if (
              !args.project_uuid ||
              !args.server_uuid ||
              !args.git_repository ||
              !args.git_branch ||
              !args.build_pack ||
              !args.ports_exposes
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: project_uuid, server_uuid, git_repository, git_branch, build_pack, ports_exposes required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationPublic({
                project_uuid: args.project_uuid!,
                server_uuid: args.server_uuid!,
                destination_uuid: args.destination_uuid,
                git_repository: args.git_repository!,
                git_branch: args.git_branch!,
                build_pack: args.build_pack! as BuildPack,
                ports_exposes: args.ports_exposes!,
                environment_name: args.environment_name,
                environment_uuid: args.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: args.fqdn,
                domains: args.domains,
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
                custom_docker_run_options: args.custom_docker_run_options,
                custom_labels: args.custom_labels,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_github':
            if (
              !args.project_uuid ||
              !args.server_uuid ||
              !args.github_app_uuid ||
              !args.git_repository ||
              !args.git_branch
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: project_uuid, server_uuid, github_app_uuid, git_repository, git_branch required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationPrivateGH({
                project_uuid: args.project_uuid!,
                server_uuid: args.server_uuid!,
                github_app_uuid: args.github_app_uuid!,
                destination_uuid: args.destination_uuid,
                git_repository: args.git_repository!,
                git_branch: args.git_branch!,
                build_pack: args.build_pack as BuildPack | undefined,
                ports_exposes: args.ports_exposes,
                environment_name: args.environment_name,
                environment_uuid: args.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: args.fqdn,
                domains: args.domains,
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
                custom_docker_run_options: args.custom_docker_run_options,
                custom_labels: args.custom_labels,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_key':
            if (
              !args.project_uuid ||
              !args.server_uuid ||
              !args.private_key_uuid ||
              !args.git_repository ||
              !args.git_branch
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: project_uuid, server_uuid, private_key_uuid, git_repository, git_branch required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationPrivateKey({
                project_uuid: args.project_uuid!,
                server_uuid: args.server_uuid!,
                private_key_uuid: args.private_key_uuid!,
                destination_uuid: args.destination_uuid,
                git_repository: args.git_repository!,
                git_branch: args.git_branch!,
                build_pack: args.build_pack as BuildPack | undefined,
                ports_exposes: args.ports_exposes,
                environment_name: args.environment_name,
                environment_uuid: args.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: args.fqdn,
                domains: args.domains,
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
                custom_docker_run_options: args.custom_docker_run_options,
                custom_labels: args.custom_labels,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_dockerimage':
            if (
              !args.project_uuid ||
              !args.server_uuid ||
              !args.docker_registry_image_name ||
              !args.ports_exposes
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: project_uuid, server_uuid, docker_registry_image_name, ports_exposes required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationDockerImage({
                project_uuid: args.project_uuid!,
                server_uuid: args.server_uuid!,
                destination_uuid: args.destination_uuid,
                docker_registry_image_name: args.docker_registry_image_name!,
                ports_exposes: args.ports_exposes!,
                docker_registry_image_tag: args.docker_registry_image_tag,
                environment_name: args.environment_name,
                environment_uuid: args.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: args.fqdn,
                domains: args.domains,
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
                custom_docker_run_options: args.custom_docker_run_options,
                custom_labels: args.custom_labels,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'create_dockerfile':
            if (!args.project_uuid || !args.server_uuid || !args.dockerfile) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: project_uuid, server_uuid, dockerfile required',
                  },
                ],
              };
            }
            return wrap(() =>
              this.client.createApplicationDockerfile({
                project_uuid: args.project_uuid!,
                server_uuid: args.server_uuid!,
                destination_uuid: args.destination_uuid,
                dockerfile: args.dockerfile!,
                dockerfile_location: args.dockerfile_location,
                ports_exposes: args.ports_exposes,
                base_directory: args.base_directory,
                environment_name: args.environment_name,
                environment_uuid: args.environment_uuid,
                name: args.name,
                description: args.description,
                fqdn: args.fqdn,
                domains: args.domains,
                custom_docker_run_options: args.custom_docker_run_options,
                custom_labels: args.custom_labels,
                instant_deploy: args.instant_deploy,
              }),
            );
          case 'update': {
            if (!uuid)
              return { content: [{ type: 'text' as const, text: 'Error: uuid required' }] };
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { action: _, uuid: __, ...updateData } = args;
            return wrap(() => this.client.updateApplication(uuid, updateData));
          }
        }
      },
    );

    this.tool(
      'application_logs',
      'Get app logs',
      { uuid: z.string(), lines: z.number().optional() },
      async ({ uuid, lines }) => wrap(() => this.client.getApplicationLogs(uuid, lines)),
    );

    // =========================================================================
    // Resource Control (1 tool - start/stop/restart for all types)
    // =========================================================================
    this.tool(
      'control',
      'Start/stop/restart app, database, or service',
      {
        resource: z.enum(['application', 'database', 'service']),
        action: z.enum(['start', 'stop', 'restart']),
        uuid: z.string(),
        pull_latest: z
          .boolean()
          .optional()
          .describe('Pull latest images before restarting (services only)'),
      },
      async ({ resource, action, uuid, pull_latest }) => {
        const methods: Record<string, Record<string, (u: string) => Promise<unknown>>> = {
          application: {
            start: (u) => this.client.startApplication(u),
            stop: (u) => this.client.stopApplication(u),
            restart: (u) => this.client.restartApplication(u),
          },
          database: {
            start: (u) => this.client.startDatabase(u),
            stop: (u) => this.client.stopDatabase(u),
            restart: (u) => this.client.restartDatabase(u),
          },
          service: {
            start: (u) => this.client.startService(u),
            stop: (u) => this.client.stopService(u),
            restart: (u) => this.client.restartService(u, pull_latest),
          },
        };

        // Generate contextual actions based on resource type and action taken
        const getControlActions = (): ResponseAction[] => {
          const actions: ResponseAction[] = [];
          if (resource === 'application') {
            actions.push({ tool: 'application_logs', args: { uuid }, hint: 'View logs' });
            actions.push({ tool: 'get_application', args: { uuid }, hint: 'Check status' });
            if (action === 'start' || action === 'restart') {
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
          } else if (resource === 'database') {
            actions.push({ tool: 'get_database', args: { uuid }, hint: 'Check status' });
          } else if (resource === 'service') {
            actions.push({ tool: 'get_service', args: { uuid }, hint: 'Check status' });
          }
          return actions;
        };

        return wrapWithActions(() => methods[resource][action](uuid), getControlActions);
      },
    );

    // =========================================================================
    // Environment Variables (1 tool - consolidated)
    // =========================================================================
    this.tool(
      'env_vars',
      "Manage env vars for app, service, or database. Values are masked by default (returned as '***') to avoid leaking secrets to MCP clients; pass reveal=true on the list action when the caller explicitly needs the plaintext (e.g. 'what is FOO set to?'). Set is_buildtime=false (and/or is_runtime=true) for runtime-only vars to avoid Dockerfile ARG issues with multiline values like PEM keys.",
      {
        resource: z.enum(['application', 'service', 'database']),
        action: z.enum(['list', 'create', 'update', 'delete', 'bulk_update']),
        uuid: z.string(),
        key: z.string().optional(),
        value: z.string().optional(),
        env_uuid: z.string().optional(),
        is_buildtime: z.boolean().optional(),
        is_runtime: z.boolean().optional(),
        reveal: z.boolean().optional(),
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
      async ({
        resource,
        action,
        uuid,
        key,
        value,
        env_uuid,
        is_buildtime,
        is_runtime,
        reveal,
        data,
      }) => {
        if (resource === 'application') {
          switch (action) {
            case 'list':
              return wrap(() =>
                this.client.listApplicationEnvVars(uuid, { summary: true, reveal }),
              );
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
        } else if (resource === 'service') {
          switch (action) {
            case 'list':
              return wrap(() => this.client.listServiceEnvVars(uuid, { reveal }));
            case 'create':
              if (!key || !value)
                return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
              return wrap(() =>
                this.client.createServiceEnvVar(uuid, { key, value, is_buildtime, is_runtime }),
              );
            case 'update':
              if (!key || !value)
                return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
              return wrap(() =>
                this.client.updateServiceEnvVar(uuid, { key, value, is_buildtime, is_runtime }),
              );
            case 'delete':
              if (!env_uuid)
                return { content: [{ type: 'text' as const, text: 'Error: env_uuid required' }] };
              return wrap(() => this.client.deleteServiceEnvVar(uuid, env_uuid));
            case 'bulk_update':
              if (!data)
                return { content: [{ type: 'text' as const, text: 'Error: data array required' }] };
              return wrap(() => this.client.bulkUpdateServiceEnvVars(uuid, { data }));
          }
        } else {
          switch (action) {
            case 'list':
              return wrap(() => this.client.listDatabaseEnvVars(uuid));
            case 'create':
              if (!key || !value)
                return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
              return wrap(() =>
                this.client.createDatabaseEnvVar(uuid, { key, value, is_buildtime, is_runtime }),
              );
            case 'update':
              if (!key || !value)
                return { content: [{ type: 'text' as const, text: 'Error: key, value required' }] };
              return wrap(() =>
                this.client.updateDatabaseEnvVar(uuid, { key, value, is_buildtime, is_runtime }),
              );
            case 'delete':
              if (!env_uuid)
                return { content: [{ type: 'text' as const, text: 'Error: env_uuid required' }] };
              return wrap(() => this.client.deleteDatabaseEnvVar(uuid, env_uuid));
            case 'bulk_update':
              if (!data)
                return { content: [{ type: 'text' as const, text: 'Error: data array required' }] };
              return wrap(() => this.client.bulkUpdateDatabaseEnvVars(uuid, { data }));
          }
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
      'Deploy by tag/UUID',
      {
        tag_or_uuid: z.string(),
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
        uuid: z.string(),
        lines: z.number().optional(), // Include logs truncated to last N entries (omit for no logs)
        page: z.number().optional(), // Log page (1=most recent, 2=older, etc.)
        max_chars: z.number().optional(), // Limit log output to last N chars (default: 50000)
        include_logs: z.boolean().optional(), // list_for_app only: include raw build logs (default false; upstream returns ~30KB per deployment)
      },
      async ({ action, uuid, lines, page, max_chars, include_logs }) => {
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
