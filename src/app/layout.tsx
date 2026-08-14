import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trial Booking",
  description: "Trial class booking with a correct roster under concurrency",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main>
          <nav>
            <Link href="/">Book a trial</Link>
            <Link href="/admin">Admin roster</Link>
          </nav>
          {children}
        </main>
      </body>
    </html>
  );
}
