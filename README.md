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
- **Built so far:** phase 0, the governance kernel, proven on a real Kubernetes cluster; the backend of phase 1, the capability core, with line items; and the first slice of the studio: the data-model and form designers, and the screens every app gets (below). File fields are next.

## What the code does today

| Area | Implemented |
|---|---|
| Identity | Sign-in with any OIDC provider (authorization code + PKCE). Just-in-time provisioning, IdP group sync, server-side sessions with revocation, MFA evidence from standard `amr`/`acr` claims, step-up sign-in |
| Spaces | A personal space for every user, created at first sign-in. Team spaces with a minimum number of owners. Freezing |
| Authorization | One policy decision point (`@platform/authz`): permissions, permission sets, roles, scoped bindings with expiry, the personal-space boundary, guardrails (deny and fresh-MFA rules), separation of duties, privilege-escalation checks and explained decisions. Every route must declare an access rule, or the server refuses to start |
| API tokens | Personal access tokens and service accounts owned by team spaces. Tokens are scoped, expire (90 days at most by default), are stored only as hashes, and can only be created from an interactive session with fresh MFA. Service accounts start with no access and gain it only through bindings. Admins can list and revoke any token, and every step is audited |
| Apps (built-in store) | Apps live in personal spaces, defined as entities, rules, actions, queries, review cards and roles:<ul><li>Each app environment gets its own database schema and NOLOGIN role, and every query switches to that role.</li><li>Definitions are versioned. Entities and fields have stable IDs, so a rename is free and carries through to every reference. Changes apply live, but anything that deletes data waits for confirmation.</li><li>Record- and field-level permissions are compiled to SQL filters, and PII is masked by default.</li><li>Every record keeps a field-level history, with where each value came from.</li><li>Line items: a record can hold lines of another entity, such as one line per receipt on a claim. Lines are read, written, permitted and kept in history with their record, each value with its source. Rules check every line, and totals and counts are worked out from the lines (rollups).</li><li>Apps can be shared with named colleagues, each in one of the app's roles.</li></ul> |
| Studio | A web app at `/studio`, in the Ocean design system, light and dark:<ul><li>The data designer: entities and fields, drag to reorder, and renames that keep the data. Saving shows the plan first, and asks again before anything deletes data.</li><li>The form designer: sections, half- or full-width fields, labels and help text, and the action a form submits through, so its rules and confirmation apply.</li><li>Every app's screens, generated from what the person may do: lists, forms, and record pages that show who changed what and when. Person fields have a picker. A colleague in a narrower role sees only what that role allows.</li><li>Sharing, the revision history, and an editor for what has no designer yet (rules, actions, queries, cards and roles).</li></ul> |
| Agents | Every action and query a person may run is an MCP tool (`/mcp`), and AI clients such as Claude can build apps through a second MCP server (`/mcp/build`). An agent that serves many people, such as agentos or a Copilot Studio bot, is approved by a Security admin, then exchanges a person's IdP token for a 10-minute Ambit token that acts for that one person (RFC 8693). Agents work through errands only, never on raw records, and the audit log names both the agent and the person. When an API token runs an action that needs confirmation, the action becomes a proposal sealed with a digest. Only the person, signed in, can approve exactly that change, on a review page where they can also edit it |
| Audit | Every change writes its audit event in the same transaction. The tables are append-only (database triggers). A background sealer signs chained RFC 6962 Merkle batches with Ed25519, and a verifier detects edits, deletions and insertions |
| Operations | Health and readiness probes, OpenTelemetry traces and metrics (OTLP), structured logs, graceful shutdown, a container image, generated OpenAPI, and a hardened Helm chart (below) |

Next, to finish phase 1 (§13 of the design doc): file fields, so each line of a claim keeps its receipt.

Later: workload identity federation, so CI systems can swap their own OIDC tokens for short-lived platform tokens with no stored secrets.

## Repository layout

```text
apps/api            Fastify API: auth, spaces, bindings, apps, records, actions, proposals, MCP, audit, health
apps/studio         Ambit Studio (React, Vite, Tailwind): the designers and every app's screens, served by the API at /studio
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

The studio's browser test runs in Chromium through Playwright, which isn't a dependency, so it's opt-in. It drives a real API and saves screenshots if you name a folder:

```bash
pnpm --filter @platform/studio build && STUDIO_E2E=1 SCREENSHOT_DIR=/tmp/shots \
  TEST_DATABASE_URL=postgres://platform:platform@localhost:5432/platform pnpm --filter @platform/api test:integration -- studio
```

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

Sign in as `alice` and open http://localhost:3000/studio/. Create an app, starting from the example, an expense-claim app. Change its fields in the data designer, lay out its form, and share it with `bob` as a requester. **Open the app** shows the screens everyone gets; sign in as `bob` to see his narrower view.

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
