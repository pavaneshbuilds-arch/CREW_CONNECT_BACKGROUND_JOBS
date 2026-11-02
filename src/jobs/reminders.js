import { prisma } from '../config/prisma.js';
import logger from '../utils/logger.js';

const SENDABLE_BOOKING_STATUSES = new Set(['confirmed', 'crew_assigned', 'in_progress']);
const ACTIVE_ASSIGNMENT_STATUSES = ['assigned', 'confirmed', 'in_progress'];
const MISSED_AFTER_MS = 6 * 60 * 60 * 1000;

function reminderCopy(reminder) {
  const booking = reminder.booking;
  const ref = booking?.bookingReference || `#${reminder.bookingId}`;
  const place = booking?.venueName || 'the venue';
  const soon = reminder.reminderType === 'TWO_HOURS_BEFORE';
  return {
    title: 'Event reminder',
    body: soon ? `${ref} at ${place} starts in 2 hours.` : `${ref} at ${place} is tomorrow.`,
  };
}

async function shouldSend(tx, reminder, now) {
  const booking = reminder.booking;
  if (!booking || !SENDABLE_BOOKING_STATUSES.has(booking.status)) return false;
  if (now.getTime() - reminder.scheduledAt.getTime() > MISSED_AFTER_MS) return false;
  if (reminder.recipientType === 'crew') {
    const assignment = await tx.eventCrewAssignment.findFirst({
      where: {
        bookingId: reminder.bookingId,
        crewId: reminder.recipientId,
        status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      },
      select: { id: true },
    });
    if (!assignment) return false;
  }
  return true;
}

export async function dispatchDueReminders(limit = 50) {
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id
      FROM scheduled_reminders
      WHERE status = 'pending'::"ReminderStatus"
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    const ids = locked.map((row) => row.id);
    if (!ids.length) return 0;

    const reminders = await tx.scheduledReminder.findMany({
      where: { id: { in: ids } },
      include: {
        booking: { select: { id: true, status: true, bookingReference: true, venueName: true } },
      },
    });

    let count = 0;
    for (const reminder of reminders) {
      const send = await shouldSend(tx, reminder, now);
      if (!send) {
        await tx.scheduledReminder.update({
          where: { id: reminder.id },
          data: { status: 'cancelled' },
        });
        continue;
      }
      const copy = reminderCopy(reminder);
      await tx.notification.create({
        data: {
          recipientType: reminder.recipientType,
          recipientId: reminder.recipientId,
          title: copy.title,
          body: copy.body,
          type: 'reminder',
          referenceEntityType: 'booking',
          referenceEntityId: reminder.bookingId,
          data: {
            bookingId: reminder.bookingId,
            bookingReference: reminder.booking.bookingReference,
            screen: reminder.recipientType === 'crew' ? 'job_details' : 'booking_details',
          },
        },
      });
      await tx.scheduledReminder.update({
        where: { id: reminder.id },
        data: { status: 'sent', sentAt: now },
      });
      count += 1;
    }
    return count;
  }, { timeout: 20000 });

  if (created) logger.info('Reminder notifications queued', { count: created });
  return created;
}
