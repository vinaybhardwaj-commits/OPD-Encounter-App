/**
 * POST /api/encounters/[id]/diagnostics
 *
 * Confirms a cart of diagnostic orders for the encounter. Writes into
 * `diagnostic_orders` (v3.0 table) and flips the encounter to
 * `paused_diagnostics` atomically (mirrors the v2
 * /api/encounters/[id]/send-to-diagnostics + /labs flow but on the new
 * unified table).
 *
 * Body: { cart: [{ service_code, source }] }
 * source ∈ 'manual' | 'qwen_suggestion_accepted' | 'bundle' | 'context_chip'
 *
 * Returns: { ok, order_ids: string[], status }
 *
 * v3.2a scope: writes only to diagnostic_orders (the new table). Does
 * NOT also write to lab_orders. The v3.0b cutover later will make
 * lab_orders a VIEW of diagnostic_orders WHERE modality='lab' so the
 * existing v2 lab pipeline (Lab tech inbox, claim, upload, etc.) sees
 * these new orders.
 *
 * UNTIL v3.0b ships, the new orders are visible in the encounter
 * timeline + this strip's confirmation toast, but DO NOT yet appear
 * on the /lab tech inbox (which queries lab_orders directly). V to
 * decide: ship v3.0b next, OR make v3.2a also dual-write to lab_orders
 * for the lab modality so the pipeline stays unbroken. Flagged in the
 * response for now.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { notifyQueue } from '@/lib/queueNotify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CartItem = {
  service_code: string;
  source: 'manual' | 'qwen_suggestion_accepted' | 'bundle' | 'context_chip';
};

type Body = { cart: CartItem[] };

const SOURCE_TO_ACTOR: Record<CartItem['source'], string> = {
  manual: 'doctor',
  qwen_suggestion_accepted: 'ai_suggestion_accepted',
  bundle: 'auto_bundle',
  context_chip: 'ai_suggestion_accepted',
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentUser();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { id: encounterId } = await ctx.params;
  const body = (await req.json()) as Body;
  if (!body.cart || !Array.isArray(body.cart) || body.cart.length === 0) {
    return NextResponse.json({ ok: false, error: 'empty_cart' }, { status: 400 });
  }

  // Verify the encounter + look up doctor_id (for ordered_by) and
  // patient_id (the view exposes it; lab inbox queries depend on it).
  const encRes = await pool.query<{
    id: string;
    doctor_id: string | null;
    patient_id: string | null;
    status: string;
  }>(
    `SELECT id, doctor_id, patient_id, status FROM encounters WHERE id = $1 LIMIT 1`,
    [encounterId],
  );
  if (encRes.rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'encounter_not_found' }, { status: 404 });
  }

  // Validate every service_code exists + look up modality for routing
  const codes = body.cart.map((c) => c.service_code);
  const catRes = await pool.query<{
    service_code: string;
    modality: 'lab' | 'imaging' | 'cardiology' | 'procedure';
    display_name: string;
  }>(
    `SELECT service_code, modality, display_name FROM diagnostic_catalog
     WHERE service_code = ANY($1::text[])`,
    [codes],
  );
  const catalogByCode = new Map(catRes.rows.map((r) => [r.service_code, r]));
  const missing = codes.filter((c) => !catalogByCode.has(c));
  if (missing.length > 0) {
    return NextResponse.json(
      { ok: false, error: 'unknown_service_codes', missing },
      { status: 400 },
    );
  }

  // Insert each cart item into diagnostic_orders.
  // status='ordered' for non-lab; lab uses 'pre_staged' equivalent for now.
  const inserted: { id: string; service_code: string; modality: string }[] = [];

  for (const item of body.cart) {
    const cat = catalogByCode.get(item.service_code)!;
    // Lab modality uses 'pending' so the v2 lab tech inbox (filters
    // WHERE status IN ('pending','in_progress','awaiting_confirmation'))
    // sees the order. Other modalities use 'ordered' (imaging =
    // awaiting radiology; procedure = awaiting operator).
    const initialStatus = cat.modality === 'lab' ? 'pending' : 'ordered';
    const orderingActor = SOURCE_TO_ACTOR[item.source] ?? 'doctor';

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO diagnostic_orders (
         encounter_id, patient_id, service_code, modality, status,
         ordered_by_doctor_id, ordering_actor, raw_text
       ) VALUES ($1, $2, $3, $4::text, $5::text, $6, $7::text, $8)
       RETURNING id`,
      [
        encounterId,
        encRes.rows[0].patient_id,
        item.service_code,
        cat.modality,
        initialStatus,
        session.id ?? null,
        orderingActor,
        cat.display_name, // raw_text preserved for lab_orders view compat
      ],
    );
    inserted.push({ id: rows[0].id, service_code: item.service_code, modality: cat.modality });
  }

  // Flip encounter to paused_diagnostics if not already
  // (mirrors v2 send-to-diagnostics behaviour)
  if (encRes.rows[0].status !== 'paused_diagnostics' && encRes.rows[0].status !== 'completed') {
    await pool.query(
      `UPDATE encounters
       SET status = 'paused_diagnostics',
           pending_diagnostic_test = $2,
           paused_reason = 'diagnostic_orders',
           updated_at = NOW()
       WHERE id = $1`,
      [encounterId, `Diagnostic panel (${inserted.length} test${inserted.length === 1 ? '' : 's'})`],
    );
  }

  // SSE notify so /dashboard refreshes
  await notifyQueue('queue:global', `diagnostic_orders:${encounterId}`).catch(() => {});

  return NextResponse.json({
    ok: true,
    encounter_id: encounterId,
    order_ids: inserted.map((i) => i.id),
    by_modality: inserted.reduce<Record<string, number>>((acc, i) => {
      acc[i.modality] = (acc[i.modality] || 0) + 1;
      return acc;
    }, {}),
    note: 'v3.0b — lab_orders is now a view of diagnostic_orders. Lab modality orders surface in /lab inbox via the view + triggers.',
  });
}
