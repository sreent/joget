# Ambit

Design and first code for **Ambit** (a3t), a **governed capability platform for people and AI agents**. This repository is still called `joget`, after the platform it set out to surpass. People ask for outcomes, in Teams, Slack or any other chat app, through an agent, or on the web. Builders, working with an AI copilot, publish the capabilities that deliver them: actions, queries, rules and review cards. Every capability is an MCP tool and an API operation. An agent always acts for a named person, and the person confirms what matters before it's committed. Roles, personal and team spaces, permission sets, efficient deployment, monitoring and a full audit trail govern all of it.

The goal is not to clone Joget DX but to surpass it: match what builders can deliver with it, beat it on governance, isolation, delivery, observability, audit and readiness for agents, and build on a modern TypeScript stack.

## Documents

| Document | What it covers |
|---|---|
| [docs/01-joget-review.md](docs/01-joget-review.md) | A review of Joget DX 9.1 (Community Edition source) against our requirements: what to borrow, what to avoid, and whether to fork or build |
| [docs/02-platform-design.md](docs/02-platform-design.md) | The design: capabilities for people and agents, proposals and confirmation, spaces, identity, roles and permission sets, governed app lifecycle, cloud-agnostic Kubernetes deployment, monitoring, audit, reference stack, roadmap, decisions and the ISO 27001 control mapping |
| [docs/03-n8n-reference.md](docs/03-n8n-reference.md) | Prior art: n8n's tech stack and governance model, read from its source, and what it means for our choices |

## Status

- **Decided:**
  - build new; one company; cloud-agnostic on Kubernetes; IdP-agnostic; TypeScript; ISO 27001:2022; no data-residency constraint;
  - building happens in personal spaces, and team spaces run Prod, with a preview for each change request;
  - people ask for outcomes and builders publish capabilities, with apps as the packages they ship in;
  - the agent and its chat adapters are a separate project that calls the platform;
  - data lives in the platform's built-in store, which is reached like any other connector;
  - it stays a low-code platform like Joget and Mendix: visual designers, an AI copilot and code edit the same definitions, and AI clients such as Claude can build through an MCP server.
- **Still open** (§14 of the design doc): PostgreSQL-only (the working assumption), and which chat platforms can carry an approval.
- **Built so far:**
  - phase 0, the governance kernel, proven on a real Kubernetes cluster;
  - phase 1, the capability core with line items and files, the studio's data-model and form designers, and the screens every app gets;
  - from phase 2: governed delivery for team apps (working copies, change requests with checks and previews, signed releases, approved deployments to Prod and Staging, and rollback); the designers for rules, actions, queries, review cards, roles, pages, the menu and dashboards; the flows that actions run before they save; moving a personal app to a team space; queries that total and group, for agents; app templates, export and import; and the command line, `ambit`.
  - from phase 3: business processes on Ambit's own engine in PostgreSQL, built as flows that wait (people's tasks, waits, the first of several waits, and ways at once), with people's tasks in an inbox across apps, timers for deadlines and escalation, tools for agents, and routing from the directory: the requester's manager, a reporting line, a department, and cover while someone is away. The studio's chat builds and changes apps on the installation's model, as Joget DX 9's vibe composition does. Ambit does its own logic: flows, like Mendix microflows, with their designer in the studio ([design §6.2](docs/02-platform-design.md#62-capabilities-actions-queries-rules-and-review-cards)). Flows call other systems' services and tell people; other systems run flows through webhooks.
- **Next:** the rest of phase 3: approving in chat, notifications, and document generation.

## What the code does today

