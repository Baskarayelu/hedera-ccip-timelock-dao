// The e2e build uses its own dist dir, and `next build` then points next-env.d.ts at it. Point it back at the
// normal build so running the tests leaves no change in git.
const fs = require("fs");
const file = `${__dirname}/../next-env.d.ts`;
fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("./.next-e2e/", "./.next/"));
