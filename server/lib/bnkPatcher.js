'use strict';

const { parseBnk, findAllIdOccurrences, findAllDurationCandidates } = require('./bnkParser');

/**
 * Given a .bnk buffer and the external Media (source) ID used for the track
 * you're modding (e.g. 520249413), exhaustively find every relevant field:
 *
 *   1. EVERY literal occurrence of that sourceId anywhere inside the owning
 *      Sound/MusicTrack HIRC object's payload. A track can reference the same
 *      source id from more than one internal structure (e.g. once in a
 *      Sources list, again in a Playlist/clip entry) — all must be rewritten
 *      to the replacement id, or the game keeps resolving the old one from
 *      whichever spot got missed.
 *   2. EVERY plausible duration-like double (100ms..2h, excluding the known
 *      unrelated fixed 1000.0 constant) inside that same track's payload.
 *   3. EVERY plausible duration-like double inside the parent MusicSegment's
 *      payload (found via refIds).
 *
 * Earlier versions picked only "the single largest value" per payload as a
 * heuristic shortcut — but real files can carry MULTIPLE legitimate duration
 * fields side by side (e.g. full length + a shorter fade/trim point), and
 * picking just one left the other stale. This version patches all of them.
 */
function locateFields(buf, targetSourceId) {
  const { result } = parseBnk(buf);

  const trackMatches = []; // { hirc, idOffsets }
  for (const h of result.hirc) {
    if (h.type !== 2 && h.type !== 11) continue; // Sound / MusicTrack
    const idOffsets = findAllIdOccurrences(h.payload, h.payloadStart, targetSourceId);
    if (idOffsets.length > 0) trackMatches.push({ hirc: h, idOffsets });
  }

  if (trackMatches.length === 0) {
    return { ok: false, reason: `Không tìm thấy HIRC object nào tham chiếu sourceId ${targetSourceId}` };
  }

  const trackIds = new Set(trackMatches.map(m => m.hirc.id));
  const segments = result.hirc.filter(h => h.type === 10 && h.refIds.some(r => trackIds.has(r)));

  const durationFields = []; // { kind, ownerId, currentValueMs, offsets }

  for (const seg of segments) {
    for (const c of findAllDurationCandidates(seg.payload, seg.payloadStart)) {
      durationFields.push({ kind: 'segment', ownerId: seg.id, currentValueMs: c.value, offsets: [c.offset] });
    }
  }

  for (const m of trackMatches) {
    for (const c of findAllDurationCandidates(m.hirc.payload, m.hirc.payloadStart)) {
      durationFields.push({ kind: 'track', ownerId: m.hirc.id, currentValueMs: c.value, offsets: [c.offset] });
    }
  }

  // idFields: absolute offsets of the sourceId itself, across all track matches
  const idFields = [];
  for (const m of trackMatches) {
    for (const off of m.idOffsets) idFields.push({ hircId: m.hirc.id, offset: off });
  }

  return { ok: true, trackIds: [...trackIds], durationFields, idFields };
}

// Kept for backward compatibility (used by /api/admin/update to validate a
// bnk without needing to patch anything).
function locateDurationFields(buf, targetSourceId) {
  const located = locateFields(buf, targetSourceId);
  if (!located.ok) return located;
  return { ok: true, trackIds: located.trackIds, fields: located.durationFields };
}

/**
 * Returns a NEW Buffer (copy) with:
 *   - EVERY sourceId occurrence for `targetSourceId` rewritten to `replacementSourceId`
 *   - EVERY located duration occurrence (segment-level AND track-level)
 *     overwritten with `newDurationMs` (float64 LE)
 * File size is preserved exactly — only fixed-width fields are rewritten in place.
 * If replacementSourceId === targetSourceId, the id "patch" is a no-op write
 * of the same value (harmless), behaving like the old in-place mode.
 */
function patchIdAndDuration(buf, targetSourceId, replacementSourceId, newDurationMs) {
  const located = locateFields(buf, targetSourceId);
  if (!located.ok) return { ok: false, reason: located.reason };

  const patched = Buffer.from(buf); // copy, never mutate the original

  let idPatchCount = 0;
  for (const idf of located.idFields) {
    patched.writeUInt32LE(replacementSourceId, idf.offset);
    idPatchCount++;
  }

  let durationPatchCount = 0;
  for (const field of located.durationFields) {
    for (const off of field.offsets) {
      patched.writeDoubleLE(newDurationMs, off);
      durationPatchCount++;
    }
  }

  return {
    ok: true,
    buffer: patched,
    trackIds: located.trackIds,
    idFields: located.idFields.map(f => ({ hircId: f.hircId, oldSourceId: targetSourceId, newSourceId: replacementSourceId })),
    idPatchCount,
    durationFields: located.durationFields.map(f => ({
      kind: f.kind, ownerId: f.ownerId,
      oldValueMs: f.currentValueMs, newValueMs: newDurationMs,
      offsetCount: f.offsets.length
    })),
    durationPatchCount
  };
}

module.exports = { locateFields, locateDurationFields, patchIdAndDuration };
