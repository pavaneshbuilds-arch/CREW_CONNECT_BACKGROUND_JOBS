import { Prisma } from '@prisma/client';

import config from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { configuredAudiences, messagingFor } from '../fcm.js';
import logger from '../utils/logger.js';

const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MULTICAST_LIMIT = 500;
const PERMANENT_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
]);

function fcmData(notification) {
  const extra = notification.data && typeof notification.data === 'object' ? notification.data : {};
  const data = {
    notificationId: String(notification.id),
    type: notification.type,
    recipientType: notification.recipientType,
  };
  if (notification.referenceEntityType) data.referenceEntityType = notification.referenceEntityType;
  if (notification.referenceEntityId != null) data.referenceEntityId = String(notification.referenceEntityId);
  if (extra.screen) data.screen = String(extra.screen);
  if (extra.bookingId != null) data.bookingId = String(extra.bookingId);
  if (extra.crewId != null) data.crewId = String(extra.crewId);
  if (extra.payoutId != null) data.payoutId = String(extra.payoutId);
  if (extra.bookingReference) data.bookingReference = String(extra.bookingReference);
  return data;
}

async function releaseStaleLocks() {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.notification.updateMany({
    where: { pushStatus: 'processing', pushLockedAt: { lt: cutoff } },
    data: { pushStatus: 'pending', pushLockedAt: null },
  });
}

async function claimBatch(limit, audiences) {
  const claimed = await prisma.$queryRaw`
    WITH claimed AS (
      SELECT id
      FROM notifications
      WHERE push_status = 'pending'::"NotificationPushStatus"
        AND recipient_type::text IN (${Prisma.join(audiences)})
        AND (push_next_attempt_at IS NULL OR push_next_attempt_at <= NOW())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notifications AS notification
    SET push_status = 'processing'::"NotificationPushStatus",
        push_attempts = notification.push_attempts + 1,
        push_locked_at = NOW(),
        push_error = NULL
    FROM claimed
    WHERE notification.id = claimed.id
    RETURNING notification.id
  `;
  const ids = claimed.map((row) => row.id);
  if (!ids.length) return [];
  return prisma.notification.findMany({ where: { id: { in: ids } } });
}

async function tokensFor(notification) {
  if (notification.recipientType === 'admin') return { skip: 'unsupported_recipient' };

  if (notification.recipientType === 'user') {
    const user = await prisma.user.findUnique({ where: { id: notification.recipientId } });
    if (!user || user.deletedAt || !user.isActive) return { skip: 'recipient_inactive' };
    if (!user.pushNotificationsEnabled) return { skip: 'push_disabled' };
  }

  if (notification.recipientType === 'crew') {
    const crew = await prisma.crewMember.findUnique({ where: { id: notification.recipientId } });
    if (!crew || crew.deletedAt || !crew.isActive) return { skip: 'recipient_inactive' };
  }

  const devices = await prisma.device.findMany({
    where: { subjectType: notification.recipientType, subjectId: notification.recipientId },
    select: { pnid: true },
  });
  const tokens = [...new Set(devices.map((device) => device.pnid).filter(Boolean))];
  if (!tokens.length) return { skip: 'no_device' };
  return { tokens };
}

async function mark(id, data) {
  await prisma.notification.update({ where: { id }, data });
}

function retryDelayMs(attempts) {
  return Math.min(30 * 60 * 1000, 2 ** attempts * 1000);
}

async function sendToTokens(messaging, notification, tokens) {
  let success = 0;
  let permanent = 0;
  let transient = 0;
  let firstError = null;

  for (let offset = 0; offset < tokens.length; offset += MULTICAST_LIMIT) {
    const batch = tokens.slice(offset, offset + MULTICAST_LIMIT);
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title: notification.title, body: notification.body },
      data: fcmData(notification),
      android: { priority: 'high' },
    });
    response.responses.forEach((result) => {
      if (result.success) {
        success += 1;
        return;
      }
      const code = result.error?.code || 'unknown';
      if (!firstError) firstError = result.error?.message || code;
      if (PERMANENT_TOKEN_ERRORS.has(code)) permanent += 1;
      else transient += 1;
    });
  }

  return { success, permanent, transient, firstError };
}

async function deliver(notification) {
  const messaging = messagingFor(notification.recipientType);
  if (!messaging) {
    await mark(notification.id, {
      pushStatus: 'pending',
      pushAttempts: Math.max(0, notification.pushAttempts - 1),
      pushLockedAt: null,
    });
    return;
  }

  const target = await tokensFor(notification);
  if (target.skip) {
    await mark(notification.id, {
      pushStatus: 'skipped',
      pushError: target.skip,
      pushLockedAt: null,
    });
    return;
  }

  try {
    const result = await sendToTokens(messaging, notification, target.tokens);
    if (result.success > 0) {
      await mark(notification.id, {
        pushStatus: 'sent',
        pushSentAt: new Date(),
        pushError: result.transient || result.permanent ? String(result.firstError || '').slice(0, 500) : null,
        pushLockedAt: null,
        pushNextAttemptAt: null,
      });
      return;
    }

    const giveUp = result.transient === 0 || notification.pushAttempts >= MAX_ATTEMPTS;
    if (giveUp) {
      await mark(notification.id, {
        pushStatus: 'failed',
        pushError: String(result.firstError || 'fcm_failed').slice(0, 500),
        pushLockedAt: null,
      });
      return;
    }

    await mark(notification.id, {
      pushStatus: 'pending',
      pushError: String(result.firstError || 'fcm_failed').slice(0, 500),
      pushLockedAt: null,
      pushNextAttemptAt: new Date(Date.now() + retryDelayMs(notification.pushAttempts)),
    });
  } catch (err) {
    const giveUp = notification.pushAttempts >= MAX_ATTEMPTS;
    await mark(notification.id, {
      pushStatus: giveUp ? 'failed' : 'pending',
      pushError: String(err.message || 'fcm_failed').slice(0, 500),
      pushLockedAt: null,
      pushNextAttemptAt: giveUp ? null : new Date(Date.now() + retryDelayMs(notification.pushAttempts)),
    });
    logger.error('FCM send failed', { notificationId: notification.id, message: err.message });
  }
}

export async function sendPendingPushes() {
  const audiences = configuredAudiences();
  if (!audiences.length) return 0;

  await releaseStaleLocks();
  const batch = await claimBatch(config.pushBatchSize, audiences);
  for (const notification of batch) {
    await deliver(notification);
  }
  if (batch.length) logger.info('Push batch finished', { count: batch.length });
  return batch.length;
}
