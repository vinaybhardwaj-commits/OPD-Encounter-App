'use client';

/**
 * <PreStageLabButton /> — thin client wrapper that opens
 * <PreStageLabModal> on click.
 *
 * Why a separate file: <RoomQueueCard> on /reception is a server
 * component (renders patient summary lines). We just need a button per
 * encounter row that opens a modal — but modals need state, so the
 * button itself is the client boundary and owns the open/close state.
 *
 * Cheap to mount many of these (one per encounter row in the room
 * grid). The modal itself only mounts when `open=true`.
 */
import { useState } from 'react';
import { PreStageLabModal } from './PreStageLabModal';

export type PreStageLabButtonProps = {
  encounterId: string;
  patientName: string;
  /**
   * If the CCE already pre-staged labs for this encounter, show a small
   * count badge so they know not to duplicate. Optional.
   */
  existingPreStagedCount?: number;
};

export function PreStageLabButton({
  encounterId,
  patientName,
  existingPreStagedCount,
}: PreStageLabButtonProps) {
  const [open, setOpen] = useState(false);
  const has = (existingPreStagedCount ?? 0) > 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider transition ${
          has
            ? 'border-even-blue-300 bg-even-blue-50 text-even-blue-900 hover:border-even-blue-400'
            : 'border-even-ink-200 bg-white text-even-ink-500 hover:border-even-blue-200 hover:bg-even-blue-50'
        }`}
        title={has ? `${existingPreStagedCount} labs pre-staged` : 'Pre-stage labs'}
      >
        <span>🧪</span>
        {has ? `+${existingPreStagedCount}` : 'Lab'}
      </button>
      <PreStageLabModal
        encounterId={encounterId}
        patientName={patientName}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
