/**
 * Notification engine. Channels (in-app / push / email) are intentionally
 * decoupled from notification *generation*: callers describe what
 * happened, this module checks each recipient's per-type, per-channel
 * preference (off by default - see spec section 27), and fans out to
 * whichever channels they've opted into. Adding a new channel later means
 * adding a case in `deliverToChannel`, not touching call sites.
 */

import { prisma } from "./db";
import type { NotificationType, NotificationChannel } from "@prisma/client";
import { sendPushToManager } from "./push";

export interface NotifyInput {
  managerId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

async function isEnabled(
  managerId: string,
  type: NotificationType,
  channel: NotificationChannel
): Promise<boolean> {
  const pref = await prisma.notificationPreference.findUnique({
    where: { managerId_type_channel: { managerId, type, channel } },
  });
  return pref?.enabled ?? false;
}

async function deliverToChannel(
  channel: NotificationChannel,
  input: NotifyInput
): Promise<void> {
  if (channel === "IN_APP") {
    await prisma.notification.create({
      data: {
        managerId: input.managerId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      },
    });
    return;
  }

  if (channel === "PUSH") {
    await sendPushToManager(input.managerId, { title: input.title, body: input.body, link: input.link });
    return;
  }

  // EMAIL: no SMTP/provider configured in this environment. Logging keeps
  // the code path real (and easy to wire to Resend/SES/etc later) without
  // requiring credentials this project doesn't have.
  console.log(`[email:not-configured] to manager ${input.managerId}: ${input.title}`);
}

/**
 * Notify one manager about one event, respecting their per-channel
 * preferences for this notification type. Silently does nothing on every
 * channel the manager hasn't opted into - that's the intended "off by
 * default" behavior, not a bug.
 */
export async function notifyManager(input: NotifyInput): Promise<void> {
  const channels: NotificationChannel[] = ["IN_APP", "PUSH", "EMAIL"];
  for (const channel of channels) {
    if (await isEnabled(input.managerId, input.type, channel)) {
      await deliverToChannel(channel, input);
    }
  }
}

export async function notifyManagers(
  managerIds: string[],
  rest: Omit<NotifyInput, "managerId">
): Promise<void> {
  for (const managerId of managerIds) {
    await notifyManager({ managerId, ...rest });
  }
}

/** Ensures every (type, channel) pair has a preference row, defaulted off. */
export async function ensureDefaultPreferences(managerId: string): Promise<void> {
  const types = Object.values(
    (await import("@prisma/client")).NotificationType
  ) as NotificationType[];
  const channels: NotificationChannel[] = ["IN_APP", "PUSH", "EMAIL"];

  const existing = await prisma.notificationPreference.findMany({ where: { managerId } });
  const existingKeys = new Set(existing.map((e) => `${e.type}:${e.channel}`));

  const toCreate: { managerId: string; type: NotificationType; channel: NotificationChannel; enabled: boolean }[] = [];
  for (const type of types) {
    for (const channel of channels) {
      if (!existingKeys.has(`${type}:${channel}`)) {
        toCreate.push({ managerId, type, channel, enabled: false });
      }
    }
  }
  if (toCreate.length > 0) {
    await prisma.notificationPreference.createMany({ data: toCreate });
  }
}
