const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const configured: Level = (process.env.LOG_LEVEL as Level) || 'info';

const log = (level: Level, message: string): void => {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(configured)) return;
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](`[${level}] ${message}`);
};

export const logger = {
  debug: (message: string): void => log('debug', message),
  info: (message: string): void => log('info', message),
  warn: (message: string): void => log('warn', message),
  error: (message: string): void => log('error', message),
};
