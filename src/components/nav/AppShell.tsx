import Link from "next/link";
import { Search } from "lucide-react";
import { TopNav } from "./TopNav";
import { BottomNav } from "./BottomNav";
import { AntlerMark } from "./AntlerMark";
import { NotificationBell } from "../notifications/NotificationBell";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <TopNav />
      <header
        className="lg:hidden sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex items-center gap-2 px-4 h-14">
          <Link href="/" className="flex items-center gap-2">
            <AntlerMark className="h-6 w-6 text-antler" />
            <span className="font-display text-base tracking-tight">Antlerboard</span>
          </Link>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/search" className="text-muted hover:text-foreground" aria-label="Search">
              <Search className="h-5 w-5" strokeWidth={1.75} />
            </Link>
            <NotificationBell />
          </div>
        </div>
      </header>
      <div className="hidden lg:flex justify-end mx-auto max-w-7xl w-full px-6 -mt-1 pb-1">
        <NotificationBell />
      </div>
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 md:px-6 pb-20 md:pb-10 pt-4">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
