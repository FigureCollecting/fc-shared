import { http, HttpResponse } from 'msw';
import { createSimpleApiClient } from '../../src/api/client';
import * as scraperApi from '../../src/api/scraper';
import { MfcCookies } from '../../src/types';
import { server, installMswServer } from '../mocks/server';

installMswServer();

const BASE = 'http://scraper.test';
const api = createSimpleApiClient({ baseUrl: BASE, auth: { getToken: () => 'tok' } });

const cookies: MfcCookies = { PHPSESSID: 'x', sesUID: 'y', sesDID: 'z' };

describe('scraper api — success and the success:false throw path', () => {
  it('getMfcCookieAllowlist returns data on success', async () => {
    server.use(
      http.get(`${BASE}/sync/mfc/cookie-allowlist`, () =>
        HttpResponse.json({ success: true, data: { allowedCookies: ['PHPSESSID'], scriptReadable: [], manualCopy: [] } }),
      ),
    );
    expect((await scraperApi.getMfcCookieAllowlist(api)).allowedCookies).toEqual(['PHPSESSID']);
  });

  it('getMfcCookieAllowlist throws when success is false', async () => {
    server.use(
      http.get(`${BASE}/sync/mfc/cookie-allowlist`, () => HttpResponse.json({ success: false, message: 'nope' })),
    );
    await expect(scraperApi.getMfcCookieAllowlist(api)).rejects.toThrow('nope');
  });

  it('validateMfcCookies posts the cookies and returns the result', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/sync/validate-cookies`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true, data: { valid: true, username: 'u' } });
      }),
    );
    const res = await scraperApi.validateMfcCookies(api, cookies);
    expect(body).toEqual({ cookies });
    expect(res.valid).toBe(true);
  });

  it('executeFullSync maps the response fields', async () => {
    server.use(
      http.post(`${BASE}/sync/full`, () =>
        HttpResponse.json({
          success: true,
          data: {
            parsedCount: 10,
            queuedCount: 9,
            skippedCount: 1,
            listsFound: 2,
            stats: { owned: 9, ordered: 0, wished: 0, total: 9, nsfw: 0 },
            errors: [],
          },
        }),
      ),
    );
    const res = await scraperApi.executeFullSync(api, { cookies, userId: 'u', sessionId: 's' });
    expect(res).toMatchObject({ success: true, parsedCount: 10, queuedCount: 9, skippedCount: 1, listsFound: 2 });
  });

  it('executeFullSync throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/full`, () => HttpResponse.json({ success: false, message: 'sync boom' })));
    await expect(scraperApi.executeFullSync(api, { cookies, userId: 'u', sessionId: 's' })).rejects.toThrow('sync boom');
  });

  it('parseMfcCsv returns parsed items', async () => {
    server.use(
      http.post(`${BASE}/sync/parse-csv`, () =>
        HttpResponse.json({ success: true, data: { items: [], stats: { owned: 0, ordered: 0, wished: 0, total: 0, nsfw: 0 } } }),
      ),
    );
    expect((await scraperApi.parseMfcCsv(api, 'csv')).items).toEqual([]);
  });

  it('getQueueStats returns stats', async () => {
    server.use(
      http.get(`${BASE}/sync/queue-stats`, () =>
        HttpResponse.json({
          success: true,
          data: {
            queues: { hot: 1, warm: 0, cold: 0 },
            total: 1,
            processing: 0,
            completed: 0,
            failed: 0,
            rateLimit: { active: false, currentDelayMs: 0 },
          },
        }),
      ),
    );
    expect((await scraperApi.getQueueStats(api)).total).toBe(1);
  });
});

describe('scraper api — null/recovery paths', () => {
  it('getSyncJob returns null on a 404', async () => {
    server.use(http.get(`${BASE}/sync/job/missing`, () => new HttpResponse(null, { status: 404 })));
    expect(await scraperApi.getSyncJob(api, 'missing')).toBeNull();
  });

  it('getSyncJob returns the job on success', async () => {
    server.use(
      http.get(`${BASE}/sync/job/s1`, () =>
        HttpResponse.json({ success: true, job: { sessionId: 's1', phase: 'queueing', message: '', stats: {}, startedAt: 't' } }),
      ),
    );
    expect((await scraperApi.getSyncJob(api, 's1'))?.sessionId).toBe('s1');
  });

  it('getActiveJob swallows errors and returns null', async () => {
    server.use(http.get(`${BASE}/sync/active-job`, () => new HttpResponse(null, { status: 500 })));
    expect(await scraperApi.getActiveJob(api)).toBeNull();
  });

  it('getActiveJob returns the job when present', async () => {
    server.use(
      http.get(`${BASE}/sync/active-job`, () =>
        HttpResponse.json({ success: true, hasActiveJob: true, job: { sessionId: 'a1', phase: 'p', message: 'm', stats: {}, startedAt: 't' } }),
      ),
    );
    expect((await scraperApi.getActiveJob(api))?.sessionId).toBe('a1');
  });

  it('cancelSyncJob throws on success:false', async () => {
    server.use(http.delete(`${BASE}/sync/job/x`, () => HttpResponse.json({ success: false, message: 'cant cancel' })));
    await expect(scraperApi.cancelSyncJob(api, 'x')).rejects.toThrow('cant cancel');
  });

  it('cancelFailedItems returns the cancelled count', async () => {
    server.use(
      http.post(`${BASE}/sync/sessions/s1/cancel-failed`, () => HttpResponse.json({ success: true, data: { cancelledCount: 4 } })),
    );
    expect(await scraperApi.cancelFailedItems(api, 's1')).toBe(4);
  });

  it('resumeSyncSession throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/sessions/s1/resume`, () => HttpResponse.json({ success: false, message: 'cannot resume' })));
    await expect(scraperApi.resumeSyncSession(api, 's1')).rejects.toThrow('cannot resume');
  });
});
