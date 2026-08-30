# Verifying UI changes locally

## Server-action buttons appear to hang in the in-app browser

**Symptom.** Click any `ManageForm` button — "Test connection", "Refresh
inventory", "Mark as staging", "Flush cache" — and it sticks on its pending
label ("Testing…", "Saving…") forever. No JS errors. A manual reload shows
the action's effect applied correctly.

**It is not a bug.** Confirmed in a real browser: the button returns to
normal and the toast fires. This reproduces only in the in-app Browser pane
(`mcp__Claude_Browser__*`), on any branch — it was verified identically on
`master` at 4cf331f, which was deployed and working at the time.

**Why it looks convincing.** The evidence points the wrong way:

- The network panel logs the action POST as `200 OK`. It logs that when
  response *headers* arrive, so a never-completing RSC stream is
  indistinguishable from a successful one.
- The server side genuinely succeeds — the database write lands and
  `activity_log` records it — so every check short of the button itself
  says the action worked.
- `console.error` stays empty and the server log stays clean.

**Do not** debug this, and do not attribute it to whatever you just changed.
One session lost time to it and rebuilt `master` to rule the change out.

**How to verify a server action locally instead:**

1. Click it, then read the effect from the database (PostgREST with the
   service key) or from `activity_log` — not from the button.
2. Reload the page and assert the new state renders.
3. For anything user-visible that depends on the response settling (a toast,
   an optimistic update, a pending label clearing), ask the operator to
   confirm in their own browser. There is no way to observe it from the pane.

Everything else in the pane is trustworthy: navigation, rendering, layout
measurement, `read_page`, viewport emulation, and any assertion about markup
that does not depend on a server action's response settling.
