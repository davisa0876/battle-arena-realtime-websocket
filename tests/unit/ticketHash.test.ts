import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashTicket, isWellFormedTicket } from "../../src/auth/ticketHash.js";

describe("ticket hashing", () => {
  it("matches Laravel hash('sha256', ticket) hex digest", () => {
    const ticket = randomBytes(32).toString("base64url");
    const expected = createHash("sha256").update(ticket, "utf8").digest("hex");
    expect(hashTicket(ticket)).toBe(expected);
  });

  it("rejects malformed tickets", () => {
    expect(isWellFormedTicket("")).toBe(false);
    expect(isWellFormedTicket("short")).toBe(false);
    expect(isWellFormedTicket("has spaces and!!!")).toBe(false);
    expect(isWellFormedTicket(randomBytes(32).toString("base64url"))).toBe(true);
  });
});
