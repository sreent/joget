import type {
  AppSummary,
  ChangeRequest,
  ChangeRequestSummary,
  Definition,
  Deployment,
  EnvironmentInfo,
  FileInfo,
  HistoryEntry,
  SkillCall,
  Me,
  Person,
  Plan,
  RecordOut,
  Release,
  Revision,
  Share,
  Space,
  UiManifest, ProcessInstance, Task } from './types.js';

/** An error from the API, with its machine-readable code and details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    // The session ended: sign in again and come back here.
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(401, 'unauthenticated', 'Sign in first');
  }
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { error?: string; message?: string; details?: unknown }) : undefined;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? 'error', data?.message ?? response.statusText, data?.details);
  return data as T;
}

/**
 * Looks people up by ID in batches: every name asked for while a screen renders goes out in one
 * request, however many records and history entries name someone.
 */
function peopleLoader() {
  type Waiter = { resolve: (person: Person | null) => void; reject: (error: unknown) => void };
  let waiting = new Map<string, Waiter[]>();
  const flush = async () => {
    const batch = waiting;
    waiting = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const { people } = await call<{ people: Person[] }>('GET', `/v1/people?ids=${chunk.join(',')}`);
        const byId = new Map(people.map((person) => [person.id, person]));
        for (const id of chunk) for (const waiter of batch.get(id)!) waiter.resolve(byId.get(id) ?? null);
      } catch (error) {
        for (const id of chunk) for (const waiter of batch.get(id)!) waiter.reject(error);
      }
    }
  };
  return (id: string) =>
    new Promise<Person | null>((resolve, reject) => {
      if (!waiting.size) setTimeout(() => void flush(), 0);
      waiting.set(id, [...(waiting.get(id) ?? []), { resolve, reject }]);
    });
}

const app = (id: string) => `/v1/apps/${encodeURIComponent(id)}`;

/** An app in one of its environments: a team app's Prod (the default), Staging, or a preview by its environment ID. */
export interface AppAt {
  readonly id: string;
  readonly env?: string | undefined;
}
const at = (target: string | AppAt): AppAt => (typeof target === 'string' ? { id: target } : target);
/** The query string that names the environment, joined to any other parameters. */
export const envParams = (target: string | AppAt, more: Record<string, string> = {}): string => {
  const { env } = at(target);
  const params = new URLSearchParams({ ...more, ...(env ? { env } : {}) }).toString();
  return params ? `?${params}` : '';
};

