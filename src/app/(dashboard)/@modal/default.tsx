/**
 * Fallback for the @modal parallel slot on every route that is not itself
 * intercepted (i.e. everywhere except the routes under @modal/(.)...). Without
 * this, Next.js has no way to know what to render in the slot on first load
 * or a hard navigation, and 404s the whole layout.
 */
export default function Default() {
  return null;
}
