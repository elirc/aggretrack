"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { BOTTOM_NAV, NAV_SECTIONS, type NavItem, type NavSection } from "./nav-items";
import type { Permission, Role } from "@/lib/authz/permissions";
import { can } from "@/lib/authz/permissions";

interface AppShellProps {
  orgName: string;
  userName: string;
  role: Role;
  readOnly: boolean;
  children: React.ReactNode;
}

function allowed(role: Role, items: NavItem[]): NavItem[] {
  return items.filter((i) => can(role, i.permission as Permission));
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ orgName, userName, role, readOnly, children }: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const sections: NavSection[] = NAV_SECTIONS.map((s) => ({
    ...s,
    items: allowed(role, s.items),
  })).filter((s) => s.items.length > 0);

  const bottom = allowed(role, BOTTOM_NAV);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80 p-0">
              <SheetHeader className="border-b px-4 py-3 text-left">
                <SheetTitle className="text-base">{orgName}</SheetTitle>
                <p className="text-xs text-muted-foreground">
                  {userName} · {role}
                </p>
              </SheetHeader>
              <ScrollArea className="h-[calc(100dvh-5rem)] px-2 py-2">
                {sections.map((section) => (
                  <div key={section.label} className="mb-3">
                    <p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {section.label}
                    </p>
                    {section.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMenuOpen(false)}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                          isActive(pathname, item.href)
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-foreground hover:bg-accent/50",
                        )}
                      >
                        <item.icon className="size-4 shrink-0" />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </ScrollArea>
            </SheetContent>
          </Sheet>
          <Link href="/" className="truncate text-sm font-semibold">
            {orgName}
          </Link>
          {readOnly ? (
            <Badge variant="destructive" className="ml-auto shrink-0">
              Read only
            </Badge>
          ) : null}
        </div>
      </header>

      {readOnly ? (
        <div className="border-b bg-destructive/10 px-4 py-2 text-center text-xs text-destructive">
          Subscription inactive — the organisation is read-only. Renew on the billing page.
        </div>
      ) : null}

      {/* Content */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-4">{children}</main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background">
        <div className="mx-auto grid h-16 w-full max-w-5xl auto-cols-fr grid-flow-col">
          {bottom.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-xs",
                isActive(pathname, item.href)
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <item.icon className="size-5" />
              {item.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground"
          >
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>
    </div>
  );
}
