import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { getTheme } from "@/ui/server-copy";
import { ThemeProvider } from "@/ui/ThemeProvider";
import "./globals.css";

// Both fonts are under the SIL Open Font License (UI-20).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "AgentVault", template: "%s · AgentVault" },
  description: "A security proxy between AI agents and payment rails.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The theme comes from a cookie, so the server renders it and there's no flash of the other one (UI-17).
  const theme = await getTheme();
  return (
    <html lang="en" data-theme={theme} className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <ThemeProvider initial={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
