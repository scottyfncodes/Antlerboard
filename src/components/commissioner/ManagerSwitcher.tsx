"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface ManagerOption {
  id: string;
  name: string;
  isCommissioner: boolean;
}

export function ManagerSwitcher() {
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [currentId, setCurrentId] = useState<string>("");
  const router = useRouter();

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        setManagers(data.managers ?? []);
        setCurrentId(data.current?.id ?? "");
      });
  }, []);

  async function switchTo(id: string) {
    setCurrentId(id);
    await fetch("/api/me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ managerId: id }),
    });
    router.refresh();
  }

  return (
    <div>
      <p className="text-xs text-muted mb-1">
        Antlerboard is a private league tool without full account logins - pick which manager this browser
        acts as.
      </p>
      <select
        value={currentId}
        onChange={(e) => switchTo(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
      >
        {managers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} {m.isCommissioner ? "(Commissioner)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
