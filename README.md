# joget

Design work for a **governed, multi-user, enterprise-grade low-code application platform**. Users and teams build forms, views, pages and workflows, with roles, personal and team spaces, permission sets, efficient deployment, monitoring and a full audit trail.

The goal is not to clone Joget DX but to surpass it: match its builder breadth, beat it on governance, isolation, delivery, observability and audit, and build on a modern TypeScript stack.

The working name is a placeholder. The product should get its own name rather than reuse the Joget trademark.

## Documents

| Document | What it covers |
|---|---|
| [docs/01-joget-review.md](docs/01-joget-review.md) | A review of Joget DX 9.1 (Community Edition source) against our requirements: what to borrow, what to avoid, and whether to fork or build |
| [docs/02-platform-design.md](docs/02-platform-design.md) | The proposed design: spaces, identity, roles and permission sets, governed app lifecycle, deployment on the cloud, monitoring, audit, reference stack, roadmap, decisions and the ISO 27001 control mapping |
| [docs/03-n8n-reference.md](docs/03-n8n-reference.md) | Prior art: n8n's tech stack and governance model, read from its source, and what it means for our choices |

## Status

Design stage, no code yet.

- **Decided:** build new; one company; public cloud; ISO 27001:2022.
- **Still open** (§14 of the design doc): cloud provider, identity provider, team skills (TypeScript is the default), workflow depth, PostgreSQL-only, and data residency.
