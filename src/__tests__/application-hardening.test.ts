/**
 * Orca fork hardening: `custom_docker_run_options` must be unreachable from every MCP tool path.
 *
 * Coolify turns that field into raw `docker run` flags (--privileged, --cap-add, --device, ...),
 * so any connector user could start a privileged container on the shared host. These tests drive
 * the real MCP protocol (Client <-> InMemoryTransport) and mock global fetch, so they assert on
 * what actually reaches the Coolify HTTP API, not on handler internals.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';

const FORBIDDEN = 'custom_docker_run_options';

const EXPECTED_TOOLS = [
  'application',
  'application_logs',
  'artifact',
  'control',
  'deploy',
  'deployment',
  'diagnose_app',
  'env_vars',
  'environments',
  'find_issues',
  'get_infrastructure_overview',
  'get_version',
  'list_applications',
  'list_deployments',
  'list_servers',
  'projects',
];

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('application tool: custom_docker_run_options is removed (Orca fork hardening)', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  let server: CoolifyMcpServer;
  let client: Client;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => jsonResponse({ uuid: 'app-uuid' }));
    global.fetch = mockFetch;
    // deployerUrl is set so the `artifact` tool registers and the 16-tool count is exact.
    server = new CoolifyMcpServer({
      baseUrl: 'http://localhost:3000',
      accessToken: 'test-token',
      deployerUrl: 'http://deployer.invalid',
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await client.close();
  });

  /** Bodies of every non-GET request the server sent to Coolify. */
  const writeBodies = (): string[] =>
    mockFetch.mock.calls
      .filter(([, init]) => init?.method && init.method !== 'GET')
      .map(([, init]) => String(init?.body ?? ''));

  const callApplication = (args: Record<string, unknown>): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'application', arguments: args });

  it('tools/list returns exactly the 16 allow-listed tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(tools).toHaveLength(16);
  });

  it('the application tool schema does not advertise custom_docker_run_options', async () => {
    const { tools } = await client.listTools();
    const app = tools.find((t) => t.name === 'application')!;
    const props = Object.keys((app.inputSchema as { properties: object }).properties);
    expect(props).not.toContain(FORBIDDEN);
    expect(JSON.stringify(app)).not.toContain(FORBIDDEN);
  });

  it('no registered tool schema mentions custom_docker_run_options', async () => {
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).not.toContain(FORBIDDEN);
  });

  const createCases: Array<[string, Record<string, unknown>]> = [
    [
      'create_public',
      {
        action: 'create_public',
        project_uuid: 'p',
        server_uuid: 's',
        git_repository: 'https://github.com/o/r',
        git_branch: 'main',
        build_pack: 'nixpacks',
        ports_exposes: '3000',
      },
    ],
    [
      'create_github',
      {
        action: 'create_github',
        project_uuid: 'p',
        server_uuid: 's',
        github_app_uuid: 'g',
        git_repository: 'o/r',
        git_branch: 'main',
      },
    ],
    [
      'create_key',
      {
        action: 'create_key',
        project_uuid: 'p',
        server_uuid: 's',
        private_key_uuid: 'k',
        git_repository: 'o/r',
        git_branch: 'main',
      },
    ],
    [
      'create_dockerimage',
      {
        action: 'create_dockerimage',
        project_uuid: 'p',
        server_uuid: 's',
        docker_registry_image_name: 'traefik/whoami',
        ports_exposes: '80',
      },
    ],
    [
      'create_dockerfile',
      {
        action: 'create_dockerfile',
        project_uuid: 'p',
        server_uuid: 's',
        dockerfile: 'FROM scratch',
      },
    ],
  ];

  it.each(createCases)(
    '%s never puts custom_docker_run_options in the request body',
    async (_name, base) => {
      await callApplication({ ...base, [FORBIDDEN]: '--privileged' });
      const bodies = writeBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain(FORBIDDEN);
      expect(bodies[0]).not.toContain('--privileged');
    },
  );

  it('update never puts custom_docker_run_options in the PATCH body', async () => {
    await callApplication({
      action: 'update',
      uuid: 'app-uuid',
      name: 'renamed',
      [FORBIDDEN]: '--privileged --cap-add=SYS_ADMIN --device=/dev/sda',
    });
    const bodies = writeBodies();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual({ name: 'renamed' });
  });

  it('update drops other unknown/undeclared keys sent by a client (zod strips them)', async () => {
    await callApplication({
      action: 'update',
      uuid: 'app-uuid',
      name: 'renamed',
      ports_mappings: '22:22',
      docker_compose_raw: 'x',
      custom_nginx_configuration: 'x',
      pre_deployment_command: 'x',
      post_deployment_command: 'x',
      redirect: 'www',
      force_domain_override: true,
      limits_memory: '1g',
      connect_to_docker_network: true,
      is_container_label_readonly_enabled: false,
    });
    expect(JSON.parse(writeBodies()[0])).toEqual({ name: 'renamed' });
  });

  it('update only forwards fields declared in the tool schema (allowlist, not spread)', async () => {
    // Called on the handler directly, i.e. with zod bypassed, to prove the handler
    // itself does not forward unknown keys.
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: Record<string, unknown>, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools['application'];
    await tool.handler(
      {
        action: 'update',
        uuid: 'app-uuid',
        name: 'renamed',
        [FORBIDDEN]: '--privileged',
        ports_mappings: '22:22',
        docker_compose_raw: 'x',
      },
      {},
    );
    const bodies = writeBodies();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual({ name: 'renamed' });
  });

  it('update still forwards declared fields (no regression)', async () => {
    await callApplication({
      action: 'update',
      uuid: 'app-uuid',
      name: 'n',
      domains: 'https://a.tools.orca-internal.net',
      custom_labels: 'dHJhZWZpaw==',
      health_check_enabled: true,
      health_check_port: 3000,
      dockerfile_target_build: 'worker',
      watch_paths: 'apps/api/**',
    });
    const bodies = writeBodies();
    expect(JSON.parse(bodies[0])).toEqual({
      name: 'n',
      domains: 'https://a.tools.orca-internal.net',
      custom_labels: 'dHJhZWZpaw==',
      health_check_enabled: true,
      health_check_port: 3000,
      dockerfile_target_build: 'worker',
      watch_paths: 'apps/api/**',
    });
  });
});
