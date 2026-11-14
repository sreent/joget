# joget

Design and first code for a **governed, multi-user, enterprise-grade low-code application platform**. Users and teams build forms, views, pages and workflows, with roles, personal and team spaces, permission sets, efficient deployment, monitoring and a full audit trail.

The goal is not to clone Joget DX but to surpass it: match its builder breadth, beat it on governance, isolation, delivery, observability and audit, and build on a modern TypeScript stack. The working name is a placeholder; the product should get its own name rather than reuse the Joget trademark.

## Documents

| Document | What it covers |
|---|---|
| [docs/01-joget-review.md](docs/01-joget-review.md) | A review of Joget DX 9.1 (Community Edition source) against our requirements: what to borrow, what to avoid, and whether to fork or build |
| [docs/02-platform-design.md](docs/02-platform-design.md) | The design: spaces, identity, roles and permission sets, governed app lifecycle, cloud-agnostic Kubernetes deployment, monitoring, audit, reference stack, roadmap, decisions and the ISO 27001 control mapping |
| [docs/03-n8n-reference.md](docs/03-n8n-reference.md) | Prior art: n8n's tech stack and governance model, read from its source, and what it means for our choices |

## Status

- **Decided:** build new; one company; cloud-agnostic on Kubernetes; IdP-agnostic; TypeScript; ISO 27001:2022; no data-residency constraint. Building happens in personal spaces, and team spaces run Prod, with a preview for each change request.
- **Still open** (§14 of the design doc): workflow depth, PostgreSQL-only (the working assumption), and the product name.
- **Built so far:** the first slice of phase 0, the governance kernel (below).

## What the code does today

| Area | Implemented |
|---|---|
| Identity | Sign-in with any OIDC provider (authorization code + PKCE). Just-in-time provisioning, IdP group sync, server-side sessions with revocation, MFA evidence from standard `amr`/`acr` claims, step-up sign-in |
| Spaces | A personal space for every user, created at first sign-in. Team spaces with a minimum number of owners. Freezing |
| Authorization | One policy decision point (`@platform/authz`): permissions, permission sets, roles, scoped bindings with expiry, the personal-space boundary, guardrails (deny and fresh-MFA rules), separation of duties, privilege-escalation checks and explained decisions. Every route must declare an access rule, or the server refuses to start |
| Audit | Every change writes its audit event in the same transaction. The tables are append-only (database triggers). A background sealer signs chained RFC 6962 Merkle batches with Ed25519, and a verifier detects edits, deletions and insertions |
| Operations | Health and readiness probes, OpenTelemetry traces and metrics (OTLP), structured logs, graceful shutdown, a migration entry point for a Kubernetes Job, a container image, and generated OpenAPI |

Next: service accounts and API tokens, the Helm chart, then phase 1 (entities, forms, views, record-level permissions).

## Repository layout

```text
apps/api            Fastify API: auth, spaces, bindings, explain, audit, health
packages/authz      Policy decision point (pure TypeScript, no I/O)
packages/audit      Canonical hashing, Merkle seals, signatures, verification
packages/db         Drizzle schema, SQL migrations, seeding, test-database helper
deploy/compose      Local PostgreSQL and a sample IdP (Keycloak)
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

Run migrations as a one-off job before starting new API pods (`node dist/migrate.js`), and give the API an Ed25519 signing key for audit seals:

```bash
pnpm --filter @platform/api audit:keygen
```
