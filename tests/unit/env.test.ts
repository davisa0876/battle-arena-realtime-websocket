import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config/env.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    WS_ALLOWED_ORIGINS: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:6379",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads defaults for valid env", () => {
    const config = loadConfig(baseEnv());
    expect(config.PORT).toBe(3001);
    expect(config.WS_MAX_PAYLOAD_BYTES).toBe(8192);
    expect(config.WS_ALLOWED_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("rejects missing allowed origins", () => {
    expect(() => loadConfig(baseEnv({ WS_ALLOWED_ORIGINS: "" }))).toThrow(ConfigError);
  });

  it("rejects heartbeat timeout <= interval", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          WS_HEARTBEAT_INTERVAL_MS: "30000",
          WS_HEARTBEAT_TIMEOUT_MS: "30000",
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("parses CSV origins and booleans", () => {
    const config = loadConfig(
      baseEnv({
        WS_ALLOWED_ORIGINS: "http://localhost:3000, http://127.0.0.1:3000",
        WS_ALLOW_MISSING_ORIGIN: "false",
      }),
    );
    expect(config.WS_ALLOWED_ORIGINS).toHaveLength(2);
    expect(config.WS_ALLOW_MISSING_ORIGIN).toBe(false);
  });
});
