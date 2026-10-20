import type { Metadata, Viewport } from "next";
import "./globals.css";
import { headers } from "next/headers";
export const metadata: Metadata = {
  title: "Second Brain",
  description: "Capture thoughts and retrieve them later.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black",
    title: "Second Brain",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
