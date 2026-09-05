import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AXIOM — proof-gated trading desk",
  description: "Quant research & paper-trading desk — backtester, safety proving ground, and forward-tested bots.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      {/* Scrolling stays enabled globally — the terminal page locks its own
          viewport with h-screen overflow-hidden on its root div. */}
      <body className="bg-terminal-bg text-txt-primary font-mono min-h-screen">
        {children}
      </body>
    </html>
  );
}
