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
  isTraceRoot,
  applyTraceIdentity,
} = require('../dist/nodes/AgentLangfuse/tracing');

const CREDS_A = { url: 'https://lf.example.com', publicKey: 'pk-a', secretKey: 'sk-a' };
const CREDS_B = { url: 'https://lf.example.com', publicKey: 'pk-b', secretKey: 'sk-b' };

function fakeSpan(traceId) {
  return { spanContext: () => ({ traceId, spanId: 'ffffffffffffffff' }) };
}

function fakeProcessor() {
  const seen = { started: [], ended: [], flushes: 0, shutdowns: 0 };
  return {
    seen,
    onStart: (span) => seen.started.push(span.spanContext().traceId),
    onEnd: (span) => seen.ended.push(span.spanContext().traceId),
    forceFlush: async () => { seen.flushes += 1; },
    shutdown: async () => { seen.shutdowns += 1; },
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

  const route = { fingerprint: credentialFingerprint(CREDS_A), identity: {}, traceIds: new Set() };

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

test('only the root span of a trace carries the session and user identity', async () => {
  const processor = fakeProcessor();
  const router = new RoutingSpanProcessor(() => processor);
  router.ensure(CREDS_A);

  // Langfuse reads session.id and user.id off the root span of the trace. Its
  // own propagateAttributes writes them to the active OpenTelemetry span, which
  // does not exist unless a global context manager is registered, so the node
  // writes them itself.
  const attributes = new Map();
  const root = {
    ...fakeSpan('trace-identity'),
    setAttribute: (key, value) => attributes.set(key, value),
  };
  const child = {
    ...fakeSpan('trace-identity'),
    parentSpanContext: { spanId: 'aaaaaaaaaaaaaaaa' },
    setAttribute: (key, value) => attributes.set('CHILD:' + key, value),
  };

  assert.equal(isTraceRoot(root), true);
  assert.equal(isTraceRoot(child), false);

  await runWithRouteForTests(
    router,
    CREDS_A,
    async () => {
      router.onStart(root, {});
      router.onStart(child, {});
    },
    new Set(),
    { sessionId: 'sess-1', userId: 'user-1' },
  );

  assert.equal(attributes.get('session.id'), 'sess-1');
  assert.equal(attributes.get('user.id'), 'user-1');
  assert.equal([...attributes.keys()].some((k) => k.startsWith('CHILD:')), false);
});

test('an absent session or user id writes no attribute at all', () => {
  const attributes = new Map();
  const span = { setAttribute: (key, value) => attributes.set(key, value) };

  applyTraceIdentity(span, {});
  assert.equal(attributes.size, 0, 'undefined identity must not write empty attributes');

  applyTraceIdentity(span, { userId: 'user-only' });
  assert.deepEqual([...attributes.entries()], [['user.id', 'user-only']]);
});

// --------------------------------------------------------------------------
// shutdown: OpenTelemetry's SpanProcessor contract
// --------------------------------------------------------------------------

test('shutdown reaches every processor exactly once', async () => {
  const built = [];
  const router = new RoutingSpanProcessor(() => {
    const p = fakeProcessor();
    built.push(p);
    return p;
  });
  router.ensure(CREDS_A);
  router.ensure(CREDS_B);

  await router.shutdown();

  assert.equal(built.length, 2);
  for (const p of built) assert.equal(p.seen.shutdowns, 1);
});

test('a shut down router hands no further spans to its dead processors', async () => {
  // A processor that has been shut down rejects its exporter's writes. Handing
  // it a span after shutdown loses the span and, with Langfuse, logs an error
  // per span for the rest of the process's life. An execution still in flight
  // when shutdown ran is exactly how such a span arrives.
  const built = [];
  const router = new RoutingSpanProcessor(() => {
    const p = fakeProcessor();
    built.push(p);
    return p;
  });
  await runWithRouteForTests(router, CREDS_A, async () => {
    router.onStart(fakeSpan('trace-1'), {});
  });

  await router.shutdown();

  router.onEnd(fakeSpan('trace-1'));
  await runWithRouteForTests(router, CREDS_A, async () => {
    router.onStart(fakeSpan('trace-2'), {});
    router.onEnd(fakeSpan('trace-2'));
  });

  assert.deepEqual(built[0].seen.started, ['trace-1'], 'no span may start on a dead processor');
  assert.deepEqual(built[0].seen.ended, [], 'no span may end on a dead processor');
});

test('a second shutdown awaits the first one draining', async () => {
  // Resolving early, while the exporters are still emptying, loses whatever
  // they had buffered.
  let releaseDrain;
  const drained = new Promise((resolve) => {
    releaseDrain = resolve;
  });
  const processor = { ...fakeProcessor(), shutdown: () => drained };
  const router = new RoutingSpanProcessor(() => processor);
  router.ensure(CREDS_A);

  const first = router.shutdown();
  const second = router.shutdown();

  let secondResolved = false;
  void second.then(() => {
    secondResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false, 'the second shutdown resolved before the drain finished');

  releaseDrain();
  await Promise.all([first, second]);
  assert.equal(secondResolved, true);
});

test('a shut down router builds no new processors', async () => {
  // Otherwise ensure() would revive the router with a processor that nothing
  // will ever shut down.
  let built = 0;
  const router = new RoutingSpanProcessor(() => {
    built += 1;
    return fakeProcessor();
  });

  await router.shutdown();
  router.ensure(CREDS_A);

  assert.equal(built, 0);
});
