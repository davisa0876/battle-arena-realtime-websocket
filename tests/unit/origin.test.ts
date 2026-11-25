import { describe, expect, it } from "vitest";

import { validateOrigin } from "../../src/websocket/upgrade.js";

describe("validateOrigin", () => {
  const allowed = ["http://localhost:3000", "http://127.0.0.1:3000"] as const;

  it("accepts allowlisted browser origins", () => {
    expect(validateOrigin("http://localhost:3000", allowed, true)).toBe(true);
  });

  it("rejects foreign origins", () => {
    expect(validateOrigin("https://evil.example", allowed, true)).toBe(false);
  });

  it("allows missing origin when configured for native clients", () => {
    expect(validateOrigin(undefined, allowed, true)).toBe(true);
    expect(validateOrigin(undefined, allowed, false)).toBe(false);
  });
});
