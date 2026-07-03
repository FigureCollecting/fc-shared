import { http, HttpResponse } from 'msw';
import { createApiClient, createSimpleApiClient, AuthAccessor } from '../../src/api/client';
import { configureLogger } from '../../src/utils/logger';
import { server, installMswServer } from '../mocks/server';

installMswServer();
afterEach(() => jest.restoreAllMocks());

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

  it('logs out on a 401 when there is no refresh token, without attempting a refresh', async () => {
    const auth = makeAuth({ refreshToken: undefined });
    const api = createApiClient({ baseUrl: BASE, auth });
    let refreshCalled = false;
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 })),
      // A refresh here would be a bug: with no refresh token the client must go
      // straight to logout. Flip a flag so the test fails loudly if it is hit.
      http.post(`${BASE}/auth/refresh`, () => {
        refreshCalled = true;
        return HttpResponse.json({ data: { accessToken: 'should-not-happen' } });
      }),
    );
    await expect(api.get('/data')).rejects.toBeDefined();
    expect(refreshCalled).toBe(false);
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

  it('rejects a response-less network error with the original error, not a TypeError from reading .status', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/boom`, () => HttpResponse.error()));
    let err: any;
    try {
      await api.get('/boom');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The rejection is the axios error (carries the request config), not a bare
    // TypeError from dereferencing `.status` on an absent response.
    expect(err.config).toBeDefined();
    expect(err.message).toMatch(/network/i);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent refreshes: two simultaneous 401s trigger exactly one refresh', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    let refreshCount = 0;
    const retryAuths: (string | null)[] = [];
    server.use(
      http.get(`${BASE}/a`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.get(`${BASE}/b`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post(`${BASE}/auth/refresh`, async ({ request }) => {
        refreshCount += 1;
        expect(await request.json()).toEqual({ refreshToken: 'rt' });
        return HttpResponse.json({ data: { accessToken: 'fresh' } });
      }),
      http.get(`${BASE}/a`, ({ request }) => {
        retryAuths.push(request.headers.get('Authorization'));
        return HttpResponse.json({ data: { r: 'a' } });
      }),
      http.get(`${BASE}/b`, ({ request }) => {
        retryAuths.push(request.headers.get('Authorization'));
        return HttpResponse.json({ data: { r: 'b' } });
      }),
    );
    const [ra, rb] = await Promise.all([api.get('/a'), api.get('/b')]);
    // The second 401 must wait on the in-flight refresh instead of starting its own.
    expect(refreshCount).toBe(1);
    expect(ra.data).toEqual({ data: { r: 'a' } });
    expect(rb.data).toEqual({ data: { r: 'b' } });
    expect(retryAuths).toEqual(['Bearer fresh', 'Bearer fresh']);
  });

  it('logs out and rejects with the refresh failure when the refresh itself errors', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      // A non-401 failure exercises the refresh catch block rather than the
      // direct /auth/refresh early-return path.
      http.post(`${BASE}/auth/refresh`, () => new HttpResponse(null, { status: 500 })),
    );
    let err: any;
    try {
      await api.get('/data');
    } catch (e) {
      err = e;
    }
    // Rejected with the refresh failure (500), not the original 401.
    expect(err?.response?.status).toBe(500);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('resets its refresh state so a later 401 drives a fresh refresh', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    let refreshCount = 0;
    server.use(
      http.get(`${BASE}/one`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.get(`${BASE}/one`, () => HttpResponse.json({ data: { n: 1 } }), { once: true }),
      http.get(`${BASE}/two`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.get(`${BASE}/two`, () => HttpResponse.json({ data: { n: 2 } }), { once: true }),
      http.post(`${BASE}/auth/refresh`, () => {
        refreshCount += 1;
        return HttpResponse.json({ data: { accessToken: `fresh${refreshCount}` } });
      }),
    );
    const r1 = await api.get('/one');
    const r2 = await api.get('/two');
    expect(r1.data).toEqual({ data: { n: 1 } });
    expect(r2.data).toEqual({ data: { n: 2 } });
    // isRefreshing/refreshPromise were reset, so the second cycle refreshes anew.
    expect(refreshCount).toBe(2);
    expect(auth.updateTokens).toHaveBeenNthCalledWith(1, 'fresh1', undefined, expect.any(Number));
    expect(auth.updateTokens).toHaveBeenNthCalledWith(2, 'fresh2', undefined, expect.any(Number));
  });

  it('does not refresh again for a request that 401s after its retry', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    let refreshCount = 0;
    server.use(
      // Always 401, so the retried request is unauthorized too.
      http.get(`${BASE}/loop`, () => new HttpResponse(null, { status: 401 })),
      http.post(`${BASE}/auth/refresh`, () => {
        refreshCount += 1;
        return HttpResponse.json({ data: { accessToken: 'fresh' } });
      }),
    );
    let err: any;
    try {
      await api.get('/loop');
    } catch (e) {
      err = e;
    }
    // The _retry guard stops a second refresh (and an infinite loop).
    expect(err?.response?.status).toBe(401);
    expect(refreshCount).toBe(1);
  });

  it('sets tokenExpiresAt to Date.now() + 14 minutes when refreshing after a 401', async () => {
    const FIXED = 1_000_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(FIXED);
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post(`${BASE}/auth/refresh`, () =>
        HttpResponse.json({ data: { accessToken: 'fresh', refreshToken: 'newRt' } }),
      ),
      http.get(`${BASE}/data`, () => HttpResponse.json({ data: { ok: true } })),
    );
    await api.get('/data');
    expect(auth.updateTokens).toHaveBeenCalledWith('fresh', 'newRt', FIXED + 14 * 60 * 1000);
  });

  it('rotates the token from an x-access-token header when x-new-token is absent', async () => {
    const FIXED = 1_000_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(FIXED);
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/thing`, () =>
        HttpResponse.json({ data: {} }, { headers: { 'x-access-token': 'Bearer rotated2' } }),
      ),
    );
    await api.get('/thing');
    expect(auth.updateTokens).toHaveBeenCalledWith('rotated2', undefined, FIXED + 14 * 60 * 1000);
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

  it('omits the Authorization header when there is no token', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => undefined } });
    let seen: string | null = 'unset';
    server.use(
      http.get(`${BASE}/s-public`, ({ request }) => {
        seen = request.headers.get('Authorization');
        return HttpResponse.json({ ok: true });
      }),
    );
    await api.get('/s-public');
    expect(seen).toBeNull();
  });

  it('rejects on an error response', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => undefined } });
    server.use(http.get(`${BASE}/err`, () => new HttpResponse(null, { status: 500 })));
    await expect(api.get('/err')).rejects.toBeDefined();
  });
});

