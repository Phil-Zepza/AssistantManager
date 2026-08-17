import type { MetadataRoute } from "next";

// PWA web app manifest (served at /manifest.webmanifest). Installable with a
// standalone display + themed splash. Icons are the AI Gaffer brand set
// (vector-derived PNGs in /public/icons; source SVGs live in /public/logo).
//
// TODO PWA: service worker (offline/precache) is out of scope for this PR.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Gaffer",
    short_name: "AI Gaffer",
    description: "Your AI football manager — FPL squad, transfers, chips, and LMS survival",
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
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
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
