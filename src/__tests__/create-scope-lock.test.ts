/**
 * Task 6: build-source fields are removed from `update`, and create_* is locked to
 * Artifacts/production on the main server. Drives the real MCP protocol and mocks global fetch,
 * so assertions are on what reaches the Coolify API.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';
import {
  REMOVED_CREATE_ACTIONS,
  REMOVED_UPDATE_FIELDS,
  SCOPE_ENVIRONMENT_NAME,
  SCOPE_ENVIRONMENT_UUID,
  SCOPE_PROJECT_UUID,
  SCOPE_SERVER_UUID,
  survivingCreateActions,
} from '../lib/scope.js';

const APP_UUID = 'a'.repeat(24);

const jsonResponse = (data: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => JSON.stringify(data),
  }) as Response;

type Handler = (a: Record<string, unknown>, extra: unknown) => Promise<unknown>;
type Tools = Record<string, { handler: Handler }>;

describe('Task 6: update loses build-source fields; create_* locked to scope', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  let server: CoolifyMcpServer;
  let client: Client;
  const clients: Client[] = [];

  async function connect(removed?: readonly string[]): Promise<{ s: CoolifyMcpServer; c: Client }> {
    const s = new CoolifyMcpServer(
      {
        baseUrl: 'http://localhost:3000',
        accessToken: 'test-token',
        deployerUrl: 'http://deployer.invalid',
      },
      removed ? { removedCreateActions: removed } : undefined,
    );
    const c = new Client({ name: 'test-client', version: '0.0.0' });
    clients.push(c);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([s.connect(st), c.connect(ct)]);
    return { s, c };
  }

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => jsonResponse({ uuid: APP_UUID, environment_id: 14 }));
    global.fetch = mockFetch;
    ({ s: server, c: client } = await connect());
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  const writeBodies = (): Array<Record<string, unknown>> =>
    mockFetch.mock.calls
      .filter(([, init]) => init?.method && init.method !== 'GET')
      .map(([, init]) => JSON.parse(String(init?.body ?? '{}')));

  const call = (args: Record<string, unknown>): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'application', arguments: args });

  const direct = (srv: CoolifyMcpServer, args: Record<string, unknown>): Promise<unknown> =>
    (srv as unknown as { _registeredTools: Tools })._registeredTools['application'].handler(
      args,
      {},
    );

  const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;

  describe('REMOVED_UPDATE_FIELDS', () => {
    it('lists exactly the build-source fields plus domains and fqdn', () => {
      expect([...REMOVED_UPDATE_FIELDS].sort()).toEqual(
        [
          'base_directory',
          'build_command',
          'build_pack',
          'docker_registry_image_name',
          'docker_registry_image_tag',
          'dockerfile',
          'dockerfile_location',
          'domains',
          'fqdn',
          'git_branch',
          'git_repository',
          'install_command',
          'start_command',
        ].sort(),
      );
    });

    const expectRefused = (r: unknown, fields: string[]): void => {
      const res = r as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^invalid_argument:/);
      for (const f of fields) expect(res.content[0].text).toContain(f);
      expect(res.content[0].text).toContain('Coolify dashboard');
      expect(mockFetch).not.toHaveBeenCalled();
    };

    it.each([...REMOVED_UPDATE_FIELDS])(
      'update with only %s is refused with zero requests',
      async (field) => {
        const r = await call({ action: 'update', uuid: APP_UUID, [field]: 'EVIL-VALUE' });
        expect(r.isError).toBe(true);
        expect((r.content as Array<{ text: string }>)[0].text).toMatch(/^invalid_argument:/);
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each([...REMOVED_UPDATE_FIELDS])(
      '%s alongside allowed fields is refused with zero requests (zod-bypassed)',
      async (field) => {
        expectRefused(
          await direct(server, { action: 'update', uuid: APP_UUID, name: 'keep', [field]: 'EVIL' }),
          [field],
        );
      },
    );

    it.each([...REMOVED_UPDATE_FIELDS])('%s with null or empty value is refused', async (field) => {
      expectRefused(await direct(server, { action: 'update', uuid: APP_UUID, [field]: null }), [
        field,
      ]);
      expectRefused(await direct(server, { action: 'update', uuid: APP_UUID, [field]: '' }), [
        field,
      ]);
    });

    it('names every offending field', async () => {
      expectRefused(
        await direct(server, {
          action: 'update',
          uuid: APP_UUID,
          git_branch: 'dev',
          dockerfile: 'FROM x',
          name: 'n',
        }),
        ['git_branch', 'dockerfile'],
      );
    });

    it('update with only allowed fields still PATCHes exactly those fields', async () => {
      await call({ action: 'update', uuid: APP_UUID, name: 'keep', description: 'd' });
      expect(writeBodies()).toEqual([{ name: 'keep', description: 'd' }]);
    });

    it('update never forwards placement fields either', async () => {
      await direct(server, {
        action: 'update',
        uuid: APP_UUID,
        name: 'keep',
        project_uuid: 'x',
        server_uuid: 'x',
        environment_uuid: 'x',
        environment_name: 'x',
        destination_uuid: 'x',
      });
      expect(writeBodies()).toEqual([{ name: 'keep' }]);
    });
  });

  describe('REMOVED_CREATE_ACTIONS', () => {
    it('the enum equals survivingCreateActions(REMOVED_CREATE_ACTIONS) + update', async () => {
      const { tools } = await client.listTools();
      const app = tools.find((t) => t.name === 'application')!;
      const en = (app.inputSchema as unknown as { properties: { action: { enum: string[] } } })
        .properties.action.enum;
      expect(en).toEqual([...survivingCreateActions(REMOVED_CREATE_ACTIONS), 'update']);
    });

    it.each(REMOVED_CREATE_ACTIONS.length ? [...REMOVED_CREATE_ACTIONS] : ['(none removed)'])(
      'removed action %s is refused with zero requests',
      async (a) => {
        if (REMOVED_CREATE_ACTIONS.length === 0) return;
        const r = await call({ action: a });
        expect(r.isError).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it('survivingCreateActions derives from the list', () => {
      expect(survivingCreateActions([])).toEqual([
        'create_public',
        'create_dockerimage',
        'create_dockerfile',
      ]);
      expect(survivingCreateActions(['create_dockerfile'])).toEqual([
        'create_public',
        'create_dockerimage',
      ]);
    });

    it.each([
      [['create_dockerfile']],
      [['create_public', 'create_dockerimage']],
      [['create_public', 'create_dockerimage', 'create_dockerfile']],
    ])('override %j removes exactly those actions everywhere', async (removed) => {
      const { s, c } = await connect(removed);
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(16);
      const app = tools.find((t) => t.name === 'application')!;
      const en = (app.inputSchema as unknown as { properties: { action: { enum: string[] } } })
        .properties.action.enum;
      expect(en).toEqual([...survivingCreateActions(removed), 'update']);

      mockFetch.mockClear();
      for (const a of removed) {
        const viaProtocol = await c.callTool({
          name: 'application',
          arguments: { action: a, dockerfile: 'FROM scratch' },
        });
        expect(viaProtocol.isError).toBe(true);
        const bypass = (await direct(s, { action: a, dockerfile: 'FROM scratch' })) as {
          isError?: boolean;
        };
        expect(bypass.isError).toBe(true);
      }
      expect(mockFetch).not.toHaveBeenCalled();

      for (const a of survivingCreateActions(removed)) {
        const base = allCreateBases.find(([n]) => n === a)![1];
        const r = (await direct(s, base)) as { isError?: boolean };
        expect(r.isError).toBeFalsy();
      }
      expect(mockFetch).toHaveBeenCalledTimes(survivingCreateActions(removed).length);
    });
  });

  const allCreateBases: Array<[string, Record<string, unknown>, string]> = [
    [
      'create_public',
      {
        action: 'create_public',
        git_repository: 'https://github.com/o/r',
        git_branch: 'main',
        build_pack: 'nixpacks',
        ports_exposes: '3000',
      },
      '/applications/public',
    ],
    [
      'create_dockerimage',
      { action: 'create_dockerimage', docker_registry_image_name: 'a/b', ports_exposes: '80' },
      '/applications/dockerimage',
    ],
    [
      'create_dockerfile',
      { action: 'create_dockerfile', dockerfile: 'FROM scratch' },
      '/applications/dockerfile',
    ],
  ];

  const SCOPE_FIELDS: Array<[string, string]> = [
    ['project_uuid', SCOPE_PROJECT_UUID],
    ['environment_uuid', SCOPE_ENVIRONMENT_UUID],
    ['environment_name', SCOPE_ENVIRONMENT_NAME],
    ['server_uuid', SCOPE_SERVER_UUID],
  ];

  // Derived from the live removed list; an empty table would make Jest throw.
  const createBases = allCreateBases.filter(([n]) =>
    survivingCreateActions(REMOVED_CREATE_ACTIONS).includes(n),
  );
  const scopeLockTable: Array<[string, Record<string, unknown>, string]> = createBases.length
    ? createBases
    : [['(all removed)', {}, '']];
  describe.each(scopeLockTable)('%s scope lock', (_name, base, path) => {
    if (createBases.length === 0) {
      it('every create action is removed', () => {});
      return;
    }

    it('omitted placement fields are filled with exactly the constants', async () => {
      const r = await call(base);
      expect(r.isError).toBeFalsy();
      const bodies = writeBodies();
      expect(bodies).toHaveLength(1);
      expect(String(mockFetch.mock.calls[0][0])).toContain(path);
      expect(bodies[0]).toMatchObject({
        project_uuid: SCOPE_PROJECT_UUID,
        environment_uuid: SCOPE_ENVIRONMENT_UUID,
        environment_name: SCOPE_ENVIRONMENT_NAME,
        server_uuid: SCOPE_SERVER_UUID,
      });
      expect(bodies[0]).not.toHaveProperty('destination_uuid');
    });

    it('explicit constants are accepted', async () => {
      const r = await call({
        ...base,
        project_uuid: SCOPE_PROJECT_UUID,
        environment_uuid: SCOPE_ENVIRONMENT_UUID,
        environment_name: SCOPE_ENVIRONMENT_NAME,
        server_uuid: SCOPE_SERVER_UUID,
      });
      expect(r.isError).toBeFalsy();
      expect(writeBodies()).toHaveLength(1);
    });

    it('destination_uuid is never forwarded', async () => {
      await direct(server, { ...base, destination_uuid: 'evil' });
      expect(writeBodies()[0]).not.toHaveProperty('destination_uuid');
    });

    describe.each(SCOPE_FIELDS)('caller-supplied %s', (field, constant) => {
      const bad: Array<[string, string]> = [
        ['other uuid', 'z'.repeat(24)],
        [
          'other case',
          constant.toUpperCase() === constant ? constant.toLowerCase() : constant.toUpperCase(),
        ],
        ['padded', ` ${constant} `],
        ['traversal', '../../etc'],
        ['encoded traversal', '%2e%2e'],
        ['empty', ''],
      ];
      it.each(bad)('%s is refused with zero requests', async (_label, value) => {
        const viaProtocol = await call({ ...base, [field]: value });
        expect(viaProtocol.isError).toBe(true);
        const bypass = (await direct(server, { ...base, [field]: value })) as {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
        expect(bypass.isError).toBe(true);
        expect(bypass.content[0].text).toMatch(/^(out_of_scope|invalid_argument)/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('a well-formed other value is out_of_scope', async () => {
        const r = await direct(server, { ...base, [field]: 'other-value-1' });
        expect(text(r)).toMatch(/^out_of_scope/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('a traversal value is invalid_argument, not out_of_scope', async () => {
        const r = await direct(server, { ...base, [field]: '../x' });
        expect(text(r)).toMatch(/^invalid_argument/);
      });
    });
  });
});
