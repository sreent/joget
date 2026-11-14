# Joget DX review: what to borrow, what to avoid

> **Status:** draft v0.1 · 2026-11-14
> **Companion:** [02-platform-design.md](02-platform-design.md), the design that follows from this review.
> **Scope note:** this is a static design review of the public source code, not a security audit. We did not run or test Joget.

## TL;DR

- **Joget gets the app model right.** It has forms that define data, lists, a UI layer (userviews), processes with org-chart-aware routing, plugins everywhere, app versions, and export/import. That breakdown of an app is worth borrowing.
- **Governance is where it falls short, at least in the Community Edition.** It has four fixed roles and no custom roles. There are no workspaces, teams or personal spaces, and no reusable permission sets: each menu, form and list carries its own inline permission rules.
- **Anyone who can design an app is effectively trusted with the whole platform.** BeanShell scripts run unsandboxed inside the server JVM, an SQL tool targets the platform's own database, and form data tables are shared by every app.
- **Change and deployment are not governed.** Publishing flips a flag, and the published version stays editable. There are no drafts, locks, approvals or rollback. Schema changes are additive DDL applied at runtime, and a git remote can sync definitions and plugins into a running instance.
- **Monitoring and audit are thin.** The audit trail records who called which method, with no outcome, diff, tamper evidence or retention. The record-history table is unused in CE, there are no metrics or health endpoints, and APM is Enterprise-only.
- **Recommendation: build new (§6).** Borrow the app model and builder UX (§5), design governance in from day one, and aim to surpass Joget rather than copy it.

---

## 1. What we reviewed

