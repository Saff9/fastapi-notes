import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/vault/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FastAPI Engineering Academy",
  description:
    "A complete, opinionated engineering curriculum for building production-grade backends with FastAPI, SQLAlchemy 2.x, PostgreSQL, and modern Python tooling.",
  keywords: [
    "FastAPI",
    "SQLAlchemy",
    "PostgreSQL",
    "Pydantic",
    "Python",
    "backend",
    "engineering",
    "curriculum",
    "Obsidian",
  ],
  authors: [{ name: "FastAPI Engineering Academy" }],
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.svg",
  },
  openGraph: {
    title: "FastAPI Engineering Academy",
    description:
      "A complete engineering curriculum for production-grade backends with FastAPI, SQLAlchemy, and PostgreSQL.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
