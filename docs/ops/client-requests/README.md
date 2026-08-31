# Client-facing request documents

Documents written to be forwarded to someone outside OCS — a client's IT team,
a host's support desk. HTML is the source; the PDF beside it is the artefact
that actually gets sent.

## Regenerating a PDF

```bash
node scripts/build-client-doc.mjs azalea-cloudflare-request
```

Edit the `.html`, re-run, forward the `.pdf`. Do not hand-export from a
browser's print dialog — the script exists because three things go wrong
silently that way, and each of them produces a document that still *looks*
finished:

- **Fonts.** Headless Chrome will not fetch Google Fonts in time, and the
  document falls back to Times New Roman throughout. `fonts-inline.css` holds
  the latin subsets as base64 woff2 so rendering never touches the network.
- **Theme.** These documents are theme-aware. Headless Chrome reports a dark
  `prefers-color-scheme`, so without an explicit `data-theme="light"` stamp the
  PDF comes out dark-on-dark.
- **Document structure.** The HTML is an Artifact body with no
  `<html>`/`<head>`/`<body>`. It has to be split at the last `</style>` and
  reassembled, or the stylesheet lands somewhere it does not apply and the
  output is an unstyled wall of text.

The script prints a page count as a smoke test. A one-page result almost
always means the stylesheet did not apply.

## Current documents

| File | Sent to | About |
|---|---|---|
| `azalea-cloudflare-request` | Client in-house IT (Cloudflare account holders) | Two WAF rules to unblock TLS renewal and site maintenance on the Azalea domains. See `../cloudflare.md` for the measurements behind it. |

## A note on fonts-inline.css

Generated once from Google Fonts (Archivo, Source Serif 4, JetBrains Mono,
latin subsets only). It is checked in deliberately: regenerating it needs
network access, and a document that has to be sent should not fail to build
because a font CDN is unreachable.
