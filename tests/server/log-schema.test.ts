/**
 * The published log-shape schema is the contract consumers' own tests import.
 * These cases pin what it accepts (the plan's own examples, verbatim) and what
 * it must refuse, so a loosened schema fails here before it fails a consumer.
 */
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, SPAN_ID, TRACE_ID, checkLine, expectValidLine } from './helpers';

const EXAMPLE_RPC_IN = {
  time: '2026-09-30T01:02:03.456Z',
  level: 'info',
  service: 'ingest-server',
  version: '1.9.0',
  event: 'rpc.in',
  msg: '',
  call: 'ingest.v1.SpineIngest/Ingest',
  code: 'ok',
  duration_ms: 41.2,
  peer: 'scraper.fc.serviceaccount.identity.linkerd.app.mesh.estate',
  trace_id: TRACE_ID,
  span_id: SPAN_ID,
  site: 'orzgk',
  claims: 23,
};

const EXAMPLE_JOB_END = {
  time: '2026-09-30T01:13:14.000Z',
  level: 'info',
  service: 'ingest-crawler',
  version: '2.2.0',
  event: 'job.end',
  msg: 'pass finished',
  code: 'ok',
  duration_ms: 671000,
  job: 'ingest-crawler-29312345',
  trace_id: TRACE_ID,
  span_id: SPAN_ID,
  stores: 27,
  enqueued: 412,
};

describe('log-shape.schema.json', () => {
  it('is a draft 2020-12 schema with a stable $id', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toMatch(/log-shape\.schema\.json$/);
  });

  it('accepts the plan examples verbatim', () => {
    expectValidLine(EXAMPLE_RPC_IN);
    expectValidLine(EXAMPLE_JOB_END);
  });

  it('accepts err, queue_ms and a line with no span', () => {
    const { trace_id: _t, span_id: _s, ...noSpan } = EXAMPLE_RPC_IN;
    expectValidLine({ ...noSpan, level: 'error', code: 'internal', err: { type: 'Error', message: 'x' }, queue_ms: 3 });
  });

  it('accepts item.coalesced with the winner\'s trace id, and app.enrichment (plan-v2 U1 scope)', () => {
    const winner = 'c'.repeat(32);
    expectValidLine({ ...EXAMPLE_JOB_END, event: 'item.coalesced', winner_trace_id: winner });
    // The winner's trace id is optional: the first enqueue may have carried no traceparent.
    expectValidLine({ ...EXAMPLE_JOB_END, event: 'item.coalesced' });
    expectValidLine({ ...EXAMPLE_JOB_END, event: 'app.enrichment', winner_trace_id: winner });
  });

  const rejects: Array<[string, Record<string, unknown>]> = [
    ['a winner_trace_id that is not a trace id', { ...EXAMPLE_JOB_END, event: 'app.log', winner_trace_id: 'not-a-trace-id' }],
    ['a zeroed winner_trace_id', { ...EXAMPLE_JOB_END, event: 'app.log', winner_trace_id: '0'.repeat(32) }],
    ['an uppercase winner_trace_id', { ...EXAMPLE_JOB_END, event: 'app.log', winner_trace_id: TRACE_ID.toUpperCase() }],
    ['a query string in call', { ...EXAMPLE_RPC_IN, call: 'POST /ingest/scrape?token=1' }],
    ['a zeroed trace_id', { ...EXAMPLE_RPC_IN, trace_id: '0'.repeat(32) }],
    ['a zeroed span_id', { ...EXAMPLE_RPC_IN, span_id: '0'.repeat(16) }],
    ['trace_id without span_id', (({ span_id: _s, ...rest }) => rest)(EXAMPLE_RPC_IN)],
    ['uppercase hex ids', { ...EXAMPLE_RPC_IN, trace_id: TRACE_ID.toUpperCase() }],
    ['rpc.in without peer', (({ peer: _p, ...rest }) => rest)(EXAMPLE_RPC_IN)],
    ['rpc.in without call', (({ call: _c, ...rest }) => rest)(EXAMPLE_RPC_IN)],
    ['http.in without duration_ms', (({ duration_ms: _d, ...rest }) => rest)({ ...EXAMPLE_RPC_IN, event: 'http.in' })],
    ['job.end without code', (({ code: _c, ...rest }) => rest)(EXAMPLE_JOB_END)],
    ['item.process without duration_ms', { ...EXAMPLE_JOB_END, event: 'item.process', duration_ms: undefined }],
    ['an unknown event', { ...EXAMPLE_RPC_IN, event: 'request' }],
    ['an uppercase app event', { ...EXAMPLE_RPC_IN, event: 'app.Console' }],
    ['a pino numeric level', { ...EXAMPLE_RPC_IN, level: 30 }],
    ['a non-contract level', { ...EXAMPLE_RPC_IN, level: 'verbose' }],
    ['a time without milliseconds', { ...EXAMPLE_RPC_IN, time: '2026-09-30T01:02:03Z' }],
    ['a numeric code', { ...EXAMPLE_RPC_IN, code: 202 }],
    ['a camelCase extra key', { ...EXAMPLE_RPC_IN, itemId: 'x' }],
    ['a nested extra value', { ...EXAMPLE_RPC_IN, detail: { a: 1 } }],
    ['an err without message', { ...EXAMPLE_RPC_IN, err: { type: 'Error' } }],
    ['a missing msg', (({ msg: _m, ...rest }) => rest)(EXAMPLE_RPC_IN)],
    ['an empty service', { ...EXAMPLE_RPC_IN, service: '' }],
  ];

  it.each(rejects)('rejects %s', (_label, line) => {
    const cleaned = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    expect(checkLine(cleaned).valid).toBe(false);
  });
});
