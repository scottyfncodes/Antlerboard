"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const PIN_LENGTH = 4;

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export function PinLoginForm() {
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  async function submit(pin: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (res.ok) {
        const next = searchParams.get("next") || "/";
        router.push(next);
        router.refresh();
        return;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "");
        setError(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? `Too many attempts. Try again in about ${formatRetryAfter(retryAfter)}.`
            : "Too many attempts. Please wait before trying again."
        );
      } else {
        setError("Incorrect PIN.");
      }
      setDigits(Array(PIN_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleChange(index: number, rawValue: string) {
    const digit = rawValue.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    setError(null);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (next.every((d) => d !== "")) {
      void submit(next.join(""));
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center gap-3" role="group" aria-label="4-digit PIN">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={1}
            value={digit}
            disabled={submitting}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={`PIN digit ${i + 1}`}
            className="h-14 w-12 rounded-lg border border-border bg-surface text-center text-2xl font-semibold tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-antler disabled:opacity-50"
          />
        ))}
      </div>
      <p className="text-center text-sm min-h-5" aria-live="polite">
        {error && <span className="text-red">{error}</span>}
        {!error && submitting && <span className="text-muted">Checking...</span>}
      </p>
    </div>
  );
}