| Area | Implemented |
|---|---|
| Identity | Sign-in with any OIDC provider (authorization code + PKCE). Just-in-time provisioning, IdP group sync, server-side sessions with revocation, MFA evidence from standard `amr`/`acr` claims, step-up sign-in |
| Spaces | A personal space for every user, created at first sign-in. Team spaces with a minimum number of owners. Freezing |
| Authorization | One policy decision point (`@platform/authz`): permissions, permission sets, roles, scoped bindings with expiry, the personal-space boundary, guardrails (deny and fresh-MFA rules), separation of duties, privilege-escalation checks and explained decisions. Every route must declare an access rule, or the server refuses to start |
| API tokens | Personal access tokens and service accounts owned by team spaces. Tokens are scoped, expire (90 days at most by default), are stored only as hashes, and can only be created from an interactive session with fresh MFA. Service accounts start with no access and gain it only through bindings. Admins can list and revoke any token, and every step is audited |
| Apps (built-in store) | Apps live in personal spaces, where their builder edits them live, or in team spaces, where they change only through reviewed change requests (below). They are defined as entities, rules, actions, queries, review cards and roles:<ul><li>Each app environment gets its own database schema and NOLOGIN role, and every query switches to that role.</li><li>Definitions are versioned. Entities and fields have stable IDs, so a rename is free and carries through to every reference. Changes apply live, but anything that deletes data waits for confirmation.</li><li>Record- and field-level permissions are compiled to SQL filters, and PII is masked by default.</li><li>Every record keeps a field-level history, with where each value came from.</li><li>Line items: a record can hold lines of another entity, such as one line per receipt on a claim. Lines are read, written, permitted and kept in history with their record, each value with its source. Rules check every line, and totals and counts are worked out from the lines (rollups).</li><li>Files, such as receipts: each upload is checked for what it really is and scanned for malware (ClamAV), then kept in the app's own schema or any S3-compatible store. Only whoever can see the field holding a file can download it.</li><li>Apps can be shared with named colleagues, each in one of the app's roles.</li></ul> |
| Studio | A web app at `/studio`, in the Ocean design system, light and dark:<ul><li>One workbench: an app's five views, Data, Forms, Pages, Flows and Permissions, each with its parts below it, and the app's history, settings and delivery beside them. Each canvas also shows as a list.</li><li>The data designer: entities and fields, drag to reorder, and renames that keep the data, as a list or as a canvas of the whole model, where each entity is a box of its fields with arrows for its references and its lines. Saving shows the plan first, and asks again before anything deletes data.</li><li>The form designer: sections, half- or full-width fields, labels and help text, and the action a form submits through, so its rules and confirmation apply. A field can show only while a condition holds, and a form can ask a section at a time, as a path of steps. The data designer makes a field required while a condition holds, which every write checks, and gives dates, times and person fields defaults such as today, now and the person.</li><li>Every app's screens, generated from what the person may do: lists, forms, and record pages that show who changed what and when. Person fields have a picker. A colleague in a narrower role sees only what that role allows.</li><li>Designers for rules, actions, queries (which answer with records, a number, or a number for each group), review cards and roles: conditions are built as clauses (a field, a test, a value), and roles as a matrix of who may do what with which records.</li><li>The page and menu designers. A page is blocks: text, lists of records (columns, which records, their order, and one-click row actions such as Approve) and buttons that open forms or pages. A page can be about one record, which a list's row opens: its fields and actions, tabs, and the lists and numbers of the records that refer to it. The menu orders pages, forms and lists under headings, and names the home page. Each person sees only the pages, columns, buttons and items their role can use.</li><li>Dashboards: numbers and charts on a page. A number counts records or their lines, or works out a sum, an average, the lowest or the highest, for the records that meet a condition and fall in a time range. A chart groups by a field or by a period, as bars, columns, a line or a table, and every chart has a table view. The database works them out under the person's own permissions, and refuses a total over a field their role masks.</li><li>Before an action saves, a flow of its own: the action designer picks it, opens it on its canvas or writes a new one, and a preview shows what it did. A value comes from a fixed value, a field, the person, today, a calculation, text joined from parts, a date some days away, the days between two dates, one of two values by a condition, text changed (capitals, trimmed, its first characters, its length), or the first value that is filled in. A condition compares dates with each other and with a date relative to today.</li><li>The flow designer: a flow's steps left to right on one canvas, drawn in Ocean's grammar as Mendix lays out a microflow, with a decision's ways, and loops and error handlers framing their steps; a long flow wraps into rows. A flow that waits is built the same way: a person's task with a way on for each outcome and the role's initial at its foot, its reminders and its deadline hanging below it, waits as rings, steps that repeat, the first of several waits and ways at once as frames, and a bar where the flow saves before it waits. Beside the canvas, "How it starts" says what starts a flow, and sets how it starts by itself or the schedule it runs on. Each arrow takes a new step, each step opens beside the canvas, and <strong>Try it</strong> runs a saved flow that runs in one go on real records, and undoes it. Live, a flow that waits shows how many cases wait at each step now, how many are stuck, and the longest wait. Actions and roles pick the flows they run.</li><li>Tasks: each person's inbox across apps, with the outcomes as buttons, and on every record page, where its processes are and who they wait for.</li><li>Sharing, the revision history, and the whole definition as JSON. New apps start blank, from a template, or from a file someone downloaded.</li><li>For team apps: delivery (environments, releases, deployments waiting for approval, rollback, history), change requests with their checks and reviews, the preview of each change, access per environment, and a prompt to sign in again when Prod needs fresh MFA.</li></ul> |
| Governed delivery | Team apps follow design §3, §6.7 and §7.1:<ul><li>**Working copies.** *Edit in my space* makes a working copy of a team app in the builder's personal space, with the same stable IDs and sample records, never Prod data. The builder changes it freely.</li><li>**Change requests.** *Submit change* opens a change request with automatic checks: validation, what changes artifact by artifact, the migration Prod would need (steps that delete data flagged), who gains or loses access (from the compiled roles, with how many hold each role now), which agent tools change, and lint. A preview, a temporary environment, runs the change for reviewers and testers.</li><li>**Review.** Someone other than the author approves (a guardrail); a new version needs approval again. Builders work at the same time: the merge is three-way at the artifact level, and conflicts are shown.</li><li>**Releases.** A release is one main-line revision, hashed and signed, and a database trigger keeps it from changing. A change that deletes data goes in a release of its own.</li><li>**Deployments.** Staging deploys at once. Prod needs an approval from someone who wrote none of the changes, and fresh MFA. The migration, a smoke check and the switch to the new release happen in one transaction. Releases that delete data are deployed in order.</li><li>**Rollback.** It makes the previous release live again in milliseconds. The data keeps the newer shape (expand and contract), and a rollback across a release that deleted data is refused.</li><li>**Promotion.** *Move to a team space* turns a personal app into a change request in a team space, with the personal app's definition. The personal app keeps working until the team app first runs in Prod; then a guardrail makes it read-only, and it points to the team app. Its data stays where it is.</li></ul> |
| Before it saves | An action runs a flow before it saves, on the record as it shapes it (design §6.2): the flow checks the record, changes it and adds lines to it, and changes nothing else. It runs when the change is worked out, so a preview and a proposal show its result, and a proposal's digest covers it. Fields that it sets count as written by the person, so their role's field permissions apply, and the rules run on the result. An older definition's action steps move into such a flow when it is checked |
| Flows | What happens in an app, like Mendix microflows (design §6.2, §6.11): find records, loop over lists and lines, create, change and delete related records, branch, check, call other flows, total, and catch errors with an undo to a savepoint. A flow runs in one go, in one transaction with the app's authority; or it waits for people and for time, keeping its place on one record. Actions run flows once they save, and roles run them through the API, with a dry run that undoes everything. Each write goes through the entity's checks and rules, and leaves its history and audit event |
| Flows that wait | A flow that waits (design §6.11) has steps that wait: a person's task, with a way on for each outcome, reminders while it waits and a deadline that ends it; a wait for a time, a date of the record (or a time before or after it), an action on it, a condition or a signal; the first of several waits; ways that run at once; and steps that repeat while a condition on the record holds. It has one input, the record it is about, and keeps no value in a variable across a wait: the record is its data. It compiles to the process engine's graph, with an element for each step named by the step's path, and a service task for each stretch of steps between two waits. An action that runs it starts it on its record; a role that lists it may start it by hand; and it can start by itself on each record: as the record is created, a time after, on a date of the record, or when a condition comes to hold. The leave template's approval is one |
| Flows on a schedule | A flow that needs no input runs by itself every hour, day, weekday, week or month, at a time of day in a time zone, once at each time, with the app's authority (design §6.11). Each environment plans its schedules when its revision changes, and the timer worker runs them; a preview runs none |
| Business processes | The process engine underneath, and BPMN-shaped processes in the definitions of apps from before flows could wait (design §6.10): start and end events, user, service, script, send and receive tasks, rule checks (business rule tasks), exclusive, parallel, inclusive, complex and event-based gateways, timers, messages, conditions, milestones and links, signals to every process of the app, events on a boundary (deadlines, messages, conditions, signals, errors and escalations), errors and escalations with codes that go up to the sub-process or call that catches them, undo actions that a compensation event or a cancelled transaction runs, starts on a record's date, a time after it is created or a condition, sub-processes, transactions, event sub-processes, ad hoc sub-processes and call activities (also for each record that refers to this one), and activities that repeat while a condition holds, all with the diagram. Each instance is about one record, which is its data. An action starts a process when it commits; a user task waits in the inbox of the person a field names, or of anyone with its role; and running an outcome's action, from the inbox, a row button or an approved proposal, completes the task. Service tasks run the app's actions with the app's authority. The engine keeps instances, tokens, tasks and timers in PostgreSQL and moves a process in the transaction of the change that moves it, with its audit events. Instances stay on the revision they started on |
| Agents | Every action and query a person may run is an MCP tool (`/mcp`), AI clients such as Claude can build apps through a second MCP server (`/mcp/build`), and operators' clients run them through a third (`/mcp/ops`). An agent that serves many people, such as agentos or a Copilot Studio bot, is approved by a Security admin, then exchanges a person's IdP token for a 10-minute Ambit token that acts for that one person (RFC 8693). Agents work through errands only, never on raw records, and the audit log names both the agent and the person. A query can answer with numbers, such as the person's spending by category this year, so an agent asks the question rather than adding up records. When an API token runs an action that needs confirmation, the action becomes a proposal sealed with a digest. Only the person, signed in, can approve exactly that change, on a review page where they can also edit it |
| Build by chat | The studio's chat builds and changes an app on the installation's model, off until an admin sets one up (design §6.5). The model changes the draft with small JSON Patch edits that the definition's checks run on, and fixes what they find. The builder undoes the change, or reviews and saves it as any other change. The model sees the definition and the builder's pictures and PDFs, never the records. The `app.compose` permission allows it, and the audit log records each request with its model and tokens. MCP clients make the same edits with `edit_definition` |
| Audit | Every change writes its audit event in the same transaction. The tables are append-only (database triggers). A background sealer signs chained RFC 6962 Merkle batches with Ed25519, and a verifier detects edits, deletions and insertions |
| Operations | Health and readiness probes, OpenTelemetry traces and metrics (OTLP), structured logs, graceful shutdown, a container image, generated OpenAPI, and a hardened Helm chart (below) |

