// Runs against the compiled output: `npm run build` first (npm test does both).
//
// The invariant under test is isolation: a span produced under credential A
// must never be handed to the processor of credential B. OpenTelemetry gives
// every span to every processor, so this routing is the only thing standing
// between two Langfuse projects.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  credentialFingerprint,
  RoutingSpanProcessor,
  resetTracingForTests,
  runWithRouteForTests,
  runTracedForTests,
} = require('../dist/nodes/AgentLangfuse/tracing');

const CREDS_A = { url: 'https://lf.example.com', publicKey: 'pk-a', secretKey: 'sk-a' };
const CREDS_B = { url: 'https://lf.example.com', publicKey: 'pk-b', secretKey: 'sk-b' };

function fakeSpan(traceId) {
  return { spanContext: () => ({ traceId, spanId: 'ffffffffffffffff' }) };
}

function fakeProcessor() {
  const seen = { started: [], ended: [], flushes: 0 };
  return {
    seen,
    onStart: (span) => seen.started.push(span.spanContext().traceId),
    onEnd: (span) => seen.ended.push(span.spanContext().traceId),
    forceFlush: async () => { seen.flushes += 1; },
    shutdown: async () => {},
  };
}

beforeEach(() => resetTracingForTests());

test('the fingerprint separates public keys and base urls', () => {
  assert.notEqual(credentialFingerprint(CREDS_A), credentialFingerprint(CREDS_B));
  assert.notEqual(
    credentialFingerprint(CREDS_A),
    credentialFingerprint({ ...CREDS_A, url: 'https://other.example.com' }),
  );
  assert.equal(credentialFingerprint(CREDS_A), credentialFingerprint({ ...CREDS_A }));
});

test('one processor per credential, created once', () => {
  const built = [];
  const router = new RoutingSpanProcessor((creds) => {
    built.push(creds.publicKey);
    return fakeProcessor();
  });

  router.ensure(CREDS_A);
  router.ensure(CREDS_A);
  router.ensure(CREDS_B);

  assert.deepEqual(built, ['pk-a', 'pk-b']);
});

test('a span raised under credential A never reaches the processor of B', async () => {
  const processors = new Map();
  const router = new RoutingSpanProcessor((creds) => {
    const p = fakeProcessor();
    processors.set(creds.publicKey, p);
    return p;
  });
  router.ensure(CREDS_A);
  router.ensure(CREDS_B);

  await runWithRouteForTests(router, CREDS_A, async () => {
    router.onStart(fakeSpan('trace-a'), {});
  });
  await runWithRouteForTests(router, CREDS_B, async () => {
    router.onStart(fakeSpan('trace-b'), {});
  });

  router.onEnd(fakeSpan('trace-a'));
  router.onEnd(fakeSpan('trace-b'));

  assert.deepEqual(processors.get('pk-a').seen.ended, ['trace-a']);
  assert.deepEqual(processors.get('pk-b').seen.ended, ['trace-b']);
});

test('a span with no route is dropped rather than guessed', () => {
  const p = fakeProcessor();
  const router = new RoutingSpanProcessor(() => p);
  router.ensure(CREDS_A);

  // onStart outside any withTracing scope, and onEnd for an unknown traceId.
  router.onStart(fakeSpan('orphan'), {});
  router.onEnd(fakeSpan('orphan'));

  assert.deepEqual(p.seen.started, []);
  assert.deepEqual(p.seen.ended, []);
});

test('release forgets the traces of a finished execution', async () => {
  const p = fakeProcessor();
  const router = new RoutingSpanProcessor(() => p);
  router.ensure(CREDS_A);

  const traceIds = new Set();
  await runWithRouteForTests(router, CREDS_A, async () => {
    router.onStart(fakeSpan('trace-x'), {});
  }, traceIds);

  router.release(traceIds);
  router.onEnd(fakeSpan('trace-x'));

  assert.deepEqual(p.seen.ended, [], 'a released trace must no longer route');
});

test('forceFlush flushes every credential', async () => {
  const processors = [];
  const router = new RoutingSpanProcessor(() => {
    const p = fakeProcessor();
    processors.push(p);
    return p;
  });
  router.ensure(CREDS_A);
  router.ensure(CREDS_B);

  await router.forceFlush();

  assert.deepEqual(processors.map((p) => p.seen.flushes), [1, 1]);
});

test('a throwing flush reporter cannot prevent trace routes from being released', async () => {
  const processor = fakeProcessor();
  const router = new RoutingSpanProcessor(() => processor);
  router.ensure(CREDS_A);

  // Both the flush and the reporter fail. Tracing is observability: neither may
  // fail the execution, and neither may skip the cleanup.
  const provider = {
    forceFlush: async () => {
      throw new Error('flush failed');
    },
  };
  let reported = false;
  const onFlushError = () => {
    reported = true;
    throw new Error('reporter exploded');
  };

  const route = { fingerprint: credentialFingerprint(CREDS_A), traceIds: new Set() };

  const result = await runTracedForTests(
    provider,
    router,
    route,
    async () => {
      router.onStart(fakeSpan('trace-boom'), {});
      return 'the execution result';
    },
    onFlushError,
  );

  assert.equal(result, 'the execution result', 'a tracing failure must not fail the execution');
  assert.ok(reported, 'the flush error should have been reported');

  router.onEnd(fakeSpan('trace-boom'));
  assert.deepEqual(processor.seen.ended, [], 'the route must have been released');
});
