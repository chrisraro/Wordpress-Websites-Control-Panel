import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { getOptionalEnv } from "@/lib/env";

// Self-hosted at build time by next/font — no third-party request at runtime,
// and no layout shift from a swap.
const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist-sans",
  display: "swap",
});

const PRODUCT_NAME = "OCS Wordpress Control Panel";
const DESCRIPTION =
  "Internal tool for Online Creative Solutions to manage, secure, and report on client WordPress sites from one dashboard.";

// APP_URL is the same env var the app already reads for building absolute
// links (see src/app/(dashboard)/users/actions.ts, src/services/jobs/handlers.ts).
// It is unset in local dev, so metadataBase is omitted rather than guessed —
// Next then resolves relative OG/icon URLs against the request origin instead.
const appUrl = getOptionalEnv("APP_URL");

export const metadata: Metadata = {
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
  title: {
    default: PRODUCT_NAME,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: PRODUCT_NAME,
  openGraph: {
    type: "website",
    title: PRODUCT_NAME,
    description: DESCRIPTION,
    siteName: PRODUCT_NAME,
    images: [{ url: "/brand/icon-512.png", width: 512, height: 512, alt: PRODUCT_NAME }],
  },
  // `icon` and `apple` are intentionally left to the file-based conventions
  // (src/app/icon.svg, src/app/apple-icon.png, src/app/manifest.ts) — Next
  // uses whichever of a file convention or this `icons` field it finds, and
  // declaring both for the same keys means the file convention silently
  // stops being used. `shortcut` isn't covered by either file convention, so
  // it's the one icon entry that belongs here.
  icons: {
    shortcut: "/brand/icon-32.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="min-h-screen bg-canvas font-geist text-body text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
