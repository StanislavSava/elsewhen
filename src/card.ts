// Field-guide card (creatures) and idea-fossil card, shown in a bottom sheet.
import type { Biome, Fauna, Fossil } from "./shared/eras";
import { formatYear } from "./shared/eras";

const sheet = document.getElementById("sheet")!;
const body = document.getElementById("sheet-body")!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function showCreature(f: Fauna, year: number, biome: Biome): void {
  const badge =
    f.kind === "extinct"
      ? `<span class="badge extinct">Extinct · a real species</span>`
      : `<span class="badge speculative">Speculative biology</span>`;
  body.innerHTML = `
    ${badge}
    <h2 class="card-title">${esc(f.name)}</h2>
    <p class="card-binomial">${esc(f.binomial)}</p>
    <p class="card-meta">${esc(formatYear(year))} · ${esc(biome)} biome${f.where ? ` · ${esc(f.where)}` : ""}</p>
    <div class="card-section">Descended from</div><div>${esc(f.ancestor)}</div>
    <div class="card-section">Way of life</div><div>${esc(f.niche)}</div>
    <div class="card-section">Why it looks like this</div>
    <ul class="adaptations">${f.adaptations.map((a) => `<li><b>${esc(a.trait)}</b>, because ${esc(a.because)}.</li>`).join("")}</ul>
    ${
      f.sources?.length
        ? `<div class="card-section">Sources</div><div class="sources">${f.sources
            .map((s) => `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(new URL(s).hostname)}</a>`)
            .join(" · ")}</div>`
        : ""
    }`;
  sheet.hidden = false;
}

export function showFossil(fossil: Fossil, imageUrl: string | null, year: number): void {
  body.innerHTML = `
    <span class="badge">Idea fossil · ${esc(fossil.medium)}</span>
    <h2 class="card-title">${esc(formatYear(year))}</h2>
    ${imageUrl ? `<img class="fossil-img" src="${esc(imageUrl)}" alt="" />` : ""}
    ${fossil.slogan ? `<p class="slogan">${esc(fossil.slogan)}</p>` : ""}
    <div class="card-section">How it persuades</div>
    <ul class="adaptations">${fossil.elements
      .map((e) => `<li><b>${esc(e.technique)}</b> · ${esc(e.name)}: ${esc(e.explanation)}.</li>`)
      .join("")}</ul>`;
  sheet.hidden = false;
}

export function closeSheet(): void {
  sheet.hidden = true;
}

document.getElementById("sheet-close")!.addEventListener("click", closeSheet);
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeSheet();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});
