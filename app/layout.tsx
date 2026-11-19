import type { Metadata, Viewport } from "next";
import { Creepster, Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { getTheme } from "@/ui/server-copy";
import { ThemeProvider } from "@/ui/ThemeProvider";
import "./globals.css";

// All three fonts are under the SIL Open Font License (UI-20).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });
// Kiroween headings only, so it isn't preloaded: the browser fetches it when a Kiroween page uses it.
const creepster = Creepster({ subsets: ["latin"], weight: "400", variable: "--font-creepster", display: "swap", preload: false });

const DESCRIPTION = "A security proxy between AI agents and payment rails.";

// UI-29: link previews. The image is app/opengraph-image.png, which Next.js adds to these tags itself.
export const metadata: Metadata = {
  title: { default: "AgentVault", template: "%s · AgentVault" },
  description: DESCRIPTION,
  openGraph: { title: "AgentVault", description: DESCRIPTION, siteName: "AgentVault", type: "website" },
  twitter: { card: "summary_large_image", title: "AgentVault", description: DESCRIPTION },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The theme comes from a cookie, so the server renders it and there's no flash of the other one (UI-17).
  const theme = await getTheme();
  return (
    <html lang="en" data-theme={theme} className={`${inter.variable} ${mono.variable} ${creepster.variable}`}>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <ThemeProvider initial={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
