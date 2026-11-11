Status: draft v0.1 · Last updated: 2026-11-10 · For review before any code

# Substrat Sales OS — Phase 1: the sales workspace

This is the readable description of the app, for the people who own it. Three sections are
written by `substrat concept sync` from the code (entity model and processes from `model.json`;
roles from a `PERMISSIONS.md` beside it, when there is one) and the rest by hand. Do not edit
between the `substrat:` markers: the next sync overwrites it, and `substrat concept sync --check`
exits 1 while one is stale.

**Scope of this design: Phase 1 of the product brief only** — CSV import, deduplication
review, the knowledge base, a basic CRM, manual interaction logging, the pipeline and the
daily work queue. Outreach, Gmail, Calendar and meeting capture (Phases 2–4) are deliberately
not designed here; section 7 lists what Phase 1 must leave room for.

## 1. Purpose and users

**What it is.** A small, agent-ready sales system of record for a founder-led B2B team.
Martin and Markus load a list of target companies and contacts, see who is worth talking to
and why, log every conversation, track opportunities through simple stages, and start each
day from one queue of what needs attention. No second spreadsheet.

**Who uses it.** Two founders (Martin and Markus) at Substrat, working in one shared
workspace. Later, an AI sales agent acts in the same workspace under its own, narrower
identity (Phase 2). No customers or prospects ever log in.

**The thing that moves through the system.** A **lead** — a company or person we want a
conversation with — moves toward one or more **opportunities** (a specific use case or system
under discussion). Everything that happens along the way is an **interaction** on a
**timeline**: an email, a call, a meeting, a note, an edit, or an action by the agent.

**Lifecycle of an opportunity** (steps may not be skipped, and every move is recorded with who
made it and when):

`new → contacted → in conversation → meeting held → proposal → won | lost` (a stalled deal stays
in its stage and is flagged; `lost` always carries a reason).

**The knowledge base** is the approved source of truth the agent will later be held to:
documents and structured entries about Substrat's positioning, capabilities, ideal customer
profile, pricing guidance, collateral and FAQs. Every product claim carries one of three
labels — **shipped**, **built but unproven**, **bet** — and every entry has a source and a date.

## 2. Roles and permissions

*Prose preview of the permission diff; the generated table below is added once the model exists.*

| Role | Who | Can do | Cannot do |
|---|---|---|---|
| `sales-admin` | Martin, Markus | Everything: import, resolve duplicates, edit and approve knowledge base entries, change owners and stages, delete records, read the full audit trail, set the ICP and exclusions | — |
| `sales-member` | A future colleague | Read and edit companies, contacts, opportunities and interactions; log activity; read the knowledge base | Approve or edit knowledge base entries, import CSVs, merge or delete records, read the audit trail |
| `sales-agent` *(Phase 2, not built now)* | The AI agent | Read the knowledge base; log interactions it performed; propose changes | Edit approved knowledge, merge records, delete anything, change exclusions |

**Who can see the money?** Opportunities carry an *estimated value range*. In Phase 1 both
roles can see it; there is no invoicing and no customer-facing money. If a future colleague
should not see value ranges, that is a one-line permission change — tell us now if it matters.

**Who can see other tenants' data?** Nobody. Each tenant is its own isolated database; there is
no way to ask for another tenant's companies, contacts or notes. The test suite includes a
second tenant whose user tries and gets nothing.

**Who can see what we are not allowed to contact?** Exclusions and opt-outs are visible to every
role (so nobody re-adds them) but only `sales-admin` can lift one.

## 3. Entity model

*Prose preview of the migration diff; the generated diagram below is added once the model exists.*

What already exists vs. what is ours:

- **Kernel (free):** isolated tenant database, roles and permissions with a proof for every
  decision, and an audit event for every change, stamped with who or what did it and when. This is
  most of the brief's "complete, searchable audit trail" requirement.
- **Engines:** none of the published engines is a fit for a CRM. Work orders, invoicing,
  protocols, booking and absence all model something else. **Booking** is the one to revisit in
  Phase 3 for meeting slots. This is the honest picture: Phase 1 is almost entirely our own
  vocabulary and tables — a normal, supported outcome.
- **Connectors (later):** Gmail and Google Calendar are reached through connectors, outside the
  database transaction. Not in Phase 1.
