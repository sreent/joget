import { createContext, type ReactNode, useContext, useState } from 'react';
import { ApiError, type AppAt, envParams, uploadFile } from '../api.js';
import type { FileInfo } from '../types.js';
import { Button } from './ui.js';

/** The app (in its environment) whose files these are, and the names of the files the screen knows about. */
interface Files {
  readonly at: AppAt;
  readonly names: Readonly<Record<string, FileInfo>>;
  remember(id: string, info: FileInfo): void;
}

const FilesContext = createContext<Files | null>(null);

/** Gives the screens below it the app's files: their names, and somewhere to keep new uploads' names. */
export function FilesProvider({ at, known, children }: { at: AppAt; known?: Readonly<Record<string, FileInfo>>; children: ReactNode }) {
  const [uploaded, setUploaded] = useState<Record<string, FileInfo>>({});
  const parent = useContext(FilesContext);
  const names = { ...parent?.names, ...known, ...uploaded };
  return (
    <FilesContext.Provider value={{ at, names, remember: (id, info) => (parent ? parent.remember(id, info) : setUploaded((all) => ({ ...all, [id]: info }))) }}>
      {children}
    </FilesContext.Provider>
  );
}

export const fileUrl = (at: AppAt, id: string) => `/v1/apps/${encodeURIComponent(at.id)}/files/${encodeURIComponent(id)}${envParams(at)}`;

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** A file, as a link that opens it. Without a link where the person may not open it any more, such as in history. */
export function FileLink({ id, link = true }: { id: string; link?: boolean }) {
  const files = useContext(FilesContext);
  const info = files?.names[id];
  const name = info?.name ?? 'A file';
  if (!link || !files) return <span>{name}</span>;
  return (
    <a href={fileUrl(files.at, id)} target="_blank" rel="noopener noreferrer">
      {name}
      {info ? <span className="ml-1 text-xs text-faint">{size(info.size)}</span> : null}
    </a>
  );
}

const ACCEPT: Record<string, string> = { image: 'image/jpeg,image/png,image/gif,image/webp,image/heic', pdf: 'application/pdf' };

/** Pick a file: it uploads straight away, and the field holds its ID. */
export function FileInput({
  id,
  value,
  accept,
  onChange,
  label,
}: {
  id: string;
  value: string | null;
  accept: readonly string[];
  onChange: (value: string | null) => void;
  label?: string;
}) {
  const files = useContext(FilesContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!files) return null;
  if (value) {
    const name = files.names[value]?.name ?? 'the file';
    return (
      <span className="flex items-center gap-1">
        <FileLink id={value} />
        <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} onClick={() => onChange(null)}>
          ✕
        </Button>
      </span>
    );
  }
  return (
    <span className="grid gap-1">
      <input
        id={id}
        type="file"
        accept={accept.map((kind) => ACCEPT[kind] ?? '').join(',')}
        disabled={busy}
        {...(label ? { 'aria-label': label } : {})}
        className="max-w-full text-sm file:mr-2 file:rounded-sm file:border file:border-line-strong file:bg-surface file:px-2 file:py-1 file:text-text"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const uploaded = await uploadFile(files.at, file);
            files.remember(uploaded.id, uploaded);
            onChange(uploaded.id);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'The file could not be uploaded');
            event.target.value = '';
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy ? <span className="text-xs text-muted">Uploading and checking…</span> : null}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </span>
  );
}
