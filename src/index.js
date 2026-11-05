import config from './config/env.js';
import { prisma } from './config/prisma.js';
import { configuredAudiences } from './fcm.js';
import { expireUnpaidCheckouts } from './jobs/expireUnpaidCheckouts.js';
import { dispatchDueReminders } from './jobs/reminders.js';
import { sendPendingPushes } from './jobs/push.js';
import logger from './utils/logger.js';

let running = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  await expireUnpaidCheckouts();
  await dispatchDueReminders();
  await sendPendingPushes();
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  logger.info('Worker stopping', { signal });
  await prisma.$disconnect();
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    logger.error('Shutdown failed', { message: err.message });
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    logger.error('Shutdown failed', { message: err.message });
    process.exit(1);
  });
});

logger.info('Crew Connect background worker started', {
  pollIntervalMs: config.pollIntervalMs,
  pushAudiences: configuredAudiences(),
});

while (running) {
  try {
    await tick();
  } catch (err) {
    logger.error('Job tick failed', { message: err.message });
  }
  if (running) await sleep(config.pollIntervalMs);
}
