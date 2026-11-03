/**
 * Orca fork scope gate: only apps in environment 14 (Artifacts/production) are manageable and
 * the artifact deployer is always denied. Drives the real MCP protocol with global fetch mocked.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';

const IN_SCOPE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OUT_SCOPE = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DEPLOYER = 'pvaqszi5ivm0dnk7nhwegjnd';
const DEPLOYMENT = 'dddddddddddddddddddddddd';
const OTHER_DEPLOYMENT = 'eeeeeeeeeeeeeeeeeeeeeeee';

function res(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('scope gate (environment 14 only)', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  let client: Client;
  let apps: Record<string, { status: number; body: unknown }>;
  let deployments: Record<string, unknown>;

  beforeEach(async () => {
    mockFetch.mockReset();
    apps = {
      [IN_SCOPE]: { status: 200, body: { uuid: IN_SCOPE, environment_id: 14 } },
      [OUT_SCOPE]: { status: 200, body: { uuid: OUT_SCOPE, environment_id: 7 } },
      [DEPLOYER]: { status: 200, body: { uuid: DEPLOYER, environment_id: 14 } },
    };
    deployments = {
      [DEPLOYMENT]: { uuid: DEPLOYMENT, application_uuid: OUT_SCOPE, status: 'in_progress' },
      [OTHER_DEPLOYMENT]: { uuid: OTHER_DEPLOYMENT, status: 'in_progress' },
    };
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const app = url.match(/\/applications\/([^/?]+)$/);
      if (method === 'GET' && app) {
        const entry = apps[app[1]];
        return entry ? res(entry.status, entry.body) : res(404, { message: 'not found' });
      }
      const dep = url.match(/\/deployments\/([^/?]+)$/);
      if (method === 'GET' && dep) {
        return deployments[dep[1]] ? res(200, deployments[dep[1]]) : res(404, {});
      }
      if (/\/envs$/.test(url) && method === 'GET') {
        return res(200, [{ uuid: 'e1', key: 'K', value: 'plain-secret' }]);
      }
      return res(200, { message: 'ok', uuid: IN_SCOPE });
    });
    global.fetch = mockFetch;
    const server = new CoolifyMcpServer({
      baseUrl: 'http://localhost:3000',
      accessToken: 'test-token',
      deployerUrl: 'http://deployer.invalid',
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await client.close();
  });

  const writes = (): Array<[string, string]> =>
    mockFetch.mock.calls
      .filter(([, init]) => init?.method && init.method !== 'GET')
      .map(([url, init]) => [String(init?.method), String(url)]);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: r.isError, text: r.content[0]?.text ?? '' };
  };

  const expectDenied = (r: { isError?: boolean; text: string }) => {
    expect(r.isError).toBe(true);
    expect(r.text.startsWith('out_of_scope')).toBe(true);
  };

  const gated = (uuid: string): Array<[string, string, Record<string, unknown>]> => [
    ['application update', 'application', { action: 'update', uuid, name: 'x' }],
    ['control start', 'control', { resource: 'application', action: 'start', uuid }],
    ['control stop', 'control', { resource: 'application', action: 'stop', uuid }],
    ['control restart', 'control', { resource: 'application', action: 'restart', uuid }],
    ['env_vars list', 'env_vars', { resource: 'application', action: 'list', uuid }],
    [
      'env_vars create',
      'env_vars',
      { resource: 'application', action: 'create', uuid, key: 'K', value: 'v' },
    ],
    [
      'env_vars update',
      'env_vars',
      { resource: 'application', action: 'update', uuid, key: 'K', value: 'v' },
    ],
    [
      'env_vars delete',
      'env_vars',
      { resource: 'application', action: 'delete', uuid, env_uuid: 'e1' },
    ],
    [
      'env_vars bulk_update',
      'env_vars',
      {
        resource: 'application',
        action: 'bulk_update',
        uuid,
        data: [{ key: 'K', value: 'v' }],
      },
    ],
    ['deploy', 'deploy', { tag_or_uuid: uuid }],
    ['deployment list_for_app', 'deployment', { action: 'list_for_app', uuid }],
    ['application_logs', 'application_logs', { uuid }],
    ['diagnose_app', 'diagnose_app', { query: uuid }],
  ];

  it('in-scope app (environment_id 14): control restart sends POST /applications/<uuid>/restart', async () => {
    const r = await call('control', { resource: 'application', action: 'restart', uuid: IN_SCOPE });
    expect(r.isError).toBeFalsy();
    expect(writes().map(([m, u]) => `${m} ${new URL(u).pathname}`)).toEqual([
      `POST /api/v1/applications/${IN_SCOPE}/restart`,
    ]);
  });

  it.each(gated(OUT_SCOPE))(
    'out-of-scope app (environment_id 7): %s is out_of_scope with zero writes',
    async (_n, tool, args) => {
      expectDenied(await call(tool, args));
      expect(writes()).toHaveLength(0);
    },
  );

  it.each([
    ['deployment get', { action: 'get', uuid: DEPLOYMENT }],
    ['deployment get with lines', { action: 'get', uuid: DEPLOYMENT, lines: 5 }],
    ['deployment cancel', { action: 'cancel', uuid: DEPLOYMENT }],
  ])('out-of-scope app: %s is out_of_scope with zero writes', async (_n, args) => {
    expectDenied(await call('deployment', args));
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['empty object', {}],
    ['string 14', { environment_id: '14' }],
  ])('missing or non-numeric environment_id is out of scope (%s)', async (_n, body) => {
    apps[IN_SCOPE] = { status: 200, body };
    expectDenied(
      await call('control', { resource: 'application', action: 'stop', uuid: IN_SCOPE }),
    );
    expect(writes()).toHaveLength(0);
  });

  it.each([404, 500])('lookup failure fails closed (%s)', async (status) => {
    apps[IN_SCOPE] = { status, body: { message: 'boom' } };
    expectDenied(
      await call('control', { resource: 'application', action: 'stop', uuid: IN_SCOPE }),
    );
    expect(writes()).toHaveLength(0);
  });

  it('deployer uuid is denied even if it reports environment_id 14', async () => {
    expectDenied(
      await call('control', { resource: 'application', action: 'stop', uuid: DEPLOYER }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['PVAQSZI5IVM0DNK7NHWEGJND', ' pvaqszi5ivm0dnk7nhwegjnd '])(
    'deployer uuid in other case or padded is denied (%j)',
    async (uuid) => {
      expectDenied(await call('control', { resource: 'application', action: 'stop', uuid }));
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("deployment cancel gates the deployment's application", async () => {
    expectDenied(await call('deployment', { action: 'cancel', uuid: DEPLOYMENT }));
    expect(writes()).toHaveLength(0);
  });

  it('deployment without application_uuid is out of scope', async () => {
    expectDenied(await call('deployment', { action: 'cancel', uuid: OTHER_DEPLOYMENT }));
    expect(writes()).toHaveLength(0);
  });

  it('env_vars is application-only without reveal', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'env_vars')!;
    const props = (t.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.resource.enum).toEqual(['application']);
    expect(props).not.toHaveProperty('reveal');
    const r = await call('env_vars', {
      resource: 'application',
      action: 'list',
      uuid: IN_SCOPE,
      reveal: true,
    });
    expect(r.text).toContain('***');
    expect(r.text).not.toContain('plain-secret');
  });

  it('deploy accepts only a 24-char lowercase uuid', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'deploy')!;
    const props = (t.inputSchema as { properties: Record<string, { pattern?: string }> })
      .properties;
    expect(props.tag_or_uuid.pattern).toBe('^[a-z0-9]{24}$');

    const bad = await call('deploy', { tag_or_uuid: 'prod' });
    expect(bad.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const ok = await call('deploy', { tag_or_uuid: IN_SCOPE });
    expect(ok.isError).toBeFalsy();
    expect(writes().map(([m, u]) => `${m} ${u.replace(/^.*\/api\/v1/, '')}`)).toEqual([
      `POST /deploy?uuid=${IN_SCOPE}&force=false`,
    ]);
  });

  it('projects offers list, get and create only', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'projects')!;
    const props = (t.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.action.enum).toEqual(['list', 'get', 'create']);
  });

  it('tools/list still returns exactly the 16 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
  });
});
