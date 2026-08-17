import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter, self-hosted via next/font, exposed as the --font-sans token consumed
// by globals.css / the Tailwind `sans` family.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: {
    default: "AI Gaffer",
    template: "%s · AI Gaffer",
  },
  description: "Your AI football manager — FPL squad, transfers, chips, and LMS survival",
  applicationName: "AI Gaffer",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "AI Gaffer",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#06080C",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-base text-primary antialiased">
        {children}
      </body>
    </html>
  );
}
