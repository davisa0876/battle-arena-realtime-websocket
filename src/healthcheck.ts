/**
 * Docker HEALTHCHECK entrypoint — probes local liveness without curl/wget.
 */
const port = Number(process.env.PORT ?? "3001");
const host = process.env.HEALTHCHECK_HOST ?? "127.0.0.1";

const response = await fetch(`http://${host}:${port}/health/live`, {
  signal: AbortSignal.timeout(2_500),
});

if (!response.ok) {
  process.exit(1);
}

process.exit(0);