- **Source:** [`jogetworkflow/jw-community`](https://github.com/jogetworkflow/jw-community/tree/5994fbcf7d761d105b3dac66ed8e3febf9e23fb3), branch `9.1-RELEASE`, commit `5994fbc` (2026-11-10). This is the **Community Edition (CE)**, licensed under **GPLv3**. The Professional, Enterprise and Large Enterprise editions are commercial, and their code is not public.
- **Method:** we read the source against each of our requirements, then checked Joget's public [feature comparison](https://www.joget.org/product/features/) and [licensing](https://joget.com/platform-guide/licensing-and-total-cost-of-ownership/) pages for Enterprise-only features. Each claim below cites the file it came from.
- **Limits:** where CE ships only an interface, a stub or a hook for a licensed edition, we say so. Several of Joget's knowledge-base pages could not be fetched, so some Enterprise details are unconfirmed and are marked as such.

## 2. How Joget works

**Stack.** Joget is built on Java 17, Spring 6.2 (MVC, plus Spring Security 6.5), Hibernate 6.6, Jakarta Servlet 6 and Ehcache 3, with JSP-based consoles, BeanShell 2.0b6, JGit 6.10 and the **Enhydra Shark** workflow engine (XPDL). It ships as a single web application, `jw.war`. The libraries are current, but the architecture belongs to an older generation: server-rendered JSP consoles, the Shark/XPDL engine, and one monolith with a local data directory.

| Module | Role |
|---|---|
| `wflow-commons` | Utilities, datasource profiles, caching, resolving the host to a profile |
| `wflow-directory` | Users, groups, organizations, departments, grades and roles; the directory-manager, identity-provider and MFA plugin interfaces |
| `wflow-wfengine`, `wflow-shark` | Workflow services wrapped around Enhydra Shark |
| `wflow-plugin-base` | The plugin framework (Apache Felix OSGi) |
| `wflow-core` | Apps: app definitions, forms, datalists, userviews, audit trail, governance health checks, reports |
| `wflow-consoleweb` | The web console, the builders, the JSON APIs and the runtime UI (`jw.war`) |

**App model.** An *app* is identified by `appId` + `version`. It bundles:

- **forms**, which also define the data tables;
- **datalists** (list views);
- **userviews**, which are the app's UI: menus and pages;
- one **process package** (XPDL);
- plugin default settings, **environment variables**, message bundles and resources.

Plugins extend almost everything: form elements, binders, datalist actions, userview menus, permissions, process tools, themes, directory managers and identity providers.

**Storage.** Every app version is a full copy. Rows are keyed by (appId, version) in:

- `app_app`;
- `app_form`, `app_datalist`, `app_userview` and `app_builder`, where each definition is a JSON text blob;
- the tables for environment variables, messages, plugin defaults and resources.

The XPDL lives in Shark's own tables, and form data lives in `app_fd_<table>` tables. One database holds the definitions, the app data, the workflow engine and the user directory. A local data directory (`wflow.home`) holds files, generated mappings, plugin JARs and the per-app git repositories.

---

## 3. Scorecard against our requirements

| Requirement | Joget CE today | What Enterprise adds (per Joget's feature page) | Rating |
|---|---|---|---|
| Multi-user | Users, groups, organizations, departments, grades and reporting lines, with a pluggable directory | LDAP/AD integration | **Partial:** a good directory, but no isolation between builders |
| Roles | 4 fixed roles and no custom roles. Per-app delegate designers work by temporary admin elevation | Not stated | **Missing** |
| Personal space | None | Not stated | **Missing** |
| Team space | None. The closest is per-app delegate designers | Not stated | **Missing** |
| Permission sets | None. Inline rules on each menu, form and list, drawn from 10 permission plugins | Not stated | **Missing** |
| Well governed | 12 health checks that run after the fact and are off by default. No approvals, no separation of duties, no ownership model | Governance Center integration | **Partial** |
| Deploy efficiently | Versions, `.jwa` export/import and a git mirror. Publishing is instant but ungoverned, with no CLI, no import API and no rollback | High availability and clustering | **Partial** |
| Monitoring | Per-app log viewer, process SLA reports (via a plugin) and health checks. No metrics, health or OpenTelemetry endpoints | Performance Analyzer (APM) | **Partial** |
| Auditable | A method-level audit trail plus logins. No outcomes, no diffs (except for settings), no reads or exports, no tamper evidence, no retention | Not stated. A record-history table exists but is unused in CE | **Partial (weak)** |

---

## 4. Findings by area

Paths are relative to the Joget repository root:

- `core/` = `wflow-core/src/main/java/org/joget/`
- `web/` = `wflow-consoleweb/src/main/`
- `commons/` = `wflow-commons/src/main/java/org/joget/commons/`
- `plugin/` = `wflow-plugin-base/src/main/java/org/joget/plugin/base/`

### 4.1 Users, groups and roles

- **A rich directory.** It has `dir_user`, `dir_group`, `dir_organization` (a tree), `dir_department` (a tree with a head of department), `dir_grade`, and `dir_employment`, which links a user to an organization, department and grade, with reporting lines. The mappings are in `wflow-directory/src/main/resources/org/joget/directory/model/*.hbm.xml`. The directory is pluggable through a directory-manager plugin; LDAP/AD integration is Enterprise-only.
- **Four stored roles**, seeded at install: `ROLE_ADMIN`, `ROLE_APP_CREATOR`, `ROLE_SYSTEM_MANAGER` and `ROLE_USER` (`wflow-install/src/main/resources/data/jwdb-empty.sql:2887-2890`). Three more are computed at login: anonymous, `ROLE_SYSADMIN` and `ROLE_APP_DESIGNER` (`core/apps/workflow/security/EnhancedWorkflowUserManager.java`).
- **Every admin also receives `ROLE_SYSADMIN`** (`core/apps/workflow/security/AuthenticationTokenWrapper.java:894`), so there is no split between administering apps and administering the system.
- **The role list is fixed.** The role DAO's add, update and delete methods have no callers, and there is no role UI. Groups are the only way to model anything finer.

**Lesson:** keep the org-chart model, because it powers workflow routing. Make roles data: custom, scoped and composed from permission sets.

### 4.2 Who can build and administer

- **Platform access control is a list of URL patterns** in one Spring Security file (`web/webapp/WEB-INF/applicationContext.xml:23-155`). The list ends with catch-all rules for `/web/json/**`, `/web/console/**` and `/web/**` (lines 138-141). There are no method-level security annotations; builder controllers re-check editability in code.
- **Who may edit an app** is decided in `core/apps/app/service/AppUtil.java` (`isAppEditableByCurrentUser`):
  - admins;
  - App Creators, for apps whose `createdBy` is themselves;
  - per-app **delegate designers**, users or groups stored in the app's `app_src/<appId>/app.properties` file.
- **Delegation works by elevation.** While a delegate is on that app's URLs, they are given `ROLE_ADMIN` plus an app-designer flag for the request (`EnhancedWorkflowUserManager.java`). Joget has no scoped grants.
- **System Managers** manage settings, the directory and monitoring, including plugin upload (`/console/setting/plugin/upload` in `web/java/org/joget/apps/app/controller/ConsoleWebController.java:4872`). Plugins run with full platform privileges (§4.8), so in practice the role is equivalent to an admin.

**Lesson:** delegation by temporary elevation is hard to reason about and hard to audit. Use scoped bindings evaluated by a single policy decision point, have every endpoint declare the action it needs, and deny by default.

### 4.3 Permissions inside apps

- **Ten permission plugins.** User, Group, Department, Organization, Logged-in user and BeanShell are in `core/apps/userview/lib/`. Admin, Anonymous, App Creator and System Manager are in `core/plugin/enterprise/`. No plugin checks custom roles or combines rules with AND/OR; anything else needs a BeanShell script.
- **Permissions are configured inline on each component:**
  - userview categories and menus, through ordered rules that deny, allow or hide;
  - form sections and fields, which become read-only or hidden per rule;
  - datalist columns, filters and actions.

  Each rule embeds the plugin class and its properties, and a rule can only be reused within the same userview, form or list.
- **Process participants** can be mapped to a user, a group, a department, a head of department, the requester, the requester's head of department, subordinates or department, a workflow variable, a plugin, or a role (`core/apps/app/model/PackageParticipant.java`). This org-aware routing is one of Joget's strengths.
- **The JSON data API** (`/web/json/data/**`) is authorized by platform role, not by the app's own permission rules. The same data therefore has two different permission models, depending on whether it is reached through the UI or the API.

**Lesson:** define app permissions once, as permission sets over entities and processes, and derive both UI visibility and API access from them ([design §5.5](02-platform-design.md#55-permissions-inside-apps)).

### 4.4 Personal and team spaces

- **There are no workspaces, teams, folders or personal spaces.** Ownership is a single `createdBy` string on the app, and "my apps" is just a filtered list.
- Virtual-host profiles (§4.10) separate tenants, not teams.
- The only per-user features are the task inbox and the user profile.

**Lesson:** spaces must be a first-class scope on every table and query from day one. Adding them later means touching every DAO.

### 4.5 Change management and versioning

- **Each app version is a full copy** of every definition (§2). A new version is created by copying an existing one (`core/apps/app/service/AppServiceImpl.java`, around line 1713).
- **Publishing flips a flag.** The previous version's `published` becomes false and the new version's becomes true, with no validation (`AppServiceImpl.java:2310`). Each app has one published version, which serves the userviews and the data APIs.
- **The published version stays editable,** so every builder save on it goes live immediately.
- **Builder saves have no server-side locking or conflict detection.** The form-save endpoint simply updates the definition (`web/java/org/joget/apps/app/controller/FormBuilderWebController.java`, `save`), so two designers editing the same form overwrite each other.
- **No drafts, branches, version diffs or rollback.** Governance health checks run only after the fact.
- **Git mirroring.** Each app version has a local JGit repository under `app_src/<appId>/<appId>_<version>`. After each request that changes it, a background thread commits the change as the current user, and can push to or pull from a per-app remote (`web/java/org/joget/apps/app/web/GitRequestFilter.java`). With "always pull" and auto-sync turned on, newer definitions from the remote are imported into the database (`core/apps/app/service/AppDevUtil.java`, around line 2114). Anyone who can push to that remote can therefore change a running app without review.
- **Process versions.** Running instances stay on the package version they started with. But re-saving a version's process migrates that version's running instances, and any instance whose current activity no longer exists is **aborted** (`AppServiceImpl.java`, around line 2990).

**Lesson:** separate editing from releasing. Use drafts, change requests with checks and approvals, immutable releases, pointer-flip deploys and one-step rollback ([design §6–7](02-platform-design.md#6-app-model-and-governed-change)). Migrating in-flight process instances must be explicit, previewed and audited.

### 4.6 Deployment and runtime topology

- **Packaging.** Joget is a single WAR on Tomcat with a local data directory (`wflow.home`) holding app sources, plugin JARs, generated mappings, uploads and logs. One database holds definitions, app data, the workflow engine and the user directory. The CE repository contains no Docker, Kubernetes or CI files, and its installer bundles Tomcat and a JRE. Joget offers Docker, Kubernetes and OpenShift deployments as products.
- **Moving apps between environments.** You export a `.jwa` file, which holds the app definition (including environment variable values), the process definition and the resources, and optionally plugin JARs and data. Importing it on the target always creates a new, unpublished version. Import is a console form, with no CLI and no import API, although publish and unpublish are available as JSON endpoints.
- **Environment-specific configuration** is limited to per-version environment variable rows. Datasources apply to the whole platform.
- **Form data schema.** Data lives in `app_fd_<table>` tables with `c_<field>` columns, all of type `text` (`core/apps/form/dao/FormDataDaoImpl.java`). Hibernate mappings are generated at runtime, and schema changes are applied as additive DDL the first time a table is accessed after a save or import. As a result:
  - columns are never dropped, renamed or retyped;
  - all versions share the same tables;
  - the database user needs DDL rights.
- **Plugins.** Apache Felix (OSGi) runs inside the JVM. The `app_plugins` folder is polled every 20 seconds, and any JAR found there is installed (`plugin/PluginManager.java:247`). Plugins can also arrive through the console, app import and git sync. Nothing checks signatures or versions, apps cannot pin plugin versions, and plugins are isolated only by classloader.
- **Clustering.** CE assumes a shared data directory, caches locally (the distributed cache is a no-op placeholder, `wflow-commons/src/main/resources/commonsApplicationContext.xml:223`) and has no session replication. High availability and clustering are Enterprise features.

**Lesson:** use stateless pods, object storage instead of a shared filesystem, reviewed migrations on typed tables, signed and pinned plugins, and an API and CLI for CI/CD ([design §6.4 and §7](02-platform-design.md#7-deployment)).

### 4.7 Monitoring

- **A per-app log viewer.** A Log4j2 appender writes a small rolling log for each app and node (200 KB, one rollover), which is tailed over a WebSocket (`web/java/org/joget/logs/LogViewerAppender.java`, `LogViewerEndpoint.java`). Access is granted by platform role, not per app.
- **Process SLA reporting.** Due dates come from the limits in the process definition. Timings are collected into `app_report_*` tables, but only for apps that enable the Process Data Collector plugin (`core/apps/app/lib/ProcessDataCollectorAuditTrail.java`).
- **Twelve governance health checks** (`core/governance/lib/`), covering things like missing plugins, orphaned form tables, unmapped participants, userviews without permissions and hard-coded email addresses. They run on demand, or on a schedule only if an interval is configured (`core/governance/service/GovHealthCheckManager.java:78`). When the overall status changes, they send an email alert.
- **No health, metrics, JMX, Prometheus or OpenTelemetry endpoints.** The APM integration (Glowroot, sold as Performance Analyzer) is Enterprise-only; in CE it is a stub (`web/java/org/joget/apm/APMUtil.java`).

**Lesson:** instrument everything with OpenTelemetry from day one, show owners the health of their own apps, and turn health checks into preventive guardrails on change requests ([design §5.6 and §8](02-platform-design.md#8-monitoring)).

### 4.8 Custom code and data isolation

- **BeanShell everywhere.** Eight plugins run BeanShell scripts written by app designers: the tool, decision, form binder, validator, multi-row validator, datalist binder, column and permission plugins. All of them go through `AppPluginUtil.executeScript` (`core/apps/app/service/AppPluginUtil.java:202-248`), which is a plain `bsh.Interpreter` inside the server JVM, with no sandbox.
- **A database update tool** runs SQL against the platform's own database by default.
- **Form data tables are global.** The table name is `app_fd_` plus the form's table name, with no app ID (`FormDataDaoImpl.java:104`). Columns are merged from every form in every app that uses the table. Any app can read any table, for example through `#form.<table>.<column>[id]#` hash variables, by binding a form to it, or from a script.
- **Some isolation guards rely on the Java SecurityManager.** CE does not install one. The SecurityManager was also deprecated for removal in Java 17 (JEP 411) and permanently disabled in JDK 24 (JEP 486), so sandboxing inside the JVM is no longer viable on modern Java.

**Consequence:** anyone who can design an app can, in practice, read and change all data and run arbitrary code with platform privileges. App designers must be trusted like platform administrators, which rules out real delegation to teams.

**Lesson:** use separate app schemas and declared cross-app references, and run custom code out of process in a capability-limited sandbox ([design §6.4 and §10](02-platform-design.md#10-extensibility-and-safe-custom-code)).

### 4.9 Audit

- **One table,** `wf_audit_trail`, with eight columns: id, username, appId, appVersion, clazz, method, message and timestamp (`wflow-core/src/main/resources/org/joget/apps/app/model/AuditTrail.hbm.xml`).
- **How rows are written:**
  - an AOP interceptor around workflow, directory and app DAO methods (`core/apps/app/service/AuditTrailInterceptor.java`);
  - explicit calls for login success and failure (with IP address), logout or session end, plugin install and uninstall, and system setting changes.

  The interceptor writes in a `finally` block, so failed calls are recorded too, but with no outcome flag.
- **What is missing from a row:**
  - The message is just the first argument's `toString()` or an object ID.
  - Before and after values are recorded only for system settings.
  - Reads, exports and permission denials are not recorded.
  - Form data changes are passed to audit plugins but never stored in the table.
- **No tamper evidence, retention or purge.** The viewer offers text search and a date range, with no export.
- **An `AuditTrailPlugin` hook** lets apps react to events. It runs synchronously and swallows plugin errors. CE ships two such plugins: the Process Data Collector and a user-notification plugin.
- **Record history:** an `app_form_data_audit_trail` table, model and DAO exist, but nothing in CE writes to them. The only history of design-time changes is the per-version git commits (§4.5).

**Lesson:** record structured events with outcomes and diffs, written in the same transaction as the change, sealed against tampering, kept according to a retention policy, and exportable and streamable. Build record history into the data layer ([design §9](02-platform-design.md#9-audit)).

### 4.10 Multi-tenancy

- **Database per profile.** `wflow/app_datasource.properties` maps a host name to a profile, and each profile has its own JDBC settings and data directory (`commons/util/DynamicDataSourceManager.java`, `commons/util/HostManager.java`). Host mapping is enabled with `-Dwflow.virtualhost=true`, and each session is bound to the host it logged in on.
- **Shared across tenants:** the JVM, the Spring context, the OSGi plugin framework and plugin folder, thread pools, the cache manager (with keys prefixed by profile), and the session signing key.
- **CE is not built to serve tenants concurrently.** Whenever the resolved database URL changes, CE closes and reopens its single datasource pool and clears the caches (`commons/util/DynamicDataSource.java:41-63`). Per-tenant datasource, plugin and security-manager classes are referenced in comments but are not in CE, and Joget's licensing page places multi-tenancy in its Cloud Edition.

**Lesson:** put `org_id` on everything and enforce it with row-level security in pooled cells, with dedicated cells for tenants that need stronger isolation ([design §5.9 and §7.2](02-platform-design.md#72-deploying-the-platform)).

---

## 5. What to borrow, what to avoid

| Borrow | Why |
|---|---|
| The breakdown of an app: data-defining forms, lists, a UI layer, processes, plugins, environment variables, translations | Proven, and familiar to low-code builders |
| Org-chart-aware process routing: requester, head of department, reporting line, department, group | This is how enterprises route approvals |
| Process instances pinned to the version they started on | Lets long-running work evolve safely |
| Plugin extension points: field types, binders, actions, themes, identity providers, MFA | Extensibility without forking |
| Governance health checks | A good idea, but run them before merge rather than after the fact |
| App export bundles and git mirroring | These become signed releases and Git sync |
| Builder presence (who else is editing) | A cheap collaboration signal |

| Avoid | Do instead |
|---|---|
| Fixed role constants, and delegation by temporary admin elevation | Custom roles built from permission sets, and scoped bindings ([design §5](02-platform-design.md#5-authorization-roles-permission-sets-bindings)) |
| Permission rules embedded in each menu, form and list, with a separate model for the API | One permission model that both the UI and the API derive from |
| Global data tables reachable from any app, with every column stored as text | Typed schemas per app and per environment |
| Unsandboxed scripts in the server JVM | An out-of-process sandbox |
| Flag-flip publishing, editable live versions, no locking | Drafts → change requests → immutable releases → pointer deploys |
| Additive DDL applied at runtime | Generated, reviewed, expand/contract migrations |
| A local data directory, and a shared filesystem for clustering | Stateless pods, object storage, cells |
| Audit messages that only name the method called | Structured, same-transaction, sealed audit events |
| Unsalted MD5 password hashes in the built-in directory, and security features reserved for paid editions | Federation first, with MFA, SCIM, audit and isolation in every edition |

---

## 6. Fork or build?

**Decision (2026-11-14): build a new platform on a modern stack, aiming to surpass Joget and be fit for enterprise use.** The table below records why.

| Factor | Fork Joget CE | Build new |
|---|---|---|
| Time to a first demo | Fast: forms, lists, userviews, processes and plugins already work | Slower: the builders must be written |
| Governance requirements | Spaces, ownership, scoped roles, permission sets and audit would touch nearly every DAO, query, builder and security check. After that, merging from upstream is no longer practical | Designed in from day one ([design §5](02-platform-design.md#5-authorization-roles-permission-sets-bindings)) |
| Expected features | Several governance features (LDAP/AD, MFA, password policies, Performance Analyzer, API Builder, clustering) are Enterprise-only, so they are not in the code you can fork | You build what you need, and include security in every edition |
| Licence | GPLv3. Distributing a fork, for example as on-premises installs for customers, requires releasing its source under GPLv3. Pure SaaS use does not trigger that (GPLv3 is not the AGPL), but it limits your options later | Your choice |
| Brand | You cannot use the Joget name | Your own |
| Long-term cost | You own a large monolith with JSP consoles and an XPDL engine | You own a codebase shaped around governance |

Two caveats:

- **Building a low-code platform is a multi-year product investment.** Keep the MVP tight ([design §13](02-platform-design.md#13-roadmap)) and put the governance kernel first.
- **Joget CE is still useful while you build.** Run it locally as a reference to study builder behaviour, edge cases and details of the app model you are replacing.
