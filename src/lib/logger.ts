type LogLevel = "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  // One JSON object per line so CloudWatch Logs Insights can query fields directly.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context }));
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, error: unknown, context?: LogContext) =>
    write("error", message, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
};
