import type { AppRole } from "@/lib/authz/types";

/**
 * One row of the user directory. `role` is nullable because an account can
 * exist in `auth.users` with no `user_roles` row — Phase 9a's `getViewer`
 * denies such a user everything, and the directory surfaces that state
 * rather than hiding it. A null-role user is never the last admin.
 */
export interface ManagedUser {
  id: string;
  email: string | null;
  role: AppRole | null;
  lastSignInAt: string | null;
  invitedNotAccepted: boolean;
  siteGrants: number;
}

/**
 * The result of a lockout guard. `reason` is rendered verbatim to an
 * administrator, so it is always a complete, plain sentence.
 */
export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

export const ALLOWED: GuardVerdict = { allowed: true };
export const refuse = (reason: string): GuardVerdict => ({ allowed: false, reason });
