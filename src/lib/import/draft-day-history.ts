/**
 * Parses a "Draft Weekend YYYY"-style sheet into a preview matching
 * DraftDayDetails' fields. Confirmed real shape: a title row, "Dates:"/
 * "City:"/"Airbnb Address:" label-value pairs in columns A/B, an
 * "Attendees:" label followed by name/status rows in columns B/C until
 * the first blank row, and - after another blank row - an optional
 * "Schedule" section with a full hour-by-hour agenda (time cells stored
 * as Excel time-of-day values, i.e. Dates anchored to 1899-12-30).
 *
 * The year comes from the sheet's own name (e.g. "Draft Weekend 2022"),
 * the one place this workbook puts it unambiguously for this category -
 * never inferred from row content.
 */

import type { ParsedDraftDayEvent } from "./types";

type Cell = string | number | Date | null | undefined;

function asTrimmedString(v: Cell): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function isBlankRow(row: Cell[]): boolean {
  return row.every((v) => v == null || (typeof v === "string" && v.trim() === ""));
}

/** Excel stores a time-of-day-only value as a Date anchored to 1899-12-30. */
function formatScheduleCell(v: Cell): string {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.startsWith("1899-12-30") ? iso.slice(11, 16) : iso.slice(0, 10);
  }
  return asTrimmedString(v) ?? "";
}

export function parseDraftDayHistorySheet(sheetName: string, rows: Cell[][]): ParsedDraftDayEvent {
  const flags: string[] = [];
  const yearMatch = sheetName.match(/(\d{4})/);
  const seasonYear = yearMatch ? Number(yearMatch[1]) : null;
  if (!seasonYear) flags.push("No 4-digit year found in the sheet name.");

  let dateRangeRaw: string | null = null;
  let venue: string | null = null;
  const attendees: string[] = [];
  const scheduleLines: string[] = [];
  let section: "none" | "attendees" | "schedule" = "none";

  for (const row of rows) {
    const colA = asTrimmedString(row[0]);
    const label = colA?.toLowerCase() ?? "";

    if (label.startsWith("dates")) {
      dateRangeRaw = asTrimmedString(row[1]);
      continue;
    }
    if (label.startsWith("city")) {
      venue = asTrimmedString(row[1]);
      continue;
    }
    if (label.startsWith("attendees")) {
      section = "attendees";
      continue;
    }
    if (label === "schedule") {
      section = "schedule";
      continue;
    }

    if (section === "attendees") {
      if (isBlankRow(row)) {
        section = "none";
        continue;
      }
      const name = asTrimmedString(row[1]);
      if (name) attendees.push(`${name}: ${asTrimmedString(row[2]) ?? "status unknown"}`);
      continue;
    }

    if (section === "schedule") {
      if (isBlankRow(row)) continue;
      const line = [formatScheduleCell(row[0]), formatScheduleCell(row[1]), formatScheduleCell(row[2])]
        .filter(Boolean)
        .join(" - ");
      if (line) scheduleLines.push(line);
    }
  }

  if (!dateRangeRaw) flags.push("No 'Dates:' row found.");
  if (!venue) flags.push("No 'City:' row found.");
  if (attendees.length === 0) flags.push("No attendee rows found under 'Attendees:'.");

  return {
    seasonYear,
    venue,
    dateRangeRaw,
    attendeesRaw: attendees.length > 0 ? attendees.join("; ") : null,
    scheduleRaw: scheduleLines.length > 0 ? scheduleLines.join("\n") : null,
    sourceRef: sheetName,
    flags,
  };
}
