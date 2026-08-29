import { describe, it, expect } from "vitest";
import { resolveCloseDestination } from "@/app/(dashboard)/@modal/(.)sites/new/resolve-close-destination";

// The connect-site modal is reachable two ways: intercepted from within the
// app (Connect site in the header/sidebar), where there is a history entry
// underneath to return to, or as a direct hit on /sites/new (a shared link,
// a fresh tab, a hard reload), where there is not. router.back() is correct
// for the first case and strands the user in the second, so the modal picks
// between them using this pure decision -- tested here without touching the
// DOM's window.history or Next's router.
describe("resolveCloseDestination", () => {
  it("goes back when there is a history entry underneath (intercepted from within the app)", () => {
    expect(resolveCloseDestination(2)).toBe("back");
    expect(resolveCloseDestination(5)).toBe("back");
  });

  it("falls back instead of going back when there is nothing underneath (direct visit)", () => {
    expect(resolveCloseDestination(1)).toBe("fallback");
    expect(resolveCloseDestination(0)).toBe("fallback");
  });
});
