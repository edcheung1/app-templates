import { useEffect, useState } from 'react';
import { Button } from '@databricks/appkit-ui/react';
import { isExportFormat, type ExportFormat, type ExportStatus } from '../../shared/exportConfig';

interface ExportAttempt {
  requestId: string;
  format: ExportFormat;
  exportId?: string;
}
export interface ExportDownloadProps {
  sourceRunId: string;
  outputId: string;
}

function restore(key: string): ExportAttempt | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value.requestId === 'string' &&
      isExportFormat(value.format) &&
      (value.exportId === undefined || /^[a-f0-9]{64}$/.test(value.exportId))
    )
      return value;
  } catch {
    /* Storage may be disabled in the browser. */
  }
  return undefined;
}

async function request(url: string, signal: AbortSignal, body?: object): Promise<ExportStatus> {
  const response = await fetch(url, {
    signal,
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Export request failed.');
  return value;
}

export function ExportDownload({ sourceRunId, outputId }: ExportDownloadProps) {
  const key = `designer-export:${sourceRunId}:${outputId}`;
  const [attempt, setAttempt] = useState<ExportAttempt | undefined>(() => restore(key));
  const [status, setStatus] = useState<ExportStatus>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const remember = (next: ExportAttempt) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Optional reload recovery. */
    }
    setAttempt(next);
  };

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const current = await request(`/api/designer/exports/${attempt?.exportId}`, controller.signal);
        setStatus(current);
        setError(undefined);
        if (['queued', 'running'].includes(current.phase)) timer = setTimeout(poll, 2000);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Could not check export status.');
      }
    }
    if (attempt.exportId) void poll();
    else {
      setError(undefined);
      void request('/api/designer/exports', controller.signal, { sourceRunId, outputId, ...attempt })
        .then((created) => {
          if (!controller.signal.aborted) {
            setStatus(created);
            const next = { ...attempt, exportId: created.exportId };
            try {
              sessionStorage.setItem(key, JSON.stringify(next));
            } catch {
              /* Optional reload recovery. */
            }
            setAttempt(next);
          }
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setError(failure instanceof Error ? failure.message : 'Could not start export.');
        });
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [attempt, key, sourceRunId, outputId, retry]);

  const busy = !error && attempt !== undefined && (!status || ['queued', 'running'].includes(status.phase));
  const generate = (format: ExportFormat) => {
    setStatus(undefined);
    setError(undefined);
    setCancelling(false);
    remember({ requestId: crypto.randomUUID(), format });
  };
  const cancel = async () => {
    if (!attempt?.exportId) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/designer/exports/${attempt.exportId}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not cancel the export. Try again.');
      setRetry((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not cancel export.');
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-2 px-6 py-4" aria-label="Download full data">
      <p className="text-muted-foreground text-xs">
        Reuses generated files for this run; otherwise recomputes this output using the run&apos;s parameters and
        current data. Run the app again for newer data. Maximum 1,000,000 rows, 5,000,000 cells and 256 MiB.
        Files are retained in the storage volume for repeat downloads and require manual cleanup.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => generate('csv')}
        >
          Generate CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => generate('xlsx')}
        >
          Generate Excel
        </Button>
        {busy && (
          <span role="status" className="text-sm">
            {cancelling ? 'Cancelling…' : 'Generating export…'}
          </span>
        )}
        {status?.runPageUrl && (
          <a className="text-sm underline" href={status.runPageUrl} target="_blank" rel="noopener noreferrer">
            View job run
          </a>
        )}
        {busy && attempt?.exportId && (
          <Button variant="outline" size="sm" disabled={cancelling} onClick={() => void cancel()}>
            Cancel export
          </Button>
        )}
        {status?.phase === 'ready' && (
          <a className="text-sm underline" href={`/api/designer/exports/${status.exportId}/download`} download>
            Download {attempt?.format === 'xlsx' ? 'Excel' : 'CSV'} ({status.rowCount?.toLocaleString()} rows)
          </a>
        )}
        {error && (
          <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            Retry request
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {status?.phase === 'failed' && (
        <p role="alert" className="text-sm">
          {status.message ?? 'Export generation failed.'}
        </p>
      )}
      {status?.phase === 'cancelled' && (
        <p role="status" className="text-sm">
          Export cancelled.
        </p>
      )}
    </div>
  );
}
