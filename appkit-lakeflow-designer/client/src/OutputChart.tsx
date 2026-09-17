import {
  AreaChart,
  BarChart,
  LineChart,
  PieChart,
  useChartUITokens,
  useThemeColors,
} from '@databricks/appkit-ui/react';

import { buildPublishedChartOptions } from './chartOptions';
import { preparePublishedChartData } from './chartData';
import type { PublishedChartPlan, PublishedChartRow } from './chartTranslation';

const CHART_HEIGHT = 260;

export function OutputChart({
  plan,
  rows,
}: {
  plan: PublishedChartPlan;
  rows: readonly PublishedChartRow[];
}) {
  const colors = useThemeColors();
  const ui = useChartUITokens();
  const chartData = preparePublishedChartData(plan, rows);
  const { data, yKeys } = chartData;
  const options = buildPublishedChartOptions(plan, chartData, colors, ui);

  if (plan.component === 'pie') {
    return (
      <div data-testid="output-chart">
        <PieChart
          data={data}
          xKey={plan.xKey}
          yKey={plan.yKey}
          title={plan.title}
          ariaLabel={plan.title ?? plan.yTitle}
          height={CHART_HEIGHT}
          showLegend
          options={options}
        />
      </div>
    );
  }

  const props = {
    data,
    xKey: plan.xKey,
    yKey: yKeys.length === 1 ? yKeys[0] : yKeys,
    height: CHART_HEIGHT,
    showLegend: yKeys.length > 1,
    orientation: plan.orientation,
    title: plan.title,
    ariaLabel: plan.title ?? `${plan.yTitle} by ${plan.xTitle}`,
    options,
  };

  return (
    <div data-testid="output-chart">
      {plan.component === 'bar' ? <BarChart {...props} /> : null}
      {plan.component === 'line' ? <LineChart {...props} /> : null}
      {plan.component === 'area' ? <AreaChart {...props} /> : null}
    </div>
  );
}
