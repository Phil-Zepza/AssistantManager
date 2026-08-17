import type { MetadataRoute } from "next";

// PWA web app manifest (served at /manifest.webmanifest). Lightweight: installable
// with a standalone display + themed splash. Icons are placeholders.
//
// TODO PWA: service worker (offline/precache) is out of scope for this PR.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FPL/LMS Assistant",
    short_name: "FPL/LMS",
    description: "Fantasy Premier League and Last Man Standing assistant",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#06080C",
    background_color: "#06080C",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
