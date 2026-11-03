/** Client-level chokepoint: every env create/update body is literal and runtime-only. */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CoolifyClient } from '../lib/coolify-client.js';

const FORCED = { is_literal: true, is_buildtime: false, is_runtime: true };
const U = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('client env writes force literal, runtime-only flags', () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = global.fetch;
  let client: CoolifyClient;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (input) => {
      const body = String(input).endsWith('/applications')
        ? [{ uuid: U, name: 'a' }]
        : { message: 'ok', uuid: U };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () => JSON.stringify(body),
      } as Response;
    });
    global.fetch = mockFetch;
    client = new CoolifyClient({ baseUrl: 'http://localhost:3000', accessToken: 't' });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const sent = (): Array<Record<string, unknown>> =>
    mockFetch.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
      .map(([, init]) => JSON.parse(String(init?.body)));

  const hostile = { is_literal: false, is_buildtime: true, is_runtime: false };

  it.each(['Application', 'Service', 'Database'] as const)(
    '%s create and update override caller flags',
    async (kind) => {
      const c = client as unknown as Record<
        string,
        (u: string, d: Record<string, unknown>) => Promise<unknown>
      >;
      await c[`create${kind}EnvVar`](U, { key: 'K', value: 'v', ...hostile });
      await c[`update${kind}EnvVar`](U, { key: 'K', value: 'v' });
      const bodies = sent();
      expect(bodies).toHaveLength(2);
      for (const b of bodies) expect(b).toMatchObject(FORCED);
    },
  );

  it.each(['Application', 'Service', 'Database'] as const)(
    '%s bulk update forces every entry',
    async (kind) => {
      const c = client as unknown as Record<
        string,
        (u: string, d: Record<string, unknown>) => Promise<unknown>
      >;
      await c[`bulkUpdate${kind}EnvVars`](U, {
        data: [
          { key: 'A', value: '1', ...hostile },
          { key: 'B', value: '2' },
        ],
      });
      const data = sent()[0].data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
      for (const e of data) expect(e).toMatchObject(FORCED);
    },
  );

  it('bulkEnvUpdate forces the flags', async () => {
    await client.bulkEnvUpdate([U], 'K', 'v');
    expect(sent()[0]).toMatchObject(FORCED);
  });
});
