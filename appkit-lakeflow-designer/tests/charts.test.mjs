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
let preparePublishedChartData;
let outputDirectory;
before(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), 'designer-chart-test-'));
  await build({
    entry: ['client/src/chartOptions.ts', 'client/src/chartData.ts'],
    config: false,
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    logLevel: 'silent',
  });
  ({ buildPublishedChartOptions } = await import(
    pathToFileURL(join(outputDirectory, 'chartOptions.mjs')).href
  ));
  ({ preparePublishedChartData } = await import(pathToFileURL(join(outputDirectory, 'chartData.mjs')).href));
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

function optionsFor(plan = planFor(), data = [{ sellingprice: 1000, count: 2 }]) {
  const prepared = preparePublishedChartData(plan, data);
  return buildPublishedChartOptions(plan, prepared, ['#123456', '#abcdef', '#987654'], ui);
}

const labelSchema = [{ name: 'sellingprice', type: 'string' }, schema[1]];
function sortedSpec(sort) {
  return {
    ...spec,
    encodings: {
      ...spec.encodings,
      x: { ...spec.encodings.x, scale: { type: 'categorical', sort } },
    },
  };
}

test('default string sorting matches Designer, including lexicographic price buckets', () => {
  const rows = [
    { sellingprice: '$5,000 - $9,999', count: 1 },
    { sellingprice: '$45,000 - $49,999', count: 2 },
    { sellingprice: '$10,000 - $14,999', count: 3 },
  ];
  for (const widgetType of ['bar', 'line', 'area']) {
    const options = optionsFor(planFor({ ...spec, widgetType }, labelSchema), rows);
    assert.deepEqual(options.xAxis.data, ['$10,000 - $14,999', '$45,000 - $49,999', '$5,000 - $9,999']);
    assert.deepEqual(options.series[0].data, [3, 2, 1]);
  }
  assert.equal(rows[0].count, 1, 'sorting must not mutate the result table');
});

test('numeric categories sort by their schema type without changing their labels', () => {
  const rows = [
    { sellingprice: '10', count: 1 },
    { sellingprice: '002', count: 2 },
    { sellingprice: null, count: 3 },
  ];
  const options = optionsFor(planFor(), rows);
  assert.deepEqual(options.xAxis.data, ['-', '002', '10']);
  assert.deepEqual(options.series[0].data, [3, 2, 1]);
  const descending = optionsFor(planFor(sortedSpec({ by: 'natural-order-reversed' })), rows);
  assert.deepEqual(descending.xAxis.data, ['10', '002', '-']);
});

test('explicit custom order puts omitted labels in natural order and ignores duplicate entries', () => {
  const options = optionsFor(
    planFor(sortedSpec({ by: 'custom-order', orderedValues: ['B', 'B', 'absent', 'A'] }), labelSchema),
    ['D', 'A', 'C', 'B'].map((sellingprice, count) => ({ sellingprice, count })),
  );
  assert.deepEqual(options.xAxis.data, ['B', 'A', 'C', 'D']);
  assert.deepEqual(options.series[0].data, [3, 1, 2, 0]);
});

for (const by of ['original-order', 'original-order-reversed', 'y', 'y-reversed']) {
  test(`explicit ${by} sorts the category domain, not individual rows`, () => {
    const options = optionsFor(planFor(sortedSpec({ by }), labelSchema), [
      { sellingprice: 'B', count: 5 },
      { sellingprice: 'A', count: 8 },
      { sellingprice: 'B', count: 6 },
    ]);
    const bFirst = by === 'original-order' || by === 'y-reversed';
    assert.deepEqual(options.xAxis.data, bFirst ? ['B', 'B', 'A'] : ['A', 'B', 'B']);
    assert.deepEqual(options.series[0].data, bFirst ? [5, 6, 8] : [8, 5, 6]);
  });
}

test('horizontal bars resolve sort-by-x and display sorted categories top to bottom', () => {
  const plan = planFor(
    {
      ...spec,
      encodings: {
        x: spec.encodings.y,
        y: { ...spec.encodings.x, scale: { type: 'categorical', sort: { by: 'x-reversed' } } },
      },
    },
    labelSchema,
  );
  const options = optionsFor(plan, [
    { sellingprice: 'A', count: 2 },
    { sellingprice: 'B', count: 5 },
  ]);
  assert.deepEqual(options.yAxis.data, ['B', 'A']);
  assert.equal(options.yAxis.inverse, true);
  assert.deepEqual(options.series[0].data, [5, 2]);
});

test('horizontal bars default to natural category order, starting at the top', () => {
  const plan = planFor({ ...spec, encodings: { x: spec.encodings.y, y: spec.encodings.x } }, labelSchema);
  const options = optionsFor(plan, [
    { sellingprice: 'B', count: 5 },
    { sellingprice: 'A', count: 2 },
  ]);
  assert.deepEqual(options.yAxis.data, ['A', 'B']);
  assert.equal(options.yAxis.inverse, true);
  assert.deepEqual(options.series[0].data, [2, 5]);
});

