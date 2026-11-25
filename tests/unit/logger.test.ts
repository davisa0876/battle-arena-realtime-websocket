import { describe, expect, it } from "vitest";

import { redactTicket, sanitizeUrlForLogs } from "../../src/observability/logger.js";

describe("log redaction helpers", () => {
  it("strips query strings that may contain tickets", () => {
    expect(sanitizeUrlForLogs("/ws?ticket=super-secret-value")).toBe("/ws?[redacted]");
  });

  it("redacts ticket material", () => {
    expect(redactTicket("abcdefghijklmnopqrstuvwxyz")).toContain("[Redacted]");
    expect(redactTicket("abcdefghijklmnopqrstuvwxyz")).not.toContain("efghijklmn");
  });
});
