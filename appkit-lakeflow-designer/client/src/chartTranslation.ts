export type PublishedChartRow = Record<string, unknown>;

export interface PublishedChartField {
  name: string;
  type: string;
}

export interface PublishedChartSpecInput {
  widgetType: string;
  [key: string]: unknown;
}

export type PublishedChartFieldType = 'quantitative' | 'temporal' | 'nominal';

export type PublishedChartComponent = 'bar' | 'line' | 'area' | 'pie';

export interface PublishedChartCoercion {
  field: string;
  to: 'number' | 'date';
}

export interface PublishedChartPlan {
  component: PublishedChartComponent;
  xKey: string;
  yKey: string;
  orientation: 'vertical' | 'horizontal';
  xType: PublishedChartFieldType;
  title?: string;
  lineShape: 'linear' | 'smooth' | 'step';

  // The long-format `color` channel. AppKit draws series wide-format, so when this is set the
  // rows are pivoted to one column per series value before charting.
  seriesKey?: string;
  xTitle: string;
  yTitle: string;

  // JSON rows carry temporal and quantitative values as strings; decode them before charting.
  coercions: PublishedChartCoercion[];
}

export type PublishedChartRefusal =
  | { reason: 'unsupportedWidgetType'; widgetType: string }
  | { reason: 'missingChannel'; channel: string }
  | { reason: 'fieldNotInResult'; fieldName: string }
  | { reason: 'noMeasure'; fieldNames: string[] };

export type PublishedChartTranslation =
  | { ok: true; plan: PublishedChartPlan }
  | { ok: false; refusal: PublishedChartRefusal };

const CARTESIAN: ReadonlyMap<string, 'bar' | 'line' | 'area'> = new Map([
  ['bar', 'bar'],
  ['line', 'line'],
  ['area', 'area'],
]);

