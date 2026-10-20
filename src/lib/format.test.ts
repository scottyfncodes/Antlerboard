import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, statusLabel } from "./format";

describe("statusLabel", () => {
  it("turns stored status enums into human labels", () => {
    expect(statusLabel("COUNTERED")).toBe("Countered");
    expect(statusLabel("WITHDRAWN")).toBe("Withdrawn");
    expect(statusLabel("PROPOSED")).toBe("Proposed");
    expect(statusLabel("CANCELLED")).toBe("Cancelled");
  });

  it("falls back to sentence case for anything unlisted", () => {
    expect(statusLabel("NEVER_SYNCED")).toBe("Never synced");
    expect(statusLabel("SUCCESS")).toBe("Success");
  });
});

describe("formatDate", () => {
  it("shows a date stored at midnight UTC as that day, not the day before", () => {
    expect(formatDate(new Date("2027-03-01T00:00:00Z"))).toBe("Mar 1, 2027");
    expect(formatDate("2027-03-01T00:00:00.000Z", "long")).toBe("March 1, 2027");
  });

  it("keeps the date and time in the same zone", () => {
    expect(formatDateTime(new Date("2027-02-15T23:30:00Z"))).toBe("Feb 15, 2027, 11:30 PM");
  });
});