Next (§13 of the design doc): phase 3, approvals and the shared agent. Left from phase 2: signed release bundles between installations, Git sync, and watching error rates after a deployment.

Later: workload identity federation, so CI systems can swap their own OIDC tokens for short-lived platform tokens with no stored secrets.

## Repository layout

```text
apps/api            Fastify API: auth, spaces, bindings, apps, records, actions, proposals, MCP, audit, health
apps/studio         Ambit Studio (React, Vite, Tailwind): the designers and every app's screens, served by the API at /studio
apps/cli            ambit, the command line: templates, export and import, releases and deployments
packages/app-model  App definitions: validation, stable IDs, migration plans, roles, and the SQL behind record-level permissions
packages/authz      Policy decision point (pure TypeScript, no I/O)
packages/audit      Canonical hashing, Merkle seals, signatures, verification
packages/db         Drizzle schema, SQL migrations, seeding, test-database helper
packages/design     The Ocean design system: tokens, IBM Plex fonts and Ambit's own styles
deploy/compose      Local PostgreSQL and a sample IdP (Keycloak)
deploy/helm         Helm chart for Kubernetes
docs                Review, design and reference notes
```

## Developing

You need Node.js 22.12 or later, pnpm 10 (`corepack enable`), and Docker for the local dependencies.

