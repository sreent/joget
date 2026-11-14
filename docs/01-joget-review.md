# Joget DX review: what to borrow, what to avoid

> **Status:** draft v0.1 · 2026-11-14
> **Companion:** [02-platform-design.md](02-platform-design.md), the design that follows from this review.

<!-- TLDR -->

---

## 1. What we reviewed

- **Source:** [`jogetworkflow/jw-community`](https://github.com/jogetworkflow/jw-community), branch `9.1-RELEASE`, commit `5994fbc` (2026-11-10). This is the **Community Edition (CE)**, licensed under **GPLv3**. The Professional, Enterprise and Large Enterprise editions are commercial and their code is not public.
- **Method:** we read the source against each of our requirements and checked Joget's public [feature comparison](https://www.joget.org/product/features/) and [licensing](https://joget.com/platform-guide/licensing-and-total-cost-of-ownership/) pages for Enterprise-only features. File references below are paths inside that repository.
- **Limits:** where CE ships only an interface, a stub or a check against a licence, we say so. Several of Joget's knowledge-base pages could not be fetched, so some Enterprise details are unconfirmed and marked as such.

## 2. How Joget works

**Stack.** Java 17, Spring 6.2 (MVC and Security 6.5), Hibernate 6.6, Jakarta Servlet 6, Ehcache 3, JSP-based consoles, BeanShell 2.0b6, JGit 6.10, and the **Enhydra Shark** workflow engine (XPDL). It ships as a single web application, `jw.war`. The libraries are current; the architecture (server-rendered JSP consoles, the Shark/XPDL engine, one monolith with a local data directory) belongs to an older generation.

| Module | Role |
|---|---|
| `wflow-commons` | Utilities, datasource profiles, caching, host/profile resolution |
| `wflow-directory` | Users, groups, organizations, departments, grades, roles; the directory-manager, identity-provider and MFA plugin interfaces |
| `wflow-wfengine`, `wflow-shark` | Workflow services wrapped around Enhydra Shark |
| `wflow-plugin-base` | The plugin framework |
| `wflow-core` | Apps: app definitions, forms, datalists, userviews, audit trail, governance health checks, reports |
| `wflow-consoleweb` | The web console, the builders, the JSON APIs and the runtime UI (`jw.war`) |

**App model.** An *app* is identified by `appId` + `version`. It bundles **forms** (which also define the data tables), **datalists** (list views), **userviews** (the app's UI: menus and pages), one **process package** (XPDL), plugin default settings, **environment variables**, message bundles and resources. Plugins extend almost everything: form elements, binders, datalist actions, userview menus, permissions, process tools, themes, directory managers and identity providers.

<!-- FINDINGS -->

---

## 6. Fork or build?

**Recommendation: build a new platform, and use Joget as the reference for the app model and builder UX, not as the codebase.**

| Factor | Fork Joget CE | Build new |
|---|---|---|
| Time to a first demo | Fast: forms, lists, userviews, processes and plugins already work | Slower: the builders must be written |
| Governance requirements | Spaces, ownership, scoped roles, permission sets and audit would touch nearly every DAO, query, builder and security check. After that, merging from upstream is no longer practical | Designed in from day one ([design §5](02-platform-design.md#5-authorization-roles-permission-sets-bindings)) |
| Features you would expect | Several governance features (LDAP/AD, MFA, password policies, Performance Analyzer, API Builder, clustering) are Enterprise-only and not in the code you can fork | You build only what you need |
| Licence | GPLv3. Distributing a fork (for example, on-premises installs for customers) requires releasing its source under GPLv3. Pure SaaS use does not trigger that (GPLv3 is not AGPL), but it limits your options later | Your choice |
| Brand | You cannot use the Joget name | Your own |
| Long-term cost | You own a large monolith with JSP consoles and an XPDL engine | You own a codebase shaped around governance |

Two caveats:

- **Building a low-code platform is a multi-year product investment.** If what you actually need is *a* governed low-code platform for internal use, rather than a product of your own, first evaluate Joget Enterprise and similar platforms against the [design doc's](02-platform-design.md) requirements.
- **Joget CE is still useful while you build:** run it locally as a reference to study builder behaviour, edge cases and the app-model details you are replacing.
