import { http, HttpResponse } from 'msw';
import { createApiClient } from '../../src/api/client';
import * as figuresApi from '../../src/api/figures';
import { Figure, MfcList, PaginatedResponse } from '../../src/types';
import { server, installMswServer } from '../mocks/server';
import { aFigure, anMfcList } from '../mocks/builders';

// ─────────────────────────────────────────────────────────────────────────────
// Four-criteria completeness check (testing doctrine §6) for src/api/figures.ts
//
// 1. Functional completeness — every exported function is exercised through the
//    real axios client + interceptors (auth/refresh) against MSW: auth mapping,
//    figures CRUD/query, bulk import, lists CRUD, email/2FA/WebAuthn passthroughs.
//    Request shaping (query strings, JSON bodies) and response unwrapping
//    (response.data vs response.data.data) are asserted per function.
// 2. Boundary handling — the accessToken→token remap and 14-min expiry, the
//    `?? default` fallbacks on optional user flags (both present and absent),
//    the `accessToken || token` refresh branch, optional query params present vs
//    omitted (getFigures status, getFigureStats status, getLists all-vs-none),
//    and filterFigures dropping undefined entries.
// 3. Failure behavior — getPublicConfig swallowing a 5xx to null, and non-2xx /
//    network errors propagating as rejections through the client error
//    interceptor for callers with no local catch.
// 4. Resilience — malformed/empty envelopes (missing data → undefined) and a
//    transport-level network error (HttpResponse.error()) surfacing as a
//    rejection rather than a hang.
// ─────────────────────────────────────────────────────────────────────────────

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

