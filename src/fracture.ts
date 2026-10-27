// The moment history changes: a golden branch fractures out of the slider at the divergence year and climbs the
// screen; "What if…?" titles the new world; then the chain of events plays as a montage, the year ticking up
// like an odometer, each event revealed word by word with its consequence, a twig sprouting per event.
// Tap to hurry it along; Skip ends it.
import { CURRENT_YEAR, type Chronicle } from "./shared/eras";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const T = (ms: number) => (reduced ? ms * 0.35 : ms);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const calendar = (y: number) => (y < 0 ? `${-y} BCE` : String(y));

function whatIf(title: string): string {
  return `What if ${title.charAt(0).toLowerCase()}${title.slice(1)}?`;
}

/** Words that drift in one after another. */
function words(text: string, baseDelay: number, step: number): string {
  return text
    .split(" ")
    .map((w, i) => `<span class="fx-w" style="animation-delay:${baseDelay + i * step}ms">${esc(w)}</span>`)
    .join(" ");
}

export function playFracture(chronicle: Chronicle, branchEl: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "fx";
    const events = chronicle.chain;
    root.innerHTML = `
      <svg class="fx-branch" aria-hidden="true">
        <defs>
          <linearGradient id="fx-grad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stop-color="#e7c76a" stop-opacity="1"/>
            <stop offset="1" stop-color="#fff2c4" stop-opacity="0.9"/>
          </linearGradient>
        </defs>
        <path class="fx-trunk" />
        <g class="fx-twigs"></g>
      </svg>
      <div class="fx-card">
        <header class="fx-head">
          <div class="fx-kicker">Alternate history · splits in ${esc(calendar(chronicle.divergenceYear ?? 0))}</div>
          <h1 class="fx-title">${words(whatIf(chronicle.title), 200, 90)}</h1>
        </header>
        <div class="fx-beat" hidden>
          <div class="fx-year"><span class="fx-year-num"></span></div>
          <p class="fx-event"></p>
          <p class="fx-consequence"></p>
        </div>
      </div>
      <div class="fx-dots">${events.map(() => "<i></i>").join("")}</div>
      <button class="fx-skip">Skip</button>`;
    document.body.append(root);

    // ------------------------------------------------ the branch: from the slider's split marker up the screen
    const svg = root.querySelector<SVGSVGElement>(".fx-branch")!;
    const trunk = root.querySelector<SVGPathElement>(".fx-trunk")!;
    const twigs = root.querySelector<SVGGElement>(".fx-twigs")!;
    const b = branchEl?.getBoundingClientRect();
    const x0 = b ? b.left + b.width / 2 : innerWidth * 0.3;
    const y0 = b ? b.top + b.height / 2 : innerHeight * 0.85;
    const side = x0 < innerWidth / 2 ? 1 : -1;
    const x1 = x0 + side * innerWidth * 0.12;
    const yTop = innerHeight * 0.08;
    svg.setAttribute("viewBox", `0 0 ${innerWidth} ${innerHeight}`);
    trunk.setAttribute(
      "d",
      `M ${x0} ${y0} C ${x0} ${y0 - innerHeight * 0.18}, ${x1} ${y0 - innerHeight * 0.3}, ${x1} ${innerHeight * 0.5} S ${x1 - side * 30} ${innerHeight * 0.2}, ${x1 + side * 20} ${yTop}`,
    );
    const len = trunk.getTotalLength();
    trunk.style.strokeDasharray = `${len}`;
    trunk.style.strokeDashoffset = `${len}`;
    trunk.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: T(1600),
      easing: "cubic-bezier(.6,.05,.3,1)",
      fill: "forwards",
    });
    // A flash where the timeline cracks.
    const flash = document.createElement("div");
    flash.className = "fx-flash";
    Object.assign(flash.style, { left: `${x0}px`, top: `${y0}px` });
    root.append(flash);

    const sprout = (k: number) => {
      const p = trunk.getPointAtLength(len * (0.25 + (0.7 * (k + 1)) / (events.length + 1)));
      const dir = k % 2 ? 1 : -1;
      const twig = document.createElementNS("http://www.w3.org/2000/svg", "path");
      twig.setAttribute("d", `M ${p.x} ${p.y} q ${dir * 40} -10 ${dir * 70} -45`);
      twig.setAttribute("class", "fx-twig");
      twigs.append(twig);
      const l = twig.getTotalLength();
      twig.style.strokeDasharray = `${l}`;
      twig.animate([{ strokeDashoffset: l }, { strokeDashoffset: 0 }], { duration: T(600), easing: "ease-out", fill: "forwards" });
      const bud = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      bud.setAttribute("cx", String(p.x + dir * 70));
      bud.setAttribute("cy", String(p.y - 45));
      bud.setAttribute("r", "4");
      bud.setAttribute("class", "fx-bud");
      twigs.append(bud);
    };

    // ------------------------------------------------ the montage
    const beat = root.querySelector<HTMLElement>(".fx-beat")!;
    const title = root.querySelector<HTMLElement>(".fx-head")!;
    const yearEl = root.querySelector<HTMLElement>(".fx-year-num")!;
    const eventEl = root.querySelector<HTMLElement>(".fx-event")!;
    const consEl = root.querySelector<HTMLElement>(".fx-consequence")!;
    const dots = [...root.querySelectorAll<HTMLElement>(".fx-dots i")];

    let done = false;
    let hurry: (() => void) | null = null;
    const wait = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, T(ms));
        hurry = () => {
          clearTimeout(t);
          r();
        };
      });

    const odometer = (from: number, to: number, ms: number) =>
      new Promise<void>((r) => {
        const start = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - start) / T(ms));
          const e = 1 - (1 - k) ** 3;
          yearEl.textContent = calendar(Math.round(from + (to - from) * e));
          if (k < 1 && !done) requestAnimationFrame(step);
          else r();
        };
        requestAnimationFrame(step);
      });

    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      root.classList.add("fx-out");
      setTimeout(() => root.remove(), 700);
      resolve();
    };
    root.querySelector(".fx-skip")!.addEventListener("click", (e) => {
      e.stopPropagation();
      finish();
    });
    root.addEventListener("click", () => hurry?.());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") hurry?.();
    };
    document.addEventListener("keydown", onKey);

    void (async () => {
      await wait(2300); // the crack, the branch, "What if…?"
      if (done) return;
      title.classList.add("fx-title-up");
      beat.hidden = false;
      let prev = chronicle.divergenceYear ?? events[0]?.year ?? 0;
      for (const [k, ev] of events.entries()) {
        if (done) return;
        dots.forEach((d, i) => d.classList.toggle("on", i <= k));
        beat.classList.remove("fx-beat-in");
        void beat.offsetWidth; // restart the entrance animation
        beat.classList.add("fx-beat-in");
        eventEl.innerHTML = words(ev.event, 250, 45);
        consEl.innerHTML = words(ev.consequence, 600 + ev.event.split(" ").length * 45, 35);
        sprout(k);
        await odometer(prev, ev.year, 900);
        prev = ev.year;
        await wait(2600);
      }
      if (done) return;
      // The landing: this world's present.
      beat.classList.remove("fx-beat-in");
      void beat.offsetWidth;
      beat.classList.add("fx-beat-in");
      eventEl.innerHTML = words("Here is your place, in that world.", 100, 70);
      consEl.innerHTML = "";
      await odometer(prev, CURRENT_YEAR, 900);
      await wait(1300);
      finish();
    })();
  });
}
