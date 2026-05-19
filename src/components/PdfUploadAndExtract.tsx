'use client';

/**
 * <PdfUploadAndExtract /> — v2.1.3 lab tech upload UI.
 *
 * Flow:
 *   1. Drag-drop OR file picker accepts PDF / PNG / JPEG.
 *   2. Client renders PDF pages to PNGs via pdf.js (renderReportToPngs).
 *      Image files pass-through as a single page.
 *   3. POST multipart to /api/lab-orders/[id]/upload:
 *        original  → File
 *        page_count → number
 *        page_0..N → base64 PNG content
 *   4. Render the extracted items grid + overall confidence bar.
 *   5. If auto_post_eligible (server says confidence ≥ 0.9), start a
 *      10s countdown banner. On expiry, POST /confirm with
 *      auto_posted=true. Cancel button stops the timer; tech can then
 *      keep the order in awaiting_confirmation (v2.1.4 will land the
 *      manual edit grid that lets them edit + manual-confirm).
 *   6. After confirm, router.refresh() — the encounter is now
 *      ready_to_resume, the order disappears from /lab inbox.
 *
 * State machine:
 *   idle → rendering → uploading → extracting (handled server-side)
 *        → reviewing → (auto)countdown → confirming → done
 *
 * Error states: render_failed / upload_failed / extract_failed
 * (caught and surfaced inline).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { renderReportToPngs } from '@/lib/pdf-render-client';
import type { ExtractedLabItem } from '@/lib/qwen-vision';

const AUTO_POST_COUNTDOWN_SEC = 10;

type Phase =
  | 'idle'
  | 'rendering'
  | 'uploading'
  | 'reviewing'
  | 'confirming'
  | 'done'
  | 'error';

type ExtractResponse = {
  ok: boolean;
  items?: ExtractedLabItem[];
  overall_confidence?: number;
  auto_post_eligible?: boolean;
  blob_url?: string;
  extraction_error?: string | null;
  error?: string;
  detail?: string;
};

export type PdfUploadAndExtractProps = {
  orderId: string;
  /** Tech can only upload when they've claimed the order. */
  canUpload: boolean;
  /** When already extracted (post-refresh), pre-load the items. */
  initialItems?: ExtractedLabItem[] | null;
  initialConfidence?: number | null;
};

