"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";

const links = [
  { href: "/", label: "Feed" },
  { href: "/identity", label: "Identity" },
  { href: "/publish", label: "Publish" },
  { href: "/deploy", label: "Deploy" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <Link href="/" className="brand">
        AS<span>N</span>
      </Link>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={`link ${path === l.href ? "active" : ""}`}>
          {l.label}
        </Link>
      ))}
      <span className="spacer" />
      <ConnectButton />
    </nav>
  );
}
