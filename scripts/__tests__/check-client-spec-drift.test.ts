import { describe, it, expect } from '@jest/globals';
import {
  extractSpecPaths,
  extractClientRoutes,
  normaliseClientRoute,
  normaliseSpecPath,
  segmentsMatch,
  findUnmatchedRoutes,
  ALLOWLIST,
} from '../check-client-spec-drift.mjs';

describe('extractSpecPaths', () => {
  it('extracts unquoted and quoted top-level path keys from a paths: block', () => {
    const spec = [
      'openapi: 3.1.0',
      'paths:',
      '  /applications:',
      '    get:',
      "      tags: ['x']",
      "  '/applications/{uuid}':",
      '    get:',
      '      tags: []',
      '  "/databases/{uuid}/envs":',
      '    get:',
      '      tags: []',
      'components:',
      '  schemas: {}',
    ].join('\n');

    expect(extractSpecPaths(spec)).toEqual([
      '/applications',
      '/applications/{uuid}',
      '/databases/{uuid}/envs',
    ]);
  });

  it('throws when there is no top-level paths: key', () => {
    expect(() => extractSpecPaths('openapi: 3.1.0\ncomponents:\n  schemas: {}\n')).toThrow(
      /paths:/,
    );
  });
});

describe('extractClientRoutes', () => {
  it('extracts template literal and string literal path arguments to this.request', () => {
    const client = `
      class C {
        async a() { return this.request<Foo>('/teams'); }
        async b(uuid: string) { return this.request<Bar>(\`/servers/\${uuid}\`); }
        async c(uuid: string) {
          return this.request<Baz>(
            \`/projects/\${uuid}/environments\`,
            { method: 'DELETE' },
          );
        }
      }
    `;
    const routes = extractClientRoutes(client);
    expect(routes).toEqual(
      expect.arrayContaining(['/teams', '/servers/${uuid}', '/projects/${uuid}/environments']),
    );
    // getVersion() bypasses this.request() and is always injected explicitly
    expect(routes).toContain('/version');
  });
});

describe('normaliseClientRoute', () => {
  it('turns a plain literal path into segments', () => {
    expect(normaliseClientRoute('/teams')).toEqual(['teams']);
  });

  it('turns a ${var} segment preceded by a slash into a param wildcard', () => {
    expect(normaliseClientRoute('/servers/${uuid}/domains')).toEqual(['servers', null, 'domains']);
  });

  it('strips a hardcoded query string starting at a literal ?', () => {
    expect(
      normaliseClientRoute(
        '/hetzner/images?cloud_provider_token_uuid=${encodeURIComponent(tokenUuid)}',
      ),
    ).toEqual(['hetzner', 'images']);
  });

  it('drops a ${query}/${qs}-style suffix glued onto the previous segment', () => {
    expect(normaliseClientRoute('/applications${query}')).toEqual(['applications']);
    expect(normaliseClientRoute('/applications/${uuid}/start${query}')).toEqual([
      'applications',
      null,
      'start',
    ]);
    expect(normaliseClientRoute('/services/${uuid}/restart${qs}')).toEqual([
      'services',
      null,
      'restart',
    ]);
  });
});

describe('normaliseClientRoute with safeSegment and object-literal query builders', () => {
  it('treats ${safeSegment(x, label)} like a plain ${x} path parameter', () => {
    expect(normaliseClientRoute("/applications/${safeSegment(uuid, 'uuid')}/logs")).toEqual(
      normaliseClientRoute('/applications/${uuid}/logs'),
    );
  });

  it('drops a query builder whose argument contains braces', () => {
    expect(
      normaliseClientRoute(
        "/applications/${safeSegment(uuid, 'uuid')}/logs${this.buildQueryString({ lines })}",
      ),
    ).toEqual(['applications', null, 'logs']);
    expect(
      normaliseClientRoute('/deploy${this.buildQueryString({ [param]: tagOrUuid, force })}'),
    ).toEqual(['deploy']);
  });

  it('still fails a genuinely mismatching safeSegment-wrapped route', () => {
    const spec = ['paths:', '  /applications/{uuid}/logs:', '    get: {}', 'components:'].join(
      '\n',
    );
    const client =
      "this.request(`/applications/${safeSegment(uuid, 'uuid')}/nope${this.buildQueryString({ a })}`)";
    expect(findUnmatchedRoutes(client, spec)).toContain(
      "/applications/${safeSegment(uuid, 'uuid')}/nope${this.buildQueryString({ a })}",
    );
  });
});

