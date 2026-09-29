/**
 * Clears the @modal parallel slot on every soft navigation that is not itself
 * intercepted.
 *
 * default.tsx only covers first load and hard navigations. On a client-side
 * navigation Next.js keeps rendering whatever a parallel slot last matched
 * when the new URL has no match in that slot -- so after the connect-site
 * modal redirects to /sites/<id> (createSite) or closes via
 * router.replace("/dashboard"), the slot kept the modal mounted over the new
 * page. A catch-all that renders nothing gives every other URL an explicit,
 * empty match, which unmounts the modal. The more specific (.)sites/new
 * interception still wins for /sites/new.
 */
export default function CatchAll() {
  return null;
}
