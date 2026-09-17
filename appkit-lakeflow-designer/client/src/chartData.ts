import { chartDomainKey, sortedChartDomain } from './chartSorting';
import type {
  PublishedChartCoercion,
  PublishedChartDomain,
  PublishedChartPlan,
  PublishedChartRow,
} from './chartTranslation';

export interface PublishedChartData {
  data: PublishedChartRow[];
  yKeys: string[];
  // Colors follow Designer's default domain, even when an explicit sort reorders marks/legend.
  colorIndexes: number[];
}

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

// Decode dates and measures without rewriting category labels or mutating the result table.
function coerceRows(
  rows: readonly PublishedChartRow[],
  coercions: readonly PublishedChartCoercion[],
): PublishedChartRow[] {
  return rows.map((row) => {
    const next = { ...row };
    for (const { field, to } of coercions) {
      next[field] = coerce(next[field], to);
    }
    return next;
  });
}

// AppKit groups series by multiple yKeys (wide-format). Sum repeated category/series buckets.
function pivotSeries(
  rows: readonly PublishedChartRow[],
  xKey: string,
  series: PublishedChartDomain,
  yKey: string,
): PublishedChartRow[] {
  const byX = new Map<unknown, PublishedChartRow>();
  for (const row of rows) {
    const seriesName = String(row[series.field]);
    // The dimension and series share the wide row's key space.
    if (seriesName === xKey) {
      continue;
    }
    const xValue = row[xKey];
    const groupKey = xValue instanceof Date ? xValue.getTime() : xValue;
    let wide = byX.get(groupKey);
    if (wide === undefined) {
      wide = { [xKey]: xValue };
      byX.set(groupKey, wide);
    }
    const measure = row[yKey];
    const prior = wide[seriesName];
    if (typeof measure === 'number') {
      wide[seriesName] = typeof prior === 'number' ? prior + measure : measure;
    } else if (prior === undefined) {
      wide[seriesName] = measure;
    }
  }
  return [...byX.values()];
}

export function preparePublishedChartData(
  plan: PublishedChartPlan,
  rows: readonly PublishedChartRow[],
): PublishedChartData {
  const data = coerceRows(rows, plan.coercions);
  let yKeys = [plan.yKey];
  let colorValues: unknown[] = [];
  let defaultRanks = new Map<unknown, number>();
  const colorDomain = plan.component === 'pie' ? plan.dimension : plan.series;
  if (colorDomain) {
    const defaultValues = sortedChartDomain(data, {
      ...colorDomain,
      sort: plan.component === 'pie' ? { by: 'measure-reversed', field: plan.yKey } : { by: 'natural-order' },
    });
    defaultRanks = new Map(
      defaultValues.map((value, index) => [chartDomainKey(value, colorDomain.valueType), index]),
    );
    if (plan.series) {
      colorValues = sortedChartDomain(data, colorDomain).filter((value) => String(value) !== plan.xKey);
      yKeys = colorValues.map(String);
    }
  }

  if (plan.dimension) {
    const domain = plan.dimension;
    const ranks = new Map(
      sortedChartDomain(data, domain).map((value, index) => [chartDomainKey(value, domain.valueType), index]),
    );
    const rank = (row: PublishedChartRow) =>
      ranks.get(chartDomainKey(row[domain.field], domain.valueType)) ?? ranks.size;
    data.sort((a, b) => rank(a) - rank(b));
  } else {
    const coordinate = (row: PublishedChartRow) => {
      const value = row[plan.xKey];
      return value instanceof Date ? value.getTime() : Number(value);
    };
    data.sort((a, b) => coordinate(a) - coordinate(b));
  }

  if (plan.component === 'pie') {
    colorValues = data.map((row) => row[plan.xKey]);
  }
  const colorIndexes = colorDomain
    ? colorValues.map((value) => defaultRanks.get(chartDomainKey(value, colorDomain.valueType)) ?? 0)
    : [0];

  return {
    data: plan.series ? pivotSeries(data, plan.xKey, plan.series, plan.yKey) : data,
    yKeys,
    colorIndexes,
  };
}
