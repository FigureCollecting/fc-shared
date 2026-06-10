import { http, HttpResponse } from 'msw';
import { createApiClient, createSimpleApiClient, AuthAccessor } from '../../src/api/client';
import { server, installMswServer } from '../mocks/server';

installMswServer();

const BASE = 'http://api.test';

type MockAuth = AuthAccessor & {
  updateTokens: jest.Mock;
  recordActivity: jest.Mock;
  logout: jest.Mock;
  onAuthFailure: jest.Mock;
};

function makeAuth(init: { token?: string; refreshToken?: string } = {}): MockAuth {
  let token: string | undefined = 'token' in init ? init.token : 'tok';
  let refreshToken: string | undefined = 'refreshToken' in init ? init.refreshToken : 'rt';
  return {
    getToken: () => token,
    getRefreshToken: () => refreshToken,
    updateTokens: jest.fn((t: string) => {
      token = t;
    }),
    recordActivity: jest.fn(),
    logout: jest.fn(() => {
      token = undefined;
      refreshToken = undefined;
    }),
    onAuthFailure: jest.fn(),
  };
}

describe('createApiClient', () => {
  it('attaches a Bearer token to requests when one is present', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/me`, ({ request }) => {
        seen = request.headers.get('Authorization');
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    await api.get('/me');
    expect(seen).toBe('Bearer tok');
    expect(auth.recordActivity).toHaveBeenCalled();
  });

  it('omits the Authorization header when there is no token', async () => {
    const auth = makeAuth({ token: undefined });
    const api = createApiClient({ baseUrl: BASE, auth });
    let seen: string | null = 'unset';
    server.use(
      http.get(`${BASE}/public`, ({ request }) => {
        seen = request.headers.get('Authorization');
        return HttpResponse.json({ data: {} });
      }),
    );
    await api.get('/public');
    expect(seen).toBeNull();
  });

  it('stores a rotated token from the x-new-token response header', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/thing`, () =>
        HttpResponse.json({ data: {} }, { headers: { 'x-new-token': 'Bearer rotated' } }),
      ),
    );
    await api.get('/thing');
    expect(auth.updateTokens).toHaveBeenCalledWith('rotated', undefined, expect.any(Number));
  });

  it('refreshes the token on 401 and retries the original request with the new token', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    let retryAuth: string | null = null;
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post(
        `${BASE}/auth/refresh`,
        async ({ request }) => {
          const body = (await request.json()) as { refreshToken: string };
          expect(body.refreshToken).toBe('rt');
          return HttpResponse.json({ data: { accessToken: 'fresh' } });
        },
        { once: true },
      ),
      http.get(`${BASE}/data`, ({ request }) => {
        retryAuth = request.headers.get('Authorization');
        return HttpResponse.json({ data: { value: 42 } });
      }),
    );
    const res = await api.get('/data');
    expect(res.data).toEqual({ data: { value: 42 } });
    expect(auth.updateTokens).toHaveBeenCalledWith('fresh', undefined, expect.any(Number));
    expect(retryAuth).toBe('Bearer fresh');
  });

  it('logs out when the refresh request itself returns 401', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.post(`${BASE}/auth/refresh`, () => new HttpResponse(null, { status: 401 })));
    await expect(api.post('/auth/refresh', { refreshToken: 'rt' })).rejects.toBeDefined();
    expect(auth.logout).toHaveBeenCalled();
    expect(auth.onAuthFailure).toHaveBeenCalled();
  });

  it('logs out on a 401 when there is no refresh token', async () => {
    const auth = makeAuth({ refreshToken: undefined });
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 })));
    await expect(api.get('/data')).rejects.toBeDefined();
    expect(auth.logout).toHaveBeenCalled();
    expect(auth.onAuthFailure).toHaveBeenCalled();
  });

  it('rejects without logging out on a 503 while authenticated', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/down`, () => new HttpResponse(null, { status: 503 })));
    await expect(api.get('/down')).rejects.toBeDefined();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('rejects on a network error while authenticated', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/boom`, () => HttpResponse.error()));
    await expect(api.get('/boom')).rejects.toBeDefined();
  });
});

describe('createSimpleApiClient', () => {
  it('attaches a Bearer token to requests', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => 'simple-tok' } });
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/s`, ({ request }) => {
        seen = request.headers.get('Authorization');
        return HttpResponse.json({ ok: true });
      }),
    );
    await api.get('/s');
    expect(seen).toBe('Bearer simple-tok');
  });

  it('rejects on an error response', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => undefined } });
    server.use(http.get(`${BASE}/err`, () => new HttpResponse(null, { status: 500 })));
    await expect(api.get('/err')).rejects.toBeDefined();
  });
});
