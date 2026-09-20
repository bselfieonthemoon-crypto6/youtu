// Diagnostic only: is the local API on 127.0.0.1:3002 reachable from node?
const ports = [3002, 3005, 3007];
for (const port of ports) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    console.log(`port ${port}: HTTP ${response.status} ok=${JSON.parse(body).ok} runtime=${JSON.parse(body).components?.agentRuntime?.status}`);
  } catch (error) {
    console.log(`port ${port}: FAILED ${error.message} cause=${error.cause?.message ?? "-"}`);
  }
}
