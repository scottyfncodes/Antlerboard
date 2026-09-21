/**
 * Web Push scaffold. Fully wired end-to-end (subscribe API, VAPID signing,
 * invalid-subscription cleanup) but only actually sends anything once
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are configured - see .env.example.
 * Until then it's a documented no-op so the rest of the notification
 * engine can be built and tested against it today.
 */

import webpush from "web-push";
import { prisma } from "./db";

let configured = false;

function ensureConfigured(): boolean {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(
      VAPID_SUBJECT || "mailto:commissioner@example.com",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    configured = true;
  }
  return true;
}

export async function sendPushToManager(
  managerId: string,
  payload: { title: string; body: string; link?: string }
): Promise<void> {
  if (!ensureConfigured()) {
    console.log(`[push:not-configured] to manager ${managerId}: ${payload.title}`);
    return;
  }

  const subscriptions = await prisma.pushSubscription.findMany({ where: { managerId } });
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload)
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription is gone (browser data cleared, unsubscribed, etc.) - remove it.
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        console.error("Push send failed", err);
      }
    }
  }
}
