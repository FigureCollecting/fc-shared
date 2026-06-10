import { http, HttpResponse } from 'msw';
import { createApiClient } from '../../src/api/client';
import * as figuresApi from '../../src/api/figures';
import { server, installMswServer } from '../mocks/server';

installMswServer();

const BASE = 'http://api.test';
const api = createApiClient({
  baseUrl: BASE,
  auth: {
    getToken: () => 't',
    getRefreshToken: () => 'r',
    updateTokens: () => undefined,
    recordActivity: () => undefined,
    logout: () => undefined,
    onAuthFailure: () => undefined,
  },
});

describe('auth functions', () => {
  it('loginUser maps accessToken to token and fills defaults', async () => {
    server.use(
      http.post(`${BASE}/auth/login`, async ({ request }) => {
        expect(await request.json()).toEqual({ email: 'a@b.c', password: 'pw' });
        return HttpResponse.json({
          data: { _id: '1', username: 'u', email: 'a@b.c', isAdmin: false, accessToken: 'AT', refreshToken: 'RT' },
        });
      }),
    );
    const user = (await figuresApi.loginUser(api, 'a@b.c', 'pw')) as Record<string, unknown>;
    expect(user.token).toBe('AT');
    expect(user.refreshToken).toBe('RT');
    expect(user.emailVerified).toBe(false);
    expect(typeof user.tokenExpiresAt).toBe('number');
  });

  it('loginUser returns the 2FA challenge when required', async () => {
    server.use(
      http.post(`${BASE}/auth/login`, () =>
        HttpResponse.json({ requiresTwoFactor: true, data: { sessionId: 's1', methods: ['totp'] } }),
      ),
    );
    expect(await figuresApi.loginUser(api, 'a@b.c', 'pw')).toEqual({
      requiresTwoFactor: true,
      sessionId: 's1',
      methods: ['totp'],
    });
  });

  it('loginUser returns undefined when the response has no data', async () => {
    server.use(http.post(`${BASE}/auth/login`, () => HttpResponse.json({})));
    expect(await figuresApi.loginUser(api, 'a@b.c', 'pw')).toBeUndefined();
  });

  it('refreshAccessToken accepts token or accessToken', async () => {
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ data: { token: 'TT', refreshToken: 'RR' } })));
    const out = await figuresApi.refreshAccessToken(api, 'old');
    expect(out.token).toBe('TT');
    expect(out.refreshToken).toBe('RR');
  });
});

describe('figures CRUD + queries', () => {
  it('getFigures builds the query string and returns the paginated envelope', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ success: true, count: 0, page: 1, pages: 0, total: 0, data: [] });
      }),
    );
    const res = await figuresApi.getFigures(api, 2, 25, 'name', 'desc', 'owned');
    expect(url?.searchParams.get('page')).toBe('2');
    expect(url?.searchParams.get('limit')).toBe('25');
    expect(url?.searchParams.get('sortBy')).toBe('name');
    expect(url?.searchParams.get('sortOrder')).toBe('desc');
    expect(url?.searchParams.get('status')).toBe('owned');
    expect(res.data).toEqual([]);
  });

  it('getFigures omits status when not given', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: [] });
      }),
    );
    await figuresApi.getFigures(api);
    expect(url?.searchParams.has('status')).toBe(false);
  });

  it('getFigureById unwraps response.data.data', async () => {
    server.use(http.get(`${BASE}/figures/abc`, () => HttpResponse.json({ data: { _id: 'abc', name: 'X' } })));
    expect(await figuresApi.getFigureById(api, 'abc')).toEqual({ _id: 'abc', name: 'X' });
  });

  it('createFigure posts the form data', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/figures`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { _id: 'new' } });
      }),
    );
    await figuresApi.createFigure(api, { manufacturer: 'GSC', name: 'S', scale: '1/7' } as never);
    expect(body).toEqual({ manufacturer: 'GSC', name: 'S', scale: '1/7' });
  });

  it('deleteFigure issues a DELETE to the id', async () => {
    let hit = false;
    server.use(
      http.delete(`${BASE}/figures/dd`, () => {
        hit = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await figuresApi.deleteFigure(api, 'dd');
    expect(hit).toBe(true);
  });

  it('searchFigures URL-encodes the query', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures/search`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: [] });
      }),
    );
    await figuresApi.searchFigures(api, 'fate stay');
    expect(url?.searchParams.get('query')).toBe('fate stay');
  });

  it('filterFigures drops undefined params', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures/filter`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: [] });
      }),
    );
    await figuresApi.filterFigures(api, { manufacturer: 'GSC', scale: undefined, page: 1 });
    expect(url?.searchParams.get('manufacturer')).toBe('GSC');
    expect(url?.searchParams.has('scale')).toBe(false);
    expect(url?.searchParams.get('page')).toBe('1');
  });

  it('getFigureStats passes status as a param', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures/stats`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: { totalCount: 5 } });
      }),
    );
    const stats = await figuresApi.getFigureStats(api, 'wished');
    expect(url?.searchParams.get('status')).toBe('wished');
    expect(stats.totalCount).toBe(5);
  });
});

describe('public config error handling', () => {
  it('getPublicConfig returns null on error', async () => {
    server.use(http.get(`${BASE}/config/missing`, () => new HttpResponse(null, { status: 500 })));
    expect(await figuresApi.getPublicConfig(api, 'missing')).toBeNull();
  });

  it('getPublicConfig returns the config on success', async () => {
    server.use(
      http.get(`${BASE}/config/theme`, () =>
        HttpResponse.json({ data: { key: 'theme', value: 'dark', type: 'string', isPublic: true } }),
      ),
    );
    expect((await figuresApi.getPublicConfig(api, 'theme'))?.value).toBe('dark');
  });
});

describe('lists + 2fa + webauthn (request shaping)', () => {
  it('getLists builds optional query params', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/lists`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: [] });
      }),
    );
    await figuresApi.getLists(api, { page: 3, privacy: 'public' });
    expect(url?.searchParams.get('page')).toBe('3');
    expect(url?.searchParams.get('privacy')).toBe('public');
  });

  it('removeItemsFromList sends ids in the request body', async () => {
    let body: unknown;
    server.use(
      http.delete(`${BASE}/lists/L1/items`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { _id: 'L1' } });
      }),
    );
    await figuresApi.removeItemsFromList(api, 'L1', [1, 2, 3]);
    expect(body).toEqual({ mfcIds: [1, 2, 3] });
  });

  it('verify2FA posts the session, method, and code', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/2fa/verify`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    await figuresApi.verify2FA(api, 's1', 'totp', '123456');
    expect(body).toEqual({ sessionId: 's1', method: 'totp', code: '123456' });
  });

  it('deleteWebAuthnCredential deletes by id', async () => {
    let hit = false;
    server.use(
      http.delete(`${BASE}/auth/webauthn/credential/cred1`, () => {
        hit = true;
        return HttpResponse.json({ data: {} });
      }),
    );
    await figuresApi.deleteWebAuthnCredential(api, 'cred1');
    expect(hit).toBe(true);
  });
});
