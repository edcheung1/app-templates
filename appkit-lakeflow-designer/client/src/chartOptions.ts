import {
  buildCartesianOption,
  buildHorizontalBarOption,
  type ChartUITokens,
  type OptionBuilderContext,
} from '@databricks/appkit-ui/react';

import type { PublishedChartPlan, PublishedChartRow } from './chartTranslation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function chartValue(value: unknown): string | number {
  if (value instanceof Date) {
    return value.getTime();
  }
  // ECharts treats '-' as missing, whereas AppKit's inferred-data path turns nulls into zeroes.
  return typeof value === 'number' || typeof value === 'string' ? value : '-';
}

export function buildPublishedChartOptions(
  plan: PublishedChartPlan,
  data: readonly PublishedChartRow[],
  yKeys: string[],
  colors: string[],
  ui: ChartUITokens,
): Record<string, unknown> {
  const horizontal = plan.orientation === 'horizontal';
  const continuousX = plan.xType !== 'nominal';
  const orderedData =
    !horizontal && continuousX
      ? [...data].sort(
          (left, right) => Number(chartValue(left[plan.xKey])) - Number(chartValue(right[plan.xKey])),
        )
      : data;
  // The spec already supplies field roles. Keep the supplied rows aligned instead of letting
  // AppKit infer dates from category labels or unrelated columns and then reorder the data.
  const context: OptionBuilderContext = {
    xData: orderedData.map((row) => chartValue(row[plan.xKey])),
    yDataMap: Object.fromEntries(yKeys.map((key) => [key, orderedData.map((row) => chartValue(row[key]))])),
    xField: plan.xKey,
    yFields: yKeys,
    colors,
    ui,
    title: plan.title,
    showLegend: yKeys.length > 1,
  };
  const option = horizontal
    ? buildHorizontalBarOption(context, false)
    : buildCartesianOption({
        ...context,
        chartType: plan.component,
        isTimeSeries: continuousX,
        stacked: false,
        smooth: plan.lineShape === 'smooth',
        showSymbol: false,
        symbolSize: 8,
      });

  // AppKit shallow-merges `options`, so retain its complete themed axes/series when overriding.
  const xAxis = record(option.xAxis);
  const yAxis = record(option.yAxis);
  return {
    ...option,
    xAxis: {
      ...xAxis,
      type:
        horizontal || plan.xType === 'quantitative'
          ? 'value'
          : plan.xType === 'temporal'
            ? 'time'
            : 'category',
      name: plan.xTitle,
      nameLocation: 'middle',
      nameGap: 36,
    },
    yAxis: { ...yAxis, name: plan.yTitle, nameLocation: 'middle', nameGap: 48 },
    grid: {
      ...record(option.grid),
      left: 56,
      right: 24,
      bottom: context.showLegend ? 76 : 52,
      containLabel: true,
    },
    series: Array.isArray(option.series)
      ? option.series.map((value) => {
          const series = record(value);
          return {
            ...series,
            ...(plan.component === 'bar'
              ? { itemStyle: { ...record(series.itemStyle), borderRadius: 0 } }
              : {}),
            ...(plan.lineShape === 'step' && (plan.component === 'line' || plan.component === 'area')
              ? { step: 'end' }
              : {}),
          };
        })
      : option.series,
  };
}
