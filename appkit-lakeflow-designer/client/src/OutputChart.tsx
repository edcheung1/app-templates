import { AreaChart, BarChart, LineChart, PieChart } from '@databricks/appkit-ui/react';

import type { PublishedChartCoercion, PublishedChartPlan, PublishedChartRow } from './chartTranslation';

const CHART_HEIGHT = 260;

function coerce(value: unknown, to: 'number' | 'date'): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (to === 'number') {
    // Number('') and Number('   ') are 0, so treat a blank string as missing rather than a real zero.
    if (typeof value === 'string' && value.trim() === '') {
      return null;
    }
    const asNumber = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  const asDate = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

// JSON rows carry temporal and quantitative columns as strings; appkit reads each axis type off the
// values, so convert those columns to Date and number before handing the rows over.
function coerceRows(
  rows: readonly PublishedChartRow[],
  coercions: readonly PublishedChartCoercion[],
): PublishedChartRow[] {
  if (coercions.length === 0) {
    return [...rows];
  }
  return rows.map((row) => {
    const next = { ...row };
    for (const { field, to } of coercions) {
      next[field] = coerce(next[field], to);
    }
    return next;
  });
}

// appkit groups series by multiple yKeys (wide-format), so fold the single long-format series column
// out to one column per distinct series value, summing collisions the way a stacked mark would.
function pivotSeries(
  rows: readonly PublishedChartRow[],
  xKey: string,
  seriesKey: string,
  yKey: string,
): { data: PublishedChartRow[]; yKeys: string[] } {
  const byX = new Map<unknown, PublishedChartRow>();
  const yKeys: string[] = [];
  for (const row of rows) {
    const series = String(row[seriesKey]);
    // A series whose value equals the x column name cannot share the wide row's key space with the
    // x value, so drop it rather than let it overwrite the x axis.
    if (series === xKey) {
      continue;
    }
    if (!yKeys.includes(series)) {
      yKeys.push(series);
    }
    const xValue = row[xKey];
    // Dates compare by reference as Map keys, so group on a primitive to fold equal instants together.
    const groupKey = xValue instanceof Date ? xValue.getTime() : xValue;
    let wide = byX.get(groupKey);
    if (wide === undefined) {
      wide = { [xKey]: xValue };
      byX.set(groupKey, wide);
    }
    const measure = row[yKey];
    const prior = wide[series];
    // Sum repeated buckets, but never let a missing measure erase a value already accumulated.
    if (typeof measure === 'number') {
      wide[series] = typeof prior === 'number' ? prior + measure : measure;
    } else if (prior === undefined) {
      wide[series] = measure;
    }
  }
  return { data: [...byX.values()], yKeys };
}

export function OutputChart({ plan, rows }: { plan: PublishedChartPlan; rows: readonly PublishedChartRow[] }) {
  const data = coerceRows(rows, plan.coercions);

  if (plan.component === 'pie') {
    return (
      <div data-testid="output-chart">
        <PieChart data={data} xKey={plan.xKey} yKey={plan.yKey} height={CHART_HEIGHT} showLegend />
      </div>
    );
  }

  const { data: chartData, yKeys } =
    plan.seriesKey === undefined
      ? { data, yKeys: [plan.yKey] }
      : pivotSeries(data, plan.xKey, plan.seriesKey, plan.yKey);

  const props = {
    data: chartData,
    xKey: plan.xKey,
    yKey: yKeys.length === 1 ? yKeys[0] : yKeys,
    height: CHART_HEIGHT,
    showLegend: yKeys.length > 1,
  };

  return (
    <div data-testid="output-chart">
      {plan.component === 'bar' ? <BarChart {...props} /> : null}
      {plan.component === 'line' ? <LineChart {...props} /> : null}
      {plan.component === 'area' ? <AreaChart {...props} /> : null}
    </div>
  );
}
