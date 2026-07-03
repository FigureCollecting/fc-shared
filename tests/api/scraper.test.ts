import { http, HttpResponse } from 'msw';
import { createSimpleApiClient } from '../../src/api/client';
import * as scraperApi from '../../src/api/scraper';
import { MfcCookies } from '../../src/types';
import { server, installMswServer } from '../mocks/server';
import { syncStats, anMfcQueueStats, anMfcParsedItem } from '../mocks/builders';

// ─────────────────────────────────────────────────────────────────────────────
// Four-criteria completeness check (testing doctrine §6) for src/api/scraper.ts
//
// 1. Functional completeness — every exported function runs against MSW through
//    the real simple client: allowlist, cookie validation, full/CSV sync, CSV
//    parse, queue + sync status, job create/get/active/cancel, and session
//    control (list/resume/cancel-failed). Request bodies and the response-field
//    remaps (executeFullSync/syncFromCsv building MfcSyncResult) are asserted.
// 2. Boundary handling — the `success:false → throw(message)` guard on every
//    write path (both the success and the throw branch per function), the
//    `errors || []` default when the backend omits errors, and the
//    includeLists/skipCached defaulting in executeFullSync's request body.
// 3. Failure behavior — getSyncJob mapping a 404 to null but re-throwing other
//    statuses; getActiveJob swallowing any error to null; and a transport-level
//    network error propagating through executeFullSync.
// 4. Resilience — reconnection/recovery reads (getSyncJob, getActiveJob,
//    getSyncSessions) returning null / empty rather than throwing when there is
//    no active job, and malformed `success:false` envelopes failing loudly.
// ─────────────────────────────────────────────────────────────────────────────

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

  it('parseMfcCsv posts the csv content and returns parsed items', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/sync/parse-csv`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true, data: { items: [], stats: { owned: 0, ordered: 0, wished: 0, total: 0, nsfw: 0 } } });
      }),
    );
    expect((await scraperApi.parseMfcCsv(api, 'csv')).items).toEqual([]);
    expect(body).toEqual({ csvContent: 'csv' });
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

describe('scraper api — success paths that complete the guard branches', () => {
  it('validateMfcCookies throws when success is false', async () => {
    server.use(
      http.post(`${BASE}/sync/validate-cookies`, () => HttpResponse.json({ success: false, message: 'bad cookies' })),
    );
    await expect(scraperApi.validateMfcCookies(api, cookies)).rejects.toThrow('bad cookies');
  });

  it('executeFullSync applies request defaults and tolerates an omitted errors field', async () => {
    let body: any;
    server.use(
      http.post(`${BASE}/sync/full`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          success: true,
          data: { parsedCount: 3, queuedCount: 3, skippedCount: 0, stats: syncStats({ owned: 3, total: 3 }) },
        });
      }),
    );
    const res = await scraperApi.executeFullSync(api, { cookies, userId: 'u', sessionId: 's' });
    // defaults: includeLists ?? false, skipCached ?? true
    expect(body.includeLists).toBe(false);
    expect(body.skipCached).toBe(true);
    // `errors || []` right-hand default when the backend omits errors
    expect(res.errors).toEqual([]);
    expect(res.parsedCount).toBe(3);
  });

  it('executeFullSync forwards explicit options', async () => {
    let body: any;
    server.use(
      http.post(`${BASE}/sync/full`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          success: true,
          data: { parsedCount: 0, queuedCount: 0, skippedCount: 0, stats: syncStats(), errors: [] },
        });
      }),
    );
    await scraperApi.executeFullSync(api, {
      cookies,
      userId: 'u',
      sessionId: 's',
      includeLists: true,
      skipCached: false,
      statusFilter: ['owned', 'wished'],
    });
    expect(body.includeLists).toBe(true);
    expect(body.skipCached).toBe(false);
    expect(body.statusFilter).toEqual(['owned', 'wished']);
  });

  it('executeFullSync rejects on a transport-level network error', async () => {
    server.use(http.post(`${BASE}/sync/full`, () => HttpResponse.error()));
    await expect(scraperApi.executeFullSync(api, { cookies, userId: 'u', sessionId: 's' })).rejects.toThrow();
  });

  it('syncFromCsv posts the CSV payload, maps the result, and defaults errors', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/sync/from-csv`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          success: true,
          data: { parsedCount: 5, queuedCount: 4, skippedCount: 1, stats: syncStats({ owned: 4, total: 4 }) },
        });
      }),
    );
    const res = await scraperApi.syncFromCsv(api, { csvContent: 'a,b', userId: 'u', cookies, sessionId: 's' });
    expect(body).toEqual({ csvContent: 'a,b', userId: 'u', cookies, sessionId: 's' });
    expect(res).toMatchObject({ success: true, parsedCount: 5, queuedCount: 4, skippedCount: 1 });
    expect(res.errors).toEqual([]);
  });

  it('syncFromCsv throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/from-csv`, () => HttpResponse.json({ success: false, message: 'csv boom' })));
    await expect(scraperApi.syncFromCsv(api, { csvContent: 'x', userId: 'u' })).rejects.toThrow('csv boom');
  });

  it('parseMfcCsv throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/parse-csv`, () => HttpResponse.json({ success: false, message: 'parse boom' })));
    await expect(scraperApi.parseMfcCsv(api, 'csv')).rejects.toThrow('parse boom');
  });

  it('parseMfcCsv returns items and stats on success', async () => {
    server.use(
      http.post(`${BASE}/sync/parse-csv`, () =>
        HttpResponse.json({ success: true, data: { items: [anMfcParsedItem({ mfcId: 'm7' })], stats: syncStats({ total: 1, owned: 1 }) } }),
      ),
    );
    const res = await scraperApi.parseMfcCsv(api, 'csv');
    expect(res.items[0].mfcId).toBe('m7');
    expect(res.stats.total).toBe(1);
  });

  it('getQueueStats throws on success:false', async () => {
    server.use(http.get(`${BASE}/sync/queue-stats`, () => HttpResponse.json({ success: false, message: 'no queue' })));
    await expect(scraperApi.getQueueStats(api)).rejects.toThrow('no queue');
  });

  it('getSyncStatus returns queue stats and processing flag', async () => {
    server.use(
      http.get(`${BASE}/sync/status`, () =>
        HttpResponse.json({ success: true, data: { queueStats: anMfcQueueStats({ total: 2, processing: 1 }), isProcessing: true } }),
      ),
    );
    const res = await scraperApi.getSyncStatus(api);
    expect(res.isProcessing).toBe(true);
    expect(res.queueStats.total).toBe(2);
  });

  it('getSyncStatus throws on success:false', async () => {
    server.use(http.get(`${BASE}/sync/status`, () => HttpResponse.json({ success: false, message: 'status boom' })));
    await expect(scraperApi.getSyncStatus(api)).rejects.toThrow('status boom');
  });
});