test('boolean and temporal categories use typed sorting while preserving their labels', () => {
  for (const { type, values, expected } of [
    { type: 'boolean', values: [true, false], expected: ['false', 'true'] },
    {
      type: 'timestamp',
      values: ['2025-01-01T01:00:00+02:00', '2025-01-01T00:30:00+02:00'],
      expected: ['2025-01-01T00:30:00+02:00', '2025-01-01T01:00:00+02:00'],
    },
  ]) {
    const options = optionsFor(
      planFor(spec, [{ name: 'sellingprice', type }, schema[1]]),
      values.map((sellingprice, count) => ({ sellingprice, count })),
    );
    assert.deepEqual(options.xAxis.data, expected);
    assert.deepEqual(options.series[0].data, [1, 0]);
  }
});

test('numeric custom orders match JSON string values and naturally sort unlisted values', () => {
  const options = optionsFor(planFor(sortedSpec({ by: 'custom-order', orderedValues: [10, 2] })), [
    { sellingprice: '20', count: 0 },
    { sellingprice: '002', count: 1 },
    { sellingprice: '3', count: 2 },
    { sellingprice: '10', count: 3 },
  ]);
  assert.deepEqual(options.xAxis.data, ['10', '002', '3', '20']);
  assert.deepEqual(options.series[0].data, [3, 1, 2, 0]);
});

function seriesPlan(sort, colorSort, fields = labelSchema) {
  const chartSpec = sortedSpec(sort);
  return planFor(
    {
      ...chartSpec,
      encodings: {
        ...chartSpec.encodings,
        color: { fieldName: 'series', scale: { type: 'categorical', sort: colorSort } },
      },
    },
    [...fields, { name: 'series', type: 'string' }],
  );
}

const seriesRows = [
  { sellingprice: 'B', series: 'Beta', count: '6', priority: '1' },
  { sellingprice: 'A', series: 'Alpha', count: null, priority: '20' },
  { sellingprice: 'B', series: 'Alpha', count: '5', priority: '1' },
  { sellingprice: 'A', series: 'Beta', count: '8', priority: '20' },
];

test('measure sorting ranks category totals before pivoting and keeps all series aligned', () => {
  const plan = seriesPlan({ by: 'y-reversed' }, { by: 'natural-order-reversed' });
  const options = optionsFor(plan, seriesRows);
  assert.deepEqual(options.xAxis.data, ['B', 'A']);
  assert.deepEqual(
    options.series.map(({ name, data, color }) => ({ name, data, color })),
    [
      { name: 'Beta', data: [6, 8], color: '#abcdef' },
      { name: 'Alpha', data: [5, '-'], color: '#123456' },
    ],
  );
  assert.equal(seriesRows[0].count, '6', 'coercing/pivoting must not mutate result rows');
});

test('a custom measure field remains available for sorting before the series pivot', () => {
  const plan = seriesPlan({ by: 'measure-reversed', measure: { fieldName: 'priority' } }, undefined, [
    ...labelSchema,
    { name: 'priority', type: 'double' },
  ]);
  const options = optionsFor(plan, seriesRows);
  assert.deepEqual(options.xAxis.data, ['A', 'B']);
  assert.deepEqual(
    options.series.map(({ name, data }) => ({ name, data })),
    [
      { name: 'Alpha', data: ['-', 5] },
      { name: 'Beta', data: [8, 6] },
    ],
  );
});

test('series can sort by measure totals or custom order without reassigning their colors', () => {
  for (const sort of [{ by: 'y-reversed' }, { by: 'custom-order', orderedValues: ['Beta'] }]) {
    const options = optionsFor(seriesPlan(undefined, sort), seriesRows);
    assert.deepEqual(options.xAxis.data, ['A', 'B']);
    assert.deepEqual(
      options.series.map(({ name, color }) => ({ name, color })),
      [
        { name: 'Beta', color: '#abcdef' },
        { name: 'Alpha', color: '#123456' },
      ],
    );
  }
});

test('numeric series labels sort numerically before conversion to wide-format keys', () => {
  const plan = planFor(
    {
      ...spec,
      encodings: { ...spec.encodings, color: { fieldName: 'series' } },
    },
    [...schema, { name: 'series', type: 'int' }],
  );
  const options = optionsFor(plan, [
    { sellingprice: 1, series: '10', count: 8 },
    { sellingprice: 1, series: '2', count: 3 },
  ]);
  assert.deepEqual(
    options.series.map(({ name, data }) => ({ name, data })),
    [
      { name: '2', data: [3] },
      { name: '10', data: [8] },
    ],
  );
});