```bash
pnpm install
```

```bash
docker compose -f deploy/compose/compose.yaml up -d
```

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
pnpm dev
```

Open http://localhost:3000/auth/login and sign in as `alice` / `alice` (an org owner), `bob` / `bob` or `carol` / `carol`. Then try http://localhost:3000/v1/me and http://localhost:3000/v1/spaces. The API description is at http://localhost:3000/openapi.json once you're signed in.

The API serves the studio's built files at http://localhost:3000/studio/. Build them once:

```bash
pnpm --filter @platform/studio build
```

To work on the studio with hot reload, run its dev server alongside the API, tell the API that's where people come from, and open http://localhost:5173/studio/:

```bash
PUBLIC_BASE_URL=http://localhost:5173 pnpm dev
```

```bash
pnpm --filter @platform/studio dev
```

### Tests

Unit tests need nothing else:

```bash
pnpm test
```

Integration tests run against a real PostgreSQL. Each test file gets its own throwaway database:

```bash
TEST_DATABASE_URL=postgres://platform:platform@localhost:5432/platform pnpm test:integration
```

The S3 file store has its own opt-in test, against any S3-compatible server, such as MinIO or moto (`moto_server -p 9000`):

```bash
TEST_S3_ENDPOINT=http://127.0.0.1:9000 TEST_DATABASE_URL=postgres://platform:platform@localhost:5432/platform \
  pnpm --filter @platform/api test:integration -- files-s3
```

The studio's browser test runs in Chromium through Playwright, which isn't a dependency, so it's opt-in. It drives a real API and saves screenshots if you name a folder:

```bash
pnpm --filter @platform/studio build && STUDIO_E2E=1 SCREENSHOT_DIR=/tmp/shots \
  TEST_DATABASE_URL=postgres://platform:platform@localhost:5432/platform pnpm --filter @platform/api test:integration -- e2e
