import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { build } from 'tsdown';

import { translatePublishedChart } from '../client/src/chartTranslation.ts';

// Bundle the real public AppKit helpers, which have browser-oriented imports Node cannot resolve
// directly. This uses the template's existing bundler and does not need a DOM or chart mocks.
let buildPublishedChartOptions;
let outputDirectory;
before(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), 'designer-chart-test-'));
  await build({
    entry: ['client/src/chartOptions.ts'],
    config: false,
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    logLevel: 'silent',
  });
  ({ buildPublishedChartOptions } = await import(
    pathToFileURL(join(outputDirectory, 'chartOptions.mjs')).href
  ));
});
after(async () => {
  if (outputDirectory !== undefined) {
    await rm(outputDirectory, { recursive: true });
  }
});

const schema = [
  { name: 'sellingprice', type: 'double' },
  { name: 'count', type: 'long' },
];
const spec = {
  widgetType: 'bar',
  encodings: {
    x: { fieldName: 'sellingprice', scale: { type: 'categorical' }, displayName: 'price range' },
    y: { fieldName: 'count', scale: { type: 'quantitative' }, displayName: 'count' },
  },
  frame: { title: 'Fords Sold in 2015 by Selling Price', showTitle: true },
};
const ui = { axisLabel: '#555', axisTitle: '#222', grid: '#ddd', tooltipBg: '#fff' };

function planFor(chartSpec = spec, fields = schema) {
  const result = translatePublishedChart({ chartSpec, schema: fields });
  assert.equal(result.ok, true);
  return result.plan;
}

function optionsFor(plan = planFor(), data = [{ sellingprice: 1000, count: 2 }], yKeys = [plan.yKey]) {
  return buildPublishedChartOptions(plan, data, yKeys, ['#123456'], ui);
}

test('the Ford chart keeps numeric selling prices categorical and renders vertical bars', () => {
  const plan = planFor();
  assert.equal(plan.orientation, 'vertical');
  assert.equal(plan.xType, 'nominal');
  assert.deepEqual(plan.coercions, [{ field: 'count', to: 'number' }]);
  const options = optionsFor(plan, [
    { sellingprice: '001000', count: 2 },
    { sellingprice: '2000', count: 5 },
  ]);
  assert.equal(options.xAxis.type, 'category');
  assert.deepEqual(options.xAxis.data, ['001000', '2000']);
  assert.equal(options.yAxis.type, 'value');
  assert.equal(options.series[0].type, 'bar');
  assert.deepEqual(options.series[0].data, [2, 5]);
  assert.equal(options.series[0].itemStyle.borderRadius, 0);
});

test('preserves chart and axis titles without losing AppKit theme or axis data', () => {
  const options = optionsFor();
  assert.equal(options.title.text, spec.frame.title);
  assert.equal(options.xAxis.name, 'price range');
  assert.equal(options.yAxis.name, 'count');
  assert.equal(options.xAxis.axisLabel.color, ui.axisLabel);
  assert.equal(options.yAxis.nameTextStyle.color, ui.axisTitle);
  assert.deepEqual(options.xAxis.data, [1000]);
  assert.equal(options.grid.containLabel, true);
});

test('keeps genuinely horizontal bars horizontal and binds the dimension and measure correctly', () => {
  const plan = planFor({ ...spec, encodings: { x: spec.encodings.y, y: spec.encodings.x } });
  assert.equal(plan.orientation, 'horizontal');
  assert.equal(plan.xKey, 'sellingprice');
  assert.equal(plan.yKey, 'count');
  const options = optionsFor(plan);
  assert.equal(options.xAxis.type, 'value');
  assert.equal(options.xAxis.name, 'count');
  assert.equal(options.yAxis.type, 'category');
  assert.equal(options.yAxis.name, 'price range');
  assert.deepEqual(options.yAxis.data, [1000]);
  assert.deepEqual(options.series[0].data, [2]);
});

test('respects hidden chart titles and custom or hidden axis titles', () => {
  const options = optionsFor(
    planFor({
      ...spec,
      frame: { ...spec.frame, showTitle: false },
      encodings: {
        x: { ...spec.encodings.x, axis: { title: 'Sale price' } },
        y: { ...spec.encodings.y, axis: { hideTitle: true } },
      },
    }),
  );
  assert.equal(options.title, undefined);
  assert.equal(options.xAxis.name, 'Sale price');
  assert.equal(options.yAxis.name, '');
});

