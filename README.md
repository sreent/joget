# joget

Design and first code for a **governed capability platform for people and AI agents**. People ask for outcomes, in Teams, Slack or any other chat app, through an agent, or on the web. Builders, working with an AI copilot, publish the capabilities that deliver them: actions, queries, rules and review cards. Every capability is an MCP tool and an API operation. An agent always acts for a named person, and the person confirms what matters before it's committed. Roles, personal and team spaces, permission sets, efficient deployment, monitoring and a full audit trail govern all of it.

The goal is not to clone Joget DX but to surpass it: match its builder breadth, beat it on governance, isolation, delivery, observability and audit, and build on a modern TypeScript stack. The working name is a placeholder; the product should get its own name rather than reuse the Joget trademark.

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
  - people build with an AI copilot, and AI clients such as Claude can build through an MCP server.
- **Still open** (§14 of the design doc): workflow depth, PostgreSQL-only (the working assumption), the product name, and which chat platforms can carry an approval.
- **Built so far:** phase 0, the governance kernel (below), proven on a real Kubernetes cluster. The first piece of phase 1 is also built: the policy engine turns record-level conditions into database filters.

## What the code does today

| Area | Implemented |
|---|---|
| Identity | Sign-in with any OIDC provider (authorization code + PKCE). Just-in-time provisioning, IdP group sync, server-side sessions with revocation, MFA evidence from standard `amr`/`acr` claims, step-up sign-in |
| Spaces | A personal space for every user, created at first sign-in. Team spaces with a minimum number of owners. Freezing |
| Authorization | One policy decision point (`@platform/authz`): permissions, permission sets, roles, scoped bindings with expiry, the personal-space boundary, guardrails (deny and fresh-MFA rules), separation of duties, privilege-escalation checks and explained decisions. Every route must declare an access rule, or the server refuses to start |
| API tokens | Personal access tokens and service accounts owned by team spaces. Tokens are scoped, expire (90 days at most by default), are stored only as hashes, and can only be created from an interactive session with fresh MFA. Service accounts start with no access and gain it only through bindings. Admins can list and revoke any token, and every step is audited |
| Audit | Every change writes its audit event in the same transaction. The tables are append-only (database triggers). A background sealer signs chained RFC 6962 Merkle batches with Ed25519, and a verifier detects edits, deletions and insertions |
| Operations | Health and readiness probes, OpenTelemetry traces and metrics (OTLP), structured logs, graceful shutdown, a container image, generated OpenAPI, and a hardened Helm chart (below) |

Next is phase 1, the capability core (§13 of the design doc):
- the built-in store, with record- and field-level permissions and record history;
- rules, actions and queries;
- review cards and proposals, with confirmation enforced by the platform;
- MCP endpoints for agents and for AI builders such as Claude.

Later: workload identity federation, so CI systems can swap their own OIDC tokens for short-lived platform tokens with no stored secrets.

## Repository layout

```text
apps/api            Fastify API: auth, spaces, bindings, explain, audit, health
packages/authz      Policy decision point (pure TypeScript, no I/O)
packages/audit      Canonical hashing, Merkle seals, signatures, verification
packages/db         Drizzle schema, SQL migrations, seeding, test-database helper
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

### Tests

Unit tests need nothing else:

```bash
pnpm test
```

Integration tests run against a real PostgreSQL. Each test file gets its own throwaway database:

```bash
TEST_DATABASE_URL=postgres://platform:platform@localhost:5432/platform pnpm test:integration
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
