/**
 * Span-attribute redaction before export (lg-logging review, SHOULD: "url.full
 * and http.url span attributes will carry raw query strings" such as signed
 * image URLs). The query, fragment and userinfo never leave the process; the
 * shared key/value secret policy still runs on everything else.
 */
import { SpanKind, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import {
  DROPPED_ATTRIBUTE_KEYS,
  DROPPED_ATTRIBUTE_PREFIXES,
  RedactingSpanExporter,
  URL_ATTRIBUTE_KEYS,
  redactSpanAttributes,
  stripUrl,
} from '../../src/server/tracing';

describe('stripUrl', () => {
  it.each([
    ['https://img.store.example/a/b.jpg?sig=abc&exp=1#frag', 'https://img.store.example/a/b.jpg'],
    ['https://user:pass@host.example:8443/x?y=1', 'https://host.example:8443/x'],
    ['http://scraper.fc.svc:3050/ingest/scrape', 'http://scraper.fc.svc:3050/ingest/scrape'],
    ['postgresql://app:secret@pg-spine-rw.data.svc:5432/spine?sslmode=require', 'postgresql://pg-spine-rw.data.svc:5432/spine'],
    ['/ingest/scrape?token=1', '/ingest/scrape'],
    ['/path#only-fragment', '/path'],
    ['not a url?x=1', 'not a url'],
    ['http://exa mple/?token=1', 'http://exa mple/'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(stripUrl(input)).toBe(expected);
  });
});

describe('redactSpanAttributes', () => {
  it('strips queries from every URL-bearing key, drops url.query and every header, and keeps the rest', () => {
    const input: Attributes = {
      'url.full': 'https://cdn.store.example/i.jpg?X-Amz-Signature=deadbeef',
      'http.url': 'http://old.semconv.example/p?session=1',
      'http.target': '/p?session=1',
      'url.original': 'https://o.example/?q=1',
      'db.connection_string': 'postgresql://u:p@h/db?x=1',
      'url.query': '?X-Amz-Signature=deadbeef',
      'url.path': '/i.jpg',
      'http.request.header.authorization': 'Bearer abcdefghijklmnop',
      'http.request.header.referer': ['https://x.example/a?sig=SECRET'],
      'http.request.header.x-client-ip': ['203.0.113.7'],
      'http.response.header.location': ['https://cdn.example/o?X-Amz-Signature=SECRET'],
      'http.request.method': 'GET',
      'fc.http.request.header.note': 'kept: not a header attribute',
      'fc.note': 'token in text Bearer abcdefghijklmnop',
      'http.response.status_code': 200,
      'fc.flags': ['a?b', 'Bearer abcdefghijklmnop'],
    };
    const out = redactSpanAttributes(input);
    expect(out).toEqual({
      'url.full': 'https://cdn.store.example/i.jpg',
      'http.url': 'http://old.semconv.example/p',
      'http.target': '/p',
      'url.original': 'https://o.example/',
      'db.connection_string': 'postgresql://h/db',
      'url.path': '/i.jpg',
      'http.request.method': 'GET',
      'fc.http.request.header.note': 'kept: not a header attribute',
      'fc.note': 'token in text [REDACTED]',
      'http.response.status_code': 200,
      'fc.flags': ['a?b', '[REDACTED]'],
    });
    expect(input['url.query']).toBe('?X-Amz-Signature=deadbeef');
  });

  it('leaves a non-string URL attribute alone rather than inventing a value', () => {
    expect(redactSpanAttributes({ 'url.full': 42 })).toEqual({ 'url.full': 42 });
  });

  it('publishes its key lists', () => {
    expect(URL_ATTRIBUTE_KEYS).toEqual(
      expect.arrayContaining(['url.full', 'http.url', 'http.target', 'url.original', 'db.connection_string']),
    );
    expect(DROPPED_ATTRIBUTE_KEYS).toEqual(['url.query']);
    expect(DROPPED_ATTRIBUTE_PREFIXES).toEqual(['http.request.header.', 'http.response.header.']);
  });
});

describe('RedactingSpanExporter', () => {
  function fakeSpan(): ReadableSpan {
    return {
      name: 'GET',
      kind: SpanKind.CLIENT,
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      startTime: [1, 0],
      endTime: [2, 0],
      status: { code: SpanStatusCode.UNSET },
      attributes: { 'url.full': 'https://cdn.example/x?sig=1', 'url.query': '?sig=1' },
      links: [{ context: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: 1 }, attributes: { 'url.full': 'https://l.example/?a=1' } }],
      events: [{ name: 'exception', time: [1, 5], attributes: { 'exception.message': 'Bearer abcdefghijklmnop' } }],
      duration: [1, 0],
      ended: true,
      resource: {} as ReadableSpan['resource'],
      instrumentationScope: { name: 'test' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
  }

  it('hands the delegate redacted attributes, links and events and never mutates the original', async () => {
    const delegate = new InMemorySpanExporter();
    const exporter = new RedactingSpanExporter(delegate);
    const original = fakeSpan();
    const result = await new Promise<ExportResult>((resolve) => exporter.export([original], resolve));

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const [sent] = delegate.getFinishedSpans();
    expect(sent.attributes).toEqual({ 'url.full': 'https://cdn.example/x' });
    expect(sent.links[0].attributes).toEqual({ 'url.full': 'https://l.example/' });
    expect(sent.events[0].attributes).toEqual({ 'exception.message': '[REDACTED]' });
    expect(sent.name).toBe('GET');
    expect(sent.duration).toEqual([1, 0]);
    expect(sent.spanContext().spanId).toBe('b'.repeat(16));
    expect(original.attributes['url.query']).toBe('?sig=1');
  });

  it('passes links and events without attributes through untouched', async () => {
    const delegate = new InMemorySpanExporter();
    const span = fakeSpan();
    (span as { links: unknown[] }).links = [{ context: span.spanContext() }];
    (span as { events: unknown[] }).events = [{ name: 'mark', time: [1, 0] }];
    await new Promise<ExportResult>((resolve) => new RedactingSpanExporter(delegate).export([span], resolve));
    const [sent] = delegate.getFinishedSpans();
    expect(sent.links[0].attributes).toBeUndefined();
    expect(sent.events[0].attributes).toBeUndefined();
  });

  it('delegates shutdown and forceFlush, tolerating a delegate without forceFlush', async () => {
    const calls: string[] = [];
    const full = new RedactingSpanExporter({
      export: (_spans, cb) => cb({ code: ExportResultCode.SUCCESS }),
      shutdown: async () => {
        calls.push('shutdown');
      },
      forceFlush: async () => {
        calls.push('flush');
      },
    });
    await full.forceFlush();
    await full.shutdown();
    expect(calls).toEqual(['flush', 'shutdown']);

    const bare = new RedactingSpanExporter({
      export: (_spans, cb) => cb({ code: ExportResultCode.SUCCESS }),
      shutdown: async () => undefined,
    });
    await expect(bare.forceFlush()).resolves.toBeUndefined();
  });
});
