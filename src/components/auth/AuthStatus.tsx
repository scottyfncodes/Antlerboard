"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import type { CurrentManagerSummary } from "@/lib/auth/types";

export function AuthStatus({ currentManager }: { currentManager: CurrentManagerSummary }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const router = useRouter();

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">
        Acting as <span className="font-medium text-foreground">{currentManager.name}</span>
      </span>
      <button
        onClick={logout}
        disabled={loggingOut}
        className="flex items-center gap-1 text-muted hover:text-foreground disabled:opacity-50"
        aria-label="Log out"
        title="Log out"
      >
        <LogOut className="h-5 w-5" strokeWidth={2.25} />
        <span className="sm:hidden">Log out</span>
      </button>
    </div>
  );
}
