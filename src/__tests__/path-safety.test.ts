/**
 * fetch() normalises `..` / `%2e%2e` path segments, so an unchecked id interpolated into a Coolify
 * URL path can retarget a request at a different resource (e.g. DELETE /applications/<any app>),
 * bypassing the scope gate. Every path-bound value must pass safeSegment; these tests prove it at
 * the client level, through the MCP protocol, and with zod bypassed (handler called directly).
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';
import { CoolifyClient } from '../lib/coolify-client.js';

const APP = 'a'.repeat(24);
const ENV = 'e'.repeat(24);
const PROJ = 'p'.repeat(24);
const DEP = 'd'.repeat(24);

const BAD: string[] = [
  '../../b',
  '..',
  '.',
  '%2e%2e',
  '%2E%2E%2f',
  'a/b',
  'a\\b',
  'a?x=1',
  'a#b',
  ' abc ',
  '',
  'x'.repeat(65),
  '../deploy?uuid=pvaqszi5ivm0dnk7nhwegjnd&force=true&x=',
  '../applications/bbbbbbbbbbbbbbbbbbbbbbbb/stop?',
];

function res(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => JSON.stringify(data),
  } as Response;
}

const mockFetch = jest.fn<typeof fetch>();
const realFetch = global.fetch;
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () =>
    res({ uuid: APP, environment_id: 14, application_uuid: APP }),
  );
  global.fetch = mockFetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('client level: no method puts a bad value into a URL', () => {
  const c = new CoolifyClient({ baseUrl: 'http://localhost:3000', accessToken: 't' });
  const methods = Object.getOwnPropertyNames(CoolifyClient.prototype).filter(
    (n) =>
      n !== 'constructor' &&
      !['request', 'buildQueryString', 'isLikelyUuid', 'deployByTagOrUuid'].includes(n) &&
      typeof (CoolifyClient.prototype as unknown as Record<string, unknown>)[n] === 'function',
  );

  it('enumerates the public client surface', () => {
    expect(methods.length).toBeGreaterThan(100);
  });

  it.each(BAD)('every method called with %j for every argument never sends it', async (bad) => {
    const forms = [bad, encodeURIComponent(bad)].filter((f) => f !== '');
    for (const m of methods) {
      mockFetch.mockClear();
      const fn = (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m];
      await Promise.resolve()
        .then(() => fn.call(c, bad, bad, bad, bad, bad))
        .catch(() => undefined);
      for (const [url] of mockFetch.mock.calls) {
        const u = String(url);
        for (const f of forms) expect([m, u.includes(f)]).toEqual([m, false]);
        expect(new URL(u).pathname.split('/')).not.toContain('..');
      }
    }
  });

  it.each(BAD)(
    'path-taking methods reject %j with invalid_argument and zero requests',
    async (bad) => {
      const calls: Array<[string, unknown[]]> = [
        ['getApplication', [bad]],
        ['updateApplication', [bad, {}]],
        ['startApplication', [bad]],
        ['stopApplication', [bad]],
        ['restartApplication', [bad]],
        ['getApplicationLogs', [bad]],
        ['listApplicationEnvVars', [bad]],
        ['createApplicationEnvVar', [bad, { key: 'k', value: 'v' }]],
        ['updateApplicationEnvVar', [bad, { key: 'k', value: 'v' }]],
        ['deleteApplicationEnvVar', [APP, bad]],
        ['deleteApplicationEnvVar', [bad, ENV]],
        ['bulkUpdateApplicationEnvVars', [bad, { data: [] }]],
        ['getDeployment', [bad]],
        ['cancelDeployment', [bad]],
        ['listApplicationDeployments', [bad]],
        ['getProject', [bad]],
        ['listProjectEnvironments', [bad]],
        ['createProjectEnvironment', [bad, { name: 'x' }]],
        ['getProjectEnvironment', [bad, 'production']],
        ['getProjectEnvironment', [PROJ, bad]],
        ['getProjectEnvironmentWithDatabases', [bad, 'production']],
        ['getServer', [bad]],
      ];
      for (const [m, args] of calls) {
        const fn = (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m];
        await expect(fn.apply(c, args)).rejects.toThrow(/^invalid_argument:/);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each(BAD)('deployByTagOrUuid keeps %j in the query string only, encoded', async (bad) => {
    await c.deployByTagOrUuid(bad, true);
    const u = new URL(String(mockFetch.mock.calls[0][0]));
    expect(u.pathname).toBe('/api/v1/deploy');
    expect([...u.searchParams.keys()]).toHaveLength(2);
    expect(u.searchParams.get('tag') ?? u.searchParams.get('uuid')).toBe(bad);
    expect(u.searchParams.get('force')).toBe('true');
    expect(u.hash).toBe('');
  });

  it('a normal 24-char uuid yields the exact expected pathname', async () => {
    const cases: Array<[string, unknown[], string]> = [
      ['getApplication', [APP], `/api/v1/applications/${APP}`],
      ['stopApplication', [APP], `/api/v1/applications/${APP}/stop`],
      ['restartApplication', [APP], `/api/v1/applications/${APP}/restart`],
      ['getApplicationLogs', [APP, 5], `/api/v1/applications/${APP}/logs`],
      ['listApplicationEnvVars', [APP], `/api/v1/applications/${APP}/envs`],
      ['deleteApplicationEnvVar', [APP, ENV], `/api/v1/applications/${APP}/envs/${ENV}`],
      ['getDeployment', [DEP], `/api/v1/deployments/${DEP}`],
      ['cancelDeployment', [DEP], `/api/v1/deployments/${DEP}/cancel`],
      ['getProject', [PROJ], `/api/v1/projects/${PROJ}`],
      ['listProjectEnvironments', [PROJ], `/api/v1/projects/${PROJ}/environments`],
      ['getProjectEnvironment', [PROJ, 'production'], `/api/v1/projects/${PROJ}/production`],
      ['deployByTagOrUuid', [APP, false], '/api/v1/deploy'],
    ];
    for (const [m, args, path] of cases) {
      mockFetch.mockClear();
      const fn = (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m];
      await fn.apply(c, args).catch(() => undefined);
      expect([m, new URL(String(mockFetch.mock.calls[0][0])).pathname]).toEqual([m, path]);
    }
    mockFetch.mockClear();
    await c.deployByTagOrUuid(APP, false);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      `http://localhost:3000/api/v1/deploy?uuid=${APP}&force=false`,
    );
    mockFetch.mockClear();
    await c.getApplicationLogs(APP, 7);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      `http://localhost:3000/api/v1/applications/${APP}/logs?lines=7`,
    );
  });
});

describe('MCP level: bad ids are rejected before any request', () => {
  let client: Client;
  let server: CoolifyMcpServer;

  beforeEach(async () => {
    server = new CoolifyMcpServer({
      baseUrl: 'http://localhost:3000',
      accessToken: 't',
      deployerUrl: 'http://deployer.invalid',
    });
    client = new Client({ name: 'c', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterEach(async () => {
    await client.close();
  });

  // [tool, args with every id valid, the id-like fields to poison one at a time]
  const targets: Array<[string, Record<string, unknown>, string[]]> = [
    [
      'env_vars',
      { resource: 'application', action: 'delete', uuid: APP, env_uuid: ENV },
      ['uuid', 'env_uuid'],
    ],
    [
      'env_vars',
      { resource: 'application', action: 'update', uuid: APP, key: 'K', value: 'v' },
      ['uuid'],
    ],
    ['env_vars', { resource: 'application', action: 'list', uuid: APP }, ['uuid']],
    [
      'env_vars',
      { resource: 'application', action: 'create', uuid: APP, key: 'K', value: 'v' },
      ['uuid'],
    ],
    [
      'env_vars',
      {
        resource: 'application',
        action: 'bulk_update',
        uuid: APP,
        data: [{ key: 'K', value: 'v' }],
      },
      ['uuid'],
    ],
    ['environments', { action: 'create', project_uuid: PROJ, name: 'x' }, ['project_uuid']],
    ['environments', { action: 'list', project_uuid: PROJ }, ['project_uuid']],
    [
      'environments',
      { action: 'get', project_uuid: PROJ, name: 'production' },
      ['project_uuid', 'name'],
    ],
    ['projects', { action: 'get', uuid: PROJ }, ['uuid']],
    ['deployment', { action: 'get', uuid: DEP }, ['uuid']],
    ['deployment', { action: 'cancel', uuid: DEP }, ['uuid']],
    ['deployment', { action: 'list_for_app', uuid: APP }, ['uuid']],
    ['control', { resource: 'application', action: 'restart', uuid: APP }, ['uuid']],
    ['application_logs', { uuid: APP }, ['uuid']],
    ['application', { action: 'update', uuid: APP, name: 'x' }, ['uuid']],
    ['deploy', { tag_or_uuid: APP }, ['tag_or_uuid']],
  ];
  const cases = targets.flatMap(([tool, args, fields]) =>
    fields.flatMap((field) =>
      BAD.map((bad) => [tool, String(args.action ?? ''), field, bad, args] as const),
    ),
  );

  it.each(cases)(
    '%s %s: %s=%j is rejected with zero requests',
    async (tool, _a, field, bad, args) => {
      const r = (await client.callTool({ name: tool, arguments: { ...args, [field]: bad } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      if (bad === '' && field === 'name') return; // handler answers 'Error: name required'
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('invalid_argument');
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  // Same table with zod bypassed: the handler itself must refuse, with the exact error prefix.
  it.each(cases)(
    'handler direct %s %s: %s=%j starts with invalid_argument, zero requests',
    async (tool, _a, field, bad, args) => {
      const handler = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (a: Record<string, unknown>, e: unknown) => Promise<unknown> }
          >;
        }
      )._registeredTools[tool].handler;
      const r = (await handler({ ...args, [field]: bad }, {})) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(mockFetch).not.toHaveBeenCalled();
      // An empty id is answered by the handler's own 'Error: <field> required'.
      if (bad === '') return;
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^invalid_argument/);
    },
  );

  it('diagnose_app never puts a bad query into a request path', async () => {
    for (const bad of BAD) {
      mockFetch.mockClear();
      await client.callTool({ name: 'diagnose_app', arguments: { query: bad } });
      for (const [url] of mockFetch.mock.calls) {
        expect(new URL(String(url)).pathname).toBe('/api/v1/applications');
      }
    }
  });

  it('tools/list is still exactly 16 tools', async () => {
    expect((await client.listTools()).tools).toHaveLength(16);
  });
});