/** Upload a file to an app, as its content: the platform reads its type from it, and checks it for malware. */
export async function uploadFile(target: string | AppAt, file: File): Promise<FileInfo & { id: string }> {
  const response = await fetch(`${app(at(target).id)}/files${envParams(target, { name: file.name })}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown } & FileInfo & { id: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'error', response.status === 413 ? 'The file is too big' : (data.message ?? response.statusText), data.details);
  return data;
}
const records = (target: string | AppAt, entity: string) => `${app(at(target).id)}/entities/${encodeURIComponent(entity)}/records`;

export const api = {
  me: () => call<Me>('GET', '/v1/me'),
  person: peopleLoader(),
  searchPeople: async (term: string) => (await call<{ people: Person[] }>('GET', `/v1/people?search=${encodeURIComponent(term)}`)).people,
  apps: () => call<{ apps: AppSummary[] }>('GET', '/v1/apps'),
  app: (id: string) => call<AppSummary>('GET', app(id)),
  createApp: (spaceId: string, body: { name: string; description?: string; definition?: unknown }) =>
    call<{ app: AppSummary; plan: Plan }>('POST', `/v1/spaces/${encodeURIComponent(spaceId)}/apps`, body),
  example: () => call<{ schema: unknown; example: Definition }>('GET', '/v1/app-model/schema'),
  /** An app's definition, as the file Ambit exports: the main line, never data. */
  exportApp: (appId: string) => call<Record<string, unknown> & { app: { handle: string } }>('GET', `${app(appId)}/export`),
  /** What this installation offers builders, such as whether it connects a7c. */
  features: () => call<{ a7c: boolean }>('GET', '/v1/features'),
  templates: () => call<{ templates: Array<{ id: string; name: string; description: string; entities: string[] }> }>('GET', '/v1/templates'),
  importApp: (spaceId: string, body: { name?: string; template?: string; bundle?: Record<string, unknown> }) =>
    call<{ app: AppSummary; plan: Plan | null; changeRequest: { id: string; number: number } | null; asExported: boolean | null }>(
      'POST',
      `/v1/spaces/${encodeURIComponent(spaceId)}/apps/import`,
      body,
    ),
  definition: (id: string) => call<{ revision: number; definition: Definition }>('GET', `${app(id)}/definition`),
  plan: (id: string, definition: Definition) => call<{ plan: Plan; definition: Definition }>('POST', `${app(id)}/definition/plan`, { definition }),
  save: (id: string, definition: Definition, baseRevision: number, confirmDestructive: boolean) =>
    call<{ plan: Plan }>('PUT', `${app(id)}/definition${confirmDestructive ? '?confirmDestructive=true' : ''}`, { definition, baseRevision }),
  revisions: (id: string) => call<{ revisions: Revision[] }>('GET', `${app(id)}/revisions`),
  shares: (id: string) => call<{ shares: Share[] }>('GET', `${app(id)}/shares`),
  share: (id: string, email: string, role: string) => call<Share>('POST', `${app(id)}/shares`, { email, role }),
  unshare: (id: string, shareId: string) => call<void>('DELETE', `${app(id)}/shares/${encodeURIComponent(shareId)}`),
  ui: (target: string | AppAt) => call<UiManifest>('GET', `${app(at(target).id)}/ui${envParams(target)}`),
  records: (target: string | AppAt, entity: string, cursor?: string) =>
    call<{ records: RecordOut[]; nextCursor: string | null }>('GET', `${records(target, entity)}${envParams(target, { limit: '50', ...(cursor ? { cursor } : {}) })}`),
  record: (target: string | AppAt, entity: string, recordId: string) => call<RecordOut>('GET', `${records(target, entity)}/${encodeURIComponent(recordId)}${envParams(target)}`),
  createRecord: (target: string | AppAt, entity: string, values: Record<string, unknown>) => call<RecordOut>('POST', `${records(target, entity)}${envParams(target)}`, { values }),
  updateRecord: (target: string | AppAt, entity: string, recordId: string, values: Record<string, unknown>, version: number) =>
    call<RecordOut>('PATCH', `${records(target, entity)}/${encodeURIComponent(recordId)}${envParams(target)}`, { values, version }),
  pageRecords: (target: string | AppAt, page: string, block: number, cursor?: string) =>
    call<{ records: RecordOut[]; nextCursor: string | null }>(
      'GET',
      `${app(at(target).id)}/pages/${encodeURIComponent(page)}/blocks/${block}/records${envParams(target, cursor ? { cursor } : {})}`,
    ),
  pageSummary: (target: string | AppAt, page: string, block: number) =>
    call<{ value: number | null } | { groups: Array<{ key: string | null; label: string | null; value: number | null }>; other: number | null; more: number }>(
      'GET',
      `${app(at(target).id)}/pages/${encodeURIComponent(page)}/blocks/${block}/summary${envParams(target)}`,
    ),
  history: (target: string | AppAt, entity: string, recordId: string) =>
    call<{ history: HistoryEntry[] }>('GET', `${records(target, entity)}/${encodeURIComponent(recordId)}/history${envParams(target)}`),
  skillCalls: (target: string | AppAt, entity: string, recordId: string) =>
    call<{ calls: SkillCall[] }>('GET', `${records(target, entity)}/${encodeURIComponent(recordId)}/skill-calls${envParams(target)}`),
  runAction: (target: string | AppAt, action: string, body: { values: Record<string, unknown>; recordId?: string; version?: number }) =>
    call<{ status: 'done'; record: RecordOut } | { status: 'needs_confirmation'; proposal: { reviewUrl: string } }>(
      'POST',
      `${app(at(target).id)}/actions/${encodeURIComponent(action)}/run${envParams(target)}`,
      body,
    ),

  // Business processes (design §6.10).
  tasks: (status: 'open' | 'closed' = 'open') => call<{ tasks: Task[] }>('GET', `/v1/me/tasks?status=${status}`),
  completeTask: (id: string, outcome: string, values?: Record<string, unknown>) =>
    call<{ task: Task; result: { status: 'done' } | { status: 'needs_confirmation'; proposal: { reviewUrl: string } } | null }>(
      'POST',
      `/v1/tasks/${encodeURIComponent(id)}/complete`,
      { outcome, ...(values ? { values } : {}) },
    ),
  recordProcesses: (target: string | AppAt, entity: string, recordId: string) =>
    call<{ instances: ProcessInstance[] }>('GET', `${records(target, entity)}/${encodeURIComponent(recordId)}/processes${envParams(target)}`),
  startProcess: (target: string | AppAt, process: string, recordId: string) =>
    call<ProcessInstance>('POST', `${app(at(target).id)}/processes/${encodeURIComponent(process)}/start${envParams(target)}`, { recordId }),
  processInstances: (target: string | AppAt, stuck = false) =>
    call<{ instances: ProcessInstance[] }>('GET', `${app(at(target).id)}/process-instances${envParams(target, stuck ? { stuck: 'true' } : {})}`),
  retryInstance: (target: string | AppAt, id: string) => call<ProcessInstance>('POST', `${app(at(target).id)}/process-instances/${encodeURIComponent(id)}/retry${envParams(target)}`),
  cancelInstance: (target: string | AppAt, id: string) => call<ProcessInstance>('POST', `${app(at(target).id)}/process-instances/${encodeURIComponent(id)}/cancel${envParams(target)}`),
  /** A process as a BPMN 2.0 file, saved by the browser. */
  downloadBpmn: async (appId: string, process: string) => {
    const response = await fetch(`${app(appId)}/processes/${encodeURIComponent(process)}/bpmn`, { credentials: 'same-origin' });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(response.status, data.error ?? 'error', data.message ?? response.statusText);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${process}.bpmn`;
    link.click();
    URL.revokeObjectURL(url);
  },
  importBpmn: (appId: string, xml: string, options: { entity?: string; as?: string } = {}) =>
    call<{ plan: Plan; processes: string[]; notes: string[] }>('POST', `${app(appId)}/processes/import`, { xml, ...options }),

  // Governed delivery for team apps.
  spaces: () => call<{ spaces: Space[] }>('GET', '/v1/spaces'),
  workingCopy: (teamId: string) => call<{ app: AppSummary; created: boolean; sampleRecords: number }>('POST', `${app(teamId)}/working-copy`),
  promote: (appId: string, body: { spaceId: string; name?: string }) => call<{ app: AppSummary; changeRequest: ChangeRequest }>('POST', `${app(appId)}/promote`, body),
  sync: (copyId: string, confirmDestructive: boolean) =>
    call<{ plan: Plan | null; app: AppSummary }>('POST', `${app(copyId)}/sync${confirmDestructive ? '?confirmDestructive=true' : ''}`),
  submit: (copyId: string, body: { title?: string; description?: string }) => call<ChangeRequest>('POST', `${app(copyId)}/submit`, body),
  changeRequests: (teamId: string) => call<{ changeRequests: ChangeRequestSummary[] }>('GET', `${app(teamId)}/change-requests`),
  changeRequest: (id: string) => call<ChangeRequest>('GET', `/v1/change-requests/${encodeURIComponent(id)}`),
  review: (id: string, verdict: 'approve' | 'request_changes' | 'comment', comment?: string) =>
    call<ChangeRequest>('POST', `/v1/change-requests/${encodeURIComponent(id)}/reviews`, { verdict, ...(comment ? { comment } : {}) }),
  merge: (id: string) => call<ChangeRequest>('POST', `/v1/change-requests/${encodeURIComponent(id)}/merge`),
  closeChange: (id: string) => call<ChangeRequest>('POST', `/v1/change-requests/${encodeURIComponent(id)}/close`),
  releases: (teamId: string) => call<{ releases: Release[] }>('GET', `${app(teamId)}/releases`),
  cutRelease: (teamId: string, body: { revision?: number; notes?: string }) => call<Release>('POST', `${app(teamId)}/releases`, body),
  deployments: (teamId: string) => call<{ environments: EnvironmentInfo[]; deployments: Deployment[] }>('GET', `${app(teamId)}/deployments`),
  requestDeployment: (teamId: string, body: { releaseId: string; env: 'staging' | 'prod'; confirmDestructive?: boolean; execute?: boolean }) =>
    call<Deployment>('POST', `${app(teamId)}/deployments`, body),
  approveDeployment: (id: string) => call<Deployment>('POST', `/v1/deployments/${encodeURIComponent(id)}/approve`),
  executeDeployment: (id: string) => call<Deployment>('POST', `/v1/deployments/${encodeURIComponent(id)}/execute`),
  cancelDeployment: (id: string) => call<Deployment>('POST', `/v1/deployments/${encodeURIComponent(id)}/cancel`),
  rollback: (teamId: string, env: 'staging' | 'prod') => call<Deployment>('POST', `${app(teamId)}/environments/${env}/rollback`),
  envShares: (target: AppAt) => call<{ shares: Share[] }>('GET', `${app(target.id)}/shares${envParams(target)}`),
  envShare: (target: AppAt, email: string, role: string) => call<Share>('POST', `${app(target.id)}/shares${envParams(target)}`, { email, role }),
  envUnshare: (target: AppAt, shareId: string) => call<void>('DELETE', `${app(target.id)}/shares/${encodeURIComponent(shareId)}${envParams(target)}`),
};

/** True if the API refused because the person must sign in again with MFA first. */
export function needsStepUp(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const reasons = (error.details as { reasons?: Array<{ kind: string }> } | undefined)?.reasons ?? [];
  return reasons.some((reason) => reason.kind === 'step_up_required');
}

/** Sign in again with MFA, then come back to this page. */
export function stepUp(): void {
  window.location.assign(`/auth/login?stepUp=true&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}
