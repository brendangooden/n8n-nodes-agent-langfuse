import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider } from '@langfuse/tracing';

import { resolveBaseUrl } from './langfuse';
import type { LangfuseCredentials } from './types';

/** Trace level fields Langfuse reads from the root span of a trace. */
export interface TraceIdentity {
  sessionId?: string;
  userId?: string;
}

interface TraceRoute {
  fingerprint: string;
  identity: TraceIdentity;
  traceIds: Set<string>;
}

// The route cannot travel in the OpenTelemetry context: ambient context only
// propagates when a global context manager is registered, and n8n registers one
// only while its `otel` module is enabled.
const routeStorage = new AsyncLocalStorage<TraceRoute>();

export function credentialFingerprint(credentials: LangfuseCredentials): string {
  return `${credentials.publicKey}@${resolveBaseUrl(credentials)}`;
}

/** A span with no parent starts a new trace. OTel 2.x renamed `parentSpanId`. */
export function isTraceRoot(span: Span | ReadableSpan): boolean {
  const s = span as { parentSpanContext?: unknown; parentSpanId?: unknown };
  return !s.parentSpanContext && !s.parentSpanId;
}

/**
 * Writes `sessionId` and `userId` onto the root span of a trace.
 *
 * Langfuse's own `propagateAttributes` would do this, but it writes to
 * `trace.getActiveSpan()`, which is undefined unless a global OpenTelemetry
 * context manager is registered. n8n registers one only while its `otel` module
 * is enabled, and this package will not install process wide OpenTelemetry
 * globals to work around that. The attribute keys are public API.
 */
export function applyTraceIdentity(span: Span, identity: TraceIdentity): void {
  if (identity.sessionId) {
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, identity.sessionId);
  }
  if (identity.userId) {
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, identity.userId);
  }
}

/**
 * Hands each span to the processor of the credential that raised it.
 *
 * OpenTelemetry delivers every span to every processor in the provider's list,
 * and Langfuse's own filter accepts any Langfuse span regardless of project. A
 * second credential would therefore see the first credential's prompts and
 * outputs. Routing here means the processor of project B never receives a span
 * belonging to project A.
 *
 * A single instance is given to the provider's constructor because OTel 2.x
 * removed `addSpanProcessor`.
 */
export class RoutingSpanProcessor implements SpanProcessor {
  private readonly processors = new Map<string, SpanProcessor>();
  private readonly routes = new Map<string, string>();

  constructor(
    private readonly createProcessor: (credentials: LangfuseCredentials) => SpanProcessor,
  ) {}

  ensure(credentials: LangfuseCredentials): string {
    const fingerprint = credentialFingerprint(credentials);
    if (!this.processors.has(fingerprint)) {
      this.processors.set(fingerprint, this.createProcessor(credentials));
    }
    return fingerprint;
  }

  onStart(span: Span, parentContext: Context): void {
    const route = routeStorage.getStore();
    if (!route) return;
    const { traceId } = span.spanContext();
    this.routes.set(traceId, route.fingerprint);
    route.traceIds.add(traceId);
    if (isTraceRoot(span)) applyTraceIdentity(span, route.identity);
    this.processors.get(route.fingerprint)?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const fingerprint = this.routes.get(span.spanContext().traceId);
    // An unrouted span belongs to no known credential. Dropping it is the safe
    // option; the alternative is exporting it to an arbitrary project.
    if (!fingerprint) return;
    this.processors.get(fingerprint)?.onEnd(span);
  }

  release(traceIds: Set<string>): void {
    for (const traceId of traceIds) this.routes.delete(traceId);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.processors.values()].map((p) => p.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.processors.values()].map((p) => p.shutdown()));
  }
}

let provider: BasicTracerProvider | undefined;
let router: RoutingSpanProcessor | undefined;

function ensureProvider(): { provider: BasicTracerProvider; router: RoutingSpanProcessor } {
  if (!provider || !router) {
    router = new RoutingSpanProcessor(
      (credentials) =>
        new LangfuseSpanProcessor({
          publicKey: credentials.publicKey,
          secretKey: credentials.secretKey,
          baseUrl: resolveBaseUrl(credentials),
        }),
    );
    provider = new BasicTracerProvider({ spanProcessors: [router] });
    // An isolated provider, not the global one. n8n registers its own tracer
    // provider when its `otel` module is on, and overwriting it would divert
    // n8n's traces into Langfuse.
    setLangfuseTracerProvider(provider);
  }
  return { provider, router };
}

interface FlushableProvider {
  forceFlush(): Promise<void>;
}

async function runTraced<T>(
  provider: FlushableProvider,
  activeRouter: RoutingSpanProcessor,
  route: TraceRoute,
  fn: () => Promise<T>,
  onFlushError?: (error: Error) => void,
): Promise<T> {
  try {
    return await routeStorage.run(route, fn);
  } finally {
    try {
      await provider.forceFlush();
    } catch (error) {
      // A reporter that throws must not take the execution down with it, nor
      // skip the cleanup below. A stale route would outlive its execution and
      // could attribute a later span to the wrong project.
      try {
        onFlushError?.(error as Error);
      } catch {
        // ignore
      }
    } finally {
      activeRouter.release(route.traceIds);
    }
  }
}

/**
 * Runs `fn` with every span it raises attributed to `credentials`, then flushes.
 *
 * Tracing is observability, not the node's job: a failing flush warns and the
 * execution continues.
 */
export async function withTracing<T>(
  credentials: LangfuseCredentials,
  identity: TraceIdentity,
  fn: () => Promise<T>,
  onFlushError?: (error: Error) => void,
): Promise<T> {
  const { provider: activeProvider, router: activeRouter } = ensureProvider();
  const fingerprint = activeRouter.ensure(credentials);
  const route: TraceRoute = { fingerprint, identity, traceIds: new Set() };
  return runTraced(activeProvider, activeRouter, route, fn, onFlushError);
}

// Test seams. Not part of the node's runtime path.
export function resetTracingForTests(): void {
  provider = undefined;
  router = undefined;
}

export async function runWithRouteForTests<T>(
  activeRouter: RoutingSpanProcessor,
  credentials: LangfuseCredentials,
  fn: () => Promise<T>,
  traceIds: Set<string> = new Set(),
  identity: TraceIdentity = {},
): Promise<T> {
  const fingerprint = activeRouter.ensure(credentials);
  return routeStorage.run({ fingerprint, identity, traceIds }, fn);
}

// Exposed so the flush-error and cleanup path can be driven with a fake
// provider whose forceFlush() rejects on demand. The real provider is a
// BasicTracerProvider backed by real LangfuseSpanProcessors, which a test
// cannot make fail on cue.
export const runTracedForTests = runTraced;
