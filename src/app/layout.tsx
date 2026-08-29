import "./globals.css";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";

// Self-hosted at build time by next/font — no third-party request at runtime,
// and no layout shift from a swap.
const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata = {
  title: "WP Control Panel",
  description: "Manage, secure, and report on WordPress sites.",
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
