/**
 * Parses and renders every Mermaid diagram in this repository's Markdown, in Chromium, with the Mermaid
 * versions GitHub and the docs site may use, so a diagram that will not render (Mermaid reads `;` as a line
 * break, for example) or renders too wide to read fails CI instead of the page.
 *
 *   node scripts/check-mermaid.mjs
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const VERSIONS = ["11.17.2", "12.1.0"];
// GitHub's Markdown column is about 1,012 px wide and shrinks a wider diagram, labels included. Up to 1,100 px
// (under 8% smaller) stays legible; a five-participant sequence diagram needs about 1,050 px at Mermaid's defaults.
const MAX_WIDTH = 1100;

const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const diagrams = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```mermaid") continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end].trim() !== "```") end++;
    diagrams.push({
      where: `${file}:${start}`,
      code: lines.slice(start, end).join("\n"),
    });
    i = end;
  }
}

const browser = await chromium.launch();
let failures = 0;
try {
  for (const version of VERSIONS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      url: `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`,
    });
    const results = await page.evaluate(async (list) => {
      const mermaid = window.mermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const out = [];
      for (const [i, d] of list.entries()) {
        try {
          await mermaid.parse(d.code);
          const { svg } = await mermaid.render(`d${i}`, d.code);
          const holder = document.createElement("div");
          holder.innerHTML = svg;
          document.body.appendChild(holder);
          const el = holder.querySelector("svg");
          const viewBox = el.viewBox.baseVal;
          out.push({ width: Math.round(viewBox?.width || el.getBoundingClientRect().width) });
          holder.remove();
        } catch (error) {
          out.push({ error: String(error?.message ?? error).split("\n").slice(0, 3).join(" ") });
        }
      }
      return out;
    }, diagrams);
    results.forEach((r, i) => {
      const { where } = diagrams[i];
      if (r.error) {
        failures++;
        console.log(`FAIL mermaid ${version} ${where}: ${r.error}`);
      } else if (r.width > MAX_WIDTH) {
        failures++;
        console.log(`FAIL mermaid ${version} ${where}: ${r.width} px wide (limit ${MAX_WIDTH})`);
      } else {
        console.log(`ok   mermaid ${version} ${where}: ${r.width} px`);
      }
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  `\n${diagrams.length} diagrams × ${VERSIONS.length} Mermaid versions: ${failures ? `${failures} failed` : "all render"}.`,
);
process.exit(failures ? 1 : 0);
