/**
 * Fails when a Markdown file contains text that create-scaffold-hbar would rewrite when it scaffolds with npm, so the
 * docs a developer reads after scaffolding are the docs in this repository. The CLI replaces the other
 * package manager's name with "npm" and turns every "npm <word>" into "npm run <word>", except for
 * run, install, exec and ci.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED_AFTER_NPM = new Set(["run", "install", "exec", "ci"]);
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.md"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const problems = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(/\bnpm\s+([a-zA-Z0-9:_-]+)\b/g)) {
        if (!ALLOWED_AFTER_NPM.has(match[1])) problems.push(`${file}:${index + 1}: "npm ${match[1]}"`);
      }
      if (/\byarn\b|yarnpkg\.com/i.test(line))
        problems.push(`${file}:${index + 1}: mentions the other package manager`);
    });
}

if (problems.length > 0) {
  console.error("These lines would be rewritten when the template is scaffolded with npm:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Docs check: ${files.length} Markdown files are safe to scaffold.`);
