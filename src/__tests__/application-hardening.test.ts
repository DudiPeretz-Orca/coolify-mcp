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
      health_check_enabled: true,
      health_check_port: 3000,
      dockerfile_target_build: 'worker',
      watch_paths: 'apps/api/**',
    });
    const bodies = writeBodies();
    expect(JSON.parse(bodies[0])).toEqual({
      name: 'n',
      domains: 'https://a.tools.orca-internal.net',
      health_check_enabled: true,
      health_check_port: 3000,
      dockerfile_target_build: 'worker',
      watch_paths: 'apps/api/**',
    });
  });

  // ---- Second hardening round: custom_labels, github_app_uuid, private_key_uuid, control ----

  const REMOVED_FIELDS = ['custom_labels', 'github_app_uuid', 'private_key_uuid'];
  const REMOVED_VALUES: Record<string, string> = {
    custom_labels: 'dHJhZWZpay5odHRwLnJvdXRlcnMueC5ydWxlPUhvc3QoYHZpY3RpbWAp',
    github_app_uuid: 'gh-app-uuid-sentinel',
    private_key_uuid: 'private-key-uuid-sentinel',
  };

  it('the application schema advertises none of custom_labels, github_app_uuid, private_key_uuid', async () => {
    const { tools } = await client.listTools();
    const app = tools.find((t) => t.name === 'application')!;
    const props = Object.keys((app.inputSchema as { properties: object }).properties);
    for (const f of REMOVED_FIELDS) {
      expect(props).not.toContain(f);
    }
    const serialized = JSON.stringify(tools);
    for (const f of REMOVED_FIELDS) {
      expect(serialized).not.toContain(f);
    }
  });

  it('the application action enum no longer offers create_github or create_key', async () => {
    const { tools } = await client.listTools();
    const app = tools.find((t) => t.name === 'application')!;
    const action = (app.inputSchema as unknown as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(action).toEqual(['create_public', 'create_dockerimage', 'create_dockerfile', 'update']);
  });

  it.each(['create_github', 'create_key'])(
    '%s is rejected and sends no request to Coolify',
    async (action) => {
      const result = await callApplication({
        action,
        project_uuid: 'p',
        server_uuid: 's',
        git_repository: 'o/r',
        git_branch: 'main',
        github_app_uuid: REMOVED_VALUES.github_app_uuid,
        private_key_uuid: REMOVED_VALUES.private_key_uuid,
      });
      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each(createCases)(
    '%s never puts custom_labels, github_app_uuid or private_key_uuid in the body',
    async (_name, base) => {
      await callApplication({ ...base, ...REMOVED_VALUES });
      const bodies = writeBodies();
      expect(bodies).toHaveLength(1);
      for (const f of REMOVED_FIELDS) {
        expect(bodies[0]).not.toContain(f);
        expect(bodies[0]).not.toContain(REMOVED_VALUES[f]);
      }
    },
  );

  it('update never puts custom_labels, github_app_uuid or private_key_uuid in the PATCH body', async () => {
    await callApplication({
      action: 'update',
      uuid: 'app-uuid',
      name: 'renamed',
      ...REMOVED_VALUES,
    });
    expect(JSON.parse(writeBodies()[0])).toEqual({ name: 'renamed' });
  });

  it('update handler with zod bypassed still drops the removed fields', async () => {
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: Record<string, unknown>, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools['application'];
    await tool.handler({ action: 'update', uuid: 'app-uuid', name: 'x', ...REMOVED_VALUES }, {});
    expect(JSON.parse(writeBodies()[0])).toEqual({ name: 'x' });
  });

  describe('control only acts on applications', () => {
    const callControl = (args: Record<string, unknown>): ReturnType<Client['callTool']> =>
      client.callTool({ name: 'control', arguments: args });

    it('schema offers only resource=application', async () => {
      const { tools } = await client.listTools();
      const control = tools.find((t) => t.name === 'control')!;
      const resource = (
        control.inputSchema as unknown as { properties: { resource: { enum: string[] } } }
      ).properties.resource.enum;
      expect(resource).toEqual(['application']);
      expect(JSON.stringify(control)).not.toContain('pull_latest');
    });

    it.each(['database', 'service'])(
      'resource=%s is rejected with no request',
      async (resource) => {
        const result = await callControl({ resource, action: 'stop', uuid: 'u' });
        expect(result.isError).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each(['database', 'service'])(
      'handler called directly (zod bypassed) with resource=%s sends no request',
      async (resource) => {
        const tool = (
          server as unknown as {
            _registeredTools: Record<
              string,
              { handler: (a: Record<string, unknown>, extra: unknown) => Promise<unknown> }
            >;
          }
        )._registeredTools['control'];
        await tool.handler({ resource, action: 'restart', uuid: 'u' }, {});
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['start', '/applications/app-uuid/start'],
      ['stop', '/applications/app-uuid/stop'],
      ['restart', '/applications/app-uuid/restart'],
    ])('application %s still works', async (action, path) => {
      const result = await callControl({ resource: 'application', action, uuid: 'app-uuid' });
      expect(result.isError).toBeFalsy();
      const urls = mockFetch.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.endsWith(path))).toBe(true);
    });
  });

  describe('legitimate flows still work', () => {
    it('create_public with domains, health checks and build config', async () => {
      await callApplication({
        action: 'create_public',
        project_uuid: 'p',
        server_uuid: 's',
        git_repository: 'https://github.com/o/r',
        git_branch: 'main',
        build_pack: 'nixpacks',
        ports_exposes: '3000',
        domains: 'https://app.tools.orca-internal.net',
        base_directory: '/apps/api',
        health_check_enabled: true,
        health_check_path: '/health',
      });
      expect(JSON.parse(writeBodies()[0])).toMatchObject({
        git_repository: 'https://github.com/o/r',
        domains: 'https://app.tools.orca-internal.net',
        base_directory: '/apps/api',
        health_check_enabled: true,
        health_check_path: '/health',
      });
    });

    it('create_dockerfile with domains', async () => {
      await callApplication({
        action: 'create_dockerfile',
        project_uuid: 'p',
        server_uuid: 's',
        dockerfile: 'FROM nginx',
        ports_exposes: '80',
        domains: 'https://site.tools.orca-internal.net',
        instant_deploy: true,
      });
      expect(JSON.parse(writeBodies()[0])).toMatchObject({
        domains: 'https://site.tools.orca-internal.net',
        ports_exposes: '80',
        instant_deploy: true,
      });
    });

    it('update with domains', async () => {
      await callApplication({
        action: 'update',
        uuid: 'app-uuid',
        domains: 'https://app.tools.orca-internal.net',
      });
      expect(JSON.parse(writeBodies()[0])).toEqual({
        domains: 'https://app.tools.orca-internal.net',
      });
    });

    it('env_vars create on an application', async () => {
      const result = await client.callTool({
        name: 'env_vars',
        arguments: {
          resource: 'application',
          action: 'create',
          uuid: 'app-uuid',
          key: 'FOO',
          value: 'bar',
        },
      });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(writeBodies()[0]);
      expect(body).toMatchObject({ key: 'FOO', value: 'bar' });
    });

    it('artifact tool still registers and routes begin to the deployer', async () => {
      mockFetch.mockImplementation(async () => jsonResponse({ upload_id: 'u1' }));
      const result = await client.callTool({
        name: 'artifact',
        arguments: { action: 'begin', name: 'demo', owner: 'dudi', mode: 'create' },
      });
      expect(result.isError).toBeFalsy();
      expect(String(mockFetch.mock.calls[0][0])).toContain('deployer.invalid');
    });
  });
});
