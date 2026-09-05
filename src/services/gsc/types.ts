/**
 * Google Search Console site verification: what is installed on a site.
 *
 * A deliberate limit runs through this whole module, and the wording of
 * everything the user sees depends on it: the panel can tell whether a
 * verification token is INSTALLED. It cannot tell whether a property is
 * VERIFIED. Only Google knows that, and the two come apart in both
 * directions — a token can sit on a site Google was never asked to check,
 * and a property can be verified through DNS or a linked Analytics account
 * with nothing on the site at all. Nothing here may render the word
 * "verified" as a claim about Google's state.
 */

/** A google<token>.html file found in the document root. */
export interface GscFile {
  name: string;
  /** The token file the body names, if the body is well-formed. */
  declared: string | null;
}

export interface GscVerification {
  files: GscFile[];
  /** A token stored by an SEO plugin, which renders it as a meta tag. */
  plugin: { name: string; token: string } | null;
}

export type GscState =
  /** At least one well-formed verification is installed. */
  | "installed"
  /** A file is present but Google will reject it — see `problems`. */
  | "malformed"
  /** Nothing found by any method this panel can see. */
  | "none";

export interface GscStatus {
  state: GscState;
  /** Every method found, for display: "HTML file", "Yoast meta tag"... */
  methods: string[];
  /** Human-readable reasons, shown whether or not the state is malformed. */
  problems: string[];
}

/**
 * Google's file method: the file is named google<token>.html and its body is
 * exactly "google-site-verification: google<token>.html". A file whose body
 * does not name itself is the classic failure — someone copies an existing
 * verification file to a second site, or renames one and forgets the
 * contents — and Google rejects it while the file sits there looking present.
 * Detecting that is most of this module's value.
 */
export const GSC_FILE_RE = /^google[0-9a-f]{8,}\.html$/;

export function expectedFileBody(fileName: string): string {
  return `google-site-verification: ${fileName}`;
}

/** Accepts what Google hands out, and nothing that could be a path. */
export function validateVerificationFileName(name: string): string | null {
  if (!name) return "Enter the file name Google gave you.";
  if (/[\/\\]/.test(name)) return "That is a path, not a file name.";
  if (!GSC_FILE_RE.test(name)) {
    return "Expected a name like google1234abcd5678.html — copy it exactly from Search Console.";
  }
  return null;
}

/**
 * Reduces what was found on a site to one state and a reason.
 *
 * `undefined` means the site has not been inventoried since this was added,
 * which is NOT the same as "nothing installed" — the same distinction
 * `maintenance` draws in InventoryPayload, and for the same reason: telling
 * someone their verification is missing when the truth is "not measured yet"
 * sends them to fix something that may not be broken.
 */
export function gscStatus(v: GscVerification | undefined): GscStatus | null {
  if (!v) return null;
  const methods: string[] = [];
  const problems: string[] = [];

  for (const f of v.files) {
    if (f.declared === f.name) {
      methods.push("HTML file");
    } else if (f.declared === null) {
      problems.push(`${f.name} is empty or unreadable, so Google cannot verify it.`);
    } else {
      // The copy-and-rename mistake, stated precisely enough to act on.
      problems.push(
        `${f.name} contains the token for ${f.declared}, not for itself. ` +
        "Google will reject it — download this site's own file from Search Console.",
      );
    }
  }
  if (v.plugin) methods.push(`${v.plugin.name} meta tag`);

  if (methods.length > 0) return { state: "installed", methods, problems };
  if (problems.length > 0) return { state: "malformed", methods, problems };
  return { state: "none", methods, problems };
}
