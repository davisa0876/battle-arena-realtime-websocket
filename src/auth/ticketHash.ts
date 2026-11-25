import { createHash } from "node:crypto";

/** SHA-256 hex digest of the opaque ticket (matches Laravel hash('sha256', $ticket)). */
export function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/**
 * Opaque tickets are base64url-encoded 32+ random bytes from Laravel.
 * Reject obviously wrong shapes before touching Redis.
 */
export function isWellFormedTicket(ticket: string): boolean {
  if (ticket.length < 32 || ticket.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(ticket);
}
