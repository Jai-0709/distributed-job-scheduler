import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL ?? 'info';

export const logger = winston.createLogger({
  level: logLevel,
  format: combine(
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    json(),
  ),
  defaultMeta: {
    service: process.env.SERVICE_NAME ?? 'job-scheduler',
    pid: process.pid,
  },
  transports: [
    // Always write JSON to stdout (captured by Docker / log aggregators)
    new winston.transports.Console({
      format: isProduction
        ? combine(timestamp(), json())
        : combine(colorize(), simple()),
    }),
  ],
});

// Convenience child loggers for each process
export function childLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
