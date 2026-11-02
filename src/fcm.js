import fs from 'node:fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import config from './config/env.js';
import logger from './utils/logger.js';

const AUDIENCES = ['user', 'crew'];
const ENV_PREFIX = { user: 'FCM_USER', crew: 'FCM_CREW' };
const missingLogged = new Set();
const failedLogged = new Set();

function loadServiceAccount(source) {
  if (source.json) {
    const raw = source.json.trim();
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  if (source.path) {
    return JSON.parse(fs.readFileSync(source.path, 'utf8'));
  }
  return null;
}

function appFor(audience) {
  const existing = getApps().find((app) => app.name === audience);
  if (existing) return existing;

  const source = config.fcm[audience];
  let serviceAccount;
  try {
    serviceAccount = loadServiceAccount(source);
  } catch (err) {
    if (!failedLogged.has(audience)) {
      failedLogged.add(audience);
      logger.error(`Could not read the ${audience} app FCM service account`, { message: err.message });
    }
    return null;
  }
  if (serviceAccount && (!serviceAccount.private_key || !serviceAccount.client_email)) {
    if (!failedLogged.has(audience)) {
      failedLogged.add(audience);
      logger.error(
        `The ${audience} app FCM file is not a service account key. Use the Admin SDK key from Firebase console → Project settings → Service accounts, not google-services.json.`
      );
    }
    return null;
  }
  if (!serviceAccount) {
    if (!missingLogged.has(audience)) {
      missingLogged.add(audience);
      const prefix = ENV_PREFIX[audience];
      logger.warn(
        `FCM credentials for the ${audience} app are not set. ${audience} notifications stay pending until ${prefix}_SERVICE_ACCOUNT_PATH or ${prefix}_SERVICE_ACCOUNT_JSON is configured.`
      );
    }
    return null;
  }

  const app = initializeApp({ credential: cert(serviceAccount) }, audience);
  logger.info('FCM client ready', { audience, projectId: serviceAccount.project_id });
  return app;
}

export function messagingFor(recipientType) {
  if (!AUDIENCES.includes(recipientType)) return null;
  const app = appFor(recipientType);
  return app ? getMessaging(app) : null;
}

export function configuredAudiences() {
  return AUDIENCES.filter((audience) => appFor(audience));
}
