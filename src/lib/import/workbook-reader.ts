/**
 * Converts an ExcelJS worksheet into the plain row-major array of cell
 * values every parser in this directory expects.
 *
 * Handles one important ExcelJS quirk, confirmed against the real
 * workbook: reading `.value` on every cell in a merged range returns the
 * *same* value for every cell in that range (ExcelJS's own convenience
 * behavior), not just the top-left one. Left uncorrected, this makes a
 * bare-year marker row (e.g. a single merged "2023" cell spanning two
 * columns) look like it has a real value in both columns, which is
 * exactly the shape a parser uses to tell a marker row apart from a real
 * data row - so an uncorrected reader silently breaks every year
 * attribution in the workbook. Only the merge's top-left ("master") cell
 * keeps its value here; every other cell in the range reads back as
 * null, matching what a human looking at the sheet actually sees.
 */

import type { Worksheet } from "exceljs";

export type WorkbookCell = string | number | Date | null;

export function worksheetToRows(ws: Worksheet, maxRow = ws.rowCount, maxCol = ws.columnCount): WorkbookCell[][] {
  const rows: WorkbookCell[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const out: WorkbookCell[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c);
      const isAnchor = !cell.isMerged || cell.master?.address === cell.address;
      out.push(normalizeCell(isAnchor ? cell.value : null));
    }
    rows.push(out);
  }
  return rows;
}

function normalizeCell(value: unknown): WorkbookCell {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "string") return value;
  // A formula cell's ExcelJS value is `{ formula, result }` - use the
  // computed result, since every parser here only cares about the value a
  // human would read off the sheet.
  if (typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return normalizeCell((value as { result: unknown }).result);
  }
  return String(value);
}
