import { Badge } from '@databricks/appkit-ui/react';
import type { OkPayload } from './payload';

const formatCount = (n: number) => n.toLocaleString();

export function ResultFooter({ payload }: { payload: OkPayload }) {
  const { rows, truncated, total_row_count, metrics } = payload;
  const rowCountLabel =
    truncated === true && total_row_count !== undefined
      ? `${formatCount(rows.length)} / ${formatCount(total_row_count)} rows`
      : `${formatCount(rows.length)} rows${truncated === false ? '' : ' shown'}`;

  return (
    <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-1.5 text-xs">
      <span className="text-muted-foreground tabular-nums">{rowCountLabel}</span>

      {truncated === true ? (
        <Badge variant="secondary" className="font-normal">
          Truncated
        </Badge>
      ) : null}

      <span className="text-muted-foreground ml-auto flex items-center gap-3">
        {metrics?.collect_ms != null ? <span className="tabular-nums">collect {metrics.collect_ms} ms</span> : null}
        {metrics?.total_ms != null ? <span className="tabular-nums">notebook {metrics.total_ms} ms</span> : null}
      </span>
    </div>
  );
}
