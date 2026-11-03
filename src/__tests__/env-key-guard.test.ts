/** env_vars key denylist (ruling R16): zero requests on refusal, through the real MCP protocol. */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';
import { DENIED_ENV_KEY_PATTERNS, assertEnvKeyAllowed } from '../lib/env-key-guard.js';

const APP = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function res(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => JSON.stringify(data),
  } as Response;
}

type ToolRes = { isError?: boolean; content: Array<{ text: string }> };

const DENIED = [
  'NIXPACKS_INSTALL_CMD',
  'nixpacks_start_cmd',
  'NIXPACKS_BUILD_CMD',
  'NIXPACKS_PKGS',
  'BUILDKIT_HOST',
  'DOCKER_HOST',
  'COMPOSE_FILE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'GIT_CONFIG_COUNT',
  'GIT_SSH_COMMAND',
  'BASH_ENV',
  'ENV',
  'PYTHONSTARTUP',
  'GIT_EXEC_PATH',
];
const ALLOWED = [
  'API_URL',
  'PORT',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'DATABASE_URL',
  'REPORT_GZ_B64',
  'lower_case_key',
  'my.dotted-key',
];
const BAD_SHAPES = ['A=B', ' KEY', 'KEY ', '', 'K\nL', 'K\0L', '1ABC', 'A'.repeat(257)];

describe('env_vars key denylist', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  let server: CoolifyMcpServer;
  let client: Client;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && /\/applications\/[^/?]+$/.test(url)) {
        return res(200, { uuid: APP, environment_id: 14 });
      }
      if (/\/envs$/.test(url) && (init?.method ?? 'GET') === 'GET') return res(200, []);
      return res(200, { message: 'ok' });
    });
    global.fetch = mockFetch;
    server = new CoolifyMcpServer({
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

  const call = async (args: Record<string, unknown>): Promise<ToolRes> =>
    (await client.callTool({
      name: 'env_vars',
      arguments: { resource: 'application', uuid: APP, ...args },
    })) as ToolRes;
  const writes = (): string[] =>
    mockFetch.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
      .map(([u, init]) => `${init?.method} ${String(u)}`);

  const refused = (r: ToolRes): void => {
    expect(r.isError).toBe(true);
    expect(r.content[0].text.startsWith('invalid_argument:')).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  };

  const forms: Array<[string, (k: string) => Record<string, unknown>]> = [
    ['create', (key) => ({ action: 'create', key, value: 'v' })],
    ['update', (key) => ({ action: 'update', key, value: 'v' })],
    ['bulk_update', (key) => ({ action: 'bulk_update', data: [{ key, value: 'v' }] })],
  ];

  describe.each(forms)('%s', (_name, build) => {
    it.each(DENIED)('refuses %s with zero requests', async (key) => {
      const r = await call(build(key));
      refused(r);
      expect(r.content[0].text).toContain(key);
      expect(r.content[0].text).toContain('Coolify dashboard');
    });

    it.each(ALLOWED)('still sends %s', async (key) => {
      const r = await call(build(key));
      expect(r.isError).toBeFalsy();
      expect(writes()).toHaveLength(1);
    });

    it.each(BAD_SHAPES)('refuses bad shape %j with zero requests', async (key) => {
      // zod accepts any string, so these reach the handler through the real protocol.
      refused(await call(build(key)));
    });
  });

  it('bulk_update with one denied key among allowed ones is refused as a whole', async () => {
    refused(
      await call({
        action: 'bulk_update',
        data: [
          { key: 'API_URL', value: '1' },
          { key: 'LD_PRELOAD', value: '2' },
          { key: 'PORT', value: '3' },
        ],
      }),
    );
  });

  it('delete of a denied key works: scope GET then one DELETE', async () => {
    const r = await call({ action: 'delete', env_uuid: 'e1' });
    expect(r.isError).toBeFalsy();
    expect(writes()).toEqual([expect.stringMatching(/^DELETE .*\/applications\/.*\/envs\/e1$/)]);
  });

  it('list is unaffected', async () => {
    const r = await call({ action: 'list' });
    expect(r.isError).toBeFalsy();
  });

  it('non-string keys are refused with zero requests (zod bypassed)', async () => {
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: Record<string, unknown>, extra: unknown) => Promise<ToolRes> }
        >;
      }
    )._registeredTools['env_vars'];
    for (const args of [
      { action: 'create', key: 123, value: 'v' },
      { action: 'update', key: null, value: 'v' },
      { action: 'bulk_update', data: [{ key: null, value: 'v' }] },
      { action: 'bulk_update', data: 'nope' },
    ]) {
      refused(await tool.handler({ resource: 'application', uuid: APP, ...args }, {}));
    }
  });

  it('exports a frozen-shape denylist and the guard throws typed errors', () => {
    expect(DENIED_ENV_KEY_PATTERNS).toHaveLength(11);
    expect(() => assertEnvKeyAllowed('PORT')).not.toThrow();
    expect(() => assertEnvKeyAllowed('docker_host')).toThrow(/^invalid_argument:/);
  });

  it('tools/list stays at 16 tools', async () => {
    expect((await client.listTools()).tools).toHaveLength(16);
  });
});
