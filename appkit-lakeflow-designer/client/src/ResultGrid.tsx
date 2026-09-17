import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@databricks/appkit-ui/react';
import { categorize, formatCell, isNumericCategory, TypeGlyph } from './dataTypes';
import type { OkPayload, SchemaField } from './payload';

const MIN_COLUMN_WIDTH = 90;
const MAX_INITIAL_COLUMN_WIDTH = 300;

const BODY_CHAR_WIDTH = 6.6;

const HEADER_CHAR_WIDTH = 7.3;
const CELL_PADDING = 16;

const HEADER_GLYPH = 20;

const WIDTH_SAMPLE_ROWS = 100;

function measureColumnWidth(field: SchemaField, rows: OkPayload['rows']): number {
  const category = categorize(field.type);
  let widestBody = 0;
  for (let i = 0; i < Math.min(rows.length, WIDTH_SAMPLE_ROWS); i += 1) {
    const { text } = formatCell(rows[i]?.[field.name], category);
    widestBody = Math.max(widestBody, (text ?? 'null').length);
  }
  const headerWidth = field.name.length * HEADER_CHAR_WIDTH + HEADER_GLYPH + CELL_PADDING;
  const bodyWidth = widestBody * BODY_CHAR_WIDTH + CELL_PADDING;
  const raw = Math.max(headerWidth, bodyWidth);
  return Math.round(Math.min(Math.max(raw, MIN_COLUMN_WIDTH), MAX_INITIAL_COLUMN_WIDTH));
}

function NullBadge() {
  return (
    <code className="bg-muted text-muted-foreground border-border rounded-[3px] border px-[0.4em] py-0 text-[85%]">
      null
    </code>
  );
}

export function ResultGrid({ payload }: { payload: OkPayload }) {
  const { schema, rows } = payload;
  const columns = schema.map((field) => ({
    field,
    category: categorize(field.type),
    width: measureColumnWidth(field, rows),
  }));
  const rowNumberWidth = Math.max(44, String(rows.length).length * BODY_CHAR_WIDTH + 24);

  return (
    <div className="border-border max-h-[60vh] overflow-auto border-t">
      <Table className="w-full min-w-max table-fixed border-separate border-spacing-0 text-xs">
        <colgroup>
          <col style={{ width: rowNumberWidth }} />
          {columns.map(({ field, width }) => (
            <col key={field.name} style={{ width }} />
          ))}
          {

}
          <col />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              className="bg-card text-muted-foreground border-border sticky top-0 z-20 h-[30px] border-r border-b p-0 px-2 text-right align-middle font-normal"
              aria-label="Row number"
            />
            {columns.map(({ field, category }) => (
              <TableHead
                key={field.name}
                title={`${field.name} · ${field.type}${field.nullable ? '' : ' · not null'}`}
                className="bg-card text-foreground border-border sticky top-0 z-10 h-[30px] border-r border-b px-2 py-0 align-middle font-bold whitespace-nowrap"
              >
                <span className="flex items-center gap-1.5 overflow-hidden">
                  <span className="text-muted-foreground flex shrink-0 items-center">
                    <TypeGlyph category={category} />
                  </span>
                  <span className="truncate">{field.name}</span>
                </span>
              </TableHead>
            ))}
            <TableHead className="bg-card sticky top-0 z-10 h-[30px] p-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow key={rowIndex} className="hover:bg-transparent">
              <TableCell className="text-muted-foreground border-border h-[25px] border-r border-b px-2 py-1 text-right align-middle tabular-nums">
                {rowIndex + 1}
              </TableCell>
              {columns.map(({ field, category }) => {
                const { text, title } = formatCell(row[field.name], category);
                return (
                  <TableCell
                    key={field.name}
                    title={text === null ? undefined : title}
                    className={[
                      'border-border text-foreground h-[25px] overflow-hidden border-r border-b px-2 py-1 align-middle',
                      'text-ellipsis whitespace-pre',
                      isNumericCategory(category) ? 'tabular-nums' : '',
                    ].join(' ')}
                  >
                    {text === null ? <NullBadge /> : text}
                  </TableCell>
                );
              })}
              <TableCell className="h-[25px] p-0" />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
