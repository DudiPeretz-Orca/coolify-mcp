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
    it('lists exactly the 11 build-source fields', () => {
      expect([...REMOVED_UPDATE_FIELDS].sort()).toEqual(
        [
          'base_directory',
          'build_command',
          'build_pack',
          'docker_registry_image_name',
          'docker_registry_image_tag',
          'dockerfile',
          'dockerfile_location',
          'git_branch',
          'git_repository',
          'install_command',
          'start_command',
        ].sort(),
      );
    });

    it.each([...REMOVED_UPDATE_FIELDS])(
      'update with %s sends a PATCH body without it',
      async (field) => {
        await call({ action: 'update', uuid: APP_UUID, name: 'keep', [field]: 'EVIL-VALUE' });
        const bodies = writeBodies();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual({ name: 'keep' });
        expect(JSON.stringify(bodies[0])).not.toContain('EVIL-VALUE');
      },
    );

    it.each([...REMOVED_UPDATE_FIELDS])(
      'zod-bypassed handler update with %s sends a body without it',
      async (field) => {
        await direct(server, { action: 'update', uuid: APP_UUID, name: 'keep', [field]: 'EVIL' });
        expect(writeBodies()).toEqual([{ name: 'keep' }]);
      },
    );

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
    it('is empty today and the enum keeps all four actions', async () => {
      expect(REMOVED_CREATE_ACTIONS).toEqual([]);
      const { tools } = await client.listTools();
      const app = tools.find((t) => t.name === 'application')!;
      const en = (app.inputSchema as unknown as { properties: { action: { enum: string[] } } })
        .properties.action.enum;
      expect(en).toEqual(['create_public', 'create_dockerimage', 'create_dockerfile', 'update']);
    });

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

    it('REMOVED_CREATE_ACTIONS override removes the action from enum, handler and tools/list', async () => {
      const { s, c } = await connect(['create_dockerfile']);
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(16);
      const app = tools.find((t) => t.name === 'application')!;
      const en = (app.inputSchema as unknown as { properties: { action: { enum: string[] } } })
        .properties.action.enum;
      expect(en).toEqual(['create_public', 'create_dockerimage', 'update']);

      mockFetch.mockClear();
      const viaProtocol = await c.callTool({
        name: 'application',
        arguments: { action: 'create_dockerfile', dockerfile: 'FROM scratch' },
      });
      expect(viaProtocol.isError).toBe(true);
      const bypass = (await direct(s, {
        action: 'create_dockerfile',
        dockerfile: 'FROM scratch',
      })) as { isError?: boolean };
      expect(bypass.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();

      // The other creates still work.
      await c.callTool({
        name: 'application',
        arguments: {
          action: 'create_dockerimage',
          docker_registry_image_name: 'a/b',
          ports_exposes: '80',
        },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  const createBases: Array<[string, Record<string, unknown>, string]> = [
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

  describe.each(createBases)('%s scope lock', (_name, base, path) => {
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