export function PdfUploadAndExtract({
  orderId,
  canUpload,
  initialItems,
  initialConfidence,
}: PdfUploadAndExtractProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>(
    initialItems && initialItems.length > 0 ? 'reviewing' : 'idle',
  );
  const [items, setItems] = useState<ExtractedLabItem[]>(initialItems ?? []);
  const [confidence, setConfidence] = useState<number>(initialConfidence ?? 0);
  const [autoEligible, setAutoEligible] = useState<boolean>(
    (initialConfidence ?? 0) >= 0.9 && (initialItems?.length ?? 0) > 0,
  );
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [extractionFailed, setExtractionFailed] = useState(false);

  // Auto-confirm countdown
  useEffect(() => {
    if (phase !== 'reviewing' || !autoEligible) return;
    setCountdown(AUTO_POST_COUNTDOWN_SEC);
    const start = Date.now();
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const left = AUTO_POST_COUNTDOWN_SEC - elapsed;
      if (left <= 0) {
        clearInterval(t);
        setCountdown(0);
        void runConfirm(true);
      } else {
        setCountdown(left);
      }
    }, 250);
    return () => clearInterval(t);
    // runConfirm is stable via useCallback below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, autoEligible]);

  const cancelCountdown = useCallback(() => {
    setAutoEligible(false);
    setCountdown(null);
  }, []);

  const runConfirm = useCallback(
    async (autoPosted: boolean) => {
      setPhase('confirming');
      try {
        const res = await fetch(`/api/lab-orders/${orderId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, auto_posted: autoPosted }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          detail?: string;
        };
        if (!json.ok) {
          setError(json.detail ?? json.error ?? 'confirm_failed');
          setPhase('error');
          return;
        }
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'network_error');
        setPhase('error');
      }
    },
    [items, orderId, router],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setExtractionFailed(false);
      setItems([]);
      setConfidence(0);
      setAutoEligible(false);
      setCountdown(null);
      setPhase('rendering');
      let payload: Awaited<ReturnType<typeof renderReportToPngs>>;
      try {
        payload = await renderReportToPngs(file);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'render_failed');
        setPhase('error');
        return;
      }

      setPhase('uploading');
      const fd = new FormData();
      fd.append('original', payload.original);
      fd.append('page_count', String(payload.page_count));
      payload.pages.forEach((p, i) => fd.append(`page_${i}`, p));

      let json: ExtractResponse;
      try {
        const res = await fetch(`/api/lab-orders/${orderId}/upload`, {
          method: 'POST',
          body: fd,
        });
        json = (await res.json()) as ExtractResponse;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'network_error');
        setPhase('error');
        return;
      }
      if (!json.ok) {
        setError(json.detail ?? json.error ?? 'upload_failed');
        setPhase('error');
        return;
      }

      setItems(json.items ?? []);
      setConfidence(json.overall_confidence ?? 0);
      setAutoEligible(json.auto_post_eligible === true);
      if (json.extraction_error) {
        setExtractionFailed(true);
      }
      setPhase('reviewing');
    },
    [orderId],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = '';
    },
    [handleFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  if (!canUpload) {
    return (
      <div className="rounded-2xl border border-dashed border-even-ink-300 bg-white p-6 text-xs text-even-ink-500">
        Claim this order to enable PDF upload + Qwen extraction.
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-even-ink-200 bg-white p-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-even-ink-500">
        Result intake
      </h2>

      {(phase === 'idle' || phase === 'error' || phase === 'done') && (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`mt-3 cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition ${
              dragOver
                ? 'border-even-pink-400 bg-even-pink-50'
                : 'border-even-ink-200 bg-even-ink-50/40 hover:border-even-pink-300 hover:bg-even-pink-50/30'
            }`}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <p className="text-sm font-medium text-even-navy">
              Drop a PDF, PNG, or JPEG here
            </p>
            <p className="mt-1 text-[11px] text-even-ink-500">
              Or click to pick a file · Qwen-VL extracts each page on the
              server.
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={onPick}
            className="hidden"
          />
          {error && (
            <p className="mt-3 rounded-md bg-even-pink-50 px-3 py-2 text-[11px] text-even-pink-800">
              {error}
            </p>
          )}
          {phase === 'done' && (
            <p className="mt-3 rounded-md bg-even-blue-50 px-3 py-2 text-[11px] text-even-blue-900">
              ✓ Posted. Encounter has been notified.
            </p>
          )}
        </>
      )}

      {phase === 'rendering' && (
        <p className="mt-3 text-xs text-even-ink-500">
          Rendering pages…
        </p>
      )}
      {phase === 'uploading' && (
        <p className="mt-3 text-xs text-even-ink-500">
          Uploading + Qwen extracting… (cold start can take ~30s)
        </p>
      )}

      {phase === 'reviewing' && (
        <div className="mt-3 space-y-3">
          {/* Confidence header */}
          <div className="rounded-lg border border-even-ink-200 bg-white px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-even-ink-500">
                Overall confidence
              </span>
              <span
                className={`text-sm font-semibold ${
                  confidence >= 0.9
                    ? 'text-even-blue-800'
                    : confidence >= 0.7
                    ? 'text-amber-700'
                    : 'text-even-pink-800'
                }`}
              >
                {(confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-even-ink-100">
              <div
                className={`h-full ${
                  confidence >= 0.9
                    ? 'bg-even-blue-500'
                    : confidence >= 0.7
                    ? 'bg-amber-400'
                    : 'bg-even-pink-500'
                }`}
                style={{ width: `${Math.max(2, Math.min(100, confidence * 100))}%` }}
              />
            </div>
            {extractionFailed && (
              <p className="mt-2 rounded-md bg-even-pink-50 px-2 py-1 text-[10px] text-even-pink-800">
                Qwen extraction error — values shown may be incomplete. Manual
                edit grid lands in v2.1.4.
              </p>
            )}
          </div>

          {/* Items table */}
          {items.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-even-ink-200">
              <table className="w-full text-[11px]">
                <thead className="bg-even-ink-50 text-even-ink-600">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left font-semibold uppercase tracking-wider">
                      Test
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold uppercase tracking-wider">
                      Value
                    </th>
                    <th className="px-2.5 py-1.5 text-left font-semibold uppercase tracking-wider">
                      Unit
                    </th>
                    <th className="px-2.5 py-1.5 text-left font-semibold uppercase tracking-wider">
                      Ref range
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold uppercase tracking-wider">
                      Flag
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold uppercase tracking-wider">
                      Conf.
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-even-ink-100">
                  {items.map((it, idx) => (
                    <tr key={idx}>
                      <td className="px-2.5 py-1.5">
                        <div className="font-medium text-even-navy">
                          {it.display_name}
                        </div>
                        <div className="font-mono text-[10px] text-even-ink-400">
                          {it.canonical_key}
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-even-navy">
                        {it.value_numeric != null
                          ? it.value_numeric
                          : it.value_text ?? '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-even-ink-600">
                        {it.unit ?? '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-even-ink-600">
                        {it.reference_range ?? '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        <FlagPill flag={it.abnormal_flag} />
                      </td>
                      <td
                        className={`px-2.5 py-1.5 text-right tabular-nums ${
                          it.confidence >= 0.9
                            ? 'text-even-blue-700'
                            : it.confidence >= 0.7
                            ? 'text-amber-700'
                            : 'text-even-pink-700'
                        }`}
                      >
                        {(it.confidence * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-even-ink-200 bg-white px-3 py-3 text-[11px] text-even-ink-500">
              Qwen returned 0 items. Re-upload a sharper scan or wait for v2.1.4
              manual edit grid.
            </p>
          )}

          {/* Auto-post countdown */}
          {autoEligible && countdown !== null && (
            <div className="flex items-center justify-between rounded-lg border border-even-blue-300 bg-even-blue-50 px-3 py-2">
              <span className="text-[11px] text-even-blue-900">
                ✓ Confidence high — auto-posting in{' '}
                <span className="font-semibold tabular-nums">{countdown}s</span>
                …
              </span>
              <button
                type="button"
                onClick={cancelCountdown}
                className="rounded-md border border-even-blue-300 bg-white px-2.5 py-1 text-[11px] font-medium text-even-blue-900 transition hover:bg-even-blue-100"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Manual confirm — visible always once reviewing */}
          {!autoEligible && (
            <div className="flex items-center justify-between rounded-lg border border-even-ink-200 bg-even-ink-50 px-3 py-2">
              <span className="text-[11px] text-even-ink-700">
                {items.length === 0
                  ? 'Nothing to post — edit grid lands in v2.1.4.'
                  : 'Manual confirm — post these values as-is.'}
              </span>
              <button
                type="button"
                onClick={() => runConfirm(false)}
                disabled={items.length === 0 || phase !== 'reviewing'}
                className="rounded-md bg-even-navy px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-even-navy-700 disabled:opacity-50"
              >
                Post results
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'confirming' && (
        <p className="mt-3 text-xs text-even-ink-500">Posting results…</p>
      )}
    </section>
  );
}

function FlagPill({ flag }: { flag: ExtractedLabItem['abnormal_flag'] }) {
  const tone =
    flag === 'high' || flag === 'low'
      ? 'bg-amber-100 text-amber-900'
      : flag === 'critical_high' || flag === 'critical_low'
      ? 'bg-even-pink-100 text-even-pink-900'
      : flag === 'normal'
      ? 'bg-even-blue-50 text-even-blue-800'
      : 'bg-even-ink-100 text-even-ink-600';
  return (
    <span
      className={`inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${tone}`}
    >
      {flag.replace(/_/g, ' ')}
    </span>
  );
}
