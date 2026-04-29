/**
 * Estellebot logger
 *
 * Minimal leveled logger. Adds a `[estellebot]` tag to every output so logs
 * stay greppable in Docker / Fly.io aggregated output. Structured JSON output
 * is introduced in Epic 5 (T-5.1).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const currentLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
const TAG = '[estellebot]'

function formatTimestamp(): string {
  return new Date().toISOString()
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack : ''}`
  }
  if (typeof arg === 'object' && arg !== null) {
    return JSON.stringify(arg, null, 2)
  }
  return String(arg)
}

function formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
  const timestamp = formatTimestamp()
  const levelStr = level.toUpperCase().padEnd(5)
  const argsStr = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : ''
  // If the caller already prefixed with [estellebot] or a sub-tag, don't double-prefix.
  const needsTag = !message.startsWith('[')
  const body = needsTag ? `${TAG} ${message}` : message
  return `[${timestamp}] ${levelStr} ${body}${argsStr}`
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.log(formatMessage('debug', message, ...args))
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(formatMessage('info', message, ...args))
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, ...args))
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(formatMessage('error', message, ...args))
    }
  },
}
