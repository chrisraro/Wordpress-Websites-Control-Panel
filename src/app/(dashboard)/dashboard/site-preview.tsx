"use client";

import { useEffect, useRef, useState } from "react";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "@/services/sites/preview";

/** The desktop viewport the live homepage is laid out at, then scaled into the card. */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

/**
 * The homepage on a site card, live.
 *
 * The real site, loaded by the viewer's own browser in a frame laid out at a
 * 1280px desktop viewport and scaled down to the card, so what the card shows
 * is what a visitor sees right now, not a cached capture.
 *
 * The frame is sandboxed with no permissions at all: no scripts, forms,
 * popups or navigation. That is deliberate, not a limitation to lift later.
 * With scripts on, every dashboard visit would fire each client's Google
 * Analytics / Pixel and count as a visit, which an SEO agency's own
 * reporting would then have to explain. HTML, CSS and images still render,
 * so the page looks like itself; script-driven sliders sit on their first
 * frame. It is also inert (aria-hidden, not focusable, no pointer events):
 * the card around it is the link.
 *
 * `liveUrl` is only set for https sites that the latest uptime check found
 * frameable (uptime_checks.frameable, 0029). Anything else, including a site
 * whose hardening sends X-Frame-Options, shows the screenshot, and failing
 * that the site's initials.
 */
export function SitePreview({
  liveUrl, screenshotSrc, name,
}: {
  liveUrl: string | null;
  screenshotSrc: string | null;
  name: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [shotFailed, setShotFailed] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!liveUrl || !el) return;
    const ro = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / VIEWPORT_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, [liveUrl]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  const placeholder = (
    <div
      aria-hidden
      className="flex size-full items-center justify-center bg-canvas text-heading font-semibold text-mid-gray"
    >
      {initials}
    </div>
  );

  if (liveUrl) {
    return (
      <div ref={boxRef} className="relative size-full overflow-hidden">
        {/* Until the page paints, the card is not empty. */}
        {!frameLoaded && <div className="absolute inset-0">{placeholder}</div>}
        {scale !== null && (
          <iframe
            src={liveUrl}
            title={`Live homepage of ${name}`}
            sandbox=""
            loading="lazy"
            referrerPolicy="no-referrer"
            tabIndex={-1}
            aria-hidden
            onLoad={() => setFrameLoaded(true)}
            width={VIEWPORT_WIDTH}
            height={VIEWPORT_HEIGHT}
            style={{ transform: `scale(${scale})` }}
            className={`pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-paper
              transition-opacity duration-300 ${frameLoaded ? "opacity-100" : "opacity-0"}`}
          />
        )}
      </div>
    );
  }

  if (!screenshotSrc || shotFailed) return placeholder;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      // An error before hydration fires no onError; catch it on mount.
      ref={(img) => {
        if (img?.complete && img.naturalWidth === 0) setShotFailed(true);
      }}
      src={screenshotSrc}
      alt=""
      width={PREVIEW_WIDTH}
      height={PREVIEW_HEIGHT}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setShotFailed(true)}
      className="size-full object-cover object-top transition-transform duration-300
        ease-[var(--ease-out-quint)] group-hover:scale-[1.02]"
    />
  );
}
