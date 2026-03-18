import chalk from "chalk";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const COLORS: Record<LogLevel, (s: string) => string> = {
  DEBUG: chalk.gray,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
};

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function log(
  level: LogLevel,
  module: string,
  message: string,
  ...args: unknown[]
) {
  const color = COLORS[level];
  const prefix = `${chalk.dim(timestamp())} ${color(`[${level}]`)} ${chalk.cyan(`[${module}]`)}`;
  console.log(`${prefix} ${message}`, ...args);
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      log("DEBUG", module, msg, ...args),
    info: (msg: string, ...args: unknown[]) =>
      log("INFO", module, msg, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      log("WARN", module, msg, ...args),
    error: (msg: string, ...args: unknown[]) =>
      log("ERROR", module, msg, ...args),
  };
}
