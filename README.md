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
- **Still open** (§14 of the design doc): workflow depth, PostgreSQL-only (the working assumption), and which chat platforms can carry an approval.
- **Built so far:**
  - phase 0, the governance kernel, proven on a real Kubernetes cluster;
  - phase 1, the capability core with line items and files, the studio's data-model and form designers, and the screens every app gets;
  - from phase 2: governed delivery for team apps (working copies, change requests with checks and previews, signed releases, approved deployments to Prod and Staging, and rollback); the designers for rules, actions, queries, review cards, roles, pages, the menu and dashboards; steps for actions (they can start a7c skills too, switched off until an installation connects a7c); moving a personal app to a team space; queries that total and group, for agents; app templates, export and import; and the command line, `ambit`.
- **Next:** phase 3, approvals and the shared agent: business processes in BPMN 2.0 on Ambit's own engine, with human tasks, a universal inbox and approving in chat. A business process, where people decide on an app's records, is Ambit's; automation across systems is a7c's ([design §6.10](docs/02-platform-design.md#610-business-processes-bpmn-20)).

## What the code does today

| Area | Implemented |
|---|---|
| Identity | Sign-in with any OIDC provider (authorization code + PKCE). Just-in-time provisioning, IdP group sync, server-side sessions with revocation, MFA evidence from standard `amr`/`acr` claims, step-up sign-in |
| Spaces | A personal space for every user, created at first sign-in. Team spaces with a minimum number of owners. Freezing |
| Authorization | One policy decision point (`@platform/authz`): permissions, permission sets, roles, scoped bindings with expiry, the personal-space boundary, guardrails (deny and fresh-MFA rules), separation of duties, privilege-escalation checks and explained decisions. Every route must declare an access rule, or the server refuses to start |
| API tokens | Personal access tokens and service accounts owned by team spaces. Tokens are scoped, expire (90 days at most by default), are stored only as hashes, and can only be created from an interactive session with fresh MFA. Service accounts start with no access and gain it only through bindings. Admins can list and revoke any token, and every step is audited |
| Apps (built-in store) | Apps live in personal spaces, where their builder edits them live, or in team spaces, where they change only through reviewed change requests (below). They are defined as entities, rules, actions, queries, review cards and roles:<ul><li>Each app environment gets its own database schema and NOLOGIN role, and every query switches to that role.</li><li>Definitions are versioned. Entities and fields have stable IDs, so a rename is free and carries through to every reference. Changes apply live, but anything that deletes data waits for confirmation.</li><li>Record- and field-level permissions are compiled to SQL filters, and PII is masked by default.</li><li>Every record keeps a field-level history, with where each value came from.</li><li>Line items: a record can hold lines of another entity, such as one line per receipt on a claim. Lines are read, written, permitted and kept in history with their record, each value with its source. Rules check every line, and totals and counts are worked out from the lines (rollups).</li><li>Files, such as receipts: each upload is checked for what it really is and scanned for malware (ClamAV), then kept in the app's own schema or any S3-compatible store. Only whoever can see the field holding a file can download it.</li><li>Apps can be shared with named colleagues, each in one of the app's roles.</li></ul> |
| Studio | A web app at `/studio`, in the Ocean design system, light and dark:<ul><li>The data designer: entities and fields, drag to reorder, and renames that keep the data. Saving shows the plan first, and asks again before anything deletes data.</li><li>The form designer: sections, half- or full-width fields, labels and help text, and the action a form submits through, so its rules and confirmation apply.</li><li>Every app's screens, generated from what the person may do: lists, forms, and record pages that show who changed what and when. Person fields have a picker. A colleague in a narrower role sees only what that role allows.</li><li>Designers for rules, actions, queries (which answer with records, a number, or a number for each group), review cards and roles: conditions are built as clauses (a field, a test, a value), and roles as a matrix of who may do what with which records.</li><li>The page and menu designers. A page is blocks: text, lists of records (columns, which records, their order, and one-click row actions such as Approve) and buttons that open forms or pages. The menu orders pages, forms and lists under headings, and names the home page. Each person sees only the pages, columns, buttons and items their role can use.</li><li>Dashboards: numbers and charts on a page. A number counts records or their lines, or works out a sum, an average, the lowest or the highest, for the records that meet a condition and fall in a time range. A chart groups by a field or by a period, as bars, columns, a line or a table, and every chart has a table view. The database works them out under the person's own permissions, and refuses a total over a field their role masks.</li><li>Steps for actions: set a value, add a line, check, branch, and, where the installation connects a7c, start an a7c skill. A value comes from a fixed value, a field, the person, today, a calculation or text joined from parts. A record's page shows the work in other systems that its actions started, and how each call went.</li><li>Sharing, the revision history, and the whole definition as JSON. New apps start blank, from a template, or from a file someone downloaded.</li><li>For team apps: delivery (environments, releases, deployments waiting for approval, rollback, history), change requests with their checks and reviews, the preview of each change, access per environment, and a prompt to sign in again when Prod needs fresh MFA.</li></ul> |
| Governed delivery | Team apps follow design §3, §6.7 and §7.1:<ul><li>**Working copies.** *Edit in my space* makes a working copy of a team app in the builder's personal space, with the same stable IDs and sample records, never Prod data. The builder changes it freely.</li><li>**Change requests.** *Submit change* opens a change request with automatic checks: validation, what changes artifact by artifact, the migration Prod would need (steps that delete data flagged), who gains or loses access (from the compiled roles, with how many hold each role now), which agent tools change, and lint. A preview, a temporary environment, runs the change for reviewers and testers.</li><li>**Review.** Someone other than the author approves (a guardrail); a new version needs approval again. Builders work at the same time: the merge is three-way at the artifact level, and conflicts are shown.</li><li>**Releases.** A release is one main-line revision, hashed and signed, and a database trigger keeps it from changing. A change that deletes data goes in a release of its own.</li><li>**Deployments.** Staging deploys at once. Prod needs an approval from someone who wrote none of the changes, and fresh MFA. The migration, a smoke check and the switch to the new release happen in one transaction. Releases that delete data are deployed in order.</li><li>**Rollback.** It makes the previous release live again in milliseconds. The data keeps the newer shape (expand and contract), and a rollback across a release that deleted data is refused.</li><li>**Promotion.** *Move to a team space* turns a personal app into a change request in a team space, with the personal app's definition. The personal app keeps working until the team app first runs in Prod; then a guardrail makes it read-only, and it points to the team app. Its data stays where it is.</li></ul> |
| Steps and a7c | An action's steps run when its change is worked out, so a preview and a proposal show their result, and a proposal's digest covers the skills it starts (design §6.2). Skill steps are switched off until an installation connects a7c (`A7C_URL`):<ul><li>Fields that steps set count as written by the person, so their role's field permissions apply, and the rules run on the result.</li><li>A skill step writes its call to an outbox, in the change's own transaction. A dispatcher starts each call in a7c through `runs.start`, with the call's ID as the idempotency key, tries again while a7c is away, and stops when a7c refuses. Every step of a call is audited.</li><li>A sandbox starts skills in a7c's personal tier, Staging and previews in its team tier, and only Prod in its production tier.</li><li>A call's input is never shown: it can hold values the reader can't see. Operators list an app's calls, and try a failed one again.</li></ul> |
| Agents | Every action and query a person may run is an MCP tool (`/mcp`), and AI clients such as Claude can build apps through a second MCP server (`/mcp/build`). An agent that serves many people, such as agentos or a Copilot Studio bot, is approved by a Security admin, then exchanges a person's IdP token for a 10-minute Ambit token that acts for that one person (RFC 8693). Agents work through errands only, never on raw records, and the audit log names both the agent and the person. A query can answer with numbers, such as the person's spending by category this year, so an agent asks the question rather than adding up records. When an API token runs an action that needs confirmation, the action becomes a proposal sealed with a digest. Only the person, signed in, can approve exactly that change, on a review page where they can also edit it |
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
- **Build with Claude:** add `http://localhost:3000/mcp/build`, with a token scoped to `app.create`, `app.read` and `app.edit`.

When an agent submits a claim, the person gets a review link: they check the card, edit what's wrong, and approve.

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

### Starting work in other systems with a7c

a7c is left out for now: it is switched off until an installation connects it. Until then, a definition whose actions start a7c skills is refused, and the templates start none. When a7c is ready, an action's steps can start its skills, such as paying an approved claim. Point Ambit at a7c with two settings: `A7C_URL`, a7c's control plane, and `A7C_TOKEN_FILE`, a file that holds Ambit's a7c token. Ambit reads the file at each call, so whatever issues the token can renew it. In the Helm chart, set `a7c.url` and `a7c.tokenSecret`, a Secret with the token under the key `token`. Without them, the calls wait in the outbox.

- `GET /v1/apps/{appId}/entities/{entity}/records/{id}/skill-calls`: the skills a record's actions started, for whoever can read the record.
- `GET /v1/apps/{appId}/skill-calls?status=failed`: an app's calls, for its operators (its owner, in a personal space).
- `POST /v1/apps/{appId}/skill-calls/{id}/retry`: try a failed call again, under the same idempotency key.

`SKILL_DISPATCH_INTERVAL_SECONDS` (5) sets how often calls are sent, and `SKILL_CALL_MAX_ATTEMPTS` (12) how many tries a call gets.

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
