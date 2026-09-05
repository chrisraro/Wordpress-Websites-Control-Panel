import { putRootFile, deleteRootFile, type RootFilesDeps } from "@/services/rootfiles/service";
import { expectedFileBody, validateVerificationFileName } from "./types";

/**
 * Installs and removes Google's HTML-file verification.
 *
 * The file method rather than the meta-tag method, deliberately. A meta tag
 * lives in whichever SEO plugin the site happens to run — three different
 * option shapes across this fleet already (Yoast, Rank Math, All in One SEO)
 * — and writing another plugin's settings from here means owning its schema
 * forever. The file works identically everywhere, survives a plugin swap,
 * and this panel already has audited machinery for writing document-root
 * files. Tokens stored by a plugin are still DETECTED and shown; they are
 * just managed where they live.
 */

export interface GscDeps extends RootFilesDeps {}

export interface InstallResult {
  fileName: string;
  url: string;
  sha256: string;
  replaced: boolean;
  /** Whether the file was actually fetchable afterwards, over the public web. */
  reachable: boolean;
  /** Why it was not reachable, when it was not. */
  reachError?: string;
}

/**
 * Writes the file and then fetches it back over HTTP, the way Google will.
 *
 * The read-back putRootFile already does proves the bytes reached the disk.
 * It does not prove Google can read them, and on this fleet that gap is
 * real: a CDN in front of the origin, a security plugin blocking unknown
 * .html at the root, or a subdirectory install whose document root is not
 * where the URL suggests, all produce a file that exists and a verification
 * that fails. Reporting "installed" on the strength of a successful write
 * would be reporting the thing we can see instead of the thing that matters.
 *
 * A failed fetch is NOT an error: the file is written and may well be served
 * a moment later, or from a different edge. It is reported alongside the
 * success so the operator knows whether to press Verify in Search Console
 * now or go and look at their CDN first.
 */
export async function installVerificationFile(
  deps: GscDeps, siteId: string, fileName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallResult> {
  const nameError = validateVerificationFileName(fileName);
  if (nameError) throw new Error(nameError);

  const site = await deps.repo.getSite(siteId);
  if (!site) throw new Error("Site not found");

  // Content is generated, never accepted from the caller. The body is a pure
  // function of the name, so a mismatched pair -- the single most common way
  // this method fails -- cannot be created through this panel at all.
  const body = Buffer.from(expectedFileBody(fileName), "utf8");
  const written = await putRootFile(deps, siteId, fileName, body);

  const publicUrl = `${site.url.replace(/\/+$/, "")}/${fileName}`;
  let reachable = false;
  let reachError: string | undefined;
  try {
    const res = await fetchImpl(publicUrl, {
      headers: { "User-Agent": "Google-Site-Verification/1.0" },
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) {
      reachError = `The site answered HTTP ${res.status} for ${fileName}.`;
    } else if (text.trim() !== expectedFileBody(fileName)) {
      // A 200 that is not the file: almost always a catch-all route or a
      // "page not found" template served with the wrong status code.
      reachError = "The site answered, but with something other than the verification file.";
    } else {
      reachable = true;
    }
  } catch (e) {
    reachError = `Could not fetch ${publicUrl}: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    fileName,
    url: written.url,
    sha256: written.sha256,
    replaced: written.replaced,
    reachable,
    reachError,
  };
}

export async function removeVerificationFile(
  deps: GscDeps, siteId: string, fileName: string,
): Promise<void> {
  const nameError = validateVerificationFileName(fileName);
  if (nameError) throw new Error(nameError);
  await deleteRootFile(deps, siteId, fileName);
}
