import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Button, Notice } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import type { ComposeAttachment, ComposeReply, Definition } from '../types.js';

/*
 * Vibe composition (design §6.5): the builder says what the app needs, and the installation's model
 * changes the draft. The draft is the builder's: they undo it, change it further, or review and
 * save it. The chat itself saves nothing.
 */

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const isMediaType = (type: string): type is MediaType => (MEDIA_TYPES as readonly string[]).includes(type);
/** The API's limits: files in one request, the size of one file, and the history it takes. */
const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HISTORY = 20;
const MAX_PROMPT = 8000;
const MAX_TURN_TEXT = 20_000;

/** One thing said in the chat. A reply that changed the draft keeps the draft before it, for undo. */
interface Said {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly files?: readonly string[];
  readonly change?: { readonly before: Definition; readonly after: Definition; readonly edits: number; readonly problems: number };
  readonly stopped?: ComposeReply['stopped'];
  readonly undone?: boolean;
}

interface Asked {
  readonly id: number;
  readonly text: string;
  readonly files: readonly ComposeAttachment[];
  readonly before: Definition;
  readonly history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly text: string }>;
}

/** What the chat said before, as text: files go once, so a turn says which it had. */
function historyOf(turns: readonly Said[]): Asked['history'] {
  return turns.slice(-MAX_HISTORY).map((turn) => {
    const notes = [turn.files?.length ? `(Files given here, not sent again: ${turn.files.join(', ')}.)` : '', turn.undone ? '(The builder undid this change.)' : ''].filter(Boolean);
    return { role: turn.role, text: [turn.text, ...notes].join('\n\n').slice(0, MAX_TURN_TEXT) };
  });
}

/** A file as base64, which the API takes. */
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} can't be read`));
    reader.readAsDataURL(file);
  });
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const STOPPED: Partial<Record<NonNullable<ComposeReply['stopped']>, string>> = {
  turns: 'It used all its turns before it finished. Ask it to go on.',
  length: 'Its answer ran out of room before it finished. Ask it to go on.',
};

