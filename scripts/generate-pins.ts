/**
 * Generates and stores PIN credentials for every C&A manager already in the
 * database, and prints the plaintext Manager -> PIN mapping to THIS
 * terminal only. Nothing here is written to a file, logged anywhere
 * persistent, or exposed through the app - this script, run manually
 * against production with a real DATABASE_URL, is the "protected
 * commissioner/deployment mechanism" the PIN list is meant to come from.
 * Run it once, relay each PIN to its manager individually and privately
 * (text, DM, whatever - never a shared doc), then close this terminal.
 *
 * Usage:
 *   npx tsx scripts/generate-pins.ts                  Generate for any manager who doesn't have a PIN yet.
 *   npx tsx scripts/generate-pins.ts --reset-all       Regenerate every manager's PIN (invalidates old ones).
 *   npx tsx scripts/generate-pins.ts --reset "Name"    Regenerate one manager's PIN by name (e.g. a forgotten PIN).
 */

import { prisma } from "../src/lib/db";
import { generatePinExcluding, generateUniquePins, hashPin } from "../src/lib/auth/pin";

interface ResultRow {
  name: string;
  role: string;
  pin: string;
  status: "generated" | "reset";
}

async function main() {
  const args = process.argv.slice(2);
  const resetAll = args.includes("--reset-all");
  const resetIndex = args.indexOf("--reset");
  const resetName = resetIndex >= 0 ? args[resetIndex + 1] : null;

  // Departed managers (active: false) are kept around only so old records
  // still resolve to a real person - see the Manager model comment in
  // schema.prisma. They can never log in (login.ts refuses inactive
  // managers), so there's no reason to hand them a PIN.
  const managers = await prisma.manager.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  if (managers.length === 0) {
    console.error("No active managers found - seed or import the league before generating PINs.");
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.managerCredential.findMany({ where: { provider: "pin" } });
  const existingByManagerId = new Map(existing.map((c) => [c.managerId, c]));
  const results: ResultRow[] = [];

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
      console.error(`No manager named "${resetName}" found. Known managers: ${managers.map((m) => m.name).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const pin = generatePinExcluding([]);
    await storePin(manager.id, pin);
    results.push({
      name: manager.name,
      role: manager.isCommissioner ? "commissioner" : "manager",
      pin,
      status: "reset",
    });
  } else {
    const targets = managers.filter((m) => resetAll || !existingByManagerId.has(m.id));
    if (targets.length === 0) {
      console.log('Every manager already has a PIN. Pass --reset-all or --reset "Name" to regenerate one.');
      return;
    }
    const pins = generateUniquePins(targets.length);
    targets.forEach((manager, i) => {
      results.push({
        name: manager.name,
        role: manager.isCommissioner ? "commissioner" : "manager",
        pin: pins[i],
        status: existingByManagerId.has(manager.id) ? "reset" : "generated",
      });
    });
    for (const row of results) {
      const manager = targets.find((m) => m.name === row.name)!;
      await storePin(manager.id, row.pin);
    }
  }

  console.log("\nDistribute each PIN privately and individually, then close this terminal:\n");
  console.table(results);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
