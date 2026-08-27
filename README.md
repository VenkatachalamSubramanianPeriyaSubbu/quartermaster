# Quartermaster

**A procurement agent that sources against a shopping list and a budget, and cannot spend money without a human saying yes.**

Built on [TrueForge](https://trueforge.dev) for the [Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge).

---

## The idea

You give Quartermaster a shopping list and a budget. It searches the open web for each item, compares candidates on price and shipping, allocates the budget across the list, and prepares an order.

Then it stops.

Spending money is irreversible, so the purchase step is gated behind human approval at the harness level — not behind a confirmation dialog in our UI that a clever prompt could talk its way past. The agent can propose a purchase. Only a person can authorise one.

You can also hand it a **photo** of something you want. A vision model extracts the attributes, turns them into a search, and then re-verifies each returned candidate against your original image before proposing anything.

> **Scope note.** Quartermaster settles orders against **Stripe test mode**, never a live retailer checkout. This is deliberate. The interesting engineering is the approval gate and the budget enforcement, not defeating anti-bot systems — and a demo that depends on scraping a real checkout is a demo that fails on stage.

---

## Why this is not a thin wrapper

Hackathon Rule 3 asks that a judge can see the harness doing real work. Quartermaster uses twelve TrueForge capabilities, each for a reason the project actually has.

<!-- PR #6 fills in the exact config values once the agent spec lands. -->

| #   | Capability             | Why we need it                                               |
| --- | ---------------------- | ------------------------------------------------------------ |
| 01  | Tool approval gate     | Money is irreversible. The gate is the product.              |
| 02  | Subagents              | One sourcing lane per channel, running in parallel.          |
| 03  | Sandbox as tool        | The agent _writes_ the budget allocation script and runs it. |
| 04  | Skills                 | Matching rules differ per vertical; load them on demand.     |
| 05  | Session persistence    | A shopping list lives for weeks, not one request.            |
| 06  | Deferred tool loading  | Bright Data's tool surface is large; don't preload it.       |
| 07  | Large-response offload | Scraped product pages are enormous.                          |
| 08  | Compaction             | Multi-day sessions would otherwise blow context.             |
| 09  | Ask-user-questions     | "Three candidates match your photo — which one?"             |
| 10  | Generative UI          | Candidate comparison tables rendered in chat.                |
| 11  | Multi-provider models  | Vision model for intake, cheaper model for ranking.          |
| 12  | Iteration limit        | Bounded runaway.                                             |

---

## Architecture

| Component               | What it is                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Bright Data MCP**     | _Attached, not built._ SERP, Web Unlocker, structured retail extractors. The discovery layer.                       |
| `packages/mcp-commerce` | The ledger and checkout MCP server. Shopping list, budget state, order drafts, and the gated `checkout_order` tool. |
| `packages/harness`      | The TrueForge client layer. Pause-event handling for the approval gate, plus the SDK contract tests.                |
| `packages/shared`       | Cross-cutting TypeScript utilities — branded identifiers, assertions.                                               |
| `agent/`                | Version-controlled agent manifest and git-backed `SKILL.md` packs.                                                  |
| `apps/web`              | The approval console. List management, photo intake, live turn stream, approval inbox.                              |

TrueForge itself runs as a server on `:8790`; this repo is what plugs into it.

---

## Getting started

Requires **Node >= 22.14** and pnpm (via corepack).

```bash
corepack enable pnpm
pnpm install
pnpm run check     # format:check + lint + typecheck + test
```

Individual tasks:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:watch
pnpm run format
```

### Running against a harness

Quartermaster talks to a TrueForge harness over HTTP. Start one, register a
model provider inside it, then point this repo at it:

```bash
npx --yes @truefoundry/trueforge@latest   # boots on :8790, no credentials needed
cp .env.example .env                      # set TRUEFORGE_SMOKE_MODEL
pnpm run smoke                            # proves a turn streams end to end
```

Full instructions, including the one step that does need a credential, are in
**[docs/runbook.md](./docs/runbook.md)**.

> Standalone TrueForge ships a **local sandbox fallback** using the machine's own
> bash and python, and reports `sandbox` and `skill` as enabled on a clean
> install. No Daytona account is needed for local development.

---

## Repository conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Budget code must not silently coerce.
- **Typed linting** via `typescript-eslint` strict + stylistic. Rule suppressions require a comment explaining why.
- Tests live beside their source as `*.test.ts`. They are excluded from the emitting build and typechecked by `tsconfig.test.json`.
- CI runs format, lint, typecheck, and test on every pull request.

---

## Qodo code review evidence

<!-- Required for hackathon submission. Filled in progressively as PRs merge. -->

| PR  | Title                    | Qodo findings    | Response |
| --- | ------------------------ | ---------------- | -------- |
| #1  | Repo scaffold            | _pending review_ |          |
| #2  | Harness contract & smoke | _pending review_ |          |

---

## Licence

MIT — see [LICENSE](./LICENSE).