test('measure sort preserves Designer tie and null-total behavior without treating blanks as zero', () => {
  const rows = [
    { sellingprice: 'A', count: 5 },
    { sellingprice: 'B', count: 5 },
    { sellingprice: 'C', count: ' ' },
    { sellingprice: 'D', count: null },
  ];
  const ascending = optionsFor(planFor(sortedSpec({ by: 'y' }), labelSchema), rows);
  assert.deepEqual(ascending.xAxis.data, ['A', 'B', 'C', 'D']);
  const descending = optionsFor(planFor(sortedSpec({ by: 'y-reversed' }), labelSchema), rows);
  assert.deepEqual(descending.xAxis.data, ['D', 'C', 'B', 'A']);
  assert.deepEqual(descending.series[0].data, ['-', '-', 5, 5]);
});

function piePlan(sort) {
  return planFor(
    {
      ...spec,
      widgetType: 'pie',
      encodings: { color: sortedSpec(sort).encodings.x, angle: spec.encodings.y },
    },
    labelSchema,
  );
}

const pieRows = [
  { sellingprice: '2025-12-01', count: '2' },
  { sellingprice: '2025-01-01', count: '8' },
  { sellingprice: '2025-06-01', count: '4' },
];

test('pie defaults to descending angle totals, without AppKit date inference reordering slices', () => {
  const options = optionsFor(piePlan(), pieRows);
  assert.deepEqual(options.series[0].data, [
    { name: '2025-01-01', value: 8, itemStyle: { color: '#123456' } },
    { name: '2025-06-01', value: 4, itemStyle: { color: '#abcdef' } },
    { name: '2025-12-01', value: 2, itemStyle: { color: '#987654' } },
  ]);
  assert.equal(options.legend.textStyle.color, ui.axisTitle);
});

test('pie default ranking uses category totals without rewriting the displayed measures', () => {
  const options = optionsFor(piePlan(), [
    { sellingprice: 'B', count: 5 },
    { sellingprice: 'A', count: 8 },
    { sellingprice: 'B', count: 6 },
  ]);
  assert.deepEqual(options.series[0].data, [
    { name: 'B', value: 5, itemStyle: { color: '#123456' } },
    { name: 'B', value: 6, itemStyle: { color: '#123456' } },
    { name: 'A', value: 8, itemStyle: { color: '#abcdef' } },
  ]);
});

for (const sort of [
  { by: 'angle' },
  { by: 'natural-order-reversed' },
  { by: 'custom-order', orderedValues: ['2025-12-01', '2025-06-01'] },
]) {
  test(`pie explicit ${sort.by} changes order but preserves category colors`, () => {
    const options = optionsFor(piePlan(sort), pieRows);
    assert.deepEqual(options.series[0].data, [
      { name: '2025-12-01', value: 2, itemStyle: { color: '#987654' } },
      { name: '2025-06-01', value: 4, itemStyle: { color: '#abcdef' } },
      { name: '2025-01-01', value: 8, itemStyle: { color: '#123456' } },
    ]);
  });
}

test('missing sort fields and unsupported sorts fall back to rows instead of showing a wrong order', () => {
  assert.deepEqual(
    translatePublishedChart({
      chartSpec: sortedSpec({ by: 'measure', measure: { fieldName: 'missing' } }),
      schema,
    }),
    { ok: false, refusal: { reason: 'fieldNotInResult', fieldName: 'missing' } },
  );
  for (const sort of [{ by: 'unknown' }, { by: 'measure' }, { by: 'custom-order' }]) {
    assert.deepEqual(translatePublishedChart({ chartSpec: sortedSpec(sort), schema }), {
      ok: false,
      refusal: { reason: 'unsupportedSort', fieldName: 'sellingprice' },
    });
  }
});

test('empty results stay empty for categorical, grouped and pie charts', () => {
  for (const plan of [planFor(), seriesPlan(), piePlan()]) {
    const prepared = preparePublishedChartData(plan, []);
    assert.deepEqual(prepared.data, []);
    assert.doesNotThrow(() => optionsFor(plan, []));
  }
});

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
  const options = optionsFor(planFor(sortedSpec({ by: 'original-order' }), labelSchema), rows);
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
    encodings: {
      ...spec.encodings,
      // Categorical sort settings do not reorder continuous coordinates.
      x: { ...spec.encodings.x, scale: { type: 'quantitative', sort: { by: 'natural-order-reversed' } } },
    },
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
  const options = optionsFor(seriesPlan(undefined, undefined, schema), [
    { sellingprice: 1000, series: 'first', count: 2 },
    { sellingprice: 1000, series: 'second', count: 4 },
  ]);
  assert.deepEqual(
    options.series.map((series) => series.data),
    [[2], [4]],
  );
  assert.equal(options.legend.textStyle.color, ui.axisTitle);
  assert.deepEqual(
    options.series.map(({ color }) => color),
    ['#123456', '#abcdef'],
  );
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
