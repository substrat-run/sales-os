# Building on Substrat — agent instructions

This project is a **Substrat vertical**: a multi-tenant business app built on the
Substrat kernel and its engines. This file is the always-on constitution — the rules
that hold no matter what you touch. It is read by every AI tool (Claude Code, Cursor,
opencode); do not duplicate it into tool-specific config.

The full build flow — interview, coverage map, a reviewed design document you approve
before any code, then reshape, run, and the checkpoints — is a **playbook**, not always-on
context. Invoke it when you start or extend a vertical:

- **Claude Code**: `/substrat`
- **Cursor / opencode**: the `new-vertical` command, or read [`.substrat/playbook.md`](.substrat/playbook.md)

Read the playbook before scaffolding. This file is what a session already mid-build
must never violate.

## The mental model

Three layers. You only own the third.

1. **Kernel — free, always.** Tenancy (one scope = one isolated database; there is no
   cross-tenant API), permissions (roles, grants, and a proof path for every decision),
   events + audit (every mutation emits a kernel-stamped event you cannot mislabel),
   migrations (journaled per module, applied lazily per scope).
2. **Engines — compose or feed.** Headless, own invariants that cannot be violated
   (state machines that can't skip states, append-only entries). You either **compose**
   an engine (import it; its in-scope functions run in *your* transaction) or **feed** it
   (emit a fat event; it consumes — no import). Engines never import each other. Read an
   engine's real surface from `node_modules/@substrat-run/engine-*/dist/index.d.ts` —
   never guess at it.
3. **Your vertical — everything a user touches.** Vocabulary, price list, extra fields,
   roles, screens. If your core noun isn't something an engine already owns, this is most
   of the app — a normal, supported outcome.

## Project layout

The linter and tests expect this shape. `manifest`/`migrations`/`module` are **module
code** (the rules below bind them); `seed`/`server` are **harness** (exempt).

```
src/entities.ts        defineEntities — WHAT EXISTS                ← module code
src/operations.ts      defineOperations — the declared surface     ← module code
src/manifest.ts        moduleManifest.parse({…}) + PERM consts   ← module code
src/migrations.ts      the SqlMigration[]                         ← module code
src/module.ts          the handlers, bound to the declaration      ← module code
src/provision.ts       MODULES, ROLES, grant shapes — node-free    ← module code
src/seed.ts            host, tenants, demo cast, seed world        ← harness
src/personas.ts        the dev cast, read by the issuer and the seed ← harness
src/routes.ts          the routes, DERIVED from the operations     ← harness
src/server.ts          the dev entrypoint (node + persona picker)   ← harness
src/worker.ts          the deployable Cloudflare worker             ← harness
test/scenario.test.ts  the scenario — including the denials
test/entities.test.ts  the registry, held to the tables it migrates
test/setup.ts          the 50-byte LIKE/GLOB pattern limit, on by default (vitest setupFiles)
test/sql-limits.test.ts  proves the setupFiles wiring itself — goes red if setup.ts stops running
```

**A new route is an `http` declaration on its operation, never a handler in an
entrypoint.** `src/routes.ts` holds no table: `mountOperations` (from
`@substrat-run/vertical-host`) derives one from the `http` each operation in
`src/operations.ts` declares — method, path, and which input fields the path
carries, compile-checked there — and both `server.ts` and `worker.ts` mount that
one derivation, so a route is live on both the moment it is declared. A route
added to only one entrypoint is a surface that works in dev and 404s in production
(or the reverse), which nothing catches until you deploy: the scenario tests call
operations directly and never boot either host. A composed engine's operations
carry no `http` of their own (an engine does not own a URL shape), so the vertical
binds them with `defineEngineRoutes` beside its own declarations. What an
entrypoint may still own is only what is genuinely its own — building a host,
resolving a caller, and its own auth-shaped routes (`/api/auth/*` and `/api/me`
in dev, `/api/me` in the worker).

`provision.ts` is deliberately node-free: both hosts register from it (the dev
server's SQLite host and the worker's `ScopeDO`), and `substrat push` reads the
permission registry from it (package.json `substrat.permissions`). Roles or
modules defined anywhere else will run locally and silently not deploy.
`worker.ts` **mounts** the platform's `/internal/*` management contract via
`mountPlatformSurface` from `@substrat-run/vertical-host` (one call — the routes
and the `{ error }` envelope are authored there, not here, so they can't drift or
ship half-done). Sign-in is `workerDoor`, from `@substrat-run/vertical-host/worker-door`:
the issuer the dashboard delivers, the tenant's identity directory, and the owner seat
the first person takes. Every route gets its stub through `door.scope`, which hands an
operation the caller's verified address as `ctx.verifiedEmail`. The first time a person
reaches the scope, the door runs your join if you name one (`workerDoor({ join })`), then
gives them every shape your `permissions` declare `bootstrap` with `holder: 'self'`, once.
That is what the seed does locally, so a vertical with a join operation names it there, or a
hosted person is never joined. There is no dev header to forget to turn off. `src/server.ts`
is the same shape, against the local OIDC issuer `pnpm dev` starts.

**A UI ships as declared assets.** If `app/` exists, `substrat.runtimeNeeds.assets` must
point at its build output and `runtimeNeeds.build` must produce it — otherwise the deployed
vertical serves the API and 404s on `/`, with every local gate green. Declare it in the same
change that creates `app/`, not at deploy time. (`substrat push` refuses an undeclared UI,
but by then you are already deploying.)

Among the hooks `door.platform` passes, **`onConfigure` is the one you must not drop.** It is
how per-instance settings reach the running app: the dashboard's Settings → Env
and Identity tabs POST to `/internal/configure`, and a vertical that supplies no
hook answers **501** to that call for its whole life — the setting is saved, the
dashboard reports `delivered: false`, and the app never sees it. That includes the
`substrat:auth` issuer choice, i.e. the difference between a working login and
401-on-everything. Deliveries land in the tenant's identity directory, and
`door.settings(env, node)` reads them back. Read settings that way and never off
`env` directly: an `envSpec` default rides as a worker binding shared by
every install of one serving script, so `env.FOO` is the same string for every
tenant no matter what any of them saved. Declare a setting once, in
`src/manifest.ts` (`SHOP_ENV`) — `src/provision.ts` re-exports it as `envSpec`,
which is what `substrat push` uploads; package.json carries no copy.

## Declare what exists, then implement it

A vertical declares its **entities** and its **operations** in two typed modules, and
the compiler checks the joins between them. This is not documentation of the code —
it is the code's other half, and the reason a whole class of mistake stops being
something a reviewer has to catch.

`src/entities.ts` says what exists. Each entry names the table, the row shape as
`ctx.sql` returns it (snake_case included — a prettier second naming is exactly the
second description this removes), its natural `key`, its `parents` (the permission
walk), and which fields are `erasable`:

```ts
export const bikeShopEntities = defineEntities({
  customer: {
    table: 'shop_customers',
    fields: z.object({ id: z.string(), number: z.string(), name: z.string(), … }),
    key: ['number'],
    erasable: ['name', 'phone'],
  },
  bike: { table: 'shop_bikes', fields: …, parents: ['customer'] },
});
```

Not every table is an entity. An entity is a thing the platform can point AT —
attachments hang off one, grants narrow to one, events are about one. `shop_price_list`
is keyed by article, has no id and is never the subject of an `EntityRef`, so it is
deliberately absent and its shape lives beside the operations that return it.

`src/operations.ts` says what each operation accepts, answers with, and is gated by —
against those entities and a declared list of permission keys:

```ts
export const bikeShopOperations = defineOperations(bikeShopEntities, SHOP_PERMISSIONS)({
  'shop/create-customer': {
    summary: 'Register a workshop customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string().min(1), name: z.string().min(1) }),
    output: bikeShopEntities.customer.fields,   // from the registry, not restated
  },
});
```

Then `src/module.ts` holds only the **bodies**, bound to that declaration:

```ts
const bound = operationsFor(bikeShopOperations)({
  'shop/create-customer': createCustomerOp,
  …
});
export const bikeShopModule: ModuleRegistration = { manifest, migrations, ...bound };
```

Five things are now compile errors at the exact method: a handler whose input
disagrees with the declared `input`, one whose return disagrees with `output`, an
operation declared and not implemented, one implemented and not declared, and one
whose type was thrown away with `as never` or `as any`. The same call hands the host
the schemas it parses with (`operationInputsOf(bikeShopOperations)`), so they are the
ones the declaration states — they cannot drift, because there is only one of them.
A registration takes no other kind of map: a hand-written `operations: { … }` does not
compile, and `boundary-lint` refuses a cast of the whole map.

The permission list works the same way. `SHOP_PERMISSIONS`, the array handed to
`defineOperations`, is also the `keys` that `src/provision.ts` hands
`definePermissions({ modules, roles, entityGrants, keys })` — and `definePermissions`
throws at module load if those keys and `MODULES` disagree in either direction. Hand
both readers the same array; a second copy is a list that drifts.

**A list read must declare `paged`.** `defineOperations` refuses a bare-array `output`
that does not, and it refuses it at module load — so it fires in every build, every
test and every dev server rather than in a lint tool that has to find you. A list
endpoint returning the whole table is a bug with a delay on it: it passes review, it
passes tests, and then one tenant's table gets large. Declare the **entry** as
`output` and let `paged` wrap it; the handler returns `Page<Entry>`, which `pageOf`
builds. Either the kernel composes the walk (`paged: { over: { entity: 'customer',
sortable: ['number'] } }`) or, where it cannot — a kernel table, a per-row permission
walk, a table the registry does not carry — the handler composes its own and names the
field the cursor walks (`paged: { sortKey: 'article' }`). Keyset, never offset: on
live data an offset shifts between requests, so pages drop and duplicate rows.

**A paged read has an HTTP half, and the derived route does it for you.** The
operation answers with a `Page<T>` — it is transport-agnostic, and a test or a seed
must be able to walk a list with no response to read headers off — so the projection
happens at the edge: `mountOperations` forwards the page trio in (`limit`, `cursor`,
`order`, parsed with the platform's own defaults and ceiling) and hands the entries
back as the body with the walk in a `Link` header. Declare `http` on the paged
operation and both halves are there; hand-mount a paged read yourself and you have
to do both by hand — forget the first and the endpoint is pinned to page one no
matter what the operation supports, forget the second and it answers with an
envelope where it used to answer with an array. That is the case for not
hand-mounting anything an operation can declare.

**An operation the model describes completely says who writes its handler.** These
shapes are derivable: a `GET` of one row by its id, a `GET` that is a `paged.over` page of the
entity's own rows behind declared filters, a `PATCH` field bag with `concurrency`, a
`DELETE` of a row nothing declares as parent, a `POST` that inserts a row every column of
which comes from the input, the parent its check narrows to, a minted id or the entity's
declared `stamps`, and, on an entity that declares `archive` or `trash`, its four moves and
its bin. Declare `derive: 'get'` (or `'list'`, `'update'`, `'delete'`, `'create'`,
`'archive'`, `'unarchive'`, `'trash'`, `'restore'`, `'trashed'`) and write no handler:
`operationsFor` leaves it out of the map it requires and supplies the platform's handler,
which checks the declared key first, reads and writes only declared columns and emits the
declared event (the bin is checked row by row instead, and a move's event is the kernel's).
Keep a handler
only with `authored: '<what the derived one would get wrong here>'`. `defineOperations`
refuses at module load a derivable operation that declares neither, a `derive` whose
declaration is not that shape, and an `authored` on an operation nothing could derive.
Each refusal names its remedy.

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). Rules 1–5 and 12 are enforced mechanically by `boundary-lint`.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter,
   `node:*`, or `cloudflare:workers` in module code. That last one is not a style rule:
   it exports an ambient `env`, so a single import hands module code every binding and
   secret your worker declares — including its own `SCOPE` Durable Object namespace,
   which reaches *another scope's* data. `ctx.sql` is closed over one scope and cannot.
   Capabilities arrive on `ctx`; `DurableObject` is imported in harness code
   (`worker.ts`, `*-do.ts`), never here.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party. The sanctioned path is a **connector**: emit a fat event, register a
   handler that runs outside the transaction. An integration is never impossible because
   of this rule — it has an answer.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine. Do the read with `readTimeline` / `readHistory` from
   `@substrat-run/kernel` rather than a `SELECT` of your own: both take an `EntityRef`,
   page like a list read, and decode the envelope for you. `readHistory` also returns the
   payload, the authorization chain (which checks the operation passed, and under which
   grant), the impersonation stamp, the PII class, the `operation` the event was emitted
   from (the exact `invoke()` string) and the `version` the emitting code was deployed as.
   On all but the PII class, a `null` is a *fact* rather than data you failed to fetch —
   the payload was erased, the row predates authorization recording, nobody was
   impersonating, a consumer emitted it (or the row predates the column), no version
   identity was present — so render it as that. `version` comes from the outbox column
   only, never the envelope, so this helper is the one way to join an event to the push
   that wrote it. Neither helper checks a permission; you do, before you call it.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` etc. — use
   the engine's exported in-scope functions. This is the rule with no runtime equivalent:
   the shortcut *works* and silently welds you to an engine's private schema forever. Need
   extra data on an engine entity? Add **your own side table keyed by the engine's id** —
   never a column upstream.
5. **Time comes from `ctx.now()`.** Module code has no other clock — `new Date()` and
   `Date.now()` are banned exactly like `node:*`. It is the same instant for the whole
   operation, so your rows and the events announcing them agree about when. Store it as
   ISO text, never an epoch integer. Because the host injects the clock, a scenario can
   test elapsed time (`manualClock` from `@substrat-run/kernel`) instead of sleeping or
   shrinking the window to zero — the workaround that proves nothing.
6. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`
   is the first line.
7. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
8. **Never fork an engine.** Extend by composition. If you must fork, the engine drew its
   line wrong — that's design feedback, not a coding problem.
9. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
10. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
    hand-roll a hash to dodge an import ban.
11. **Parse, don't trust** — and the **host** is what parses. A module binds its
    handlers with `operationsFor(ops)(…)`, which hands the host the declared schemas with
    them, and every invocation is parsed against them before the guards and the handler,
    on every path in (HTTP, test, seed, schedule). Handlers do not hand-parse; a declared
    input nobody parses stops being possible rather than merely discouraged. Import `z` from
    `@substrat-run/contracts`, **never from `zod`**. Zod schemas don't compose across
    copies or majors; composing a contracts schema into one built from a separate `zod`
    fails at *runtime* (`expected a Zod schema`) with an error pointing nowhere near the
    cause.
12. **A CSV is written by `csvTable(header, rows)`** from `@substrat-run/contracts`, never
    by joining cells with `','`. Excel, LibreOffice and Google Sheets run a cell starting
    with `=`, `+`, `-` or `@` as a formula even when it is quoted, so a name someone typed
    reaches whoever opens the export as a working link. `csvTable` writes it as text.

## Swallowing an engine error requires `ctx.atomic`

An engine call composed inside your transaction has no boundary of its own. A `catch` that
handles the failure and carries on therefore leaves you holding the engine's partial
writes — the rows its invariants were protecting — and then commits them. Give the call a
boundary instead:

```ts
try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
} catch {
  // the engine's rows, events, links and grants are all gone; your own writes
  // survive, and the operation still commits once
}
```

A succeeded `ctx.atomic` is still provisional: if the operation later throws, its writes go
too. Sub-transactions nest but must not interleave — starting two concurrently throws.

The line is whether the failure still reaches the caller. A catch that **swallows** an
engine error — one that does not rethrow — is what needs the boundary, and outside
`ctx.atomic` `boundary-lint` rejects it with **no** escape hatch. A catch that always
rethrows (`catch (e) { log(e); throw e }`) needs nothing, and neither does `try`/`finally`
with no `catch`: the operation still fails and the whole transaction rolls back, which is
already the outcome the rule protects. `ctx.atomic` is what you reach for when you intend
to *continue* past the failure.

"Always rethrows" is read literally — the catch's last statement is the `throw`. A `throw`
buried in an `if` block is not that, because the catch runs on past it.

## Declare every link edge

`entityRelations` in the manifest must declare every edge you traverse — both your own
(`bike → customer`) and the ones an engine makes on your behalf (`workorder → bike`). The
adapter **rejects** a `ctx.link` for an undeclared edge, so a missing one fails loudly.
This is also what lets a portal permission-walk reach the owner.

## Sharing is `ctx.grant` / `ctx.revoke`, not a table

When a person shares their own record with another person — and takes them off it again —
the operation narrows a permission it already holds onto that one entity:

```ts
await ctx.grant(principal, PERM.listContribute, listRef(listId));   // share
await ctx.revoke(principal, PERM.listContribute, listRef(listId));  // un-share
```

Entity-required (module code can never write a scope- or tenant-wide grant), delegating
(the caller's own decision on that entity is re-checked, so an operation can never hand out
more than it holds), and transactional with the operation. Every later `ctx.check` reads
the grant, so nothing else has to remember who may touch what.

Neither alternative is this, so you can tell a real absence from this one: a `ctx.link`
edge **can be moved but never removed** (`ctx.relink` replaces one parent with another), so
it is not a revoke, and org membership is revocable but coarse-grained — a whole org, not
one record. Never mint an org per domain row, or a
membership table consulted by hand in every handler, to get a revoke. The two-line
reference is the [todo demo](https://github.com/substrat-run/substrat/tree/main/demos/todo)
(`src/module.ts`, `todo/share-list` and `todo/revoke-share`).

## The gates — run them, believe them

```sh
npm test                        # the scenario, including the denials
npx @substrat-run/boundary-lint # the layer rules (1–5, 12)
npm run typecheck
```

`boundary-lint` exits non-zero if it *couldn't do its job* (no module code found, no
engines resolvable) — a pass that checked nothing is worse than no linter. Never wave that
through; fix the setup until it can see your code.

A green scenario test does **not** mean the app works: the test calls operations directly
and never exercises `server.ts`, its routes, or the principal picker. Before calling a
vertical done, boot the server and drive the real flow over HTTP as two personas — one who
should succeed and one who should be denied — and confirm the denial arrives as a denial
(not a generic error).

`.claude/launch.json` is what starts those servers for an agent with a browser pane, and it
declares a **port** — never a path or a query. So the pane opens each server's bare origin,
and no entry can deep-link a page underneath it: reaching one is a navigation you perform
once the preview is up, not something configuration expresses. Do that without being asked.
The page worth opening first on a vertical that serves the Scalar API reference is
**`/api/docs`** — every operation, rendered from the OpenAPI document the platform serves
beside it at `/api/openapi.json` (derived from the same operations as the routes), on the
vertical's own origin, so a try-it request carries the session cookie you already have and
a 403 in the playground is the permission system working rather than a broken page.

The `tests` entry is the one whose bare origin shows nothing: the vitest dashboard serves
only the URL it prints when it starts (`UI started at …/__vitest__/?token=…`) and answers a
403 without the token, which guards an API that can write files and run code. Take that URL
from the server's output; never work around the token.

## When it breaks — symptom → fix

Six failures that have each cost someone a day. What makes them expensive is that none of
them names its own cause: the symptom points somewhere other than the fix, so an agent
debugging from first principles walks away from the answer.

| Symptom | Fix |
|---|---|
| `expected a Zod schema` at runtime, pointing nowhere useful | Two copies of Zod. Never add `zod` to `package.json` — import `z` from `@substrat-run/contracts`, so the schema you build and the one the host validates with are the same class. |
| Killing the dev server kills unrelated ones too | `pkill -f 'tsx src/server.ts'` matches every Substrat project running on the machine, not just yours. Kill by port instead: `kill $(lsof -ti :<port>)`. |
| Green locally, red in CI, with nothing in the diff that explains it | A warm build output hides it. Delete `dist`, reinstall from the lockfile (`--frozen-lockfile`), and re-run the gates before believing a local green. |
| Green test suite, broken app | The scenario calls operations directly and never reaches `server.ts`, its routes, or the principal picker. Boot the server and drive the flow over HTTP as two personas — one who should succeed and one who should be denied. |
| Permission denied after you widened a role | Roles are projected into a scope when that scope is provisioned, from `ROLES` in `src/provision.ts`. An existing scope keeps the projection it was born with — re-provision it (or re-seed onto a fresh data directory), then present the permission diff below. |
| `pnpm install` dies compiling `better-sqlite3` | Take `better-sqlite3` out of `pnpm.onlyBuiltDependencies`. Since 13.x it ships prebuilt binaries and no install script, but it still ships a `binding.gyp` — so an allowlist entry makes pnpm run a `node-gyp rebuild` that nothing here needs. |

## Two human checkpoints — you may never self-approve

Present these and stop:

1. **Migration diff** — every new `SqlMigration`, verbatim. Migrations are append-only
   forever once shipped, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why. Walk the
   reviewer through it in their own vocabulary until they can answer *who can now see the
   money, and who can see other tenants' data?* A permission diff nobody understands is
   theater — it reproduces the exact failure Substrat exists to prevent.

## This app: Substrat Sales OS (Phase 1 — the sales workspace)

A sales system of record for a founder-led B2B team. Design: `spec/concept.md`. Brief: the
"Substrat Sales OS" product brief (Phases 1–4); **only Phase 1 is built** — CSV import with
duplicate review, knowledge base, basic CRM, manual interaction logging, pipeline, the Today queue.

- **No engine is composed.** Companies, contacts, opportunities, interactions, tasks, knowledge
  entries, exclusions and imports are this vertical's own tables (`sales_*`). Booking is the one
  engine to revisit in Phase 3 (meeting slots). Gmail/Calendar arrive as connectors, never `fetch`.
- **Roles** (`src/provision.ts`): `sales-admin` (Markus, Martin: everything) and `sales-member`
  (works the pipeline, reads knowledge; cannot import, merge, approve knowledge, lift an exclusion
  or read the audit trail). A `sales-agent` role is designed for Phase 2 and not built. No prospect
  ever signs in, so there are no entity-narrowed grant shapes.
- **Vocabulary:** company, contact, opportunity (several per company), interaction (a customer
  quote is stored apart from the summary; `generated` marks AI content), task, knowledge entry
  (claim label `shipped` / `built_unproven` / `bet`), exclusion, import batch, duplicate candidate.
- **Opportunity stages:** new → contacted → in_conversation → meeting_held → proposal → won, or `lost` (needs a reason). A move may go to any other stage, back included, and reopens a won/lost one; the same stage is refused. Every move is an event.
- **Meetings** (`sales_meetings`, migration `0003`) are scheduled against a company and optionally an opportunity (`scheduled` → `held` / `cancelled`;
  a cancelled meeting is not held until scheduled again). **Recordings are attachments on the meeting** (`attachmentTargets` in the manifest, read by
  `crm:read`, written by `crm:write`; no new permission key, so any member can also delete one). The browser records the microphone, and uploads through
  the platform's single-use upload link that `sales/start-recording` mints (capped at 25 MiB, `audio/*` only; the recorder uses 32 kbit/s). **Consent is
  checked when the link is minted**: `consent` is an explicit boolean the handler insists is `true`, NOT `z.literal(true)` (the route table pins a literal
  input itself, which let a request that never mentioned consent through). Who ticked and when is on the meeting and in `sales.recording-started`.
  Listing, playing and deleting go through `/api/meetings/{id}/recordings` and `/api/recordings/{id}` in `src/routes.ts`, which need the signed-in person's
  id for `host.attachments(...)`: the local server passes it, the worker does not yet (the routes answer 503 and the screen says so). A scope needs a
  `vertical` and a provisioned blob store for attachments (`provisionWorkspace` in `src/seed.ts`); a data directory seeded before meetings cannot gain one,
  so it has to be reseeded.
- **Transcripts** (`sales_transcript_segments`, migration `0004`): timed passages on a meeting, read with `crm:read`, saved and corrected with `crm:write`
  (no new key). The words are customer speech: `text` is `erasable`, no event carries it (`sales.transcript-saved` has a count, `sales.transcript-corrected`
  the ids), and no assistant tool returns it. The browser (`app/src/live.ts`) cuts the microphone into ~10 s 16 kHz WAV clips and posts each to
  `POST /api/meetings/{id}/transcribe`, a HOST route in `src/routes.ts` (module code may not call a model) that asks the kernel first
  (`sales/open-transcription`) and then a `Transcriber` (`src/transcribe.ts`): Whisper large-v3-turbo through `env.AI` on the worker, or Cloudflare's HTTP API
  with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` locally. Neither present: `GET /api/transcription/status` says why and recording is unaffected.
  The deployed worker gets `env.AI` from the platform when `package.json` → `substrat.usesModels` is `true` (and the platform's fleet switch for models is on); a push
  that does not declare it gets no binding. Not Nova-3: its docs do not list Swedish.
- **Transcript versions** (`sales_transcript_runs`, `sales_transcript_speakers`, migration `0005`; `run_id` + `speaker` on the passages): every transcript is a
  version with the model that made it. The live save (`sales/save-transcript`) records a `live` run; **Transcribe again** (`POST /api/meetings/{id}/transcribe-again`,
  a HOST route) asks the kernel first (`sales/start-transcript-run`: the consent tick, at most 5 runs per recording with failed ones counting, one running at a time,
  a run stuck 15 minutes is stale), reads the stored recording through the caller's attachments, calls the chosen model, and closes the run with
  `sales/finish-transcript-run` or `sales/fail-transcript-run` (a plain sentence, never the provider's text). The first finished version for a recording is current; a person
  switches it (`sales/set-current-transcript-run`). The default read of `sales/list-transcript` is each recording's current version plus any passage saved before versions
  (empty `run_id`). Models are listed in `src/transcribe.ts` (`TRANSCRIPTION_MODELS`: Whisper large-v3-turbo, Grok STT via the gateway with `diarize`); the operations hold only
  the keys (`TRANSCRIPTION_MODEL_KEYS`). A model whose `maxBytes` is below the recording is refused with the reason, not tried. Speaker numbers are 1, 2, 3… per version in order
  of appearance and are named per version (`sales/rename-transcript-speaker`; `name` is `erasable`); events carry ids, model keys and counts, never words or names.
  Live clips never ask for speakers (they would restart in every clip). Whisper's `maxBytes` (4 MiB) is cautious and unconfirmed; Grok's WebM acceptance is untested.
- **Imports never merge silently.** A same-domain row matches; a same-name, different-domain row
  creates the record AND a duplicate candidate; a person decides (`sales/resolve-duplicate`). A
  merge re-points children and marks the loser `merged_into`; nothing is deleted. Raw uploaded
  rows are kept in `sales_import_rows`.
- **Every mutation announces itself** with `announce(ctx, '<op>', row)` in `src/module.ts`, which
  reads the event's type and payload fields off the operation's own `emits` declaration. Declaring
  `emits` alone emits nothing — the handler must call `announce`.
- **Updates are command-shaped POSTs** (`/…/update`, `/…/move`), not PATCH. A partial field-bag
  update must declare `concurrency`; a create with one required field and only optional columns
  looks like a field bag to `defineOperations`, which is why `sales/create-company` requires `source`.
- **Dev cast** (`src/personas.ts`): Markus, Martin (admins), Nora (member), Rex (admin of the OTHER
  workspace, who exists to be turned away). `pnpm dev` → API :8891, issuer :8879, docs `/api/docs`.

## The UI (`app/`)

Vite + React + TypeScript, no router or UI library: hash routes, plain CSS, one typed client in
`app/src/api.ts`. It is declared in `package.json` → `substrat.runtimeNeeds` (`build` + `assets`,
`runWorkerFirst: ["/api/*", "/internal/*"]`), so a deploy builds and serves it.

- **The app calls its own origin** (`/api/…`), never a base URL. Dev: `pnpm dev` (issuer :8879, API
  :8891) plus `pnpm dev:web` (:5174, `WEB_PORT` moves it, `API_PORT` points the proxy). The Vite proxy
  must NOT set `changeOrigin` (the OIDC redirect_uri is derived from the forwarded Host), and targets
  `127.0.0.1` (Node resolves `localhost` to `::1` first and stalls).
- **Signed-out states** (`app/src/App.tsx`): `/api/me` on a deployed instance answers 200, not 401, until someone is bound:
  `{status:'needs-setup', firstSignInOpen}`. Only an answer naming a `principal` is "signed in". `firstSignInOpen` is true for
  **15 minutes after provision** (the first sign-in claims the owner seat); after that the app offers no sign-in, because it
  would bind nobody, and points at the dashboard's Owner seat card, which mints a one-use claim link.
- **Claim links** (`app/src/claim.ts`): `/?claim=<secret>` is read once, moved out of the address bar into sessionStorage (it survives the
  sign-in round trip, which drops the query string) and redeemed with `POST /api/claim-owner { token }` once somebody is signed in. 401 =
  not signed in yet, nothing spent; 400 = invalid, expired or already used. The app never shows a Sign in button that cannot bind anyone.
- **Layout:** one `<aside className="side">` is a left menu at 900px and up and the top bar below it (`app/src/styles.css`). Settings (`#/settings`, in the
  menu's footer, not the main list) holds Appearance and the Team list. The look and light/dark are a personal preference kept in
  localStorage (`app/src/theme.ts`, applied before first paint by `initTheme()` in `main.tsx`): three Substrat themes (Ledger, Standard = Web Awesome's
  base, Atelier) and `wa-dark` from "match my device" / light / dark. Team management is built: see **Team invitations** below.
- **Screens:** Today, Companies (+ detail: contacts, opportunities, interactions, timeline), Pipeline,
  Import (CSV, flagged rows, duplicate review), Do not contact, Knowledge, Audit.
- **What a caller sees follows `sales/my-permissions`** (`useCan(key)`): admin-only nav and buttons are
  hidden for a `sales-member`. That is courtesy only — the server's permission check is the boundary.
- **Edits carry the version they read (`If-Match`).** `sales/get-company`, `sales/get-opportunity` and
  `sales/get-knowledge` answer with an ETag; the three update forms send it back, and a stale save is
  refused with 412 and the UI offers "Load the latest version". A form reads the CURRENT row when it
  opens and is keyed on the ETag, so reloading re-initialises it. Stage moves, approvals and retirements
  are command-shaped and do not use it. `test/scenario.test.ts` step 12 holds this over the real routes.

### Elements (`@substrat-run/elements`)

The UI uses the package's web components where a screen is a list or an account menu, and hand-written
React everywhere else (forms, the pipeline board, detail pages). `app/src/elements.tsx` wraps them for
React 18 (properties and events go through a ref).

- **`<sub-user-menu>`** is the header's account menu (name, Switch user, Sign out); it is handed the
  session `App` already read, so it does not read `/api/me` twice.
- **`<sub-entity-table>`** draws Companies and the rows of an import. Its source is
  `readPage(path)` in `app/src/api.ts`: `{ entries, next, total }`, with `next` the `Link` header's
  URL. Search is the list's own `q` parameter. The list reads are handler-composed (keyset over `id`),
  so columns declare no `sort`: server-side sorting needs `paged.over` with `sortable` on the entity.
  Keep a table's `source` and `columns` identity stable (`useMemo`) or it starts over; change
  `reloadKey` to read it again.
- **Theme:** `base.css` + `ledger.css`, `sub-theme-ledger` on `<html>`, `wa-dark` toggled from the
  system setting in `main.tsx`. `app/src/styles.css` maps its own colours onto `--wa-*` tokens, so
  hand-written cards and the elements share one palette.

- **Ctrl/Cmd+K** (`app/src/Palette.tsx`): a `<wa-dialog>` palette: jump to a screen the person may see, or search companies
  (the list's `q`, 2+ characters, debounced). It reads only what the person can already read and changes nothing. The
  header "Search" button opens it by event. Its **Ask** tab is the assistant (below).

## The assistant (Ask tab)

Composes `@substrat-run/engine-assistant`, the record of a conversation (threads, an append-only event log,
one writer at a time). The engine never calls a model; **`src/assistant-host.ts` is the loop it leaves to the
host**, and `src/assistant-model.ts` picks the model (`@substrat-run/model-providers`, `provider:model`).

- **Who writes what.** A person's side (`assistant/create-thread`, `send-message`) is under `assistant:use`, held
  by both roles, for their OWN threads only; anyone else, an admin included, is told a thread does not exist.
  `assistant:audit` (reading other people's) is held by nobody. The assistant's side is written only by its
  SYSTEM identity (`assistant:run`, `holder: 'system'`; no role can hold it), reached with
  `host.getSystemScope(assistantModule.manifest.id, …)` and granted in `ensureAssistant` (`src/seed.ts`), which
  runs on every boot so a data directory seeded before the assistant is upgraded in place.
- **What it can read: four read-only operations** (`sales/assistant-*`), each run on the ASKING PERSON'S stub and
  gated by `knowledge:read` / `crm:read`. They return only the `ai*` shapes in `src/operations.ts`: no contact
  names, emails or phones, no interaction summaries or quotes, no relationship context, no owner ids. Knowledge
  is **approved entries only**. The model provider is a subprocessor of everything the tools return, so widening
  those shapes is a privacy decision to put in front of a person, not a refactor. It cannot change anything.
- **Grounding.** The system prompt requires a knowledge search before any product answer, the claim label
  (shipped / built_unproven / bet) on every capability, and "That is not in the knowledge base. Ask a person."
  when nothing supports an answer. `source` events are written from what the tools actually returned, not from
  anything the model says. A model failure is recorded as a plain sentence, never the provider's text.
- **Always closed.** Every turn ends with `turn-finish` or `turn-error`, so a dead run never locks a person out of
  their thread. The client (`app/src/assistant.ts`) asks, starts `POST /api/assistant/threads/{id}/run`, and polls
  `read-events`. If the run request itself fails, the client abandons that thread (nothing could write to it).
- **Model and key.** `ASSISTANT_MODEL` (default `anthropic:claude-sonnet-5-5`) and `ANTHROPIC_API_KEY`, read from the
  server's environment. Unset, the Ask tab says the assistant is not set up and nothing else is affected.
- **Entitlement.** The engine is its own SKU: `package.json` → `substrat.entitlements` must list it (`["sales-os", "assistant"]`), or a hosted
  install is granted only its slug and every `assistant/*` call is refused "operation not entitled". An install that existed before the key was
  declared has to be granted it (the control plane re-delivers through `/internal/reconcile`). The kernel's refusal text lists every key the tenant
  holds, so the app never shows a server error as the assistant's words (`app/src/assistant.ts`).
- **Offered only where it can run.** `GET /api/assistant/status` answers `{ available }` (true only when the entrypoint passes `runAssistant`); the
  screen hides Ask unless it is true.
- **Not yet on the deployed worker.** `src/worker.ts` passes no `runAssistant`, so the run route answers 503
  there; the engine's journal, permissions and routes are deployed, the loop is not. Needs: a system scope from
  the Cloudflare host, the provider bundled for workerd, the key as a delivered per-install secret, and the
  recovery path for a worker stopped mid-turn. `assistant-host.ts` is written against `ScopeStub` so it moves as is.
- **Tests:** `test/assistant.test.ts` (engine, tools, isolation) and `test/assistant-host.test.ts` (the loop against a
  scripted model: grounding, no personal data shown to the model, not-configured, model failure, owner-only).

## Team invitations (Settings → Team)

Admins (`member:manage`) invite people from Settings. This is the **sign-in door's member invites** (`@substrat-run/vertical-auth`), not
`engine-invites`: only the identity directory can mint the principal a brand-new person needs, which is why `podcasts` uses
`engine-invites` on its local server but the directory's invitations on its hosted worker. `devMemberInvites` runs the same
invitations locally, so one path serves both. (Weighed in `spec/concept.md`, section 7.)

- **The door makes the invitation; the vertical only records it.** `POST /api/member-invites { email, roleKey }` (and
  `/:principal/withdraw`) are mounted by the worker's `workerDoor({ invites })` and by `members.mount(...)` in `src/server.ts`. The
  door mints the invited principal, refuses an invite to a role the inviter does not hold, and admits the person by the address their
  issuer verified (no link, no email). It then calls our `sales/invite-member` / `sales/cancel-invite` AS THE INVITER, which write
  `sales_invites` (migration `0002-invites`) so the screen can show them. Neither grants anything.
- **Arrival.** `sales/join` (the door's `join`, and `server.ts` locally on a person's first request) settles an open invitation whose id is
  the caller's principal: `status` goes `open` → `arrived`. `list-invites` reads an open invitation past `expires_at` as `expired`.
- **Roles offered:** `sales-admin` and `sales-member`. **Not in the app:** changing a role or removing a person. Those are platform admin
  verbs a vertical cannot call; Settings says to use the Substrat dashboard.
- **Dev:** the persona **Ida** (`ida@substrat.test`) is deliberately not in the seed's `homes`. Invite her, then sign in as Ida to arrive.
- **Tests:** `test/team.test.ts`.
