import type { Metadata, Viewport } from "next";
import { Libre_Franklin, IBM_Plex_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import Script from "next/script";

// Franklin Gothic is the typeface of the newspaper sports page and the box
// score, which is what Antlerboard's dense standings and keeper tables are.
// Paired with Fraunces for headings and Plex Mono for PINs.
const bodySans = Libre_Franklin({
  variable: "--font-body",
  subsets: ["latin"],
});

const bodyMono = IBM_Plex_Mono({
  variable: "--font-body-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Antlerboard · C&A Front Office",
  description:
    "The Claw & Antler League's front office: keepers, trades, DPUD, and league history in one place.",
  applicationName: "Antlerboard",
  // iOS Safari otherwise rewrites number- and date-like text (transaction
  // notes, dates, FAAB bids) into links before React hydrates, and the
  // changed DOM fails hydration (React #418).
  formatDetection: { telephone: false, date: false, address: false, email: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Antlerboard",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d0f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${bodySans.variable} ${bodyMono.variable} ${fraunces.variable} antialiased bg-background text-foreground`}
      >
        <ServiceWorkerRegister />
        {children}
        {/* HaveAnApp Pulse: anonymous, cookieless usage counts. */}
        <Script src="https://haveanapp-pulse-collect.vercel.app/p.js" data-app="antlerboard" strategy="afterInteractive" />
      </body>
    </html>
  );
}