```

That runs two: the studio's own (`studio.e2e`), and governed delivery from a working copy to Prod and back (`delivery.e2e`).

Type-check and build everything:

```bash
pnpm typecheck && pnpm build
```

### Container image

```bash
docker build -f apps/api/Dockerfile -t platform-api .
```

Behind a TLS-inspecting proxy, as on many corporate networks, pass the proxy's CA bundle as a build secret. It is used only while dependencies download, and never ends up in the image:

```bash
docker build --secret id=build_ca,src=/path/to/ca-bundle.pem -f apps/api/Dockerfile -t platform-api .
```

Give the API an Ed25519 signing key for audit seals:

```bash
pnpm --filter @platform/api audit:keygen
```

## Using API tokens

Create a personal access token while signed in. It can do at most what you can, narrowed to its scopes. The token is shown once:

```bash
curl -X POST http://localhost:3000/v1/me/tokens -H 'content-type: application/json' \
  -b 'platform_session=<your session cookie>' \
  -d '{"name": "reporting script", "scopes": ["space.read", "org.audit.read"], "expiresInDays": 30}'
```

Use it as a bearer token:

```bash
curl http://localhost:3000/v1/spaces -H 'authorization: Bearer plt_pat_...'
```

For automation, a team-space admin creates a service account (`POST /v1/spaces/{spaceId}/service-accounts`), grants it roles like any other principal (`POST /v1/bindings`), and issues it a token (`POST /v1/service-accounts/{id}/tokens`). Security admins can list every token (`GET /v1/tokens`) and revoke any of them (`POST /v1/tokens/{id}/revoke`).

Some steps stay with a person, whatever the token: approving a proposal or a change request, deploying to Prod (approving it, making it live and rolling it back), and deleting data (a record, an app, or a change or deployment that deletes data). A token, an agent or a pipeline can prepare them: a pipeline cuts a release, deploys it to Staging and asks for Prod. Only the person, signed in, does them. A token gets `403 session_required`, with the step in `details.step`.

## Building an app and letting an agent use it

Sign in as `alice` and open http://localhost:3000/studio/. Create an app, starting from the example, an expense-claim app. Change its fields in the data designer, lay out its form, arrange its pages, menu and dashboard, and share it with `bob` as a requester. **Open the app** shows its screens; sign in as `bob` to see his narrower view, without the page for approvers.

Everything the studio does goes through the API, so you can do the same without it. `GET /v1/app-model/schema` returns the definition format and the example. Create an app in your personal space from it:

```bash
curl -X POST http://localhost:3000/v1/spaces/<your personal space ID>/apps -H 'content-type: application/json' \
  -b 'platform_session=<your session cookie>' -d '{"name": "Expenses", "definition": <the example>}'
```

Then share it, or point an agent at it:

- **Share it with colleagues:** `POST /v1/apps/{appId}/shares`, with an email and one of the app's roles.
- **Let an agent use it:** connect any MCP client to `http://localhost:3000/mcp` with a personal access token scoped to `app.run`, `action.run`, `query.run`, `record.read` and `record.create`. Each action and query the person may run is a tool.
- **Operate it with an AI client:** add `http://localhost:3000/mcp/ops`, with a token scoped to `app.read`, `ops.monitor.read`, `ops.job.retry`, `process.admin` and `ops.task.reassign` (and `app.edit` for your own apps). It lists the apps you operate, shows where each process instance waits and why one is stuck, tries stuck instances again, cancels an instance, throws a signal, and moves a task to someone else.
- **Build with Claude:** add `http://localhost:3000/mcp/build`, with a token scoped to `app.create`, `app.read` and `app.edit`. `edit_definition` changes a definition with small JSON Patch edits: it checks them first, and saves them when asked.

When an agent submits a claim, the person gets a review link: they check the card, edit what's wrong, and approve.

### Building by chat

The studio's chat builds and changes an app from what the builder tells it, with pictures or PDFs if they help, such as a photo of a paper form. It changes the draft in the designers, and the builder undoes it, or reviews and saves it as any other change. The model sees the app's definition and the files, never its records. The chat is off until an admin sets up a model:

- `AI_PROVIDER`: `anthropic`. An OpenAI-compatible provider follows.
- `AI_MODEL`: the model's ID at the provider. Ambit names no default.
- `AI_API_KEY_FILE`: a file that holds the API key. Ambit reads it at each request, so whatever issues the key can renew it.
- `AI_BASE_URL`: a gateway in front of the provider, if there is one. It must use https in production.
- `AI_EFFORT` (`high`): how much effort the model puts into each turn: `low`, `medium`, `high`, `xhigh` or `max`, or `off` for a model that takes no effort setting.
- `AI_FALLBACK` (`default`): a turn that the model declines goes on with the provider's fallback model. `off` is for a model or gateway that refuses the setting.
- `AI_MAX_TURNS` (12): the most turns of the model in one request.

