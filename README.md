# Substrat Sales OS

A small sales system of record for a founder-led B2B team, built as a multi-tenant app on
[Substrat](https://substrat.net). Load a list of prospects, keep a clear record of every conversation,
track opportunities through simple stages, and start each day from one queue of what needs attention. No
second spreadsheet.

It is deliberately narrow: **prospect lists, relevant conversations, meetings and disciplined follow-up for a
small team.** It is not a general-purpose CRM and not a marketing suite.

> **Status: Phase 1 (the sales workspace) plus a read-only assistant, running locally.** Outreach, Gmail and
> Calendar (Phases 2 and 3) are not built, and the deployed Cloudflare worker does not run the assistant yet.
> See [What is and is not built](#what-is-and-is-not-built).

## What it does

| Screen | What you do there |
|---|---|
| **Today** | The daily queue: overdue tasks, tasks due today, stalled opportunities (no activity for 14 days), and open opportunities with no next step. |
| **Companies** | A searchable list, and a page per company: contacts (with opt-out), opportunities, every interaction, and a timeline of who changed what and when. |
| **Pipeline** | Opportunities by stage: `new → contacted → in conversation → meeting held → proposal → won`, or `lost` with a reason. A stage moves one step at a time and cannot be skipped. |
| **Import** | Paste or upload a CSV of companies and contacts. Rows are matched, never silently merged. Anything unclear (a probable duplicate, a missing company, an email already on another company) is flagged for a person. |
| **Do not contact** | Companies and domains that must never be contacted. An import skips them. |
| **Knowledge** | The approved source of truth: positioning, capabilities, ICP, pricing, security, FAQs, cases. Every claim is labelled **shipped**, **built but unproven**, or **bet**, and has a source and a date. |
| **Audit** | Admins only. Every change to a record: what, when, who or what made it, and which permission allowed it. |
| **Ctrl/Cmd+K** | Jump to a screen or find a company. The **Ask** tab is the assistant. |

A few rules the app enforces rather than hopes for:

- **Customer quotes are stored apart from summaries** and never overwritten. AI-written text is marked as such.
- **A merge never deletes.** The record that was merged away stays on file and points at the survivor.
- **Two people editing the same record can't silently overwrite each other.** A stale save is refused and the
  screen offers to load the latest version.
- **Opting a contact out is open to everyone; lifting it is not.**

## The assistant

Press **Ctrl/Cmd+K** and open **Ask**. Ask a question such as *"What do we say about pilot pricing?"* or
*"Which opportunities have no next step?"*

- It answers **only from approved knowledge entries and your company records**, names the sources it used, and says
  *"That is not in the knowledge base. Ask a person."* when nothing supports an answer. It must state the claim label
  (shipped, built but unproven, bet) when it describes a capability.
- It is **read-only**. It cannot change anything.
- It runs **as the person asking**, so it can never see more than that person can.
- **What leaves the app:** the question and what the assistant's tools return are sent to the model provider while it
  answers. Those results contain no contact names, emails or phones, no interaction summaries or customer quotes, and no
  relationship notes. Only *approved* knowledge is used; drafts and retired entries never are.
- Conversations are private to their owner. Even an admin is told a colleague's thread does not exist.

It uses Substrat's [`engine-assistant`](https://substrat.net/engines/assistant/index.md) (the record of a conversation),
the [`<sub-assistant>`](https://substrat.net/reference/elements.md) element, and the model-provider table. To turn it on
locally, set a key before starting the API:

```sh
export ANTHROPIC_API_KEY=sk-ant-...        # required
export ASSISTANT_MODEL=anthropic:claude-sonnet-5-5   # optional; this is the default
```

Without a key the Ask tab says the assistant is not set up, and the rest of the app is unaffected.

## Who can do what

There are two roles, and no prospect or customer ever signs in.

| | `sales-admin` | `sales-member` |
|---|:---:|:---:|
| Read and edit companies, contacts, opportunities, tasks; log interactions; move stages; opt a contact out | ✔ | ✔ |
| Read the knowledge base; add an exclusion | ✔ | ✔ |
| Use the assistant (own conversations only) | ✔ | ✔ |
| Import CSVs, read the raw uploaded rows | ✔ | – |
| See and decide duplicate candidates (keep both, merge) | ✔ | – |
| Write, approve and retire knowledge entries | ✔ | – |
| Lift an exclusion or an opt-out | ✔ | – |
| Read the full audit trail | ✔ | – |

Opportunity value ranges are visible to both roles. Each workspace is its own isolated database: there is no way to
ask for another workspace's companies, contacts or notes, and the tests prove it.

## How it is built

Substrat is a multi-tenant kernel (tenancy, permissions, an audit event for every change, migrations) with headless
**engines** and **verticals**. This app is a vertical:

```
 ┌──────────────────────── Web UI (Vite + React) ───────────────────────┐
 │  Substrat elements: <sub-entity-table> <sub-user-menu> <sub-assistant> │
 └───────────────┬───────────────────────────────────────────────────────┘
                 │  /api/…  (routes derived from the declared operations)
 ┌───────────────▼───────────────────────────────────────────────────────┐
 │  Sales OS vertical: entities, 40 operations, permissions, migrations   │
 │  Composed engine: engine-assistant (conversation record)               │
 ├────────────────────────────────────────────────────────────────────────┤
 │  Assistant host: runs the model, tools run as the asking person        │
 ├────────────────────────────────────────────────────────────────────────┤
 │  Substrat kernel: tenancy · permissions · events + audit · migrations  │
 └────────────────────────────────────────────────────────────────────────┘
```

- **No published engine fits a CRM**, so companies, contacts, opportunities, interactions, tasks, knowledge entries,
  exclusions and imports are this vertical's own tables (`sales_*`). Booking is the engine to revisit for meeting slots.
- **Everything is declared once**, in `src/entities.ts` and `src/operations.ts`; handlers in `src/module.ts` are bound to
  that declaration by the compiler, and the HTTP routes are derived from it.
- **Every mutation announces itself** as an event, so the timeline and the audit trail come from the kernel rather than
  from code that could forget.
- **Personal data is marked erasable** so it can be removed without breaking the history around it, and never appears
  in an event payload.
- **Citations are not the model's word.** The assistant's `source` events are written from what its tools actually
  returned.

### Project layout

```
spec/concept.md        the design, in plain language, with a decisions log
src/entities.ts        what exists                       src/operations.ts   the declared surface
src/module.ts          the handlers                      src/migrations.ts   the database
src/manifest.ts        permissions and events            src/provision.ts    modules, roles, entitlements
src/assistant-host.ts  the assistant's loop              src/assistant-model.ts  which model, which key
src/seed.ts            two demo workspaces and a cast    src/server.ts       the local API
app/                   the web UI                        test/               the scenarios, including the denials
```

## Running it locally

Requires Node 22 and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev          # sign-in issuer on :8879 and the API on :8891
pnpm dev:web      # the web app on :5174 (in a second terminal)
```

Open <http://localhost:5174> and sign in as one of the demo people (there are no passwords; the local issuer lists names):

| Person | Workspace | Role |
|---|---|---|
| Markus, Martin | Substrat | `sales-admin` |
| Nora | Substrat | `sales-member` |
| Rex | Rival Co (a *different* workspace) | admin, and there to be turned away |

The API's reference is at <http://localhost:8891/api/docs>. Data lives in `.data/` and is safe to delete.

Set `PORT`, `ISSUER_PORT`, `WEB_PORT` or `API_PORT` to move a server.

### Checks

```sh
pnpm test                # the scenarios, including every denial
pnpm lint:boundaries     # Substrat's layer rules
pnpm typecheck
npm --prefix app run build
```

The tests replay a real scenario: import a CSV, review the duplicates, keep the knowledge base honest, work an
opportunity through its stages, read the daily queue, then prove every door that should be shut is shut, each paired
with a control showing a neighbouring door is open. The assistant is tested against a scripted model: what it is shown,
what lands on the record, and every way a turn can end.

## What is and is not built

**Built:** CSV import with duplicate review, the knowledge base, the CRM, manual interaction logging, the pipeline, the
daily queue, exclusions and opt-outs, the audit trail, edit-conflict protection, Ctrl/Cmd+K, and the read-only assistant.

**Not built, by design for now:**

- **Phase 2, outreach:** campaigns and sequences, a Gmail connection, reply detection, controlled sending, deliverability.
- **Phase 3, meetings:** Calendar availability and booking, meeting briefings, transcript capture, quote extraction.
- **Phase 4, prioritisation:** relationship-aware scoring and account research.
- **The assistant on the deployed worker.** The engine, its permissions and routes deploy; the loop that calls the model
  does not yet (it needs a system scope from the Cloudflare host, the provider bundled for the worker, and the key as a
  per-install secret).
- **Real sign-in.** Local development uses a dev issuer. A deployment needs a separate OIDC issuer.

### Claiming a deployed workspace

A new instance has an empty owner seat. For **15 minutes after it is provisioned**, the first person to sign in takes it
and becomes `sales-admin`. After that a plain sign-in binds nobody (`/api/me` answers `needs-setup` with
`firstSignInOpen: false`, and the app says so). The installer then opens the **Owner seat** card for the app in the
Substrat dashboard and follows the one-use claim link it mints (valid 15 minutes).

The design, including the reasoning behind each choice, is in [`spec/concept.md`](spec/concept.md). Rules for working
on the code, whether you are a person or an agent, are in [`AGENTS.md`](AGENTS.md).

## Built with

[Substrat](https://substrat.net) (kernel, `@substrat-run/engine-assistant`, `@substrat-run/elements`,
`@substrat-run/model-providers`), TypeScript, React, Vite, Hono, and SQLite locally or Cloudflare Durable Objects when
deployed.
