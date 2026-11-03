/**
 * Task 7: connector domain validation; `domains`/`fqdn` refused on update.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoolifyMcpServer } from '../lib/mcp-server.js';
import {
  BUILTIN_RESERVED_LABELS,
  DomainError,
  reservedLabels,
  validateCreateDomain,
  ZONE_HOST_RE,
} from '../lib/domain-guard.js';
import { REMOVED_UPDATE_FIELDS } from '../lib/scope.js';

const APP_UUID = 'a'.repeat(24);
const TAKEN = 'https://taken.tools.orca-internal.net';

const REJECTS: Array<[string, string]> = [
  ['https://x.tools.orca-internal.net:8443', ''],
  ['https://x.tools.orca-internal.net/api', ''],
  ['https://x.tools.orca-internal.net?a=1', ''],
  ['https://u:p@x.tools.orca-internal.net', ''],
  ['http://x.tools.orca-internal.net', ''],
  ['https://a.tools.orca-internal.net,https://b.tools.orca-internal.net', ''],
  ['https://x.example.com', ''],
  ['https://*.tools.orca-internal.net', ''],
  ['https://a.b.tools.orca-internal.net', ''],
  ['https://coolify.tools.orca-internal.net', ''],
  ['https://COOLIFY.tools.orca-internal.net', ''],
  ['https://coolify.tools.orca-internal.net.', ''],
  ['https://apps.tools.orca-internal.net', 'apps,auth,login'],
  [TAKEN, ''],
];

describe('domain-guard unit', () => {
  const saved = process.env.RESERVED_LABELS;
  afterEach(() => {
    if (saved === undefined) delete process.env.RESERVED_LABELS;
    else process.env.RESERVED_LABELS = saved;
  });

  it('exports the zone regex and built-ins', () => {
    expect(ZONE_HOST_RE.test('a.tools.orca-internal.net')).toBe(true);
    expect(BUILTIN_RESERVED_LABELS).toEqual(['coolify', 'deployer', 'test-artifact']);
  });

  it('reservedLabels reads env per call, trimmed and lower-cased', () => {
    expect([...reservedLabels({ RESERVED_LABELS: ' Apps , AUTH,' })].sort()).toEqual(
      [...BUILTIN_RESERVED_LABELS, 'apps', 'auth'].sort(),
    );
    expect(reservedLabels({}).size).toBe(3);
  });

  it.each(REJECTS)('rejects %s', async (raw, env) => {
    if (env) process.env.RESERVED_LABELS = env;
    await expect(
      validateCreateDomain(raw, async () => ['taken.tools.orca-internal.net']),
    ).rejects.toThrow(/^invalid_domain: /);
    await expect(
      validateCreateDomain(raw, async () => ['taken.tools.orca-internal.net']),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('rejects a host whose www. variant is taken', async () => {
    await expect(
      validateCreateDomain('https://x.tools.orca-internal.net', async () => [
        'www.x.tools.orca-internal.net',
      ]),
    ).rejects.toThrow(/^invalid_domain: /);
  });

  it('accepts a clean host and passes undefined through', async () => {
    await expect(
      validateCreateDomain('https://my-app.tools.orca-internal.net', async () => []),
    ).resolves.toBe('https://my-app.tools.orca-internal.net');
    await expect(validateCreateDomain(undefined, async () => [])).resolves.toBeUndefined();
  });
});

describe('domain-guard through the protocol', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  const clients: Client[] = [];
  let client: Client;
  const saved = process.env.RESERVED_LABELS;

  const json = (data: unknown): Response =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: async () => JSON.stringify(data),
    }) as Response;

  const writes = (): Array<{ url: string; method: string; body: Record<string, unknown> }> =>
    mockFetch.mock.calls
      .filter(([, init]) => init?.method && init.method !== 'GET')
      .map(([url, init]) => ({
        url: String(url),
        method: String(init?.method),
        body: JSON.parse(String(init?.body ?? '{}')),
      }));

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/applications')
        ? json([{ uuid: 'b'.repeat(24), fqdn: `${TAKEN},https://other.tools.orca-internal.net` }])
        : json({ uuid: APP_UUID, environment_id: 14 }),
    );
    global.fetch = mockFetch;
    const s = new CoolifyMcpServer({
      baseUrl: 'http://localhost:3000',
      accessToken: 'test-token',
      deployerUrl: 'http://deployer.invalid',
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    clients.push(client);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([s.connect(st), client.connect(ct)]);
  });

  afterEach(async () => {
    global.fetch = realFetch;
    if (saved === undefined) delete process.env.RESERVED_LABELS;
    else process.env.RESERVED_LABELS = saved;
    await Promise.all(clients.splice(0).map((x) => x.close()));
  });

  const call = (args: Record<string, unknown>): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'application', arguments: args });
  const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;

  it.each(['domains', 'fqdn'])('REMOVED_UPDATE_FIELDS includes %s', (f) => {
    expect(REMOVED_UPDATE_FIELDS).toContain(f);
  });

  it.each(['domains', 'fqdn'])(
    'update never sends %s: refused, no request at all (any value)',
    async (f) => {
      for (const v of ['https://x.tools.orca-internal.net', '', null]) {
        const r = await call({ action: 'update', uuid: APP_UUID, [f]: v }).catch((e) => e);
        // null fails zod (isError result or thrown); both are refusals with no request.
        if (r instanceof Error) continue;
        expect(r.isError).toBe(true);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('update with domains refused explicitly naming the field', async () => {
    const r = await call({
      action: 'update',
      uuid: APP_UUID,
      domains: 'https://x.tools.orca-internal.net',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_argument:/);
    expect(text(r)).toContain('domains');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allowed-only update still PATCHes without domains or fqdn', async () => {
    const r = await call({ action: 'update', uuid: APP_UUID, name: 'renamed' });
    expect(r.isError).toBeFalsy();
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].body).toEqual({ name: 'renamed' });
    expect(w[0].body).not.toHaveProperty('domains');
    expect(w[0].body).not.toHaveProperty('fqdn');
  });

  const createArgs: Record<string, Record<string, unknown>> = {
    create_public: {
      git_repository: 'https://github.com/orca-playground/x',
      git_branch: 'main',
      build_pack: 'nixpacks',
      ports_exposes: '3000',
    },
    create_dockerimage: { docker_registry_image_name: 'nginx', ports_exposes: '80' },
    create_dockerfile: { dockerfile: 'FROM nginx' },
  };

  describe.each(Object.keys(createArgs))('surviving create action %s', (action) => {
    it.each(['domains', 'fqdn'])('invalid %s: invalid_domain, zero writes', async (field) => {
      const r = await call({
        action,
        ...createArgs[action],
        [field]: 'https://coolify.tools.orca-internal.net',
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^invalid_domain:/);
      expect(writes()).toHaveLength(0);
    });

    it('a host used by an existing app is refused, zero writes', async () => {
      const r = await call({ action, ...createArgs[action], domains: TAKEN });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^invalid_domain:/);
      expect(writes()).toHaveLength(0);
    });

    it('a valid domain reaches the POST; an omitted one is not invented', async () => {
      const ok = await call({
        action,
        ...createArgs[action],
        domains: 'https://fresh.tools.orca-internal.net',
      });
      expect(ok.isError).toBeFalsy();
      expect(writes()).toHaveLength(1);
      expect(JSON.stringify(writes()[0].body)).toContain('https://fresh.tools.orca-internal.net');
      mockFetch.mockClear();
      await call({ action, ...createArgs[action] });
      expect(writes()).toHaveLength(1);
      expect(JSON.stringify(writes()[0].body)).not.toContain('orca-internal.net');
    });
  });
});