describe('normaliseClientRoute fails closed on interpolations it cannot resolve', () => {
  const LOGS = ['applications', null, 'logs'];

  it('reports an unterminated ${ as unmatched', () => {
    const spec = ['paths:', '  /applications/{uuid}:', '    get: {}', 'components:'].join('\n');
    const route = '/applications/${safeSegment(uuid, ' + "'uuid')" + '/x';
    expect(findUnmatchedRoutes('this.request(`' + route + '`)', spec)).toContain(route);
  });

  it('resolves a nested template literal to the correct path', () => {
    expect(normaliseClientRoute('/applications/${a(`x${y}z`)}/logs${this.q({ lines })}')).toEqual(
      LOGS,
    );
  });

  it("ignores braces inside string literals ('{' and '}')", () => {
    expect(normaliseClientRoute("/applications/${f('{', 'a')}/logs")).toEqual(LOGS);
    expect(normaliseClientRoute('/applications/${f("}")}/logs')).toEqual(LOGS);
  });

  it('leaves an unterminated string inside an interpolation in the route (never a silent match)', () => {
    expect(normaliseClientRoute("/applications/${f('{}/logs")).not.toEqual(LOGS);
  });
});

describe('normaliseSpecPath', () => {
  it('turns {param} segments into wildcards', () => {
    expect(normaliseSpecPath('/applications/{uuid}/envs/{env_uuid}')).toEqual([
      'applications',
      null,
      'envs',
      null,
    ]);
  });
});

describe('segmentsMatch', () => {
  it('matches equal-length segment lists where params act as wildcards', () => {
    expect(segmentsMatch(['applications', null], ['applications', null])).toBe(true);
    // a null on either side is a wildcard — position 0 matches regardless
    expect(segmentsMatch(['applications', null], [null, 'envs'])).toBe(true);
  });

  it('does not match when literal segments differ', () => {
    expect(segmentsMatch(['applications', null], ['databases', null])).toBe(false);
  });

  it('does not match segment lists of different lengths', () => {
    expect(segmentsMatch(['applications'], ['applications', null])).toBe(false);
  });
});

describe('findUnmatchedRoutes', () => {
  const client = `
    class C {
      async list() { return this.request<T>(\`/applications/\${uuid}/scheduled-tasks\`); }
      async get() { return this.request<T>('/teams'); }
    }
  `;

  it('reports client routes with no matching spec path', () => {
    // extractClientRoutes always injects '/version' too (getVersion() bypasses
    // this.request()), so a spec missing both /version and scheduled-tasks
    // should report both.
    const specWithGapsOnly = [
      'paths:',
      '  /teams:',
      '    get:',
      '      tags: []',
      'components:',
    ].join('\n');

    expect(findUnmatchedRoutes(client, specWithGapsOnly)).toEqual(
      expect.arrayContaining(['/applications/${uuid}/scheduled-tasks', '/version']),
    );
    expect(findUnmatchedRoutes(client, specWithGapsOnly)).toHaveLength(2);
  });

  it('reports nothing once the spec covers every client route', () => {
    const fullSpec = [
      'paths:',
      '  /teams:',
      '    get:',
      '      tags: []',
      "  '/applications/{uuid}/scheduled-tasks':",
      '    get:',
      '      tags: []',
      '  /version:',
      '    get:',
      '      tags: []',
      'components:',
    ].join('\n');

    expect(findUnmatchedRoutes(client, fullSpec)).toEqual([]);
  });
});

describe('ALLOWLIST', () => {
  it('is an array (empty once the bundled spec is fully caught up)', () => {
    expect(Array.isArray(ALLOWLIST)).toBe(true);
  });
});
