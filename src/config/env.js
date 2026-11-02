import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

function get(name, { required = false, fallback = undefined } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required) throw new Error(`Missing required environment variable: ${name}`);
    return fallback;
  }
  return value;
}

function getInt(name, fallback) {
  const raw = get(name, { fallback: undefined });
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

const nodeEnv = get('NODE_ENV', { fallback: 'development' });

const config = {
  nodeEnv,
  databaseUrl: get('DATABASE_URL', { required: true }),
  pollIntervalMs: getInt('POLL_INTERVAL_MS', 5000),
  pushBatchSize: getInt('PUSH_BATCH_SIZE', 50),
  fcm: {
    user: {
      path: get('FCM_USER_SERVICE_ACCOUNT_PATH'),
      json: get('FCM_USER_SERVICE_ACCOUNT_JSON'),
    },
    crew: {
      path: get('FCM_CREW_SERVICE_ACCOUNT_PATH'),
      json: get('FCM_CREW_SERVICE_ACCOUNT_JSON'),
    },
  },
};

export default config;
