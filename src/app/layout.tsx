import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bright Start Tutoring — Trial Classes",
  description: "Book a trial class. Every seat counted correctly.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main>
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                ✳
              </span>
              Bright Start Tutoring
            </Link>
            <nav className="tabs">
              <Link href="/">Book a trial</Link>
              <Link href="/admin">Admin</Link>
            </nav>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
