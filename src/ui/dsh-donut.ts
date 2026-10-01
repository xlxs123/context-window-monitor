/*! SPDX-License-Identifier: Apache-2.0
 * Copyright 2025 bowenliang123
 * Adapted donut geometry; see docs/licenses/dsh-context-APACHE-2.0.txt. */
// Adapted from bowenliang123/dsh-context, src/client/components/donut.tsx,
// commit 42f84915617705ccd4f1f9a0112bd5113b6089fd (2026-10-01).
// Modified: pure geometry for the Codex DOM renderer; no React or DSH SDK.
export interface DonutValue { key: string; color: string; value: number | null }
export interface DonutArc { key: string; color: string; length: number; offset: number }
export function donutArcs(segments: DonutValue[]): DonutArc[] {
  let total = 0;
  for (const segment of segments) if (segment.value !== null && Number.isFinite(segment.value) && segment.value > 0) total += segment.value;
  const arcs: DonutArc[] = [];
  let accumulated = 0;
  if (total > 0) for (const segment of segments) {
    const value = segment.value !== null && Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0;
    if (value === 0) continue;
    const percentage = value / total * 100;
    arcs.push({key: segment.key, color: segment.color, length: percentage, offset: 100 - accumulated + 25});
    accumulated += percentage;
  }
  if (arcs.length > 1) for (const arc of arcs) {
    const cut = Math.min(0.5 / 2, arc.length / 4);
    arc.length -= cut * 2;
    arc.offset -= cut;
  }
  return arcs;
}
