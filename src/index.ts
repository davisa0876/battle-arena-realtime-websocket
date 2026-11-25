import { loadConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { createLogger } from "./observability/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    // Pretty transport requires the optional pino-pretty package (local only).
    pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
  });

  const app = createApp({ config, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "received shutdown signal");
    try {
      await app.stop();
      process.exit(0);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : "unknown" },
        "shutdown failed",
      );
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await app.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
