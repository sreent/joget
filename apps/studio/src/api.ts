import type { AppSummary, Definition, HistoryEntry, Me, Person, Plan, RecordOut, Revision, Share, UiManifest } from './types.js';

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
const records = (id: string, entity: string) => `${app(id)}/entities/${encodeURIComponent(entity)}/records`;

export const api = {
  me: () => call<Me>('GET', '/v1/me'),
  person: peopleLoader(),
  searchPeople: async (term: string) => (await call<{ people: Person[] }>('GET', `/v1/people?search=${encodeURIComponent(term)}`)).people,
  apps: () => call<{ apps: AppSummary[] }>('GET', '/v1/apps'),
  app: (id: string) => call<AppSummary>('GET', app(id)),
  createApp: (spaceId: string, body: { name: string; description?: string; definition?: unknown }) =>
    call<{ app: AppSummary; plan: Plan }>('POST', `/v1/spaces/${encodeURIComponent(spaceId)}/apps`, body),
  example: () => call<{ schema: unknown; example: Definition }>('GET', '/v1/app-model/schema'),
  definition: (id: string) => call<{ revision: number; definition: Definition }>('GET', `${app(id)}/definition`),
  plan: (id: string, definition: Definition) => call<{ plan: Plan; definition: Definition }>('POST', `${app(id)}/definition/plan`, { definition }),
  save: (id: string, definition: Definition, baseRevision: number, confirmDestructive: boolean) =>
    call<{ plan: Plan }>('PUT', `${app(id)}/definition${confirmDestructive ? '?confirmDestructive=true' : ''}`, { definition, baseRevision }),
  revisions: (id: string) => call<{ revisions: Revision[] }>('GET', `${app(id)}/revisions`),
  shares: (id: string) => call<{ shares: Share[] }>('GET', `${app(id)}/shares`),
  share: (id: string, email: string, role: string) => call<Share>('POST', `${app(id)}/shares`, { email, role }),
  unshare: (id: string, shareId: string) => call<void>('DELETE', `${app(id)}/shares/${encodeURIComponent(shareId)}`),
  ui: (id: string) => call<UiManifest>('GET', `${app(id)}/ui`),
  records: (id: string, entity: string, cursor?: string) =>
    call<{ records: RecordOut[]; nextCursor: string | null }>('GET', `${records(id, entity)}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  record: (id: string, entity: string, recordId: string) => call<RecordOut>('GET', `${records(id, entity)}/${encodeURIComponent(recordId)}`),
  createRecord: (id: string, entity: string, values: Record<string, unknown>) => call<RecordOut>('POST', records(id, entity), { values }),
  updateRecord: (id: string, entity: string, recordId: string, values: Record<string, unknown>, version: number) =>
    call<RecordOut>('PATCH', `${records(id, entity)}/${encodeURIComponent(recordId)}`, { values, version }),
  history: (id: string, entity: string, recordId: string) => call<{ history: HistoryEntry[] }>('GET', `${records(id, entity)}/${encodeURIComponent(recordId)}/history`),
  runAction: (id: string, action: string, body: { values: Record<string, unknown>; recordId?: string; version?: number }) =>
    call<{ status: 'done'; record: RecordOut } | { status: 'needs_confirmation'; proposal: { reviewUrl: string } }>('POST', `${app(id)}/actions/${encodeURIComponent(action)}/run`, body),
};
