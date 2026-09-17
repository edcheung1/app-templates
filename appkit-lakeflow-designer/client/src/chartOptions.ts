import {
  buildCartesianOption,
  buildHorizontalBarOption,
  buildPieOption,
  type ChartUITokens,
  type OptionBuilderContext,
} from '@databricks/appkit-ui/react';

import type { PublishedChartData } from './chartData';
import type { PublishedChartPlan } from './chartTranslation';

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
  if (typeof value === 'boolean') {
    return String(value);
  }
  // ECharts treats '-' as missing, whereas AppKit's inferred-data path turns nulls into zeroes.
  return typeof value === 'number' || typeof value === 'string' ? value : '-';
}

export function buildPublishedChartOptions(
  plan: PublishedChartPlan,
  { data, yKeys, colorIndexes }: PublishedChartData,
  colors: string[],
  ui: ChartUITokens,
): Record<string, unknown> {
  const horizontal = plan.orientation === 'horizontal';
  const continuousX = plan.xType !== 'nominal';
  // The spec already supplies field roles. Keep the supplied rows aligned instead of letting
  // AppKit infer dates from category labels or unrelated columns and then reorder the data.
  const context: OptionBuilderContext = {
    xData: data.map((row) => chartValue(row[plan.xKey])),
    yDataMap: Object.fromEntries(yKeys.map((key) => [key, data.map((row) => chartValue(row[key]))])),
    xField: plan.xKey,
    yFields: yKeys,
    colors: colorIndexes.map((index) => colors[index % colors.length]),
    ui,
    title: plan.title,
    showLegend: plan.component === 'pie' || yKeys.length > 1,
  };
  if (plan.component === 'pie') {
    const option = buildPieOption(context, 'pie', 0, true, 'outside');
    return {
      ...option,
      series: Array.isArray(option.series)
        ? option.series.map((value) => {
            const series = record(value);
            return {
              ...series,
              data: Array.isArray(series.data)
                ? series.data.map((slice, index) => ({
                    ...record(slice),
                    itemStyle: { color: context.colors[index] },
                  }))
                : series.data,
            };
          })
        : option.series,
    };
  }
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
    yAxis: {
      ...yAxis,
      ...(horizontal ? { inverse: true } : {}),
      name: plan.yTitle,
      nameLocation: 'middle',
      nameGap: 48,
    },
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
