#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild } from "../scripts/build.mjs";
import { runVerify } from "../scripts/verify-build.mjs";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(BIN_DIR, "..");

function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function parseArgs(argv) {
  const positionals = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
    } else if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        opts[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, opts };
}

function printHelp() {
  console.log(`notes-site v${readPkgVersion()} — Reusable static study-notes site CLI

Usage:
  notes-site build [options]           Build static site into dist/
  notes-site verify [options]          Run full QA verification gates on dist/
  notes-site check [options]           Run build + verify sequentially
  notes-site prepare-deploy [options]  Prepare Cloudflare Build Output v1 (.cloudflare/output/v1/)
  notes-site init <dir> [options]      Scaffold a new course notes site from starter/

Common options:
  --root <dir>                  Course project root directory (default: current directory)
  --config <file>               Path to site.config.json
  --out-dir <dir>               Override output directory
  --allow-missing-explained     Dev fallback when content-explained/ is incomplete

Init options:
  --title <name>                Course title (e.g. "线性代数精讲笔记")
  --slug <id>                   URL/storage namespace slug (e.g. "linear-algebra")
  --brand-mark <char>           Single-character brand monogram
  --single-mode                 Disable dual reading-style mode (uses content/ only)
  --force                       Allow scaffolding into a non-empty directory
`);
}

function sanitizeSlug(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "my-course";
}

const DEFAULT_STARTER_GITIGNORE = `node_modules/
dist/
.cloudflare/
.wrangler/
.env
.env.*
!.env.example
.dev.vars
.DS_Store
*.log
`;

function copyStarterRecursive(srcDir, destDir, isRoot = true) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".cloudflare") {
        continue;
      }
      copyStarterRecursive(srcPath, path.join(destDir, entry.name), false);
    } else if (entry.isFile()) {
      if (isRoot && (entry.name === "gitignore" || entry.name === ".gitignore")) {
        // Materialize non-dotfile starter/gitignore as .gitignore explicitly below
        continue;
      }
      fs.copyFileSync(srcPath, path.join(destDir, entry.name));
    }
  }
}

