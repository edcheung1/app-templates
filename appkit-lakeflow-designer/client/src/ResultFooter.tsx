import { Badge } from '@databricks/appkit-ui/react';
import type { OkPayload } from './payload';

const formatCount = (n: number) => n.toLocaleString();

export function ResultFooter({ payload }: { payload: OkPayload }) {
  const { rows, truncated, metrics } = payload;
  const schemaOmitted = truncated?.schema_omitted === true;
  const byBytes = truncated?.by_byte_budget === true;
  const byRows = truncated?.by_row_limit === true;

  return (
    <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-1.5 text-xs">
      <span className="text-muted-foreground tabular-nums">{formatCount(rows.length)} rows</span>

      {schemaOmitted || byBytes ? (
        <Badge variant="destructive" className="font-normal">
          {schemaOmitted ? 'Output did not fit' : 'Result too large'}
        </Badge>
      ) : null}
      {!schemaOmitted && !byBytes && byRows ? (
        <Badge variant="secondary" className="font-normal">
          Based on sample data
        </Badge>
      ) : null}

      <span className="text-muted-foreground">
        {schemaOmitted
          ? `The ${formatCount(truncated.byte_budget)}-byte payload budget was already spent by the outputs before this one, so none of it was returned: not the rows and not the column list. This is not an empty result. Narrow the earlier outputs or raise the budget.`
          : byBytes
            ? `Serialization stopped at the ${formatCount(truncated.byte_budget)}-byte payload budget, so rows are missing from the end. Narrow the result or raise the budget.`
            : byRows
              ? `Showing the first ${formatCount(truncated.row_limit)} rows. There may be more upstream.`
              : 'Complete result.'}
      </span>

      <span className="text-muted-foreground ml-auto flex items-center gap-3">
        {metrics?.collect_ms != null ? <span className="tabular-nums">collect {metrics.collect_ms} ms</span> : null}
        {metrics?.total_ms != null ? <span className="tabular-nums">notebook {metrics.total_ms} ms</span> : null}
      </span>
    </div>
  );
}