describe('auth registration + refresh + session mapping', () => {
  it('registerUser posts credentials and carries the provided verification flags', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/register`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          data: {
            _id: '9',
            username: 'newbie',
            email: 'new@b.c',
            isAdmin: false,
            accessToken: 'AT',
            refreshToken: 'RT',
            emailVerified: true,
            twoFactorEnabled: true,
            webauthnCredentialCount: 2,
          },
        });
      }),
    );
    const user = await figuresApi.registerUser(api, 'newbie', 'new@b.c', 'pw');
    expect(body).toEqual({ username: 'newbie', email: 'new@b.c', password: 'pw' });
    expect(user.token).toBe('AT');
    expect(user.refreshToken).toBe('RT');
    // truthy side of the `?? default` fallbacks (the login test covers the false side)
    expect(user.emailVerified).toBe(true);
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.webauthnCredentialCount).toBe(2);
    expect(typeof user.tokenExpiresAt).toBe('number');
  });

  it('registerUser returns undefined when the response has no data', async () => {
    server.use(http.post(`${BASE}/auth/register`, () => HttpResponse.json({})));
    expect(await figuresApi.registerUser(api, 'u', 'e@x.c', 'pw')).toBeUndefined();
  });

  it('registerUser defaults the verification flags when the backend omits them', async () => {
    server.use(
      http.post(`${BASE}/auth/register`, () =>
        HttpResponse.json({ data: { _id: '9', username: 'u', email: 'e@x.c', isAdmin: false, accessToken: 'AT' } }),
      ),
    );
    const user = await figuresApi.registerUser(api, 'u', 'e@x.c', 'pw');
    // falsy side of the `?? default` fallbacks
    expect(user.emailVerified).toBe(false);
    expect(user.twoFactorEnabled).toBe(false);
    expect(user.webauthnCredentialCount).toBe(0);
  });

  it('loginUser keeps explicit verification flags rather than defaulting them', async () => {
    server.use(
      http.post(`${BASE}/auth/login`, () =>
        HttpResponse.json({
          data: {
            _id: '1',
            username: 'u',
            email: 'a@b.c',
            isAdmin: true,
            accessToken: 'AT',
            emailVerified: true,
            twoFactorEnabled: true,
            webauthnCredentialCount: 5,
          },
        }),
      ),
    );
    const user = (await figuresApi.loginUser(api, 'a@b.c', 'pw')) as Record<string, unknown>;
    expect(user.isAdmin).toBe(true);
    expect(user.emailVerified).toBe(true);
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.webauthnCredentialCount).toBe(5);
  });

  it('refreshAccessToken prefers accessToken over token', async () => {
    server.use(
      http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ data: { accessToken: 'NEW' } })),
    );
    expect((await figuresApi.refreshAccessToken(api, 'old')).token).toBe('NEW');
  });

  it('logoutUser and logoutAllSessions hit their endpoints', async () => {
    let logout = false;
    let logoutAll = false;
    server.use(
      http.post(`${BASE}/auth/logout`, () => {
        logout = true;
        return HttpResponse.json({ success: true });
      }),
      http.post(`${BASE}/auth/logout-all`, () => {
        logoutAll = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await figuresApi.logoutUser(api);
    await figuresApi.logoutAllSessions(api);
    expect(logout).toBe(true);
    expect(logoutAll).toBe(true);
  });

  it('getUserSessions unwraps data.data', async () => {
    server.use(
      http.get(`${BASE}/auth/sessions`, () =>
        HttpResponse.json({ data: [{ id: 's1', current: true }] }),
      ),
    );
    expect(await figuresApi.getUserSessions(api)).toEqual([{ id: 's1', current: true }]);
  });

  it('getUserProfile and updateUserProfile round-trip through data.data', async () => {
    let sent: unknown;
    server.use(
      http.get(`${BASE}/auth/profile`, () => HttpResponse.json({ data: { _id: '1', username: 'u' } })),
      http.put(`${BASE}/auth/profile`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ data: { _id: '1', username: 'renamed' } });
      }),
    );
    expect((await figuresApi.getUserProfile(api))._id).toBe('1');
    const updated = await figuresApi.updateUserProfile(api, { username: 'renamed' });
    expect(sent).toEqual({ username: 'renamed' });
    expect(updated.username).toBe('renamed');
  });
});

describe('figures — update + stats-without-status', () => {
  it('updateFigure PUTs the form data to the id and returns the updated figure', async () => {
    let body: unknown;
    const updated = aFigure({ _id: 'f1', name: 'Renamed' });
    server.use(
      http.put(`${BASE}/figures/f1`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: updated });
      }),
    );
    const res = await figuresApi.updateFigure(api, 'f1', { manufacturer: 'GSC', name: 'Renamed', scale: '1/7' });
    expect(body).toEqual({ manufacturer: 'GSC', name: 'Renamed', scale: '1/7' });
    expect(res).toEqual(updated);
  });

  it('getFigureStats sends no status param when omitted', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/figures/stats`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: { totalCount: 0 } });
      }),
    );
    await figuresApi.getFigureStats(api);
    expect(url?.searchParams.has('status')).toBe(false);
  });
});

describe('bulk import', () => {
  it('previewBulkImport posts the CSV and returns the preview envelope', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/figures/bulk-import/preview`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true, totalItems: 1, summary: { new: 1, catalogExists: 0, duplicates: 0 }, items: [] });
      }),
    );
    const res = await figuresApi.previewBulkImport(api, 'mfcId,status');
    expect(body).toEqual({ csvContent: 'mfcId,status' });
    expect(res.totalItems).toBe(1);
  });

  it('executeBulkImport defaults skipDuplicates to true and honors an explicit false', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE}/figures/bulk-import`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ success: true, totalItems: 0, imported: 0, skipped: 0, errors: [] });
      }),
    );
    await figuresApi.executeBulkImport(api, 'csv');
    await figuresApi.executeBulkImport(api, 'csv', false);
    expect(bodies[0]).toEqual({ csvContent: 'csv', skipDuplicates: true });
    expect(bodies[1]).toEqual({ csvContent: 'csv', skipDuplicates: false });
  });
});

