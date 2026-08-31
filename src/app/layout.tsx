import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SECTOR — Throws Flight Analysis",
  description:
    "Monocular flight tracking for the throwing events. One camera, no markers: release velocity, release height, sector deviation and Rule 32 distance, solved from the arc itself.",
};

export const viewport: Viewport = {
  themeColor: "#06080a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