In the Helm chart, set `ai.provider`, `ai.model` and `ai.keySecret`, a Secret with the key under the key `key`. The `app.compose` permission allows the chat, and builder roles hold it. Every request is in the audit log, with the model and the tokens it used.

- `GET /v1/compose`: whether the chat is on.
- `POST /v1/apps/{appId}/compose`: send the request, the draft, the conversation so far and up to three files. The answer is the model's reply and the changed draft, which nothing has saved.

### Notices

What reaches a person comes to their notices in the studio, by record, with the unread count beside Notices in the header (design §6.12): what a flow told them with an `inform` step, and each task that came to them, is due soon or is overdue. An `inform` step can post to a Teams channel too, which a connection names. A notice goes only to people the app is shared with, and each person reads only their own. By email too, when the installation has a mail server and the person hasn't turned email off; a field classified as PII stays out of what an email says.

- `SMTP_URL`: the mail server, as `smtp://mail.example.com:587`, which must offer STARTTLS, or `smtps://mail.example.com:465`. Without it, notices stay in the app.
- `SMTP_USER` and `SMTP_PASSWORD_FILE`: the user name, and a file that holds the password. a3t reads it at each sending.
- `MAIL_FROM` (`a3t <noreply@localhost>`): who email comes from.
- `TASK_DUE_SOON_HOURS` (24): how long before a task is due its person hears that it is due soon.
- `NOTICE_RETENTION_DAYS` (90): how long a notice stays, read or not.

In the Helm chart, set `mail.url`, `mail.from`, and `mail.user` with `mail.passwordSecret`, a Secret with the password under the key `password`.

- `GET /v1/me/notices`: your notices, the newest first, with how many are unread; `?unread=true` for the unread only.
- `POST /v1/me/notices/read`: mark some read by their IDs, or all up to a time, so that what came after stays unread.
- `GET` and `PUT /v1/me/notices/settings`: whether your notices come by email too.

### Connecting to other systems

An app connects to a service, at an address, or to a Teams channel (design §6.13). A flow calls the service with a `call_service` step and keeps what it answers in typed variables; another system runs a flow through a webhook, signing each request; a notice posts to the Teams channel. The definition holds no secret: each environment keeps its own, sealed, and whoever manages connections there keeps them, a personal app's owner or a team space's admins. A call goes over https, to an allowed host, never to a private network, and leaves an audit event.

- `SECRETS_KEY_FILE`: a file with the key that seals apps' secrets, 32 random bytes in base64. Production keeps no secrets without it. In the Helm chart, `appSecrets.keySecret`, a Secret with the key under the key `key`.
- `OUTBOUND_HOSTS` (`*`): the hosts connections may call, as names or `*.example.com`.
- `OUTBOUND_PRIVATE_HOSTS`: hosts on a private network that connections may call all the same.
- `OUTBOUND_ALLOW_HTTP` (false): plain http, for development only.
- `SERVICE_TIMEOUT_SECONDS` (10): how long a call may take.

- `GET /v1/apps/{appId}/connections`: the connections and webhooks, and whether the environment keeps each secret. Never the secrets.
- `PUT` and `DELETE /v1/apps/{appId}/connections/{name}/secret`: keep or remove a connection's secret in the environment.
- `POST /v1/apps/{appId}/webhooks/{name}/secret`: make a webhook's key, shown this once.
- `POST /v1/hooks/{environmentId}/{name}`: another system runs the webhook's flow, with `X-A3T-Timestamp` and `X-A3T-Signature: sha256=…`, the HMAC-SHA256 in hex of the time, a dot and the body.

## Delivering a team app

A team app lives in a team space and changes only through reviewed change requests. Give people the space roles first: builders (`space.builder`), reviewers (`space.reviewer`) and release managers (`space.release_manager`). Then, in the studio:

1. **Create it** in the team space: it starts empty.
2. **Edit in my space:** a builder gets a working copy in their personal space, with sample records. They build there, or let Claude build there through `/mcp/build` (`start_working_copy`, then `submit_change`).
3. **Submit change:** the change request shows what changes, the migration Prod would need, who gains or loses access, and which agent tools change. **Try it in the preview** runs the change with test data.
4. **Approve** (someone other than the author), then **Merge** (a release manager).
5. **Cut a release**, then **Deploy to Staging** (at once) or **Ask to deploy to Prod**. A reviewer approves the Prod deployment, with fresh MFA, and the release manager selects **Deploy now**.
6. Under **Access**, a space admin gives people the app's roles in Prod or Staging.
7. **Roll back** makes the previous release live again at once.

