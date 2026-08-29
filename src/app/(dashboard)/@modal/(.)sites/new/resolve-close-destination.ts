/**
 * Decide where closing the connect-site modal should send the user.
 *
 * When /sites/new was reached by clicking "Connect site" from within the app
 * (dashboard header or sidebar), the intercepting route rendered on top of
 * the page underneath without leaving it, so router.back() lands back on
 * that page. When /sites/new was opened directly instead -- a shared link, a
 * fresh tab, or a hard reload -- there is no in-app history entry to return
 * to, and router.back() would strand the user on a blank tab or bounce them
 * out of the app entirely. history.length is 1 only in that second case (a
 * fresh navigation entry with nothing before it), so it is what distinguishes
 * the two.
 */
export function resolveCloseDestination(historyLength: number): "back" | "fallback" {
  return historyLength > 1 ? "back" : "fallback";
}