/** The chat that builds the app, beside the designers. */
export function ComposePanel({
  appId,
  definition,
  onDraft,
  onBusy,
  onClose,
}: {
  appId: string;
  /** The draft as it is now, which the chat changes. */
  definition: Definition;
  onDraft: (definition: Definition) => void;
  /** While the chat works, the designers wait: its draft replaces the one it was given. */
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<readonly Said[]>([]);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<readonly ComposeAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = useRef(0);
  const conversation = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const promptId = useId();

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns.length]);

  const ask = useMutation({
    mutationFn: (asked: Asked) => api.compose(appId, { prompt: asked.text, definition: asked.before, history: asked.history, attachments: asked.files }),
    onMutate: (asked) => {
      onBusy(true);
      setProblem(null);
      setPrompt('');
      setFiles([]);
      setTurns((list) => [...list, { id: asked.id, role: 'user', text: asked.text, files: asked.files.map((file) => file.name) }]);
    },
    onSuccess: (reply, asked) => {
      const after = reply.changed && reply.definition ? normalize(reply.definition) : undefined;
      if (after) onDraft(after);
      ids.current += 1;
      setTurns((list) => [
        ...list,
        { id: ids.current, role: 'assistant', text: reply.reply, stopped: reply.stopped, ...(after ? { change: { before: asked.before, after, edits: reply.edits, problems: reply.problems } } : {}) },
      ]);
    },
    onError: (error, asked) => {
      // The request didn't happen: what the builder wrote comes back, to send again.
      setTurns((list) => list.filter((turn) => turn.id !== asked.id));
      setPrompt(asked.text);
      setFiles(asked.files);
      setProblem(error instanceof ApiError ? error.message : "The chat can't be reached. Try again.");
    },
    onSettled: () => onBusy(false),
  });

  const send = () => {
    const text = prompt.trim();
    if (!text || ask.isPending) return;
    ids.current += 1;
    ask.mutate({ id: ids.current, text: text.slice(0, MAX_PROMPT), files, before: definition, history: historyOf(turns) });
  };

  const add = async (list: FileList | null) => {
    if (!list) return;
    setProblem(null);
    const chosen = [...files];
    for (const file of Array.from(list)) {
      if (chosen.length >= MAX_FILES) {
        setProblem(`The chat takes ${MAX_FILES} files at most.`);
        break;
      }
      if (!isMediaType(file.type)) setProblem(`${file.name} isn't a picture or a PDF.`);
      else if (file.size > MAX_FILE_BYTES) setProblem(`${file.name} is larger than 5 MB.`);
      else chosen.push({ name: file.name.trim().slice(0, 200) || 'file', mediaType: file.type, data: await readFile(file) });
    }
    setFiles(chosen);
  };

  // Undo the latest change the chat made, while the draft is still what it left.
  const latest = [...turns].reverse().find((turn) => turn.change && !turn.undone);
  const undoable = latest?.change && JSON.stringify(definition) === JSON.stringify(latest.change.after) ? latest : undefined;
  const undo = (turn: Said) => {
    if (!turn.change) return;
    onDraft(turn.change.before);
    setTurns((list) => list.map((item) => (item.id === turn.id ? { ...item, undone: true } : item)));
  };

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-raised">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id={titleId} className="m-0 text-base font-semibold">
          Build by chat
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close the chat
        </Button>
      </header>

      <div ref={conversation} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {turns.length === 0 ? (
          <div className="grid gap-2 text-sm text-muted">
            <p className="m-0">Say what the app needs: a field, a form, a page, a rule or a step in a process. Add a photo of a paper form or a PDF of a process if it helps.</p>
            <p className="m-0">The chat changes your draft with your organization's AI model. It sees the app's design and your files, never its records. Nothing is saved until you review and save the draft.</p>
          </div>
        ) : null}
        <ol role="log" aria-label="The conversation" className="m-0 grid list-none gap-3 p-0">
          {turns.map((turn) => (
            <li key={turn.id} className={turn.role === 'user' ? 'ml-8 justify-self-end rounded-lg bg-accent-soft px-3 py-2 text-sm' : 'mr-8 rounded-lg bg-sunken px-3 py-2 text-sm'}>
              <span className="sr-only">{turn.role === 'user' ? 'You: ' : 'The chat: '}</span>
              <p className="m-0 whitespace-pre-wrap">{turn.text}</p>
              {turn.files?.length ? <p className="m-0 mt-1 text-xs text-muted">With {turn.files.join(', ')}</p> : null}
              {turn.change ? (
                <div className="mt-2 grid gap-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">{turn.undone ? 'You undid this change.' : `Changed the draft: ${count(turn.change.edits, 'edit')}.`}</span>
                    {undoable?.id === turn.id ? (
                      <Button size="sm" onClick={() => undo(turn)}>
                        Undo
                      </Button>
                    ) : null}
                  </div>
                  {turn.change.problems && !turn.undone ? <span className="text-warn">The checks still find {count(turn.change.problems, 'problem')}: review the draft to see them.</span> : null}
                </div>
              ) : null}
              {turn.stopped && STOPPED[turn.stopped] ? <p className="m-0 mt-1 text-xs text-warn">{STOPPED[turn.stopped]}</p> : null}
            </li>
          ))}
          {ask.isPending ? <li className="mr-8 rounded-lg bg-sunken px-3 py-2 text-sm text-muted">Working on the draft…</li> : null}
        </ol>
      </div>

      <form
        className="grid gap-2 border-t border-line px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        <label htmlFor={promptId} className="text-sm text-muted">
          What should the app do?
        </label>
        <textarea
          id={promptId}
          className="min-h-20 w-full resize-y rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm"
          maxLength={MAX_PROMPT}
          value={prompt}
          readOnly={ask.isPending}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        {files.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Files to send">
            {files.map((file, i) => (
              <li key={`${file.name}-${i}`} className="flex items-center gap-1 rounded-sm bg-sunken px-2 py-0.5 text-xs">
                {file.name}
                <button type="button" className="text-muted hover:text-text" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== i))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-sm border border-line-strong bg-surface px-2.5 py-1 text-sm font-medium focus-within:outline-2 focus-within:outline-focus hover:bg-sunken has-disabled:cursor-default has-disabled:opacity-55">
            Add a picture or PDF
            <input
              type="file"
              multiple
              accept={MEDIA_TYPES.join(',')}
              className="sr-only"
              disabled={ask.isPending || files.length >= MAX_FILES}
              onChange={(event) => {
                const input = event.currentTarget;
                void add(input.files).finally(() => {
                  input.value = '';
                });
              }}
            />
          </label>
          <Button type="submit" variant="primary" disabled={ask.isPending || !prompt.trim()}>
            {ask.isPending ? 'Working…' : 'Send'}
          </Button>
        </div>
        <p className="m-0 text-xs text-faint">Ctrl+Enter sends. Undo takes back the chat's latest change.</p>
      </form>
    </section>
  );
}