// Used only when the chart has no explicit scale; numeric columns can be plotted as categories.
function fieldTypeOf(sparkType: string): PublishedChartFieldType {
  const type = sparkType.trim().toLowerCase();
  if (type === 'date' || type.startsWith('timestamp') || type === 'datetime') {
    return 'temporal';
  }
  if (
    type.startsWith('decimal') ||
    type.startsWith('numeric') ||
    type === 'tinyint' ||
    type === 'smallint' ||
    type === 'int' ||
    type === 'integer' ||
    type === 'bigint' ||
    type === 'long' ||
    type === 'short' ||
    type === 'byte' ||
    type === 'float' ||
    type === 'double' ||
    type === 'real'
  ) {
    return 'quantitative';
  }
  return 'nominal';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Bound {
  field: string;
  type: PublishedChartFieldType;
  title: string;
}

function channelOf(
  chartSpec: PublishedChartSpecInput,
  channel: string,
): { fieldName: string; title: string; type?: PublishedChartFieldType } | undefined {
  const encodings = chartSpec.encodings;
  if (!isRecord(encodings)) {
    return undefined;
  }
  const encoding = encodings[channel];
  if (!isRecord(encoding) || typeof encoding.fieldName !== 'string' || encoding.fieldName === '') {
    return undefined;
  }

  const displayName =
    typeof encoding.displayName === 'string' && encoding.displayName !== ''
      ? encoding.displayName
      : undefined;
  const axis = isRecord(encoding.axis) ? encoding.axis : undefined;
  const title =
    axis?.hideTitle === true
      ? ''
      : typeof axis?.title === 'string'
        ? axis.title
        : (displayName ?? encoding.fieldName);
  const scale = isRecord(encoding.scale) ? encoding.scale.type : undefined;
  const type =
    scale === 'categorical'
      ? 'nominal'
      : scale === 'quantitative' || scale === 'temporal'
        ? scale
        : undefined;
  return { fieldName: encoding.fieldName, title, type };
}

function bindChannel(
  chartSpec: PublishedChartSpecInput,
  channel: string,
  schema: readonly PublishedChartField[],
  overrideType?: PublishedChartFieldType,
): { ok: true; bound: Bound } | { ok: false; refusal: PublishedChartRefusal } {
  const declared = channelOf(chartSpec, channel);
  if (declared === undefined) {
    return { ok: false, refusal: { reason: 'missingChannel', channel } };
  }
  const field = schema.find((candidate) => candidate.name === declared.fieldName);
  if (field === undefined) {
    return { ok: false, refusal: { reason: 'fieldNotInResult', fieldName: declared.fieldName } };
  }
  return {
    ok: true,
    bound: {
      field: declared.fieldName,
      type: overrideType ?? declared.type ?? fieldTypeOf(field.type),
      title: declared.title,
    },
  };
}

function coercionsOf(...bounds: Bound[]): PublishedChartCoercion[] {
  return bounds.flatMap((bound): PublishedChartCoercion[] => {
    if (bound.type === 'quantitative') {
      return [{ field: bound.field, to: 'number' }];
    }
    if (bound.type === 'temporal') {
      return [{ field: bound.field, to: 'date' }];
    }
    return [];
  });
}

export function translatePublishedChart({
  chartSpec,
  schema,
}: {
  chartSpec: PublishedChartSpecInput;
  schema: readonly PublishedChartField[];
}): PublishedChartTranslation {
  const frame = isRecord(chartSpec.frame) ? chartSpec.frame : undefined;
  const title = frame?.showTitle === true && typeof frame.title === 'string' ? frame.title : undefined;
  const mark = isRecord(chartSpec.mark) ? chartSpec.mark : undefined;
  const lineShape = mark?.lineShape === 'smooth' || mark?.lineShape === 'step' ? mark.lineShape : 'linear';
  const cartesian = CARTESIAN.get(chartSpec.widgetType);
  if (cartesian !== undefined) {
    const x = bindChannel(chartSpec, 'x', schema);
    if (!x.ok) {
      return x;
    }
    const y = bindChannel(chartSpec, 'y', schema);
    if (!y.ok) {
      return y;
    }

    if (x.bound.type !== 'quantitative' && y.bound.type !== 'quantitative') {
      return { ok: false, refusal: { reason: 'noMeasure', fieldNames: [x.bound.field, y.bound.field] } };
    }
    const color = bindChannel(chartSpec, 'color', schema, 'nominal');
    // A color/series channel is optional on a cartesian chart, but if the spec declares one whose
    // field the run didn't return, refuse rather than silently drawing an ungrouped chart.
    if (!color.ok && color.refusal.reason !== 'missingChannel') {
      return color;
    }
    const horizontal = cartesian === 'bar' && x.bound.type === 'quantitative' && y.bound.type === 'nominal';
    return {
      ok: true,
      plan: {
        component: cartesian,
        // AppKit always takes the dimension as xKey, including for horizontal bars.
        xKey: horizontal ? y.bound.field : x.bound.field,
        yKey: horizontal ? x.bound.field : y.bound.field,
        orientation: horizontal ? 'horizontal' : 'vertical',
        xType: x.bound.type,
        title,
        lineShape,
        ...(color.ok ? { seriesKey: color.bound.field } : {}),
        xTitle: x.bound.title,
        yTitle: y.bound.title,
        coercions: coercionsOf(x.bound, y.bound),
      },
    };
  }

  if (chartSpec.widgetType === 'pie') {
    const angle = bindChannel(chartSpec, 'angle', schema);
    if (!angle.ok) {
      return angle;
    }
    if (angle.bound.type !== 'quantitative') {
      return { ok: false, refusal: { reason: 'noMeasure', fieldNames: [angle.bound.field] } };
    }

    const color = bindChannel(chartSpec, 'color', schema, 'nominal');
    if (!color.ok) {
      return color;
    }
    return {
      ok: true,
      plan: {
        component: 'pie',
        xKey: color.bound.field,
        yKey: angle.bound.field,
        orientation: 'vertical',
        xType: color.bound.type,
        title,
        lineShape,
        xTitle: color.bound.title,
        yTitle: angle.bound.title,
        coercions: coercionsOf(angle.bound),
      },
    };
  }

  return { ok: false, refusal: { reason: 'unsupportedWidgetType', widgetType: chartSpec.widgetType } };
}

export function describePublishedChartRefusal(refusal: PublishedChartRefusal): string {
  switch (refusal.reason) {
    case 'unsupportedWidgetType':
      return `This output is published as a ${refusal.widgetType} chart, which a published app cannot draw yet. Its rows are shown instead.`;
    case 'missingChannel':
      return `This output's chart has no ${refusal.channel} column configured, so it cannot be drawn. Its rows are shown instead.`;
    case 'fieldNotInResult':
      return `This output's chart plots a column called "${refusal.fieldName}", which the run did not return. Its rows are shown instead.`;
    case 'noMeasure':
      return `This output's chart has nothing numeric to measure (${refusal.fieldNames.join(', ')}), so it cannot be drawn. Its rows are shown instead.`;
  }
}
