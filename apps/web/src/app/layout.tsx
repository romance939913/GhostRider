import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "GhostRider",
  description: "Synthetic monitoring for critical user journeys.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 560,
          margin: "4rem auto",
          padding: "0 1rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
