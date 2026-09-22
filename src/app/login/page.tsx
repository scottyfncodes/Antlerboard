import { Suspense } from "react";
import { AntlerboardLogotype } from "@/components/brand/AntlerboardLogotype";
import { PinLoginForm } from "@/components/auth/PinLoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 px-6 bg-background text-foreground">
      <div className="flex flex-col items-center gap-4">
        <AntlerboardLogotype />
        <p className="text-sm text-muted text-center max-w-xs">
          Enter your 4-digit PIN to access the front office.
        </p>
      </div>
      <Suspense fallback={null}>
        <PinLoginForm />
      </Suspense>
    </div>
  );
}
