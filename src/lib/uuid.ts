const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` has the shape of a UUID (this checks the shape only,
 * not that any version/variant bits are set, or that a row with this id
 * actually exists).
 *
 * Used to reject a malformed `[id]` route param before it ever reaches
 * Supabase — `auth.admin.getUserById` (and similar lookups) only treat
 * GoTrue's stable `user_not_found` code as "no such row"; a malformed id is
 * a validation error instead, which throws rather than 404ing. Checking the
 * shape here turns that into a clean `notFound()` / 404 for every route that
 * calls it, instead of each one re-deriving its own copy of this pattern.
 */
export function isUuidShaped(value: string): boolean {
  return UUID_SHAPE.test(value);
}
