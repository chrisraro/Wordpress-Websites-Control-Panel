import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Finding 1 (Phase 9b review, Fix round 1): CopyValueButton/CopyLinkButton
// must never echo a bearer credential (an invite link, a report share token)
// into the toast body — ToastProvider renders `description` directly, and a
// success toast lives ~4.5s outside whatever dialog the admin is looking at.
//
// This is a source-scan, not a rendered-DOM assertion, because this repo's
// vitest config runs with `environment: "node"` and has no jsdom/React
// Testing Library harness, and adding one is out of scope for this fix. What
// can be pinned without a harness is (a) the component actually has a code
// path that drops `description` when `secret` is set, rather than merely
// blanking it, and (b) both places that copy a credential opt into it.
const COPY_BUTTON = join(__dirname, "..", "src", "components", "ui", "copy-button.tsx");
const INVITE_DIALOG = join(
  __dirname, "..", "src", "app", "(dashboard)", "users", "invite-dialog.tsx",
);
const REPORTS_PAGE = join(
  __dirname, "..", "src", "app", "(dashboard)", "sites", "[id]", "reports", "page.tsx",
);

describe("copy-button suppresses the toast description when secret", () => {
  const source = readFileSync(COPY_BUTTON, "utf8");

  it("CopyLinkButton's success toast has no description in the secret branch", () => {
    expect(source).toMatch(/secret\s*\?\s*\{\s*tone:\s*"success",\s*title:\s*"Link copied"\s*\}/);
  });

  it("CopyValueButton's success toast has no description in the secret branch", () => {
    expect(source).toMatch(/secret\s*\?\s*\{\s*tone:\s*"success",\s*title:\s*"Copied"\s*\}/);
  });

  it("the non-secret branches still echo the copied value (unchanged behaviour)", () => {
    expect(source).toContain('{ tone: "success", title: "Link copied", description: url }');
    expect(source).toContain('{ tone: "success", title: "Copied", description: value }');
  });

  it("neither component's failure branch carries the copied value", () => {
    // Every `description:` that follows a `tone: "error"` in this file must
    // be a plain string literal with no interpolation — a leak on the catch
    // path would defeat the fix just as surely as one on the success path.
    const errorDescriptions = [
      ...source.matchAll(/tone:\s*"error"[\s\S]*?description:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g),
    ].map((m) => m[1]);
    expect(errorDescriptions).toHaveLength(2);
    for (const d of errorDescriptions) {
      expect(d).not.toMatch(/\$\{/);
    }
  });
});

describe("the two credential call sites opt into secret copying", () => {
  it("the invite dialog's Copy link button (the one-time invite link) passes secret", () => {
    const source = readFileSync(INVITE_DIALOG, "utf8");
    expect(source).toMatch(/<CopyValueButton\s+value=\{success\.inviteLink\}[^>]*\bsecret\b[^>]*\/>/);
  });

  it("the reports page's share-link copy button passes secret", () => {
    const source = readFileSync(REPORTS_PAGE, "utf8");
    expect(source).toMatch(/<CopyLinkButton\s+path=\{`\/r\/\$\{r\.share_token\}`\}[^>]*\bsecret\b[^>]*\/>/);
  });

  it("the site overview page's WP-username copy button is intentionally left non-secret", () => {
    // Not a call-site regression check — a guard against someone "fixing"
    // this one too. A WordPress username is not a bearer credential (it
    // can't authenticate anything by itself), and the review explicitly
    // scoped the flag to the invite link and the report share link only.
    // `site.wp_username` no longer exists (spec §5.2 moved it to the
    // `connection` value returned by getSiteConnection); this button now
    // reads `connection.wp_username`.
    const source = readFileSync(
      join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]", "page.tsx"),
      "utf8",
    );
    expect(source).toMatch(/<CopyValueButton\s+value=\{connection\.wp_username\}[^>]*\/>/);
    expect(source).not.toMatch(/<CopyValueButton\s+value=\{connection\.wp_username\}[^>]*\bsecret\b/);
  });
});
