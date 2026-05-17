/**
 * Sprint 0 landing — palette smoke test and a placeholder for the
 * doctor sign-in shell that ships in M0.4.
 */
export default function Home() {
  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-between px-6 py-12 sm:px-10 sm:py-16">
        <header className="flex items-center gap-3">
          <div
            aria-hidden
            className="h-8 w-8 rounded-full bg-even-blue ring-4 ring-even-blue-100"
          />
          <span className="text-sm font-medium uppercase tracking-[0.18em] text-even-navy">
            Even Hospital
          </span>
        </header>

        <section className="my-16">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-even-blue-700">
            Sprint 0 · scaffold
          </p>
          <h1 className="mb-5 text-4xl font-semibold leading-tight tracking-tight text-even-navy sm:text-5xl">
            OPD Encounter App
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-even-ink-600">
            A faster, more elegant way for OPD doctors at Even Hospital to
            record, document, prescribe and dispatch in a single sitting.
            Doctor sign-in and the full encounter flow ship in the next
            sprints.
          </p>
        </section>

        <section
          aria-label="Brand palette preview"
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          <Swatch label="Blue" hex="#0055FF" className="bg-even-blue text-white" />
          <Swatch label="Navy" hex="#002054" className="bg-even-navy text-white" />
          <Swatch label="Pink" hex="#F96EB1" className="bg-even-pink text-even-navy" />
          <Swatch
            label="White"
            hex="#FCFCFC"
            className="border border-even-ink-200 bg-even-white-DEFAULT text-even-navy"
          />
        </section>

        <footer className="mt-16 text-xs text-even-ink-400">
          M0.2 · Even palette wired into Tailwind · build a doctor login next.
        </footer>
      </div>
    </main>
  );
}

function Swatch({
  label,
  hex,
  className,
}: {
  label: string;
  hex: string;
  className: string;
}) {
  return (
    <div
      className={`flex h-24 flex-col justify-between rounded-xl p-3 ${className}`}
    >
      <span className="text-xs font-medium uppercase tracking-wider opacity-90">
        {label}
      </span>
      <span className="font-mono text-xs opacity-90">{hex}</span>
    </div>
  );
}
