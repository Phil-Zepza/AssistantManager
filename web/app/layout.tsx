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
    default: "FPL / LMS Assistant",
    template: "%s · FPL / LMS",
  },
  description: "Fantasy Premier League and Last Man Standing assistant",
  applicationName: "FPL/LMS Assistant",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "FPL/LMS",
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