The same through the API: `POST /v1/apps/{teamAppId}/working-copy`, `POST /v1/apps/{copyId}/submit`, `POST /v1/change-requests/{id}/reviews` and `/merge`, `POST /v1/apps/{teamAppId}/releases`, `POST /v1/apps/{teamAppId}/deployments`, `POST /v1/deployments/{id}/approve` and `/execute`, and `POST /v1/apps/{teamAppId}/environments/prod/rollback`. Runtime calls take `?env=staging`, or a preview's environment ID, to use an environment other than Prod. Two settings change how many approvals are needed: `CHANGE_APPROVALS` and `DEPLOY_PROD_APPROVALS` (both 1 by default).

### The command line

`ambit` does from a terminal or CI what the studio does for delivery. Build it, then run it with an API token in `AMBIT_TOKEN`, never in the command:

```bash
pnpm --filter @platform/cli build
```

```bash
export AMBIT_URL=https://ambit.example.com
```

```bash
node apps/cli/dist/bin.js deploy expenses --release 4 --env prod --wait
```

`ambit help` lists the commands: `templates`, `apps`, `export`, `import`, `check` (offline), `release`, `releases`, `deploy`, `deployments` and `rollback`. Add `--json` for machine-readable output. The token's scopes limit what it can do: naming a space needs `space.read`, and deploying needs `deploy.request` and `deploy.execute`. In CI, use a team space's service account.

### Templates, export and import

A new app starts blank, or from a template: expense claims, leave requests or purchase requests (`GET /v1/templates`). **History** › **Download the definition** saves an app as a file (`GET /v1/apps/{appId}/export`): its definition, never its data. **Start from** › **A file…** imports one, edited or not (`POST /v1/spaces/{spaceId}/apps/import`, with a `template` or a `bundle`). In a personal space the app is ready at once; in a team space it arrives as a change request.

### Moving a personal app to a team space

When a personal app outgrows its owner and a few colleagues, its owner opens **Share** and chooses **Move to a team space** (`POST /v1/apps/{appId}/promote`, with the target `spaceId`). The team space gets a new app, and a change request that brings in the personal app's definition; its reviewers check it like any change. The personal app keeps working until the team app first runs in Prod. Then it is read-only, and points to the team app. Its records stay where they are.

### Flows

A flow is the app's logic: it finds, creates, changes and deletes records, loops, branches, totals, calls other flows and handles errors, in one transaction. An action names its flow (`"flow": {"flow": "record_spend", "input": {"claim": {"ref": "record"}}}`), and so can a process's service task. A role lists the flows its holders may run:

- `POST /v1/apps/{appId}/flows/{flow}/run`, with its `input` (records by their IDs) and `dryRun`. The answer is the flow's result, its warnings, and how many records it created, changed and deleted. A dry run does all of it, and then undoes it.

### Business processes

A process starts when an action that its start event names commits on a record, or by hand (`POST /v1/apps/{appId}/processes/{process}/start`) for someone whose role may start it. The leave template has one: the manager the employee names decides within three days.

- `GET /v1/me/tasks`: your tasks across apps, the soonest due first; `?status=closed` for the ones you finished.
- `POST /v1/tasks/{taskId}/complete`, with an `outcome`: an outcome that runs an action runs it as you. From an API token, the action becomes a proposal, and the task completes when the person approves it.
- `GET /v1/apps/{appId}/entities/{entity}/records/{id}/processes`: where a record's processes are, for whoever can read the record.
- `GET /v1/apps/{appId}/process-instances?stuck=true`, `…/{instanceId}`, `…/{instanceId}/retry` and `…/{instanceId}/cancel`: for an app's operators (its owner, in a personal space).
- `POST /v1/apps/{appId}/signals`, with a signal's `name`, and an `entity` and `recordId` for the processes it starts: throws the signal to every process of the app that waits for it. It takes `process.admin`.

A task goes to whoever a field of the record names, or, from the directory, to the manager of whoever a field names, such as the requester's manager, up to five levels up the reporting line. A task for nobody in particular can be kept to the department of whoever a field names. Someone away names who covers for them (`PUT /v1/me/cover`), and new tasks go to their cover until then. A person hands their task to a colleague with the same role (`POST /v1/tasks/{taskId}/reassign`), operators move any task of an app they operate, and anyone with a task's role takes one that waits for nobody in particular (`…/claim`).

The directory's departments and managers come from the IdP at each sign-in, from the claims that `OIDC_DEPARTMENT_CLAIM` and `OIDC_MANAGER_CLAIM` (the manager's email) name. Directory admins set them by hand where the IdP doesn't (`PATCH /v1/people/{userId}/directory`), and a loop in the reporting line is refused.

