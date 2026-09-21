import { describe, it, expect } from "vitest";
import { parseDraftDayHistorySheet } from "./draft-day-history";

describe("parseDraftDayHistorySheet", () => {
  it("parses dates, city, and attendee status from the confirmed real sheet shape", () => {
    const rows = [
      ["Claw & Antler's Fantasy Baseball League"],
      [null, "Draft Weekend 2022"],
      [],
      ["Dates: ", "March 25-27th 2022"],
      ["City:", "Dallas, TX"],
      ["Airbnb Address:"],
      ["Attendees:"],
      [null, "Alex", "Paid"],
      [null, "Sam", "Paid"],
      [null, "Jordan", "not paid"],
    ];
    const result = parseDraftDayHistorySheet("Draft Weekend 2022", rows);
    expect(result.seasonYear).toBe(2022);
    expect(result.dateRangeRaw).toBe("March 25-27th 2022");
    expect(result.venue).toBe("Dallas, TX");
    expect(result.attendeesRaw).toBe("Alex: Paid; Sam: Paid; Jordan: not paid");
    expect(result.flags).toEqual([]);
  });

  it("stops collecting attendees at the first blank row instead of absorbing a later section", () => {
    // Confirmed real shape: the attendee list is followed by a blank row,
    // then a separate "Schedule" section reusing the same columns - a
    // parser that keeps collecting "attendees" forever would wrongly
    // swallow schedule rows as if they were more attendees.
    const rows = [
      ["Attendees:"],
      [null, "Alex", "Paid"],
      [null, "Sam", "Paid"],
      [],
      ["Schedule", "Schedule", "Schedule"],
      [null, "Airbnb Check-in", "Alex making reservations"],
    ];
    const result = parseDraftDayHistorySheet("Draft Weekend 2023", rows);
    expect(result.attendeesRaw).toBe("Alex: Paid; Sam: Paid");
    expect(result.scheduleRaw).toBe("Airbnb Check-in - Alex making reservations");
  });

  it("formats an Excel time-of-day value (epoch-anchored Date) as HH:MM in the schedule", () => {
    const rows = [
      ["Schedule", "Schedule", "Schedule"],
      [new Date("1899-12-30T13:00:00.000Z"), "Check-in", "Notes"],
      [new Date("2023-03-25T00:00:00.000Z")],
    ];
    const result = parseDraftDayHistorySheet("Draft Weekend 2023", rows);
    expect(result.scheduleRaw).toBe("13:00 - Check-in - Notes\n2023-03-25");
  });

  it("flags a sheet name with no year instead of guessing one", () => {
    const result = parseDraftDayHistorySheet("Draft Weekend", [["Dates:", "Some date"]]);
    expect(result.seasonYear).toBeNull();
    expect(result.flags).toContain("No 4-digit year found in the sheet name.");
  });

  it("flags missing sections without throwing", () => {
    const result = parseDraftDayHistorySheet("Draft Weekend 2023", [["Attendees:"]]);
    expect(result.flags).toContain("No 'Dates:' row found.");
    expect(result.flags).toContain("No 'City:' row found.");
    expect(result.flags).toContain("No attendee rows found under 'Attendees:'.");
  });
});
