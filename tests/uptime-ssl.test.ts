import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// sslDaysRemaining used Node's default rejectUnauthorized:true, so an expired
// or otherwise invalid certificate failed the handshake and came back as null
// -- exactly the case the uptime check exists to flag. It must connect with
// rejectUnauthorized:false and report the (negative) day count.

const connectOpts: Array<Record<string, unknown>> = [];
let validTo = "";

vi.mock("node:tls", () => {
  const connect = (opts: Record<string, unknown>, onSecure: () => void) => {
    connectOpts.push(opts);
    const socket = Object.assign(new EventEmitter(), {
      getPeerCertificate: () => ({ valid_to: validTo }),
      end: () => {},
      destroy: () => {},
    });
    queueMicrotask(() => {
      // Mirrors Node: with verification on, an expired cert is an error.
      if (opts.rejectUnauthorized !== false) socket.emit("error", new Error("certificate has expired"));
      else onSecure();
    });
    return socket;
  };
  return { default: { connect }, connect };
});

import { sslDaysRemaining } from "@/services/security/uptime";

beforeEach(() => { connectOpts.length = 0; });

describe("sslDaysRemaining", () => {
  it("reports a negative day count for an expired certificate", async () => {
    validTo = new Date(Date.now() - 3 * 86_400_000 - 60_000).toUTCString();
    const days = await sslDaysRemaining("expired.test");
    expect(connectOpts[0]).toMatchObject({ rejectUnauthorized: false, servername: "expired.test" });
    expect(days).toBe(-4);
  });

  it("reports the remaining days for a valid certificate", async () => {
    validTo = new Date(Date.now() + 30 * 86_400_000 + 60_000).toUTCString();
    expect(await sslDaysRemaining("ok.test")).toBe(30);
  });
});