- **Ours:** everything below.

The data we will store (plain terms):

| Thing | Holds |
|---|---|
| **Company** | name, domain, segment, ICP fit score and the reason for it, owner, source, relationship context |
| **Contact** | name, role, email, phone, company, source, owner, opt-out flag |
| **Lead / Opportunity** | company, use case or system, stage, fit rationale, value range (low–high), owner, next step, target date. Several per company. |
| **Interaction** | contact and/or company, kind (email, call, meeting, note), direction, who it was logged by (person or agent), when, body. Customer quotes are stored **separately** from AI summaries and are never overwritten. |
| **Task** | what, due date, owner, linked opportunity |
| **Import batch / import row** | which CSV, who uploaded it, each raw row preserved exactly as uploaded, and what happened to it (created, matched, flagged) |
| **Duplicate candidate** | two records that might be the same, why we think so, and the human decision. **Never merged silently.** |
| **Knowledge entry** | title, body, category (positioning, capability, ICP, pricing, collateral, security, FAQ, case, relationship), claim label (shipped / built but unproven / bet), source, date, approved by, status (draft / approved / retired) |
| **Exclusion** | company or domain we must not contact, and why |

Every human-readable name shown on a screen (an owner, an approver, "logged by Anna") has a
source table: the workspace **member** table maps each person to their display name, since
principals are internal IDs.

Personal data (names, emails, phone numbers) is marked erasable so a deletion request can remove
it without breaking the history around it.

## 4. Processes

<!-- substrat:processes -->
<!-- /substrat:processes -->

### The scenario the tests will replay

1. Admin uploads a CSV of 20 rows; 3 are probable duplicates of existing records; 2 have missing
   fields. They land as *flagged*, nothing is merged, the raw rows are kept.
