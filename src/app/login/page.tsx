import { Suspense } from "react";
import { AntlerMark } from "@/components/nav/AntlerMark";
import { PinLoginForm } from "@/components/auth/PinLoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 px-6 bg-background text-foreground">
      <div className="flex flex-col items-center gap-3">
        <AntlerMark className="h-12 w-12 text-antler" />
        <h1 className="font-display text-2xl tracking-tight">Antlerboard</h1>
        <p className="text-sm text-muted text-center max-w-xs">
          Enter your 4-digit PIN to access the Claw &amp; Antler League front office.
        </p>
      </div>
      <Suspense fallback={null}>
        <PinLoginForm />
      </Suspense>
    </div>
  );
}