A message is one of the app's update actions, saved on the process's record: a process can wait for it, or let it take a task away, as when the employee withdraws a request while the manager decides. An error event on a service task catches its action's failure, and the process takes the error's path instead of waiting for an operator.

A script task changes the record with Ambit's steps, never code. A rule check checks the record against the app's rules and goes on by what it finds: passed, warned or failed. A send task runs an update action as a message, on the record or on one it refers to, and the processes there hear it; a receive task waits for one.

A sub-process is a part of a process with its own start and end: a deadline or a withdrawal on its boundary acts on all of it, and an error event on it catches an action that fails inside it. A call activity runs another process of the app and waits until it ends, on the same record or on the record that a reference field names; `calledBy` on an instance says which instance called it.

Several people can decide one task, each with a vote in their inbox: everyone with the role, the people some fields of the record name, or the reporting line up from the requester, at once or one after another. The first vote decides, or enough votes for one outcome (a number, all, or a majority); for example, "all approve, or one rejection rejects". Once the votes decide, the outcome's action runs with the app's authority.

Agents get `my_tasks` and `complete_task` on `/mcp` once an app they can use has a process. Operators' AI clients get the operator routes above as tools on `/mcp/ops`, with the same checks. `PROCESS_TIMER_INTERVAL_SECONDS` (5) sets how often due timers fire; 0 leaves them to a worker.

a3t keeps no BPMN files: it neither imports nor exports BPMN 2.0 XML (design §6.11).

### Connecting an agent that serves many people

1. Create a service account for the agent in a team space (`POST /v1/spaces/{spaceId}/service-accounts`), and give it a token (`POST /v1/service-accounts/{id}/tokens`).
2. A Security admin approves it as an agent, choosing what it may do for people (`PUT /v1/service-accounts/{id}/agent`, with scopes from `app.run`, `action.run`, `query.run` and `record.read`).
3. For each person, the agent exchanges the token the IdP gave it for that person:

   ```bash
   curl -X POST http://localhost:3000/v1/oauth/token -H 'authorization: Bearer plt_sat_...' \
     -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
     -d subject_token_type=urn:ietf:params:oauth:token-type:id_token -d subject_token=<the person's ID token>
   ```

4. It calls `/mcp` with the token it gets back (`plt_dlg_...`), which lasts 10 minutes.

The person's token must be issued for an audience Ambit accepts: its own client ID, or the agent's, listed in `TOKEN_EXCHANGE_AUDIENCES`. With Entra ID, set `OIDC_SUBJECT_CLAIM=oid` before anyone signs in, so agents and sign-ins name people the same way.

## Deploying to Kubernetes

The chart in `deploy/helm/platform` runs on any conformant cluster. It includes:

- restricted pod security;
- probes, autoscaling, a disruption budget and zone spreading;
- a default-deny network policy;
- migrations as a pre-install and pre-upgrade job.

Secrets come from an existing Secret, which your secret manager creates. The chart refuses to put secrets in values:

```bash
kubectl create secret generic platform-secrets \
  --from-literal=DATABASE_URL='postgres://...' \
  --from-literal=COOKIE_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OIDC_CLIENT_SECRET='...' \
  --from-file=AUDIT_SIGNING_KEY_PEM=audit-signing-key.pem
```

```bash
helm install platform deploy/helm/platform \
  --set image.repository=ghcr.io/your-org/platform-api \
  --set config.PUBLIC_BASE_URL=https://platform.example.com \
  --set config.OIDC_ISSUER=https://login.example.com
```

The database user needs the `CREATEROLE` attribute: each app environment gets its own `NOLOGIN` role, and the API switches to it for every query on that app's data. A managed PostgreSQL's administrator user usually has it.

The values schema rejects plain-http URLs, secrets in values and development-only settings. CI lints the chart and validates the rendered manifests against Kubernetes schemas.

`deploy/helm/e2e/run.sh` installs the chart on a throwaway [kind](https://kind.sigs.k8s.io/) cluster and proves that:

- the migration job runs before the pods start;
- the pods are admitted in a namespace that enforces the "restricted" Pod Security Standard, while a privileged pod is not;
- the API answers health checks, and sign-in returns 503 while the identity provider is unreachable;
- the network policy blocks other namespaces;
- `helm upgrade` rolls the pods without failing a request.

CI runs it on every pull request. To run it yourself:

```bash
docker build -f apps/api/Dockerfile -t platform-api:e2e . && deploy/helm/e2e/run.sh
```
