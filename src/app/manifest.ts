import type { MetadataRoute } from "next";

// App Router web manifest convention — served at /manifest.webmanifest and
// linked into <head> automatically. Icons point at the pre-rendered PNGs in
// public/brand (generated from public/brand/mark.svg); the maskable entry
// uses the variant already inset to the platform's 80% safe zone rather than
// asking the OS to crop the plain mark itself.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OCS Wordpress Control Panel",
    short_name: "OCS Control Panel",
    description:
      "Internal tool for Online Creative Solutions to manage, secure, and report on client WordPress sites.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/brand/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
