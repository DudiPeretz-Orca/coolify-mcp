import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { DeployerClient } from '../lib/deployer-client.js';

describe('DeployerClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('strips a trailing slash from the base URL and sends JSON', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'queued' }), { status: 200 }));
    await new DeployerClient('http://d.test/').status('d1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('http://d.test/v1/deployments/d1');
    expect((init as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('formats a non-JSON error body as HTTP <status>: <first 200 chars>', async () => {
    // Fresh Response per call: a Response body can only be consumed once.
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('x'.repeat(500), { status: 502 })));
    await expect(new DeployerClient('http://d.test').commit('u1')).rejects.toThrow(
      /^HTTP 502: x{200}$/,
    );
  });
});
