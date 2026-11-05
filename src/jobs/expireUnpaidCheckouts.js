import { prisma } from '../config/prisma.js';
import logger from '../utils/logger.js';

const EXPIRE_AFTER_MS = 30 * 60 * 1000;
const STALE_PAYMENT = new Set(['initiated', 'failed']);
const PROTECTED_PAYMENT = new Set(['processing', 'success']);

function latestPayment(payments) {
  return [...payments].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0] || null;
}

function isStale(booking, cutoff) {
  if (!booking || booking.status !== 'created') return false;
  if (booking.payments.some((payment) => PROTECTED_PAYMENT.has(payment.status))) return false;
  const latest = latestPayment(booking.payments);
  if (!latest || !STALE_PAYMENT.has(latest.status)) return false;
  return latest.createdAt.getTime() <= cutoff.getTime();
}

/**
 * Created checkouts whose latest payment is still initiated or failed after
 * 30 minutes become expired. Processing and captured payments are left alone.
 */
export async function expireUnpaidCheckouts(limit = 50) {
  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MS);
  const rows = await prisma.$queryRaw`
    SELECT b.id
    FROM bookings b
    JOIN LATERAL (
      SELECT status, created_at
      FROM payments
      WHERE booking_id = b.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest ON true
    WHERE b.status = 'created'::"BookingStatus"
      AND latest.status IN ('initiated'::"PaymentStatus", 'failed'::"PaymentStatus")
      AND latest.created_at <= ${cutoff}
      AND NOT EXISTS (
        SELECT 1
        FROM payments held
        WHERE held.booking_id = b.id
          AND held.status IN ('processing'::"PaymentStatus", 'success'::"PaymentStatus")
      )
    ORDER BY latest.created_at
    LIMIT ${limit}
  `;

  let expired = 0;
  for (const row of rows) {
    const bookingId = Number(row.id);
    const didExpire = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { payments: true },
      });
      if (!isStale(booking, cutoff)) return false;

      const latest = latestPayment(booking.payments);
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: 'expired' },
      });
      if (latest.status === 'initiated') {
        await tx.payment.update({
          where: { id: latest.id },
          data: { status: 'failed' },
        });
      }
      await tx.notification.create({
        data: {
          recipientType: 'user',
          recipientId: booking.userId,
          title: 'Checkout expired',
          body: `Payment was not completed, so ${booking.bookingReference} has expired.`,
          type: 'booking_expired',
          referenceEntityType: 'booking',
          referenceEntityId: booking.id,
          data: {
            bookingId: booking.id,
            bookingReference: booking.bookingReference,
            screen: 'booking_details',
          },
        },
      });
      return true;
    });
    if (didExpire) expired += 1;
  }

  if (expired) logger.info('Unpaid checkouts expired', { count: expired });
  return expired;
}
