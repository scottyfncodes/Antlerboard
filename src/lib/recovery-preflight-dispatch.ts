/**
 * Starts the read-only recovery preflight (.github/workflows/recovery-preflight.yml)
 * as soon as the scheduled Yahoo sync has finished. GitHub's own schedule
 * proved too late to rely on: the runs due at 11:41 and 12:11 UTC on
 * 2026-10-20 started at 15:49 and 16:57, long after the 12:45 deadline. See
 * docs/recovery-preflight-automation.md.
 *
 * Inert unless GITHUB_RECOVERY_DISPATCH_TOKEN is set, and only ever sent from
 * Production. The token is a fine-grained GitHub token for this repository
 * only, with "Actions: read and write". Dispatching only asks GitHub to start
 * the workflow: whether the job runs is still decided there
 * (RECOVERY_PREFLIGHT_ENABLED), and the workflow runs at most once a day, so
 * a duplicate dispatch skips. A failure here never fails the sync.
 */

import { prisma } from "@/lib/db";

export const RECOVERY_DISPATCH_ACTION = "RECOVERY_PREFLIGHT_DISPATCH";

const DISPATCH_URL =
  "https://api.github.com/repos/scottyfncodes/Antlerboard/actions/workflows/recovery-preflight.yml/dispatches";
// The production branch; the workflow refuses a run from any other ref.
const PRODUCTION_REF = "claude/antlerboard-fantasy-baseball-7b3vai";
const TIMEOUT_MS = 10_000;

export type RecoveryDispatchResult =
  | { status: "sent"; attempts: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; attempts: number; error: string };

async function send(token: string): Promise<{ ok: boolean; retry: boolean; error?: string }> {
  try {
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: PRODUCTION_REF, inputs: { mode: "preflight" } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (res.status === 204) return { ok: true, retry: false };
    // GitHub's message only; never the request or its headers.
    const message = ((await res.json().catch(() => ({}))) as { message?: unknown }).message;
    return {
      ok: false,
      retry: res.status >= 500,
      error: `HTTP ${res.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`,
    };
  } catch (err) {
    return { ok: false, retry: true, error: err instanceof Error ? err.name : "network error" };
  }
}

/** Asks GitHub to start today's preflight, retrying once on a network error or 5xx. */
export async function dispatchRecoveryPreflight(retryPauseMs = 2_000): Promise<RecoveryDispatchResult> {
  const token = process.env.GITHUB_RECOVERY_DISPATCH_TOKEN?.trim();
  if (process.env.VERCEL_ENV !== "production") return { status: "skipped", reason: "not Production" };
  if (!token) return { status: "skipped", reason: "GITHUB_RECOVERY_DISPATCH_TOKEN not set" };

  let attempt = await send(token);
  let attempts = 1;
  if (!attempt.ok && attempt.retry) {
    await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
    attempt = await send(token);
    attempts = 2;
  }
  return attempt.ok
    ? { status: "sent", attempts }
    : { status: "failed", attempts, error: attempt.error ?? "unknown error" };
}

/** Records the dispatch outcome next to the sync's own audit entry. Best effort. */
export async function recordRecoveryDispatch(result: RecoveryDispatchResult, at: Date = new Date()) {
  try {
    await prisma.auditLogEntry.create({
      data: {
        actorName: "Vercel Cron",
        action: RECOVERY_DISPATCH_ACTION,
        entityType: "GitHubWorkflow",
        isHistoricalCorrection: false,
        after: { at: at.toISOString(), ...result },
      },
    });
  } catch (err) {
    console.error("Could not record the recovery preflight dispatch", err instanceof Error ? err.message : err);
  }
}