describe('lists CRUD + request shaping', () => {
  it('getLists issues a bare /lists request when no params are given', async () => {
    let url: URL | undefined;
    const envelope: PaginatedResponse<MfcList> = { success: true, count: 0, page: 1, pages: 0, total: 0, data: [] };
    server.use(
      http.get(`${BASE}/lists`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(envelope);
      }),
    );
    await figuresApi.getLists(api);
    expect(url?.search).toBe('');
  });

  it('getLists serializes every optional param when provided', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/lists`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ data: [] });
      }),
    );
    await figuresApi.getLists(api, { page: 2, limit: 50, sortBy: 'name', sortOrder: 'desc', privacy: 'friends' });
    expect(url?.searchParams.get('page')).toBe('2');
    expect(url?.searchParams.get('limit')).toBe('50');
    expect(url?.searchParams.get('sortBy')).toBe('name');
    expect(url?.searchParams.get('sortOrder')).toBe('desc');
    expect(url?.searchParams.get('privacy')).toBe('friends');
  });

  it('getListById unwraps a single list', async () => {
    const list = anMfcList({ _id: 'L9' });
    server.use(http.get(`${BASE}/lists/L9`, () => HttpResponse.json({ data: list })));
    expect((await figuresApi.getListById(api, 'L9'))._id).toBe('L9');
  });

  it('createList posts form data and returns the created list', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/lists`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: anMfcList({ _id: 'L-new', name: 'Wishlist' }) });
      }),
    );
    const res = await figuresApi.createList(api, { name: 'Wishlist', privacy: 'private' });
    expect(body).toEqual({ name: 'Wishlist', privacy: 'private' });
    expect(res._id).toBe('L-new');
  });

  it('updateList PUTs a partial and returns the updated list', async () => {
    let body: unknown;
    server.use(
      http.put(`${BASE}/lists/L1`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: anMfcList({ _id: 'L1', teaser: 'new teaser' }) });
      }),
    );
    const res = await figuresApi.updateList(api, 'L1', { teaser: 'new teaser' });
    expect(body).toEqual({ teaser: 'new teaser' });
    expect(res.teaser).toBe('new teaser');
  });

  it('deleteList issues a DELETE to the id', async () => {
    let hit = false;
    server.use(
      http.delete(`${BASE}/lists/L1`, () => {
        hit = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await figuresApi.deleteList(api, 'L1');
    expect(hit).toBe(true);
  });

  it('getListsByItem fetches lists containing an mfcId', async () => {
    server.use(
      http.get(`${BASE}/lists/by-item/4242`, () =>
        HttpResponse.json({ data: [{ _id: 'L1', name: 'Fate' }] }),
      ),
    );
    expect(await figuresApi.getListsByItem(api, 4242)).toEqual([{ _id: 'L1', name: 'Fate' }]);
  });

  it('addItemsToList posts the mfcIds and returns the list', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/lists/L1/items`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: anMfcList({ _id: 'L1', itemMfcIds: [7, 8] }) });
      }),
    );
    const res = await figuresApi.addItemsToList(api, 'L1', [7, 8]);
    expect(body).toEqual({ mfcIds: [7, 8] });
    expect(res.itemMfcIds).toEqual([7, 8]);
  });

  it('syncLists posts the lists and returns the upserted count', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/lists/sync`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { upserted: 3 } });
      }),
    );
    const res = await figuresApi.syncLists(api, [{ name: 'A' }, { name: 'B' }]);
    expect(body).toEqual({ lists: [{ name: 'A' }, { name: 'B' }] });
    expect(res.upserted).toBe(3);
  });
});