test('uses schema types when a scale is absent', () => {
  assert.equal(
    planFor({ ...spec, encodings: { ...spec.encodings, x: { fieldName: 'sellingprice' } } }).xType,
    'quantitative',
  );
});

test('numeric x axes use value coordinates, not equally spaced categories or dates', () => {
  const plan = planFor({
    ...spec,
    encodings: { ...spec.encodings, x: { ...spec.encodings.x, scale: { type: 'quantitative' } } },
  });
  const options = optionsFor(plan, [
    { sellingprice: 1, count: 2 },
    { sellingprice: 100, count: 5 },
  ]);
  assert.equal(options.xAxis.type, 'value');
  assert.deepEqual(options.series[0].data, [
    [1, 2],
    [100, 5],
  ]);
});

test('date-looking category labels and row order survive unrelated date columns', () => {
  const rows = [
    { sellingprice: '2025-12-01', count: 3, created_date: '2025-01-01' },
    { sellingprice: '2025-01-01', count: 8, created_date: '2025-12-01' },
  ];
  const options = optionsFor(planFor(), rows);
  assert.equal(options.xAxis.type, 'category');
  assert.deepEqual(options.xAxis.data, ['2025-12-01', '2025-01-01']);
  assert.deepEqual(options.series[0].data, [3, 8]);
});

test('temporal axes plot decoded dates on a time axis', () => {
  const plan = planFor({
    ...spec,
    widgetType: 'line',
    encodings: { ...spec.encodings, x: { ...spec.encodings.x, scale: { type: 'temporal' } } },
  });
  const date = new Date('2025-01-01T00:00:00Z');
  const options = optionsFor(plan, [{ sellingprice: date, count: 2 }]);
  assert.equal(options.xAxis.type, 'time');
  assert.deepEqual(options.series[0].data, [[date.getTime(), 2]]);
});

test('continuous axes sort coordinates together with their series values', () => {
  const plan = planFor({
    ...spec,
    widgetType: 'line',
    encodings: { ...spec.encodings, x: { ...spec.encodings.x, scale: { type: 'quantitative' } } },
  });
  const options = optionsFor(plan, [
    { sellingprice: 100, count: 5 },
    { sellingprice: 1, count: 2 },
  ]);
  assert.deepEqual(options.series[0].data, [
    [1, 2],
    [100, 5],
  ]);
});

for (const widgetType of ['line', 'area']) {
  for (const lineShape of [undefined, 'linear', 'smooth', 'step']) {
    test(`${widgetType} honors line shape ${lineShape ?? 'default (linear)'}`, () => {
      const options = optionsFor(planFor({ ...spec, widgetType, mark: { lineShape } }));
      assert.equal(options.series[0].smooth, lineShape === 'smooth');
      assert.equal(options.series[0].step, lineShape === 'step' ? 'end' : undefined);
      assert.equal(options.series[0].type, 'line');
    });
  }
}

test('missing measures remain gaps, and duplicate categories are not silently summed', () => {
  const options = optionsFor(planFor(), [
    { sellingprice: 1000, count: null },
    { sellingprice: 1000, count: 2 },
  ]);
  assert.deepEqual(options.xAxis.data, [1000, 1000]);
  assert.deepEqual(options.series[0].data, ['-', 2]);
});

test('multiple series retain their aligned data and theme colors', () => {
  const options = optionsFor(planFor(), [{ sellingprice: 1000, first: 2, second: 4 }], ['first', 'second']);
  assert.deepEqual(
    options.series.map((series) => series.data),
    [[2], [4]],
  );
  assert.equal(options.legend.textStyle.color, ui.axisTitle);
});

test('pie charts preserve their title and still bind category and angle', () => {
  const plan = planFor({
    ...spec,
    widgetType: 'pie',
    encodings: { color: spec.encodings.x, angle: spec.encodings.y },
  });
  assert.equal(plan.title, spec.frame.title);
  assert.equal(plan.xKey, 'sellingprice');
  assert.equal(plan.yKey, 'count');
});

test('unsupported charts and missing result fields still fall back to rows', () => {
  assert.deepEqual(translatePublishedChart({ chartSpec: { ...spec, widgetType: 'box' }, schema }), {
    ok: false,
    refusal: { reason: 'unsupportedWidgetType', widgetType: 'box' },
  });
  assert.deepEqual(translatePublishedChart({ chartSpec: spec, schema: schema.slice(1) }), {
    ok: false,
    refusal: { reason: 'fieldNotInResult', fieldName: 'sellingprice' },
  });
});