describe('scraper api — sync job lifecycle', () => {
  it('createSyncJob posts the options and returns the full envelope', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/sync/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          success: true,
          job: { sessionId: 's1', phase: 'queued', message: 'ready' },
          webhookUrl: 'http://backend/webhook',
          webhookSecret: 'secret',
        });
      }),
    );
    const res = await scraperApi.createSyncJob(api, { sessionId: 's1', includeLists: true, statusFilter: ['owned'], skipCached: false });
    expect(body).toEqual({ sessionId: 's1', includeLists: true, statusFilter: ['owned'], skipCached: false });
    expect(res.webhookUrl).toBe('http://backend/webhook');
    expect(res.webhookSecret).toBe('secret');
    expect(res.job.sessionId).toBe('s1');
  });

  it('createSyncJob throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/job`, () => HttpResponse.json({ success: false, message: 'job boom' })));
    await expect(scraperApi.createSyncJob(api, { sessionId: 's1' })).rejects.toThrow('job boom');
  });

  it('getSyncJob returns null when the backend reports success:false', async () => {
    server.use(http.get(`${BASE}/sync/job/s1`, () => HttpResponse.json({ success: false })));
    expect(await scraperApi.getSyncJob(api, 's1')).toBeNull();
  });

  it('getSyncJob re-throws a non-404 error', async () => {
    server.use(http.get(`${BASE}/sync/job/s1`, () => new HttpResponse(null, { status: 500 })));
    await expect(scraperApi.getSyncJob(api, 's1')).rejects.toThrow();
  });

  it('getActiveJob returns null when there is no active job', async () => {
    server.use(http.get(`${BASE}/sync/active-job`, () => HttpResponse.json({ success: true, hasActiveJob: false })));
    expect(await scraperApi.getActiveJob(api)).toBeNull();
  });

  it('cancelSyncJob resolves when success is true', async () => {
    let hit = false;
    server.use(
      http.delete(`${BASE}/sync/job/s1`, () => {
        hit = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await expect(scraperApi.cancelSyncJob(api, 's1')).resolves.toBeUndefined();
    expect(hit).toBe(true);
  });
});

describe('scraper api — session control', () => {
  it('getSyncSessions returns the session summary', async () => {
    server.use(
      http.get(`${BASE}/sync/sessions`, () =>
        HttpResponse.json({
          success: true,
          data: {
            sessions: [{ sessionId: 's1', isPaused: true, inCooldown: false, consecutiveFailures: 2, failedMfcIds: ['m1'] }],
            count: 1,
            pausedCount: 1,
            inCooldownCount: 0,
          },
        }),
      ),
    );
    const res = await scraperApi.getSyncSessions(api);
    expect(res.count).toBe(1);
    expect(res.pausedCount).toBe(1);
    expect(res.sessions[0].sessionId).toBe('s1');
  });

  it('getSyncSessions throws on success:false', async () => {
    server.use(http.get(`${BASE}/sync/sessions`, () => HttpResponse.json({ success: false, message: 'sessions boom' })));
    await expect(scraperApi.getSyncSessions(api)).rejects.toThrow('sessions boom');
  });

  it('resumeSyncSession resolves when success is true', async () => {
    let hit = false;
    server.use(
      http.post(`${BASE}/sync/sessions/s1/resume`, () => {
        hit = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await expect(scraperApi.resumeSyncSession(api, 's1')).resolves.toBeUndefined();
    expect(hit).toBe(true);
  });

  it('cancelFailedItems throws on success:false', async () => {
    server.use(http.post(`${BASE}/sync/sessions/s1/cancel-failed`, () => HttpResponse.json({ success: false, message: 'cannot cancel' })));
    await expect(scraperApi.cancelFailedItems(api, 's1')).rejects.toThrow('cannot cancel');
  });
});

describe('scraper api — default error text when the backend omits a message', () => {
  // The write paths throw `new Error(response.data.message || '<default>')`. The
  // tests above cover the message-present branch; these pin the `|| default`
  // fallback (backend returns success:false with no message body) and assert the
  // exact user-facing default string per function.
  it('getMfcCookieAllowlist falls back to its default message', async () => {
    server.use(http.get(`${BASE}/sync/mfc/cookie-allowlist`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.getMfcCookieAllowlist(api)).rejects.toThrow('Failed to get cookie allowlist');
  });

  it('validateMfcCookies falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/validate-cookies`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.validateMfcCookies(api, cookies)).rejects.toThrow('Cookie validation failed');
  });

  it('executeFullSync falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/full`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.executeFullSync(api, { cookies, userId: 'u', sessionId: 's' })).rejects.toThrow('Full sync failed');
  });

  it('syncFromCsv falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/from-csv`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.syncFromCsv(api, { csvContent: 'x', userId: 'u' })).rejects.toThrow('CSV sync failed');
  });

  it('parseMfcCsv falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/parse-csv`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.parseMfcCsv(api, 'csv')).rejects.toThrow('CSV parsing failed');
  });

  it('getQueueStats falls back to its default message', async () => {
    server.use(http.get(`${BASE}/sync/queue-stats`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.getQueueStats(api)).rejects.toThrow('Failed to get queue stats');
  });

  it('getSyncStatus falls back to its default message', async () => {
    server.use(http.get(`${BASE}/sync/status`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.getSyncStatus(api)).rejects.toThrow('Failed to get sync status');
  });

  it('createSyncJob falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/job`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.createSyncJob(api, { sessionId: 's1' })).rejects.toThrow('Failed to create sync job');
  });

  it('cancelSyncJob falls back to its default message', async () => {
    server.use(http.delete(`${BASE}/sync/job/s1`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.cancelSyncJob(api, 's1')).rejects.toThrow('Failed to cancel sync job');
  });

  it('getSyncSessions falls back to its default message', async () => {
    server.use(http.get(`${BASE}/sync/sessions`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.getSyncSessions(api)).rejects.toThrow('Failed to get sync sessions');
  });

  it('resumeSyncSession falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/sessions/s1/resume`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.resumeSyncSession(api, 's1')).rejects.toThrow('Failed to resume session');
  });

  it('cancelFailedItems falls back to its default message', async () => {
    server.use(http.post(`${BASE}/sync/sessions/s1/cancel-failed`, () => HttpResponse.json({ success: false })));
    await expect(scraperApi.cancelFailedItems(api, 's1')).rejects.toThrow('Failed to cancel failed items');
  });
});
