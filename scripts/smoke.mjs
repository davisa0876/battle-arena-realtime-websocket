#!/usr/bin/env node
/**
 * Local smoke checks against a running realtime container/process.
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
const base = process.argv[2] ?? "http://127.0.0.1:3001";

async function check(path, expectStatus) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (res.status !== expectStatus) {
    throw new Error(`${path} expected ${expectStatus}, got ${res.status}`);
  }
  console.log(`OK ${path} -> ${res.status}`);
}

await check("/health/live", 200);
await check("/health/ready", 200);
console.log("Smoke checks passed.");
