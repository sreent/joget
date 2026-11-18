import type { TestResult, TestsRun } from '../types.js';
import { Badge } from './ui.js';

/** A value as a test's result says it: JSON, short. */
const shown = (value: unknown): string => (value === null || value === undefined ? 'nothing' : typeof value === 'string' ? value : JSON.stringify(value));

/** What a run of the app's tests found: each test, whether it passed, and if not, why. */
export function TestResults({ run }: { run: TestsRun }) {
  return (
    <div className="grid gap-2">
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={run.failed ? 'bad' : 'good'}>{run.failed ? `${run.failed} failed` : 'All passed'}</Badge>
        <span className="text-muted">
          {run.passed} of {run.passed + run.failed} passed
        </span>
      </p>
      <ul aria-label="Test results" className="m-0 grid list-none gap-1.5 p-0">
        {run.results.map((result) => (
          <TestResultItem key={result.name} result={result} />
        ))}
      </ul>
    </div>
  );
}

function TestResultItem({ result }: { result: TestResult }) {
  return (
    <li className="grid gap-0.5 text-sm">
      <span className="flex items-center gap-2">
        <Badge tone={result.passed ? 'good' : 'bad'}>{result.passed ? 'passed' : 'failed'}</Badge>
        <span className="font-medium">{result.label}</span>
      </span>
      {!result.passed && result.outcome === 'refused' ? <span className="text-xs text-bad">Refused: {result.message}</span> : null}
      {!result.passed && result.outcome === 'error' ? <span className="text-xs text-bad">{result.message}</span> : null}
      {result.passed && result.outcome === 'refused' && result.message ? (
        <span className="text-xs text-muted">Refused, as it should be: {result.message}</span>
      ) : null}
      {result.mismatches?.map((mismatch) => (
        <span key={mismatch.field} className="text-xs text-bad">
          {mismatch.field} is {shown(mismatch.actual)}, not {shown(mismatch.expected)}
        </span>
      ))}
      {!result.passed && result.outcome === 'saved' && !result.mismatches?.length ? (
        <span className="text-xs text-bad">It saved, and the test expects a refusal</span>
      ) : null}
    </li>
  );
}
