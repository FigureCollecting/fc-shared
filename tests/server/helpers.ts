/**
 * Shared fixtures for the node-only ./server/* tests.
 *
 * validateLine compiles the PUBLISHED schema file, not a copy of it, so a
 * consumer's contract test and these tests can never disagree about the shape.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { ROOT_CONTEXT, context, trace } from '@opentelemetry/api';

export const PKG_ROOT = resolve(__dirname, '..', '..');
export const SCHEMA_PATH = join(PKG_ROOT, 'schema', 'log-shape.schema.json');

export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const SPAN_ID = '00f067aa0ba902b7';
export const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

export type LogLine = Record<string, unknown>;

let compiled: ((data: unknown) => boolean) & { errors?: unknown } | undefined;

function validator(): ((data: unknown) => boolean) & { errors?: unknown } {
  if (compiled === undefined) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
    // Strict, with two standard JSON Schema idioms allowed: if/then `required` on
    // keys the subschema does not redeclare, and a union type for extra values.
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/** The schema verdict for one parsed line, with Ajv's errors when it fails. */
export function checkLine(line: unknown): { valid: boolean; errors: unknown } {
  const validate = validator();
  const valid = validate(line);
  return { valid, errors: valid ? null : validate.errors };
}

/** Assert a parsed line satisfies the published schema; show why when it does not. */
export function expectValidLine(line: unknown): void {
  expect({ line, ...checkLine(line) }).toEqual({ line, valid: true, errors: null });
}

/** A sink that keeps every raw line, plus the lines parsed as JSON. */
export function captureSink(): { lines: string[]; sink: (line: string) => void; parsed: () => LogLine[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
    parsed: () => lines.map((line) => JSON.parse(line) as LogLine),
  };
}

/** Run fn with a fixed, valid remote span active (needs a context manager registered). */
export function withRemoteSpan<T>(fn: () => T, traceId = TRACE_ID, spanId = SPAN_ID): T {
  const span = trace.wrapSpanContext({ traceId, spanId, traceFlags: 1, isRemote: true });
  return context.with(trace.setSpan(ROOT_CONTEXT, span), fn);
}
