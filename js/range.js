import { el } from "./util.js";

/** Pointer capture keeps dragging outside the control. A canceled gesture
 * commits the last accepted position, never the cancellation event's (often
 * zero or stale) coordinates. Only the owning pointer can change the value.
 */
export function rangeControl({ onInput, onCommit, label, step = 0.02,
  shiftStep = 0.1, valueText = (v) => `${Math.round(v * 100)}%` }) {
  const fill = el("div.range-fill");
  const buffer = el("div.range-buffer");
  const thumb = el("div.range-thumb");
  const track = el("div.range-track", {}, [buffer, fill]);
  const root = el("div.range", {
    role: "slider", tabindex: "0", "aria-label": label,
    "aria-valuemin": "0", "aria-valuemax": "100",
    "aria-orientation": "horizontal",
  }, [track, thumb]);
  let pointer = null;
  let bounds;
  const doc = root.ownerDocument;
  const move = (e) => { if (e.pointerId === pointer) update(e); };
  const blur = () => end({ type: "pointercancel", pointerId: pointer });
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const update = (e) => {
    if (!Number.isFinite(e.clientX) || !bounds.width) return;
    root.setValue(clamp((e.clientX - bounds.left) / bounds.width));
    onInput?.(root.value);
  };
  root.addEventListener("pointerdown", (e) => {
    if (pointer !== null || e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault(); // no text selection or native drag competing with us
    root.focus({ preventScroll: true });
    pointer = e.pointerId;
    bounds = root.getBoundingClientRect();
    root.classList.add("dragging");
    // Also listen on the document for browsers that drop pointer capture.
    // These listeners exist only for the active gesture and owning pointer.
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
    doc.defaultView.addEventListener("blur", blur);
    try { root.setPointerCapture(pointer); } catch { /* document fallback */ }
    update(e);
  });
  const end = (e) => {
    if (pointer === null || e.pointerId !== pointer) return;
    if (e.type === "pointerup") update(e);
    const id = pointer;
    pointer = null;
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", end);
    doc.removeEventListener("pointercancel", end);
    doc.defaultView.removeEventListener("blur", blur);
    root.classList.remove("dragging");
    if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
    onCommit?.(root.value);
  };
  // Lost capture is not cancellation: document listeners continue the drag.
  root.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = e.shiftKey ? shiftStep : step;
    let v;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = root.value + delta;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = root.value - delta;
    else if (e.key === "Home") v = 0;
    else if (e.key === "End") v = 1;
    else return;
    e.preventDefault();
    e.stopPropagation(); // do not also invoke the global seek/volume shortcut
    root.setValue(clamp(v));
    onCommit?.(root.value);
  });
  root.value = 0;
  root.isDragging = () => pointer !== null;
  root.setValue = (v) => {
    if (!Number.isFinite(v)) return;
    root.value = clamp(v);
    const pct = `${root.value * 100}%`;
    fill.style.width = pct;
    thumb.style.left = pct;
    root.setAttribute("aria-valuenow", String(Math.round(root.value * 100)));
    root.setAttribute("aria-valuetext", valueText(root.value));
  };
  root.setBuffer = (v) => { buffer.style.width = `${clamp(v) * 100}%`; };
  return root;
}
