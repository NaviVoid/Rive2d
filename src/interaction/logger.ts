import type { RuntimeLogger } from './contracts';

export class ConsoleRuntimeLogger implements RuntimeLogger {
  constructor(private readonly prefix = 'interaction') {}

  debug(message: string, details?: unknown): void {
    this.write('debug', message, details);
  }

  info(message: string, details?: unknown): void {
    this.write('info', message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write('warn', message, details);
  }

  error(message: string, details?: unknown): void {
    this.write('error', message, details);
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): void {
    const method = level === 'debug' ? 'log' : level;
    const suffix = details === undefined ? '' : details;
    console[method](`[${this.prefix}] ${message}`, suffix);
  }
}
