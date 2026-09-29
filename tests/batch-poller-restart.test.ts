import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The vitest environment is "node", so this pins the poller's wiring by
// source (the same approach as tests/pending-states.test.ts).
//
// BatchPoller stops polling once the batch reports done, and its effect
// depended only on [batchId]. "Retry N failed" is offered exactly when the
// batch is done, so after a successful retry nothing restarted polling: the
// page stayed frozen on the old failures and `announced` stayed true, so the
// second completion was never toasted. processQueueNowAction's result was
// also awaited and dropped, so a denied or failed run looked like success.
const POLLER = join(
  __dirname,
  "..",
  "src",
  "app",
  "(dashboard)",
  "marketplace",
  "batches",
  "[id]",
  "poller.tsx",
);

describe("BatchPoller restarts polling after retry/cancel", () => {
  const source = readFileSync(POLLER, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("keeps a pollKey and includes it in the polling effect's deps", () => {
    expect(source).toMatch(/const \[pollKey, setPollKey\] = useState\(0\)/);
    expect(source).toContain("}, [batchId, pollKey]);");
  });

  it("restartPolling resets done and announced and bumps the key", () => {
    const body = source.match(/const restartPolling = \(\) => \{([\s\S]*?)\};/)?.[1] ?? "";
    expect(body).toContain("setDone(false)");
    expect(body).toContain("announced.current = false");
    expect(body).toContain("setPollKey((k) => k + 1)");
  });

  function handler(name: string): string {
    const start = source.indexOf(`const ${name} = () => {`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  };\n", start);
    return source.slice(start, end);
  }

  it("a successful retry restarts polling (after the !ok early return)", () => {
    const body = handler("retryFailed");
    const bail = body.indexOf("if (!res.ok)");
    const restart = body.indexOf("restartPolling()");
    expect(bail).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(bail);
  });

  it("a successful cancel restarts polling (after the !ok early return)", () => {
    const body = handler("cancelQueued");
    const bail = body.indexOf("if (!res.ok)");
    const restart = body.indexOf("restartPolling()");
    expect(bail).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(bail);
  });

  it("processNow surfaces a failed result instead of dropping it", () => {
    const body = handler("processNow");
    expect(body).toContain("const res = await processQueueNowAction()");
    expect(body).toMatch(/if \(!res\.ok\) \{[\s\S]*toast\(\{\s*tone: "error"/);
  });

  it("processNow names failed jobs as failed jobs, not a queue outage", () => {
    const body = handler("processNow");
    expect(body).toContain("const failed = res.failed ?? 0");
    expect(body).toMatch(/failed > 0\s*\?\s*`\$\{failed\} job/);
    expect(body).toContain('"Could not process the queue"');
  });
});