2. Admin resolves one duplicate (keep both) and one (merge, with the loser's data preserved).
3. Admin adds a knowledge entry labelled *built but unproven*; a member can read it but cannot
   approve it — **denied**.
4. Member logs a call against a contact; it appears on the company timeline with their name.
5. Opportunity moves `new → contacted`; trying `new → won` is **refused**.
6. Today queue shows the overdue task and the stalled opportunity.
7. A user in a **different tenant** asks for the same company by ID and gets nothing.
8. A `sales-member` tries to import a CSV and to read the audit trail — both **denied**, while
   logging an interaction (a neighbouring door) still works.

## 5. Screens and dashboard

- **Today** — the first thing each person sees: new replies *(empty until Phase 2)*, meetings to
  prepare *(Phase 3)*, follow-ups due, overdue tasks, stalled opportunities. Answers: "what should I
  do next?"
- **Companies and contacts** — searchable list; each record shows source, owner, relationship
  context and the full timeline.
- **Pipeline** — opportunities by stage with owner, value range, next step and target date.
- **Import** — upload a CSV, review flagged rows and duplicate candidates, decide each.
- **Knowledge base** — browse and search by category; claim-label badges; draft vs. approved.
- **Audit** *(admin only)* — searchable list of who or what changed what, and when.

The UI is a small web app on top of the API. It roughly doubles the work compared to API-only,
so we build the API and tests first, then the screens.

## 6. Decisions log

- 2026-11-10 — Scope fixed to Phase 1 of the brief. The brief says it is not an instruction to
  build every phase at once, and Phases 2–3 depend on a working system of record.
- 2026-11-10 — No published engine fits; the vertical owns the CRM tables outright. Booking to be
  re-evaluated for Phase 3.
- 2026-11-11 — Design approved by Markus; implementation started. Build decisions made on the way,
  for the reviewer to confirm: (a) `source` is required when creating a company, because the brief
  asks for source on every record; (b) updates are command-shaped POSTs, and the three partial-edit
  operations declare `concurrency`; (c) import matching: same domain matches, same name with a
  different or missing domain creates a record plus an open duplicate candidate, an email already on
  another company is left alone and flagged; (d) a merge never deletes, the loser is marked
  `merged_into` and snapshotted; (e) the stalled threshold is 14 days without activity; (f) the
  entity model and roles regions above are not yet generated: `substrat concept sync` was not run
  (no `model.json` / `PERMISSIONS.md` written), so they remain prose.

- 2026-11-11 — Markus approved the Phase 1 migration (`0001-init`) and the permission table (two roles, ten keys) as presented.

- 2026-11-11 — Two people editing one record: an edit now carries the version it read, and a stale save is refused rather than overwriting. Added two reads, `get-opportunity` and `get-knowledge`, to hand back that version. No new table or permission key; `crm:read` and `knowledge:read` gate them as they gate the lists.

- 2026-11-11 — Ctrl/Cmd+K command palette built (jump to a screen, find a company; Enter opens). It reads only what the person already may read and changes nothing, so it adds no permission and no table. The assistant: see the proposal under section 7.

- 2026-11-11 — Assistant design approved as written (read-only; `assistant:audit` held by nobody; personal data left out of what the model is sent; Anthropic by default with a server-held key). Built: engine composed, four read-only tool operations, the host loop, the Ask tab. No migration of ours; the engine ships its own four tables. Choices made while building, for the reviewer: (a) interaction summaries and relationship context are also excluded from tool results, as both are free text that names people; (b) a source event is written for each entry or company a tool returned, so citations are what the model was shown, not what it claims; (c) the deployed worker does not run the loop yet.
- 2026-11-11 — Markus approved the assistant's permission diff (`assistant:use` for both roles, own conversations only; `assistant:audit` for nobody; `assistant:run` for the assistant's system identity only) and confirmed it adds no migration of ours (the engine's four tables apply per workspace).
- 2026-11-11 — Left menu on a desktop (the same markup is the top bar on a narrow screen) and a Settings page built: appearance (three Substrat looks, light / dark / match my device, kept in this browser) and a read-only team list. No permission, table or operation changed. Managing the team (inviting people) is proposed under section 7, awaiting a choice.
- 2026-11-11 — Team invitations: option A (the sign-in door's member invites) chosen by Markus. Roles offered: Admin and Member; changing a role or removing a person stays in the Substrat dashboard (the proposal's defaults, not separately answered). `engine-invites` was reconsidered after Markus pointed out other apps use it: the `podcasts` app uses it only on its local server and uses the directory invitations when hosted, for the reason recorded in section 7.

## 7. Open questions

**Deliberately out of scope for Phase 1:** sending or receiving any email, Gmail and Calendar
connections, campaigns and sequences, reply classification, meeting preparation, transcript and
quote extraction, automated scoring, enrichment from external sources, reporting beyond Today and
Pipeline. Phase 1 must leave room for them: interactions already carry a "performed by person or
agent" field, and exclusions and opt-outs exist before anything can be sent.

**Decisions needing a recommended default:**

1. **Sign-in.** Default: local development sign-in only; real sign-in (a separate OIDC issuer)
   is wired only if we deploy for real users.
2. **Deploy or stay local.** Default: stay local-first for internal testing; deploy later.
3. **Stage names.** Default: the seven above. Change them if your process differs.
4. **Can a `sales-member` see value ranges?** Default: yes.
5. **UI.** Default: build one after the API and tests are green.

**Review questions for the human:**

1. Looking at the roles table in section 2: is it right that the only people in the system are
   founders and (later) colleagues — no customer ever signs in — and that only `sales-admin` can
   approve knowledge and merge records?
2. Is *"never merge duplicates silently, always keep the raw uploaded row"* the right posture for
   imports, even though it means more review clicks?
3. Is Phase 1 alone the right first build, or do you want to cut it further (for example, skip
   the knowledge base until the CRM is in use)?

### Proposed change (v0.2, awaiting approval): "Ask Sales OS", an assistant inside Ctrl+K

**Status: approved by Markus 2026-11-11 and built for the local server. The deployed worker does not run the assistant yet (see AGENTS.md).**

**What a person would see.** In the Ctrl+K palette, a second tab, "Ask". They type a question ("What do we say about pricing for a pilot?", "Which of our companies are in fintech?"). The answer streams in, every factual claim names its source (a knowledge entry with its claim label: shipped, built but unproven, or bet; or a company record), and when the knowledge base does not support an answer it says so and tells them to ask a person. It never invents a capability, a price or a customer result. Past conversations are kept per person.

**What already exists vs. what is ours.**
- *Substrat provides:* a published conversation engine (`engine-assistant`): threads, an append-only record of every message, one run writing at a time, and approval-gated tool calls bound to the exact input the person saw. It also provides the chat box component (`<sub-assistant>`) and a model-provider table (`@substrat-run/model-providers`: Anthropic, OpenAI, Mistral, EU-hosted options, local Ollama).
- *The engine does not talk to a model.* Our server must run the loop: take the turn, call the model, run the tools, write the answer back. **No vertical has done this yet and the engine's own docs say the host integration is "still to come"**, so this is the first real use of it here, on both the local server and the deployed worker.
- *Ours:* the tools the assistant may use, the grounding rule, the instructions it is given, the model choice, and the screen.

**Who is denied what (the permission preview).** The engine adds three keys:

| Key | Meaning | Held by (proposed) |
|---|---|---|
| `assistant:use` | Start and read **your own** conversations | `sales-admin`, `sales-member` |
| `assistant:audit` | Read **other people's** conversations | **nobody** in v1 |
| `assistant:run` | Write the assistant's side of a conversation | A system identity only; no person or role can hold it |

- *Who can see the money?* Same as today: both roles see value ranges, and the assistant can quote one only to someone who could already read it.
- *Who can read my conversation?* Only you. Anyone else is told it does not exist. Admins cannot read colleagues' conversations unless we later choose to grant `assistant:audit`.
- *Who can see other workspaces' data?* Nobody; the assistant runs inside one workspace.
- *The assistant sees what the asker may see.* Its tools run as the person asking, so it can never read more than that person can. A `sales-member` asking about the audit trail gets nothing, the same as in the app.

**What the assistant may do (proposed v1): read only.** Tools: search approved knowledge, search and open companies and opportunities, read the Today queue. **No tool changes anything**, so no approval step is needed yet. Draft/agent actions (log an interaction, create a task, move a stage) come later, each behind the engine's approval gate.

**Where the data goes.** The question, the knowledge entries and the company text the tools return are sent to the model provider while it answers: the provider is a subprocessor of that text. Proposed: **personal data is left out of what the assistant reads**: contact names, emails and phone numbers, and interaction summaries and customer quotes, are not returned by its tools. Only approved knowledge entries are used as facts; drafts and retired entries are not.

**The model and its key (open decision, recommended default).** Default: Anthropic through the provider table, a Claude model chosen in settings. The API key is a per-install secret set in the dashboard, never in code or the browser; locally it is an environment variable. Provider and hosting location are shown in settings (the provider table has a disclosure for exactly this). Without a key the Ask tab says it is not set up, and the rest of the app is unaffected.

**Data we'd store.** The engine's four tables (threads, events, runs, tool calls); no table of ours. Erasing a person erases their conversations. *(This previews the migration checkpoint: the engine ships its own migrations; we add none.)*

**The scenario the tests will replay.** A member asks and gets an answer citing an approved entry; the same question where only a draft entry matches gets "not in the knowledge base"; a retired entry is never cited; a member cannot read an admin's conversation and an admin cannot either; a cross-workspace user gets nothing; a stale or duplicate run cannot write twice; no key set gives a clear "not set up", never an error page.

**Out of scope for v1.** Any action that changes data, streaming tool approvals, files, memory across conversations, support handoff, spend limits per person (we'd add a per-person hourly cap before deploying to real users), and answering from emails or calendar (Phase 2 and 3).

**Risks and unknowns, honestly.** (1) First vertical to compose this engine: expect rough edges, and the effort is closer to a day or two than an hour. (2) The loop must run outside any database transaction and survive the worker being stopped mid-turn; the engine provides recovery hooks but the host has to use them. (3) Model answers can still be wrong even when grounded; the source labels and the "not in the knowledge base" rule are the guard, not a guarantee. (4) The deployed worker needs the provider package bundled for Cloudflare, which I have not yet tried.

**Review questions for the human.**
1. Is it acceptable that knowledge entries and non-personal company text are sent to the model provider while a question is answered? If not, the alternatives are an EU-hosted provider or a local model.
2. Should `assistant:audit` stay with nobody? (Granting it to admins would let them read colleagues' conversations.)
3. Is read-only the right v1, with actions added later behind approvals?

### Proposed change (v0.3, awaiting approval): managing the team from Settings

**Status: proposal. Nothing below is built. The Settings page shows the team today, read-only.**

**What a person would see.** Settings → Team, for admins: **Invite** (an email address and a role, *Admin* or *Member*), and a list of **pending invitations** with *Withdraw*. The invited person signs in with that address and is let in with that role: no link and no email is needed, the inviter simply tells them to sign in. Once they have, they appear in the team list.

**What cannot be done from the app, and why.** *Changing someone's role* and *removing someone* are platform administration (assigning and revoking roles in the workspace's directory). Substrat gives a vertical no way to do either from its own code, and this version documents none. They stay in the Substrat dashboard, and Settings says so. (If you need them in the app, that is a request to the platform, not something to work around here.)

**Two ways to build the invitation, and a recommendation.**

| | **A. The sign-in door's member invites** *(recommended)* | **B. `engine-invites`** |
|---|---|---|
| What it is | The platform's path into a *workspace*: it creates the member with a role, admits them by their verified address, and can be withdrawn. The worker's door already mounts the two routes. | A record of an offer to join an *organization*, designed to be non-enumerable (addresses stored hashed, never listed). |
| Who gets the role | The platform binds the new person to the role, bounded by the inviter's own permissions: an admin can never invite someone to more than they hold. | On acceptance the kernel's membership executor assigns the offered role, bounded by the inviter. But the person has to be able to call "accept" first, and a brand-new person, not yet bound to this workspace, cannot get past the sign-in door to do so. |
| Maturity | Used by the platform's own sign-in; documented end to end. Runs the same way hosted and on the local dev server (`devMemberInvites`). | Used by the `podcasts` app, but **only on its local server**: on its hosted worker `podcasts` turns the engine's routes off and uses the directory invitations, "because only it can mint the principal a new person needs". |
| What we store | One table of ours (`sales_invites`): who was invited, with which role, by whom, and whether they have arrived. | The engine's own tables, plus our own membership table. |

I recommend **A**. It is the path that actually puts a person into this workspace with a role. B is the better fit if we later need organizations with many teams, or invitations that must never reveal whether an address is already known.

**Who is denied what (the permission preview).** No new permission key. Inviting, withdrawing and listing invitations all require the existing `member:manage`, which only `sales-admin` holds. A `sales-member` sees the team list but no Invite controls. The platform refuses an invitation to a role the inviter does not themselves hold.
- *Who can see the money?* Unchanged: both roles still see value ranges.
- *Who can see other workspaces' data?* Nobody.
- *New thing to be aware of:* an admin can now let a person into the workspace. Whoever holds `sales-admin` is trusted with that.

**Data we'd store (previews the migration, option A).** `sales_invites`: the invited person's id, their address *(personal data, marked erasable)*, the role, who invited them, when, and a status (open, withdrawn, arrived). One migration, `0002`, which we would show you verbatim before it ships.

**Operations (option A).** `sales/invite-member`, `sales/cancel-invite`, `sales/list-invites`, plus a small change to `sales/join` so it marks an invitation as arrived. Wired into the worker's door as its `invites`, and into the local dev server so it can be tried locally with a persona that is not yet a member.

**The scenario the tests will replay.** An admin invites an address as a member; the invitation is listed; the person signs in with that address and arrives with only the member's permissions; an admin cannot invite someone to a role they do not hold; a member cannot invite, list or withdraw; a withdrawn invitation admits nobody; a second invitation to the same address is refused while one is open; a cross-workspace user gets nothing.

**Out of scope.** Sending email, changing a role, removing a member, inviting someone as the owner.

**Risks and unknowns.** (1) The hosted behaviour (the door admitting by verified address, and the platform's role bound) can only be fully verified on your deployment; locally it runs through the dev issuer's equivalent. (2) The invite is by address, so it only works if the person's sign-in provider verifies that address. (3) Option B was weighed against `podcasts`, which composes `engine-invites` locally and uses the directory invitations when hosted; with `devMemberInvites` a single path (A) now works in both places. B remains available later if we want its hashed, non-enumerable record and its standard events; it would sit beside A, not replace it.

**Review questions for the human.**
1. A (the door's member invites, recommended) or B (`engine-invites`)?
2. Are *Admin* and *Member* the right roles to offer?
3. Is it acceptable that changing a role or removing someone stays in the Substrat dashboard for now?
