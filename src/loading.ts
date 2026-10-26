// Loading screen for live scenes: the first era takes 1–2 minutes (historian, painting, critic), so the wait
// tells the story of what each Meta model is doing, over the user's own photo.

export type StepId = "read" | "research" | "paint" | "check";
type StepState = "waiting" | "active" | "done" | "failed";

const root = document.getElementById("loading")!;
const titleEl = document.getElementById("loading-title")!;
const placeEl = document.getElementById("loading-place")!;
const barEl = document.getElementById("loading-bar")!;
const captionEl = document.getElementById("loading-caption")!;

export const loading = {
  show(title: string): void {
    titleEl.textContent = title;
    placeEl.textContent = "";
    captionEl.textContent = "";
    barEl.style.width = "0%";
    for (const el of root.querySelectorAll<HTMLElement>("[data-step]")) el.dataset.state = "waiting";
    root.classList.remove("leaving");
    root.hidden = false;
  },

  step(id: StepId, state: StepState, detail?: string): void {
    const el = root.querySelector<HTMLElement>(`[data-step="${id}"]`);
    if (!el) return;
    el.dataset.state = state;
    const d = el.querySelector<HTMLElement>(".step-detail");
    if (d && detail !== undefined) d.textContent = detail;
  },

  place(text: string): void {
    placeEl.textContent = text;
  },

  progress(done: number, total: number): void {
    barEl.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  },

  caption(text: string): void {
    captionEl.textContent = text;
  },

  hide(): void {
    if (root.hidden) return;
    root.classList.add("leaving");
    setTimeout(() => (root.hidden = true), 600);
  },

  get visible(): boolean {
    return !root.hidden;
  },
};
