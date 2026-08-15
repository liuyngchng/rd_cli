import type { ReactNode } from 'react';

type AuthScreenLayoutProps = {
  description: string;
  children: ReactNode;
  logo?: ReactNode;
};

export default function AuthScreenLayout({
  description,
  children,
  logo,
}: AuthScreenLayoutProps) {
  return (
    <div className="relative h-screen overflow-y-auto bg-background">
      {/* Ambient, on-brand backdrop that gives the screen depth without
          competing with the card content. Fixed so it stays put while the
          form scrolls on short viewports. */}
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-32 -left-24 h-[26rem] w-[26rem] rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.04)_1px,transparent_1px)] opacity-60 [background-size:22px_22px]" />
      </div>

      <div className="relative mx-auto flex min-h-full w-full max-w-md items-center justify-center px-4 py-4">
        <div className="w-full rounded-2xl border border-border/70 bg-card/90 p-5 shadow-[0_24px_60px_-20px_hsl(var(--foreground)/0.18)] ring-1 ring-foreground/5 backdrop-blur-xl sm:p-8">
          <div className="text-center">
            <div className="mb-3 flex justify-center">
              {logo ?? (
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
                  <img src="/logo.svg" alt="rdCLI" className="h-7 w-7" />
                </div>
              )}
            </div>
            <p className="mx-auto max-w-xs text-base font-medium leading-relaxed text-foreground">{description}</p>
          </div>

          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
