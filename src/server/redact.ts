/**
 * Span-attribute redaction applied just before export.
 *
 * Auto-instrumentation stamps full URLs onto client and server spans: url.full
 * (undici, http), url.query (undici), and the older http.url / http.target.
 * Store image URLs are often SIGNED (X-Amz-Signature, exp, token), and a
 * connection string may carry a password. So before a span leaves the process:
 *   - every URL-bearing attribute loses its query, fragment and userinfo;
 *   - url.query is dropped outright (it is nothing but the query), and so is
 *     every http.request.header.* and http.response.header.* attribute (a
 *     Referer or Location carries a signed URL, a client IP is personal data);
 *   - then fc-shared's redactAttributes policy runs as for any attribute.
 * Links and events get the same treatment. The original span is never mutated.
 */
import type { Attributes, Link } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace';
import { redactAttributes, type AttributeValue, type RedactOptions } from '../utils/sanitize';

/** Attributes whose value is a URL (or URL-like target) to strip. */
export const URL_ATTRIBUTE_KEYS: readonly string[] = [
  'url.full',
  'url.original',
  'http.url',
  'http.target',
  'db.connection_string',
];

/** Attributes removed entirely: they hold only a query string. */
export const DROPPED_ATTRIBUTE_KEYS: readonly string[] = ['url.query'];

/** Attribute-name prefixes removed entirely: captured request and response headers. */
export const DROPPED_ATTRIBUTE_PREFIXES: readonly string[] = ['http.request.header.', 'http.response.header.'];

function isDropped(key: string): boolean {
  return DROPPED_ATTRIBUTE_KEYS.includes(key) || DROPPED_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Remove query, fragment and userinfo from a URL. A relative target
 * ('/path?x') or an unparseable value is cut at the first '?' or '#'.
 */
export function stripUrl(value: string): string {
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // fall through to the plain cut
    }
  }
  return value.split(/[?#]/)[0];
}

/** URL stripping, url.query and header removal, then the shared secret/PII policy. */
export function redactSpanAttributes(attributes: Attributes, options: RedactOptions = {}): Attributes {
  const stripped: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isDropped(key)) continue;
    stripped[key] = URL_ATTRIBUTE_KEYS.includes(key) && typeof value === 'string' ? stripUrl(value) : value;
  }
  // The shared policy maps strings to strings and passes other scalars through,
  // so an OTel attribute record in is an OTel attribute record out.
  return redactAttributes(stripped as Record<string, AttributeValue>, options) as Attributes;
}

function redactLink(link: Link, options: RedactOptions): Link {
  return link.attributes === undefined ? link : { ...link, attributes: redactSpanAttributes(link.attributes, options) };
}

function redactEvent(event: TimedEvent, options: RedactOptions): TimedEvent {
  return event.attributes === undefined ? event : { ...event, attributes: redactSpanAttributes(event.attributes, options) };
}

/**
 * A view of the span with redacted attributes, links and events. Object.create
 * keeps the real span as the prototype, so the SDK's getter-backed fields
 * (duration, ended, status, resource) survive; a spread would drop them.
 */
function redactSpan(span: ReadableSpan, options: RedactOptions): ReadableSpan {
  return Object.create(span as object, {
    attributes: { value: redactSpanAttributes(span.attributes, options), enumerable: true },
    links: { value: span.links.map((link) => redactLink(link, options)), enumerable: true },
    events: { value: span.events.map((event) => redactEvent(event, options)), enumerable: true },
  }) as ReadableSpan;
}

/** Wraps the real exporter so nothing unredacted is ever handed to it. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly options: RedactOptions = {},
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(
      spans.map((span) => redactSpan(span, this.options)),
      resultCallback,
    );
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}
