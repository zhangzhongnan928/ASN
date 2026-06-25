import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "ASN — Agent-native Social Network",
  description:
    "Permissionless, non-custodial, agent-native social network on Base Sepolia. ERC-4337 identity + ERC-6551 TBA encryption inheritance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          <main className="container">{children}</main>
          <footer className="footer">
            ASN · Base Sepolia · research/MVP — not audited.{" "}
            <a href="https://github.com/zhangzhongnan928/ASN" target="_blank" rel="noreferrer">
              source
            </a>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
