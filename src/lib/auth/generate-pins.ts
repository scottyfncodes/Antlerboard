/**
 * Shared logic behind scripts/generate-pins.ts and the protected
 * /api/admin/generate-pins route - two different ways to reach the same
 * "protected commissioner/deployment mechanism" for producing PINs,
 * depending on which one can actually reach the production database (see
 * the comment on /api/admin/seed for why that's not a given on this host).
 */

import { prisma } from "@/lib/db";
import { generatePinExcluding, generateUniquePins, hashPin } from "./pin";

export interface GeneratedPinRow {
  managerId: string;
  name: string;
  role: "manager" | "commissioner";
  pin: string;
  status: "generated" | "reset";
}

export type GeneratePinsResult =
  | { ok: true; rows: GeneratedPinRow[] }
  | { ok: false; error: string };

export async function generatePins(options: { resetAll?: boolean; resetName?: string } = {}): Promise<GeneratePinsResult> {
  const { resetAll = false, resetName } = options;

  // Departed managers (active: false) are kept around only so old records
  // still resolve to a real person - see the Manager model comment in
  // schema.prisma. They can never log in (login.ts refuses inactive
  // managers), so there's no reason to hand them a PIN.
  const managers = await prisma.manager.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  if (managers.length === 0) {
    return { ok: false, error: "No active managers found - seed or import the league before generating PINs." };
  }

  const existing = await prisma.managerCredential.findMany({ where: { provider: "pin" } });
  const existingByManagerId = new Map(existing.map((c) => [c.managerId, c]));
  const rows: GeneratedPinRow[] = [];

  async function storePin(managerId: string, pin: string) {
    await prisma.managerCredential.upsert({
      where: { managerId_provider: { managerId, provider: "pin" } },
      create: { managerId, provider: "pin", secretHash: hashPin(pin) },
      update: { secretHash: hashPin(pin) },
    });
  }

  if (resetName) {
    const manager = managers.find((m) => m.name.toLowerCase() === resetName.toLowerCase());
    if (!manager) {
      return {
        ok: false,
        error: `No manager named "${resetName}" found. Known managers: ${managers.map((m) => m.name).join(", ")}`,
      };
    }
    const pin = generatePinExcluding([]);
    await storePin(manager.id, pin);
    rows.push({
      managerId: manager.id,
      name: manager.name,
      role: manager.isCommissioner ? "commissioner" : "manager",
      pin,
      status: "reset",
    });
    return { ok: true, rows };
  }

  const targets = managers.filter((m) => resetAll || !existingByManagerId.has(m.id));
  if (targets.length === 0) {
    return { ok: true, rows: [] };
  }

  const pins = generateUniquePins(targets.length);
  targets.forEach((manager, i) => {
    rows.push({
      managerId: manager.id,
      name: manager.name,
      role: manager.isCommissioner ? "commissioner" : "manager",
      pin: pins[i],
      status: existingByManagerId.has(manager.id) ? "reset" : "generated",
    });
  });
  for (const row of rows) {
    await storePin(row.managerId, row.pin);
  }

  return { ok: true, rows };
}