function runInit(targetArg, opts) {
  if (!targetArg) {
    throw new Error('Missing target directory. Usage: notes-site init <dir> [--title "..."] [--slug "..."]');
  }
  const starterDir = path.join(PACKAGE_ROOT, "starter");
  if (!fs.existsSync(starterDir)) {
    throw new Error(`Starter template directory missing at ${starterDir}`);
  }

  const targetDir = path.resolve(process.cwd(), targetArg);
  if (fs.existsSync(targetDir)) {
    const existing = fs.readdirSync(targetDir).filter((f) => f !== ".git");
    if (existing.length > 0 && !opts.force) {
      throw new Error(
        `Target directory "${targetDir}" is not empty. Pass --force to scaffold into it.`
      );
    }
  }

  const slug = sanitizeSlug(opts.slug || path.basename(targetDir));
  const title =
    typeof opts.title === "string" && opts.title.trim() ? opts.title.trim() : `${slug} 课程讲义`;
  const brandMark =
    typeof opts["brand-mark"] === "string" && opts["brand-mark"].trim()
      ? opts["brand-mark"].trim().slice(0, 2)
      : slug[0].toUpperCase();
  const singleMode = Boolean(opts["single-mode"]);

  copyStarterRecursive(starterDir, targetDir, true);

  // Explicitly write .gitignore from non-dotfile starter/gitignore (preserved by npm pack)
  const starterGitignoreSrc = path.join(starterDir, "gitignore");
  const gitignoreContent = fs.existsSync(starterGitignoreSrc)
    ? fs.readFileSync(starterGitignoreSrc, "utf8")
    : DEFAULT_STARTER_GITIGNORE;
  fs.writeFileSync(path.join(targetDir, ".gitignore"), gitignoreContent, "utf8");

  // Copy D1 schema migration from base package into target/migrations/ for turnkey Cloudflare D1 setup
  const baseMigration = path.join(PACKAGE_ROOT, "migrations", "0001_init.sql");
  if (fs.existsSync(baseMigration)) {
    const destMigDir = path.join(targetDir, "migrations");
    fs.mkdirSync(destMigDir, { recursive: true });
    fs.copyFileSync(baseMigration, path.join(destMigDir, "0001_init.sql"));
  }

  // Patch starter/package.json
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.name = `${slug}-notes`;
    pkg.description = `${title} — built on notes-site-base`;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }

  // Patch starter/site.config.json
  const cfgPath = path.join(targetDir, "site.config.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.site = {
      ...(cfg.site || {}),
      title,
      shortTitle: title,
      brandMark,
      exportPrefix: title,
    };
    cfg.storage = {
      ...(cfg.storage || {}),
      prefix: `${slug}:v1`,
      themeKey: `${slug}-color-scheme`,
      syncHashPrefix: `${slug}-sync-v1:`,
    };
    if (singleMode) {
      cfg.features = {
        ...(cfg.features || {}),
        dualReadingStyle: false,
      };
    }
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }

  // Patch starter/data/sitemap.json
  const sitemapPath = path.join(targetDir, "data", "sitemap.json");
  if (fs.existsSync(sitemapPath)) {
    const sm = JSON.parse(fs.readFileSync(sitemapPath, "utf8"));
    if (sm.site && typeof sm.site === "object") {
      sm.site.title = title;
    }
    fs.writeFileSync(sitemapPath, `${JSON.stringify(sm, null, 2)}\n`, "utf8");
  }

  // Patch starter/src/worker.mjs
  const workerPath = path.join(targetDir, "src", "worker.mjs");
  if (fs.existsSync(workerPath)) {
    const src = fs
      .readFileSync(workerPath, "utf8")
      .replace(/course-demo-sync-v1:/g, `${slug}-sync-v1:`);
    fs.writeFileSync(workerPath, src, "utf8");
  }

  // Patch starter/cloudflare.config.ts
  const cfCfgPath = path.join(targetDir, "cloudflare.config.ts");
  if (fs.existsSync(cfCfgPath)) {
    const src = fs
      .readFileSync(cfCfgPath, "utf8")
      .replace(/course-demo-notes/g, `${slug}-notes`)
      .replace(/course-demo-sync/g, `${slug}-sync`);
    fs.writeFileSync(cfCfgPath, src, "utf8");
  }

  if (singleMode) {
    fs.rmSync(path.join(targetDir, "content-explained"), { recursive: true, force: true });
  }

  console.log(
    `[notes-site] Scaffolded ${singleMode ? "single-mode" : "dual-mode"} course site "${title}" (${slug}) at ${targetDir}`
  );
  console.log(`Next steps:\n  cd ${path.relative(process.cwd(), targetDir) || "."}\n  npm install\n  npm run check`);
}

async function main() {
  const { positionals, opts } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (opts.version) {
    console.log(readPkgVersion());
    return;
  }
  if (!cmd || opts.help) {
    printHelp();
    return;
  }

  const rootOpts = {
    ...opts,
    root: opts.root ? path.resolve(opts.root) : process.cwd(),
  };

  if (cmd === "build") {
    await runBuild(rootOpts);
    return;
  }

  if (cmd === "verify") {
    const res = runVerify(rootOpts);
    if (!res.ok) process.exit(1);
    return;
  }

  if (cmd === "check") {
    await runBuild(rootOpts);
    const res = runVerify(rootOpts);
    if (!res.ok) process.exit(1);
    return;
  }

  if (cmd === "prepare-deploy") {
    const mod = await import("../src/worker/prepare-deploy.mjs");
    if (typeof mod.prepareDeploy !== "function") {
      throw new Error("notes-site-base/src/worker/prepare-deploy.mjs must export prepareDeploy()");
    }
    await mod.prepareDeploy({ rootDir: rootOpts.root });
    return;
  }

  if (cmd === "init") {
    runInit(positionals[1], opts);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run "notes-site --help" for usage.`);
}

main().catch((err) => {
  console.error(`[notes-site ERROR] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
