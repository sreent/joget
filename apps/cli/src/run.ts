import { parseArgs } from 'node:util';
import { validateDefinition } from '@platform/app-model';

/**
 * ambit, the command line for Ambit (design §7.1): what people do in the studio, for scripts and
 * CI. It signs in with an API token from AMBIT_TOKEN, never a token in a command, so the token
 * stays out of shell history and CI logs. `check` needs no server: it validates a file offline.
 */

/** What the command needs from the world, so tests can stand in for it. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  out(text: string): void;
  err(text: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** A failure with what to tell the person, and the exit code: 1 when the work failed, 2 when the command was wrong. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
  }
}

/** The parts of the API's answers that the command reads. */
interface AppInfo {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly kind: string;
  readonly revision: number;
  readonly workingCopyOf: unknown;
}
interface ReleaseInfo {
  readonly id: string;
  readonly number: number;
  readonly revision: number;
  readonly liveIn: readonly string[];
  readonly verified: boolean;
  readonly destructive: boolean;
  readonly createdAt: string;
}
interface DeploymentInfo {
  readonly id: string;
  readonly environment: 'staging' | 'prod';
  readonly kind: 'deploy' | 'rollback';
  readonly status: string;
  readonly release: { readonly number: number };
  readonly approvals: { readonly required: number; readonly by: readonly unknown[] };
  readonly error: string | null;
  readonly requestedAt: string;
}
interface Bundle {
  readonly app: { readonly name: string; readonly handle: string };
  readonly revision: number;
  readonly digest: string;
}
interface ImportResult {
  readonly app: { readonly name: string; readonly handle: string };
  readonly changeRequest: { readonly number: number } | null;
  readonly asExported: boolean | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `ambit: the command line for Ambit

Usage: ambit <command> [options]

  templates                                 The templates an app can start from
  apps                                      The apps you build or use
  export <app> [--out <file>]               Save an app's definition as a file
  import <file> --space <space> [--name <name>]
  import --template <id> --space <space> [--name <name>]
                                            Start an app from a file or a template. In a
                                            team space, it arrives as a change request
  check <file>                              Check a definition file, offline
  release <app> [--revision <n>] [--notes <text>]
                                            Cut a release of a team app
  releases <app>                            A team app's releases
  deploy <app> --release <n> --env <staging|prod> [--confirm-destructive] [--wait]
                                            Deploy a release. Staging deploys at once;
                                            Prod waits for approvals
  deployments <app>                         A team app's deployments
  rollback <app> --env <staging|prod>       Make the previous release live again

<app> is an app's ID or handle. <space> is a space's ID or name, or "mine".
Add --json for machine-readable output.

Settings, from the environment:
  AMBIT_URL     Where Ambit runs, for example https://ambit.example.com
  AMBIT_TOKEN   An API token: a personal access token, or a service account's for CI
`;

/** A small HTTP client for the API, with the token from the environment. */
class Api {
  constructor(
    private readonly io: Io,
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.io.fetch(new URL(path, this.base), {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CliError(`Can't reach Ambit at ${this.base}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed as { message?: string; details?: { issues?: Array<{ path?: string; field?: string; message: string }> } } | null;
      const issues = (error?.details?.issues ?? []).map((issue) => `\n  ${issue.path ?? issue.field ?? ''}: ${issue.message}`).join('');
      throw new CliError(`${error?.message ?? `Ambit answered ${response.status}`}${issues}`);
    }
    return parsed as T;
  }
}

function connect(io: Io): Api {
  const token = io.env['AMBIT_TOKEN'];
  if (!token) throw new CliError('Set AMBIT_TOKEN to an API token. Create one in Ambit, or use a service account\'s in CI.', 2);
  return new Api(io, io.env['AMBIT_URL'] ?? 'http://localhost:3000', token);
}

/** An app by its ID, or by its handle among the apps the token can see. */
async function appId(api: Api, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const { apps } = await api.call<{ apps: AppInfo[] }>('GET', '/v1/apps');
  const found = apps.filter((app) => app.handle === ref && !app.workingCopyOf);
  if (found.length === 1) return found[0]!.id;
  if (!found.length) throw new CliError(`No app ${ref} that you can see`);
  throw new CliError(`More than one app is called ${ref}: give its ID (ambit apps lists them)`);
}

/** A space by its ID, its name, or "mine" for the caller's personal space. */
async function spaceId(api: Api, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  if (ref === 'mine') {
    const me = await api.call<{ personalSpaceId: string | null }>('GET', '/v1/me');
    if (!me.personalSpaceId) throw new CliError('You have no personal space');
    return me.personalSpaceId;
  }
  const { spaces } = await api.call<{ spaces: Array<{ id: string; name: string }> }>('GET', '/v1/spaces');
  const found = spaces.filter((space) => space.name.toLowerCase() === ref.toLowerCase());
  if (found.length === 1) return found[0]!.id;
  throw new CliError(found.length ? `More than one space is called ${ref}: give its ID` : `No space ${ref} that you can see`);
}

/** A release by its number, or its ID. */
async function releaseOf(api: Api, app: string, ref: string): Promise<ReleaseInfo> {
  const { releases } = await api.call<{ releases: ReleaseInfo[] }>('GET', `/v1/apps/${app}/releases`);
  const found = releases.find((release) => release.id === ref || String(release.number) === ref);
  if (!found) throw new CliError(`No release ${ref} of this app`);
  return found;
}

function table(rows: ReadonlyArray<readonly string[]>): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ')).join('\n');
}

const FINAL = new Set(['succeeded', 'failed', 'cancelled']);

function describeDeployment(deployment: DeploymentInfo): string {
  const where = deployment.environment === 'prod' ? 'Prod' : 'Staging';
  const release = `release ${deployment.release.number}`;
  switch (deployment.status) {
    case 'succeeded':
      return `${where} runs ${release}${deployment.kind === 'rollback' ? ', rolled back' : ''}.`;
    case 'awaiting_approval':
      return `Deploying ${release} to ${where} waits for ${deployment.approvals.required - deployment.approvals.by.length} approval(s) in Ambit.`;
    case 'approved':
      return `Deploying ${release} to ${where} is approved, and waits to be executed.`;
    case 'failed':
      return `Deploying ${release} to ${where} failed: ${deployment.error ?? 'no reason given'}`;
    default:
      return `Deploying ${release} to ${where}: ${deployment.status}.`;
  }
}

/** Run one command. Returns the exit code: 0 when it worked, 1 when it failed, 2 when the command was wrong. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.out(HELP);
      return 0;
    }
    const parsed = (() => {
      try {
        return parseArgs({
          args: [...rest],
          allowPositionals: true,
          strict: true,
          options: {
            json: { type: 'boolean', default: false },
            out: { type: 'string' },
            space: { type: 'string' },
            name: { type: 'string' },
            template: { type: 'string' },
            revision: { type: 'string' },
            notes: { type: 'string' },
            release: { type: 'string' },
            env: { type: 'string' },
            'confirm-destructive': { type: 'boolean', default: false },
            wait: { type: 'boolean', default: false },
            timeout: { type: 'string', default: '600' },
          },
        });
      } catch (error) {
        throw new CliError(`${error instanceof Error ? error.message : String(error)}. See ambit help.`, 2);
      }
    })();
    const { values, positionals } = parsed;
    const print = (data: unknown, text: () => string) => io.out(values.json ? JSON.stringify(data, null, 2) : text());
    const one = (what: string): string => {
      if (positionals.length !== 1) throw new CliError(`Name ${what}. See ambit help.`, 2);
      return positionals[0]!;
    };
    const env = (): 'staging' | 'prod' => {
      if (values.env !== 'staging' && values.env !== 'prod') throw new CliError('Give --env staging or --env prod', 2);
      return values.env;
    };

    switch (command) {
      case 'check': {
        const file = one('the definition file');
        let raw: unknown;
        try {
          raw = JSON.parse(await io.readFile(file));
        } catch (error) {
          throw new CliError(`Can't read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        // An exported file carries its definition inside; a bare definition is checked as it is.
        const definition = isObject(raw) && 'format' in raw && 'definition' in raw ? raw['definition'] : raw;
        const result = validateDefinition(definition);
        print(result.ok ? { ok: true, notes: result.notes } : { ok: false, issues: result.issues }, () =>
          result.ok ? `${file}: no problems.` : `${file} has ${result.issues.length} problem(s):\n${result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
        );
        return result.ok ? 0 : 1;
      }
      case 'templates': {
        const { templates } = await connect(io).call<{ templates: Array<{ id: string; name: string; description: string }> }>('GET', '/v1/templates');
        print(templates, () => table([['ID', 'NAME', 'DESCRIPTION'], ...templates.map((t) => [t.id, t.name, t.description])]));
        return 0;
      }
      case 'apps': {
        const { apps } = await connect(io).call<{ apps: AppInfo[] }>('GET', '/v1/apps');
        print(apps, () =>
          table([['HANDLE', 'NAME', 'KIND', 'REVISION', 'ID'], ...apps.map((app) => [app.handle, app.name, app.workingCopyOf ? 'working copy' : app.kind, String(app.revision), app.id])]),
        );
        return 0;
      }
      case 'export': {
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const bundle = await api.call<Bundle>('GET', `/v1/apps/${id}/export`);
        const out = values.out ?? `${bundle.app.handle}.ambit.json`;
        await io.writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
        print({ file: out, revision: bundle.revision, digest: bundle.digest }, () => `Saved revision ${bundle.revision} of ${bundle.app.name} to ${out}. It holds no data.`);
        return 0;
      }
      case 'import': {
        if (!values.space) throw new CliError('Give --space: a space ID or name, or "mine"', 2);
        if ((values.template === undefined) === (positionals.length === 0)) throw new CliError('Import a file, or --template <id>: one of them', 2);
        const api = connect(io);
        const space = await spaceId(api, values.space);
        let body: Record<string, unknown>;
        if (values.template !== undefined) body = { template: values.template };
        else {
          const file = one('the file');
          try {
            body = { bundle: JSON.parse(await io.readFile(file)) };
          } catch (error) {
            throw new CliError(`Can't read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const result = await api.call<ImportResult>('POST', `/v1/spaces/${space}/apps/import`, { ...body, ...(values.name ? { name: values.name } : {}) });
        print(result, () =>
          result.changeRequest
            ? `${result.app.name} arrives in the team space as change request #${result.changeRequest.number}, for review.`
            : `Created ${result.app.name} (${result.app.handle}), ready in your personal space.${result.asExported === false ? ' The file had changed since it was exported.' : ''}`,
        );
        return 0;
      }
      case 'release': {
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const revision = values.revision === undefined ? undefined : Number(values.revision);
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new CliError('--revision is a revision number', 2);
        const release = await api.call<ReleaseInfo>('POST', `/v1/apps/${id}/releases`, { ...(revision ? { revision } : {}), ...(values.notes ? { notes: values.notes } : {}) });
        print(release, () => `Cut release ${release.number}, of revision ${release.revision}${release.destructive ? '. It deletes data, so it deploys on its own' : ''}.`);
        return 0;
      }
      case 'releases': {
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const { releases } = await api.call<{ releases: ReleaseInfo[] }>('GET', `/v1/apps/${id}/releases`);
        print(releases, () =>
          table([
            ['RELEASE', 'REVISION', 'LIVE IN', 'SIGNATURE', 'CUT'],
            ...releases.map((r) => [String(r.number), String(r.revision), r.liveIn.join(', ') || '-', r.verified ? 'verified' : 'NOT VERIFIED', r.createdAt]),
          ]),
        );
        return 0;
      }
      case 'deploy': {
        if (!values.release) throw new CliError('Give --release: a release number or ID', 2);
        const target = env();
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const release = await releaseOf(api, id, values.release);
        let deployment = await api.call<DeploymentInfo>('POST', `/v1/apps/${id}/deployments`, { releaseId: release.id, env: target, confirmDestructive: values['confirm-destructive'], execute: true });
        const deadline = io.now() + Number(values.timeout) * 1000;
        // Waiting follows the deployment until it ends: approvals come from people, in Ambit.
        while (values.wait && !FINAL.has(deployment.status) && io.now() < deadline) {
          if (deployment.status === 'approved') {
            deployment = await api.call<DeploymentInfo>('POST', `/v1/deployments/${deployment.id}/execute`);
            continue;
          }
          await io.sleep(2000);
          const current: DeploymentInfo = deployment;
          const { deployments } = await api.call<{ deployments: DeploymentInfo[] }>('GET', `/v1/apps/${id}/deployments`);
          deployment = deployments.find((d) => d.id === current.id) ?? current;
        }
        const ended: DeploymentInfo = deployment;
        print(ended, () => describeDeployment(ended));
        if (ended.status === 'failed' || ended.status === 'cancelled') return 1;
        if (values.wait && !FINAL.has(ended.status)) {
          io.err('Stopped waiting: the deployment has not ended.');
          return 1;
        }
        return 0;
      }
      case 'deployments': {
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const { deployments } = await api.call<{ deployments: DeploymentInfo[] }>('GET', `/v1/apps/${id}/deployments`);
        print(deployments, () =>
          table([['ENV', 'KIND', 'RELEASE', 'STATUS', 'REQUESTED'], ...deployments.map((d) => [d.environment, d.kind, String(d.release.number), d.status, d.requestedAt])]),
        );
        return 0;
      }
      case 'rollback': {
        const target = env();
        const api = connect(io);
        const id = await appId(api, one('the app'));
        const deployment = await api.call<DeploymentInfo>('POST', `/v1/apps/${id}/environments/${target}/rollback`);
        print(deployment, () => describeDeployment(deployment));
        return deployment.status === 'succeeded' ? 0 : 1;
      }
      default:
        throw new CliError(`No command ${command}. See ambit help.`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
