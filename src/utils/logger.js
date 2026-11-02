const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const threshold = LEVELS[activeLevel] ?? LEVELS.debug;

function emit(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const entry = { level, time: new Date().toISOString(), message };
  if (meta !== undefined) entry.meta = meta;
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};

export default logger;
