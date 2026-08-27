/**
 * Live smoke test against a running TrueForge harness.
 *
 * The type-level contract lives in packages/harness/src/pending.test.ts and runs
 * in CI without credentials. This script is the other half: it proves the
 * harness is actually reachable, a model is configured, and a turn streams to
 * completion with the event types we expect.
 *
 *   pnpm run smoke
 *
 * Requires a harness on TRUEFORGE_BASE_URL and at least one model provider
 * configured inside it. See docs/runbook.md.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';

const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const MODEL = process.env.TRUEFORGE_SMOKE_MODEL;
const TOKEN = process.env.TRUEFORGE_TOKEN;

/** Event types the rest of the project is built on. */
const EXPECTED_EVENTS = ['turn.created', 'model.message.delta', 'turn.done'] as const;

function fail(message: string, hint?: string): never {
  console.error(`\n  FAIL  ${message}`);
  if (hint !== undefined) console.error(`        ${hint}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`  ok    ${message}`);
}

async function main(): Promise<void> {
  console.log(`\nTrueForge smoke test → ${BASE_URL}\n`);

  const client = new TrueForge({
    baseUrl: BASE_URL,
    timeoutInSeconds: 120,
    ...(TOKEN !== undefined && TOKEN !== '' ? { token: TOKEN } : {}),
  });

  // 1. Reachability. Distinguishes "harness is down" from every other failure.
  try {
    await client.server.getCapabilities();
    ok('harness reachable');
  } catch (error) {
    fail(
      `cannot reach the harness: ${error instanceof Error ? error.message : String(error)}`,
      'Start it with: npx @truefoundry/trueforge@latest',
    );
  }

  // 2. A model must be configured inside the harness, not just in our .env.
  const { data: models } = await client.models.list();
  if (models.length === 0) {
    fail(
      'no models configured in the harness',
      'Add a provider in the TrueForge UI, then set TRUEFORGE_SMOKE_MODEL.',
    );
  }
  ok(`${String(models.length)} model(s) configured`);

  const model = MODEL ?? models[0]?.name;
  if (model === undefined) fail('could not resolve a model name');
  ok(`using model: ${model}`);

  // 3. Session creation with an inline agent spec.
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: model },
        instructions: 'You are a smoke test. Answer in one short sentence.',
      },
    },
  });
  ok(`session created: ${session.id}`);

  // 4. Stream a turn and record which event types actually arrive.
  const seen = new Set<string>();
  let text = '';

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'Reply with exactly: quartermaster online' }],
  });

  for await (const { data: event } of stream.withMetadata()) {
    seen.add(event.type);
    if (event.type === 'model.message.delta') text += event.content ?? '';
  }

  ok(`turn streamed, ${String(seen.size)} distinct event type(s)`);

  // 5. Report drift rather than asserting blindly — the point of this script is
  //    to tell us what changed, not just that something did.
  const missing = EXPECTED_EVENTS.filter((type) => !seen.has(type));
  console.log(`\n  observed: ${[...seen].sort().join(', ')}`);

  if (missing.length > 0) {
    fail(
      `expected event type(s) never arrived: ${missing.join(', ')}`,
      'The SDK contract may have drifted. Check packages/harness/src/pending.test.ts.',
    );
  }
  ok('all expected event types present');

  console.log(`\n  model said: ${text.trim() || '(no text)'}\n`);
  console.log('  SMOKE TEST PASSED\n');

  // Leave no state behind; the harness persists sessions by design.
  await client.sessions.delete(session.id);
}

main().catch((error: unknown) => {
  console.error('\n  FAIL  unexpected error');
  console.error(error);
  process.exit(1);
});
