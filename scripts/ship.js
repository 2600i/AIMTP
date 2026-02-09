#!/usr/bin/env node
/**
 * AIMTP Ship Discipline Script
 * - Runs verification (test/build/smoke)
 * - Updates spec if needed
 * - Commits changes
 * - Tags release
 * - Optionally pushes
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function output(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function runPush(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
    if (out && out.trim()) {
      process.stdout.write(out);
    }
  } catch (err) {
    if (err && err.stderr) {
      process.stderr.write(String(err.stderr));
    }
    fail(`Push failed: ${cmd}`);
  }
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

/* ----------------------------------------------------- */
/* 1. Verification                                      */
/* ----------------------------------------------------- */

try {
  run("npm test");
  run("npm run build");
  run("npm run smoke:federation");
} catch {
  fail("Verification failed. Ship aborted.");
}

/* ----------------------------------------------------- */
/* 2. Clean untracked noise                              */
/* ----------------------------------------------------- */

const status = output("git status --porcelain");
if (!status) {
  console.log("✓ Working tree clean");
}

/* ----------------------------------------------------- */
/* 3. Spec alignment                                    */
/* ----------------------------------------------------- */

const specPath = path.join("spec", "aimtp-v0.2-federation.md");
if (!fs.existsSync(specPath)) {
  fail("Federation spec not found");
}

let spec = fs.readFileSync(specPath, "utf8");

const envBlock = `
When federation is enabled, relay key material MUST be provided via environment variables:

- \`AIMTP_RELAY_PUBLIC_KEY\`
- \`AIMTP_RELAY_PRIVATE_KEY\`

Keys MUST correspond to the relay identity public key and be suitable for Ed25519 signing.
`;

if (!spec.includes("AIMTP_RELAY_PUBLIC_KEY")) {
  console.log("Updating spec with federation key env vars");
  spec += `\n${envBlock}\n`;
  fs.writeFileSync(specPath, spec);
  run(`git add ${specPath}`);
  run(`git commit -m "spec: document federation relay key environment variables"`);
}

/* ----------------------------------------------------- */
/* 4. Commit remaining changes                           */
/* ----------------------------------------------------- */

const remaining = output("git status --porcelain");
if (remaining) {
  run("git add .");
  run(`git commit -m "feat: Phase 7 federation & trust (implementation + smoke test)"`);
}

/* ----------------------------------------------------- */
/* 5. Version + Tag                                     */
/* ----------------------------------------------------- */

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const currentVersion = pkg.version;

const tags = output("git tag").split("\n").filter(Boolean);
const lastTag = tags[tags.length - 1] || null;

let nextVersion;
if (!lastTag || lastTag.startsWith("v0.1")) {
  nextVersion = "0.2.0";
} else {
  const [maj, min, patch] = currentVersion.split(".").map(Number);
  nextVersion = `${maj}.${min}.${patch + 1}`;
}

if (nextVersion !== currentVersion) {
  pkg.version = nextVersion;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
  run("git add package.json");
  run(`git commit -m "chore: bump version to ${nextVersion}"`);
}

const tagName = `v${nextVersion}`;
run(`git tag -a ${tagName} -m "AIMTP ${tagName} — Federation & Trust (Phase 7)"`);

/* ----------------------------------------------------- */
/* 6. Optional push                                     */
/* ----------------------------------------------------- */

(async () => {
  const shouldPush = await confirm("Push commits and tags to origin?");
  if (shouldPush) {
    let branch;
    try {
      branch = output("git rev-parse --abbrev-ref HEAD");
    } catch {
      fail("Unable to determine current branch");
    }

    let hasUpstream = true;
    try {
      output("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
    } catch {
      hasUpstream = false;
    }

    if (!hasUpstream) {
      runPush(`git push -u origin ${branch}`);
    } else {
      runPush("git push");
    }
    runPush("git push --tags");
  } else {
    console.log("Push skipped.");
  }

  console.log(`\n✅ Ship complete: ${tagName}`);
})();
