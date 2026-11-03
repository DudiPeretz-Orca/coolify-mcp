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
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  '_JAVA_OPTIONS',
  'RAILPACK_INSTALL_CMD',
  'BUILDX_CONFIG',
  'NIXPACKS-INSTALL-CMD',
  'nixpacks.install.cmd',
  'node-options',
  'Docker.Host',
  'PERL5OPT',
  'perl5db',
  'PYTHONWARNINGS',
  'BROWSER',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'PROMPT_COMMAND',
  'GOFLAGS',
  'RUSTC_WRAPPER',
  'RUSTFLAGS',
  'JAVA_OPTS',
  'MAVEN_OPTS',
  'MAVEN_ARGS',
  'GRADLE_OPTS',
  'NPM_CONFIG_NODE_OPTIONS',
  'npm_config_node_options',
  'npm-config-script-shell',
  'NPM_CONFIG_SCRIPT_SHELL',
  'MISE_EXEC',
  'mise.env',
];
const ALLOWED = [
  'API_URL',
  'PORT',
  'PYTHONPATH',
  'DATABASE_URL',
  'REPORT_GZ_B64',
  'lower_case_key',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_LOGLEVEL',
  'MAVEN_HOME',
  'JAVA_HOME',
  'RUBYOPT',
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

  describe('values', () => {
    const PEM = '-----BEGIN KEY-----\nabc=\ndef\n-----END KEY-----';
    const reqs: Array<[string, (v: string, ml?: boolean) => Record<string, unknown>]> = [
      ['create', (value, ml) => ({ action: 'create', key: 'K', value, is_multiline: ml })],
      ['update', (value, ml) => ({ action: 'update', key: 'K', value, is_multiline: ml })],
      [
        'bulk_update',
        (value, ml) => ({ action: 'bulk_update', data: [{ key: 'K', value, is_multiline: ml }] }),
      ],
    ];
    describe.each(reqs)('%s', (_n, build) => {
      it.each([
        ['CR', 'a\rb', true],
        ['NUL', 'a\0b', true],
        ['LF without is_multiline', 'a\nb', undefined],
        ['LF with is_multiline false', 'a\nb', false],
        ['denied assignment line', 'ok\nNIXPACKS_INSTALL_CMD=curl x', true],
        ['export denied assignment', 'ok\nexport BASH_ENV=/x', true],
        ['dotted denied assignment', 'ok\n  nixpacks.install.cmd = x', true],
        ['colon assignment', 'ok\nNODE_OPTIONS: --import=x', true],
        ['export colon assignment', 'ok\nexport NODE_OPTIONS: x', true],
        ['double-quoted key', 'ok\n"NODE_OPTIONS"=x', true],
        ['single-quoted key', "ok\n'NIXPACKS_INSTALL_CMD':y", true],
        ['no-space colon', 'ok\nNODE_OPTIONS:v', true],
        ['YAML env key', 'a\nenv: production', true],
        ['single-line denied assignment', 'NODE_OPTIONS=--require x', undefined],
      ])('refuses %s without echoing the value', async (_c, v, ml) => {
        const r = await call(build(v as string, ml as boolean | undefined));
        refused(r);
        expect(r.content[0].text).not.toContain(v as string);
      });
      it('accepts LF with is_multiline true', async () => {
        expect((await call(build('a\nb', true))).isError).toBeFalsy();
        expect(writes()).toHaveLength(1);
      });
      it('accepts a PEM-like multi-line value', async () => {
        expect((await call(build(PEM, true))).isError).toBeFalsy();
      });
      it('accepts a YAML-style line with an allowed key', async () => {
        expect((await call(build('a\nname: foo', true))).isError).toBeFalsy();
      });
      it('accepts denied text that is not at line start', async () => {
        expect((await call(build('see NIXPACKS_INSTALL_CMD=x here'))).isError).toBeFalsy();
      });
    });

    it('bulk_update with one bad value among good entries is refused as a whole', async () => {
      refused(
        await call({
          action: 'bulk_update',
          data: [
            { key: 'A', value: '1' },
            { key: 'B', value: 'x\ny' },
          ],
        }),
      );
    });

    it('non-string values are refused (zod bypassed)', async () => {
      const tool = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (a: Record<string, unknown>, extra: unknown) => Promise<ToolRes> }
          >;
        }
      )._registeredTools['env_vars'];
      refused(
        await tool.handler(
          { resource: 'application', uuid: APP, action: 'create', key: 'K', value: 5 },
          {},
        ),
      );
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
    expect(DENIED_ENV_KEY_PATTERNS).toHaveLength(35);
    expect(() => assertEnvKeyAllowed('PORT')).not.toThrow();
    expect(() => assertEnvKeyAllowed('docker_host')).toThrow(/^invalid_argument:/);
  });

  it('tools/list stays at 16 tools', async () => {
    expect((await client.listTools()).tools).toHaveLength(16);
  });
});
