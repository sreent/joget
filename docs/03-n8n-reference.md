# n8n reference: tech stack and governance model

> **Status:** reference note · 2026-11-14
> **Source:** [`n8n-io/n8n`](https://github.com/n8n-io/n8n/tree/251c44bc5e072afcc3daab3c3d1baf525afd8d41), `main` at commit `251c44b` (2026-11-14). This note comes from reading the repository's package manifests, configuration and module layout; we did not run n8n.
> **Why:** n8n is a modern platform in the same category as ours (visual building, workflows, integrations), so its stack and governance choices are useful prior art for the [design](02-platform-design.md).

## 1. Tech stack

| Layer | What n8n uses | Where we saw it |
|---|---|---|
| Language and runtime | TypeScript on Node.js 24 or later | Root `package.json` (`engines`) |
| Monorepo | pnpm 12 workspaces with version catalogs, plus Turborepo with package boundaries | `package.json`, `pnpm-workspace.yaml`, `turbo.json` |
| Backend HTTP | Express 5 | `packages/cli/package.json`, catalog |
| DI and configuration | n8n's own dependency-injection container (`@n8n/di`), and typed configuration validated with Zod (`@n8n/config`) | `packages/@n8n/di`, `packages/@n8n/config` |
| Database | n8n's own fork of TypeORM (`@n8n/typeorm`). **SQLite (the default) or PostgreSQL only**; other databases are no longer supported | `packages/@n8n/config/src/configs/database.config.ts` |
| Queue and scaling | Bull 4 on Redis (ioredis) for "queue mode": main instances, workers and webhook processors. Multi-main and worker pools are Enterprise features | `packages/cli/package.json`, `packages/cli/src/scaling/` |
| Execution engine | n8n's own engine (`packages/core`, `packages/workflow`), plus a newer engine package on PostgreSQL (`@n8n/engine`, "engine v2") | `packages/@n8n/engine` |
| Scheduling | An in-house scheduler package built on cron-parser | `packages/@n8n/scheduler` |
| Running user code | **Task runners in separate processes**, for JavaScript and for Python (3.13 or later), shipped as their own container image (with a distroless variant). Expressions are evaluated in isolated-vm and QuickJS (quickjs-emscripten) | `packages/@n8n/task-runner`, `packages/@n8n/task-runner-python`, `packages/@n8n/expression-runtime`, `docker/images/runners/` |
| Authentication | bcryptjs password hashing, JWT, TOTP MFA (otpauth), SAML (samlify), OIDC (openid-client), LDAP (ldapts) and a SCIM module | `packages/cli/package.json`, `packages/cli/src/modules/` |
| Secrets | External secret stores such as AWS Secrets Manager (Enterprise) | `packages/cli/src/modules/external-secrets.ee/` |
| Observability | Prometheus metrics (prom-client, express-prom-bundle), OpenTelemetry tracing over OTLP, Sentry error reporting. Log streaming, including syslog, is Enterprise | `packages/cli/package.json`, `packages/cli/src/modules/otel/`, `packages/cli/src/modules/log-streaming.ee/` |
| Frontend | Vue 3.5, Pinia, Vue Router, Vite 8, vue-i18n | `packages/frontend/editor-ui/package.json` |
| UI kit | n8n's own design system, built on Element Plus and Reka UI, documented in Storybook | `packages/frontend/@n8n/design-system` |
| Canvas and editors | Vue Flow for the workflow canvas, CodeMirror 6 for code and expression editors | `packages/frontend/editor-ui/package.json` |
| Real-time collaboration | Yjs CRDTs | `packages/@n8n/crdt` |
| AI | LangChain-based AI nodes, an AI workflow builder (Enterprise), agents, and MCP as both server and client | `packages/@n8n/nodes-langchain`, `packages/@n8n/ai-workflow-builder.ee`, `packages/cli/src/modules/mcp*` |
| Testing | Vitest for unit tests (no Jest left), Playwright for end-to-end tests | `vitest.config.*`, `packages/quality/testing/playwright/` |
| Packaging | Docker images built on hardened base images, with a separate image for the task runners | `docker/images/` |
| Licence | The **Sustainable Use License** covers most code: use or modification "only for your own internal business purposes or for non-commercial or personal use". Files or folders marked `.ee` need an n8n Enterprise licence | `LICENSE.md`, `LICENSE_EE.md` |

## 2. Governance model

- **Permissions are scopes** of the form `resource:operation`, for example `workflow:create`, `credential:share` and `project:manageMembers` (`packages/@n8n/permissions/src/constants.ee.ts`).
- **Roles at three levels** (`packages/@n8n/permissions/src/roles/role-maps.ee.ts`):
  - **Global:** owner, admin and member, plus chat-user and agent roles.
  - **Project:** admin, editor, viewer and chat user, plus **personal owner**.
  - **Sharing:** owner and user roles on individual workflows and credentials.
- **Custom roles** (Enterprise) are composed from an allowed set of project and global scopes (`roles/custom-role-scopes.ee.ts`).
- **Personal and team projects.** Every user has a personal project, and teams share projects. This is the same personal/team split as our spaces.
- **Enterprise governance modules** in `packages/cli/src/modules/`:
  - **workflow reviews:** a review lifecycle, a decision policy, a review inbox, and a *publish guard* that blocks publishing until a change is approved;
  - **promotions:** Git-based promotion between environments, with an apply preview;
  - **source control and environments;**
  - **policy infrastructure:** policy decisions with their own audit;
  - **redaction**, **log streaming**, **external secrets**, **SSO** (SAML, OIDC, LDAP), **SCIM provisioning** and **instance reporting**.

## 3. What it means for us

- **Same architecture family.** n8n shows that TypeScript on Node.js, PostgreSQL, Redis-backed queues and out-of-process code runners are a proven stack for this category. Its move to PostgreSQL only (plus SQLite for small installs) supports our PostgreSQL-only recommendation ([design §14](02-platform-design.md#14-decisions)).
- **Vue or React.** n8n chose Vue. We recommend React for its larger ecosystem of builder components (dnd-kit, React Flow), but either works; this is a team-skills choice.
- **Governance is converging on our model.** n8n's newest Enterprise modules match ideas in [design §5–7](02-platform-design.md#5-authorization-roles-permission-sets-bindings): reviews that guard publishing, previewed promotions, audited policy decisions, and personal and team projects with scoped roles. The difference is that n8n sells these as Enterprise features, while for us they are the core.
- **Code isolation.** n8n runs user code in separate runner processes and evaluates expressions in isolates. That is the same principle as our out-of-process sandbox ([design §10](02-platform-design.md#10-extensibility-and-safe-custom-code)), and the opposite of Joget's in-JVM BeanShell.
- **Use n8n as a component?** The Sustainable Use License allows internal business use, so a one-company platform could run n8n for integration-heavy automations instead of building hundreds of connectors. There are trade-offs, though:
  - its own governance features need an n8n Enterprise licence;
  - it brings a second permission model and audit trail that our policy engine and audit log don't govern.

  If you consider it, run it only as a back-end connector engine reached through our platform's service accounts, not as a second platform that users log in to, and check the licence terms with your legal team.