// The error interceptors branch their diagnostics on error shape: a response-less
// error is "network unavailable", a 502/503/504 is "backend unavailable", and the
// refresh lifecycle emits its own trail. The logger only writes to console when
// debug is enabled, so these tests turn it on and spy the console to pin down
// which branch fires under each failure — the behavior the branch conditions
// actually select.
describe('error-interceptor logging branches', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    configureLogger({ debug: true, level: 'verbose' });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    configureLogger({ debug: false, level: 'error' });
  });

  const logged = (spy: jest.SpyInstance): string =>
    spy.mock.calls.map((c: unknown[]) => c.map((a: unknown) => String(a)).join(' ')).join('\n');

  it('warns "network error" on a response-less error while authenticated', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/boom`, () => HttpResponse.error()));
    await expect(api.get('/boom')).rejects.toBeDefined();
    expect(logged(warnSpy)).toContain('Network error detected');
  });

  it('warns "backend unavailable" (not the network warning) on a 503 while authenticated', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/down`, () => new HttpResponse(null, { status: 503 })));
    await expect(api.get('/down')).rejects.toBeDefined();
    expect(logged(warnSpy)).toContain('Backend unavailable (503)');
    expect(logged(warnSpy)).not.toContain('Network error detected');
  });

  it('emits no backend-unavailable warning on a plain 500', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/err`, () => new HttpResponse(null, { status: 500 })));
    await expect(api.get('/err')).rejects.toBeDefined();
    expect(logged(warnSpy)).not.toContain('Backend unavailable');
  });

  it('rejects a response-less error with no token via the original error, not a status dereference', async () => {
    const auth = makeAuth({ token: undefined });
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.get(`${BASE}/boom`, () => HttpResponse.error()));
    let err: any;
    try {
      await api.get('/boom');
    } catch (e) {
      err = e;
    }
    expect(err?.config).toBeDefined();
    expect(err?.message).toMatch(/network/i);
  });

  it('logs the refresh lifecycle (attempt + success) on a 401 that refreshes', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ data: { accessToken: 'fresh' } })),
      http.get(`${BASE}/data`, () => HttpResponse.json({ data: { ok: true } })),
    );
    await api.get('/data');
    expect(logged(logSpy)).toContain('Token expired');
    expect(logged(infoSpy)).toContain('Token refreshed successfully');
  });

  it('warns when the refresh request itself returns 401', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(http.post(`${BASE}/auth/refresh`, () => new HttpResponse(null, { status: 401 })));
    await expect(api.post('/auth/refresh', { refreshToken: 'rt' })).rejects.toBeDefined();
    expect(logged(warnSpy)).toContain('Refresh token invalid');
  });

  it('logs an error when the refresh attempt fails', async () => {
    const auth = makeAuth();
    const api = createApiClient({ baseUrl: BASE, auth });
    server.use(
      http.get(`${BASE}/data`, () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post(`${BASE}/auth/refresh`, () => new HttpResponse(null, { status: 500 })),
    );
    await expect(api.get('/data')).rejects.toBeDefined();
    expect(logged(errorSpy)).toContain('Token refresh failed');
  });

  it('the simple client logs the response body on an error', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => undefined } });
    server.use(
      http.get(`${BASE}/err`, () => HttpResponse.json({ message: 'kaboom-detail' }, { status: 500 })),
    );
    await expect(api.get('/err')).rejects.toBeDefined();
    const out = logged(errorSpy);
    expect(out).toContain('API error:');
    expect(out).toContain('kaboom-detail');
  });

  it('the simple client logs "API error" via the message when there is no response', async () => {
    const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => undefined } });
    server.use(http.get(`${BASE}/boom`, () => HttpResponse.error()));
    let err: any;
    try {
      await api.get('/boom');
    } catch (e) {
      err = e;
    }
    // Reached the interceptor with the axios error (has config), not a TypeError
    // from dereferencing `.data` on an absent response.
    expect(err?.config).toBeDefined();
    expect(logged(errorSpy)).toContain('API error:');
  });
});
