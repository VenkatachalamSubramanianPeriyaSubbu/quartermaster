# Local runbook

How to get a TrueForge harness running and prove Quartermaster can talk to it.

Everything below was verified against **TrueForge v0.1.4** and
**@truefoundry/trueforge-sdk 0.1.3** on macOS (darwin, Node 24.7).

---

## 1. Start the harness

```bash
npx --yes @truefoundry/trueforge@latest
```

It boots in **standalone mode** and needs no credentials to start:

- listening on `http://localhost:8790`
- API docs at `http://localhost:8790/api/v1/docs`
- SQLite at `~/Library/Application Support/trueforge/db/db.sqlite`
- auth disabled, so no login and no `TRUEFORGE_TOKEN` needed
- runs its own schema migrations on first boot

Standalone mode is explicitly **localhost only** — it is not hardened for shared
or internet-facing use.

## 2. Confirm what the harness supports

```bash
curl -s http://localhost:8790/api/v1/capabilities
```

On a clean install this returns:

```json
{
  "data": {
    "sandbox": { "enabled": true },
    "skill": { "enabled": true },
    "settings": { "enabled": true }
  }
}
```

> **Sandbox and Skills work out of the box.** The harness logs
> `Local sandbox fallback is available` and uses the machine's own bash and
> python. A Daytona account is therefore **not** required for local development
> of the agent-authored budget optimiser (PR #11) or the `SKILL.md` packs
> (PR #10). Daytona remains the right answer for a hosted deployment, where
> running agent-written code on the host is not acceptable.

## 3. Configure a model provider

This is the one step that needs a credential, and it happens **inside** the
harness rather than in this repo's `.env`.

Open <http://localhost:8790>, go to settings, add a model provider (OpenAI for
the hackathon credit), and note the fully-qualified model name it registers —
`provider/model`, e.g. `openai/gpt-5-mini`.

Until you do this, `client.models.list()` returns an empty array and every turn
will fail. The smoke test detects exactly this and says so.

## 4. Point the repo at it

```bash
cp .env.example .env
```

For a default local setup only `TRUEFORGE_SMOKE_MODEL` needs changing — set it
to the model name from step 3. `TRUEFORGE_BASE_URL` already defaults correctly
and `TRUEFORGE_TOKEN` stays empty while auth is disabled.

## 5. Run the smoke test

```bash
pnpm run smoke
```

Expected output once a model is configured:

```
TrueForge smoke test → http://localhost:8790

  ok    harness reachable
  ok    1 model(s) configured
  ok    using model: openai/gpt-5-mini
  ok    session created: ses_...
  ok    turn streamed, N distinct event type(s)

  observed: model.message, model.message.delta, turn.created, turn.done

  ok    all expected event types present
  SMOKE TEST PASSED
```

The script deletes its session afterwards, since the harness persists sessions
by design.

---

## What the smoke test is for

It is the live half of a two-part contract check:

| Check                                      | Where                                  | Needs credentials? | Runs in CI? |
| ------------------------------------------ | -------------------------------------- | ------------------ | ----------- |
| SDK type shapes (event names, field names) | `packages/harness/src/pending.test.ts` | no                 | yes         |
| Harness reachable, turn actually streams   | `scripts/smoke.ts`                     | yes                | no          |

The type-level half is the one that matters most day to day: the fixtures there
are annotated with the SDK's own interfaces, so a renamed field fails the build
instead of breaking the approval gate silently during the demo.

---

## Troubleshooting

**`cannot reach the harness`** — it isn't running, or it picked a different
port. Check the startup banner for the actual listen address.

**`no models configured in the harness`** — step 3 was skipped. Adding the key
to `.env` is not enough; the provider must be registered in the harness itself.

**`expected event type(s) never arrived`** — the SDK contract has drifted.
Compare against `packages/harness/src/pending.test.ts`, which is pinned to
SDK 0.1.3, and update both together.

**Stale sessions** — standalone state lives in the SQLite file above. Deleting
it resets the harness completely.
