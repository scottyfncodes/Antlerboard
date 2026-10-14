"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export interface UrlFilterSelect {
  /** Search-param key the select writes to. */
  param: string;
  /** Accessible label; also the text of the "no filter" option. */
  label: string;
  allLabel: string;
  options: { value: string; label: string }[];
}

/**
 * Search box + selects that live in the URL (like PlayerFilters and
 * KeeperFilters), so a filtered view is shareable and server-rendered.
 * Changing any filter drops `page`, since the old page number no longer
 * means anything. Controls are 16px on phones so iOS Safari doesn't zoom
 * in on focus, and stack two-up instead of overflowing.
 */
export function UrlFilterBar({
  searchPlaceholder,
  selects,
  preserve = [],
}: {
  searchPlaceholder?: string;
  selects: UrlFilterSelect[];
  /** Params that "Clear filters" keeps (e.g. the season being viewed). */
  preserve?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function push(next: URLSearchParams) {
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    push(next);
  }

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  function onSearch(value: string) {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => update("q", value.trim()), 300);
  }

  const active = searchPlaceholder ? !!params.get("q") : false;
  const anyActive = active || selects.some((s) => !!params.get(s.param));

  function clear() {
    setQ("");
    const next = new URLSearchParams();
    for (const key of preserve) {
      const v = params.get(key);
      if (v) next.set(key, v);
    }
    push(next);
  }

  const control = "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-base md:text-sm md:py-1.5";

  return (
    <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
      {searchPlaceholder && (
        <input
          type="search"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className={`${control} col-span-2 md:w-56`}
        />
      )}
      {selects.map((s) => (
        <select
          key={s.param}
          aria-label={s.label}
          className={`${control} md:w-auto`}
          value={params.get(s.param) ?? ""}
          onChange={(e) => update(s.param, e.target.value)}
        >
          <option value="">{s.allLabel}</option>
          {s.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}
      {anyActive && (
        <button onClick={clear} className="col-span-2 justify-self-start text-xs text-muted hover:text-foreground underline md:col-span-1">
          Clear filters
        </button>
      )}
    </div>
  );
}