describe('email verification + password reset passthroughs', () => {
  it('verifyEmailToken posts the token and userId and returns the raw payload', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/verify-email`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ verified: true });
      }),
    );
    expect(await figuresApi.verifyEmailToken(api, 'tok', 'u1')).toEqual({ verified: true });
    expect(body).toEqual({ token: 'tok', userId: 'u1' });
  });

  it('resendVerificationEmail posts the email', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/resend-verification`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ sent: true });
      }),
    );
    expect(await figuresApi.resendVerificationEmail(api, 'a@b.c')).toEqual({ sent: true });
    expect(body).toEqual({ email: 'a@b.c' });
  });

  it('forgotPasswordRequest posts the email', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/forgot-password`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    expect(await figuresApi.forgotPasswordRequest(api, 'a@b.c')).toEqual({ ok: true });
    expect(body).toEqual({ email: 'a@b.c' });
  });

  it('resetPasswordRequest posts the token, password and userId', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/reset-password`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    expect(await figuresApi.resetPasswordRequest(api, 'tok', 'newpw', 'u1')).toEqual({ ok: true });
    expect(body).toEqual({ token: 'tok', password: 'newpw', userId: 'u1' });
  });
});

describe('two-factor + WebAuthn passthroughs', () => {
  it('setupTOTP posts and returns the setup payload', async () => {
    server.use(http.post(`${BASE}/auth/2fa/totp/setup`, () => HttpResponse.json({ secret: 'S', qr: 'Q' })));
    expect(await figuresApi.setupTOTP(api)).toEqual({ secret: 'S', qr: 'Q' });
  });

  it('verifyTOTPSetup posts the code', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/2fa/totp/verify-setup`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ enabled: true });
      }),
    );
    expect(await figuresApi.verifyTOTPSetup(api, '123456')).toEqual({ enabled: true });
    expect(body).toEqual({ code: '123456' });
  });

  it('disableTOTP sends the code in the DELETE body', async () => {
    let body: unknown;
    server.use(
      http.delete(`${BASE}/auth/2fa/totp`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ disabled: true });
      }),
    );
    expect(await figuresApi.disableTOTP(api, '123456')).toEqual({ disabled: true });
    expect(body).toEqual({ code: '123456' });
  });

  it('regenerateBackupCodes posts the code', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/2fa/backup-codes`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ codes: ['a', 'b'] });
      }),
    );
    expect(await figuresApi.regenerateBackupCodes(api, '123456')).toEqual({ codes: ['a', 'b'] });
    expect(body).toEqual({ code: '123456' });
  });

  it('getWebAuthnRegisterOptions posts the nickname', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/webauthn/register/options`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ challenge: 'c' });
      }),
    );
    expect(await figuresApi.getWebAuthnRegisterOptions(api, 'yubikey')).toEqual({ challenge: 'c' });
    expect(body).toEqual({ nickname: 'yubikey' });
  });

  it('verifyWebAuthnRegistration posts the challengeId and response', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/webauthn/register/verify`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ verified: true });
      }),
    );
    expect(await figuresApi.verifyWebAuthnRegistration(api, 'ch1', { id: 'x' })).toEqual({ verified: true });
    expect(body).toEqual({ challengeId: 'ch1', response: { id: 'x' } });
  });

  it('getWebAuthnLoginOptions posts the email', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/webauthn/login/options`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ challenge: 'c' });
      }),
    );
    expect(await figuresApi.getWebAuthnLoginOptions(api, 'a@b.c')).toEqual({ challenge: 'c' });
    expect(body).toEqual({ email: 'a@b.c' });
  });

  it('verifyWebAuthnLogin posts the challengeId and response', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/webauthn/login/verify`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ token: 't' });
      }),
    );
    expect(await figuresApi.verifyWebAuthnLogin(api, 'ch1', { id: 'x' })).toEqual({ token: 't' });
    expect(body).toEqual({ challengeId: 'ch1', response: { id: 'x' } });
  });
});

describe('failure behavior + resilience', () => {
  it('getFigureById rejects when the backend returns a 5xx', async () => {
    server.use(http.get(`${BASE}/figures/boom`, () => new HttpResponse(null, { status: 500 })));
    await expect(figuresApi.getFigureById(api, 'boom')).rejects.toThrow();
  });

  it('getFigures rejects on a transport-level network error', async () => {
    server.use(http.get(`${BASE}/figures`, () => HttpResponse.error()));
    await expect(figuresApi.getFigures(api)).rejects.toThrow();
  });
});
