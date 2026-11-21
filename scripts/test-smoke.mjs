import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { DEFAULT_CONFIG, loadSiteConfig, normalizeConfig } from "../src/config.mjs";
import { buildConceptMatcher, injectConcepts } from "./inject-concepts.mjs";
import { runBuild } from "./build.mjs";
import { runVerify } from "./verify-build.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const STARTER_DIR = path.join(PACKAGE_ROOT, "starter");
const CLI_PATH = path.join(PACKAGE_ROOT, "bin", "notes-site.mjs");

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testConfigAndConcepts() {
  const def = normalizeConfig({});
  assert.equal(def.site.brandMark, DEFAULT_CONFIG.site.brandMark);
  assert.equal(def.storage.prefix, "notes:v1");
  assert.equal(def.storage.themeKey, "notes-color-scheme");
  assert.equal(def.storage.syncHashPrefix, "notes-sync-v1:");
  assert.equal(def.features.dualReadingStyle, true);
  assert.deepEqual(def.concepts.nonNegatedTerms, []);
  assert.deepEqual(def.concepts.inertCompoundBlockers, []);

  // Verify inject-concepts has zero hardcoded discipline terms by default,
  // and cleanly honors injected config.concepts guards.
  const concepts = [
    { id: "linear-map", term: "线性变换", aliases: ["线性映射"], targetPage: "p02" },
    { id: "elem", term: "零元", targetPage: "p03" },
  ];
  const matcher = buildConceptMatcher(concepts, {
    nonNegatedTerms: ["线性变换"],
    inertCompoundBlockers: ["非线性变换"],
    suffixGuards: [{ endsWith: "元", afterNot: "素" }],
  });

  const blocked = injectConcepts("<article><p>这是一个非线性变换，含零元素。</p></article>", {
    currentPageSlug: "p01",
    matcher,
  });
  assert.equal(blocked.linkCount, 0, `Expected 0 links, got: ${blocked.html}`);

  const positive = injectConcepts(
    "<article><p>除非线性变换满足条件，否则不存在零元。</p></article>",
    { currentPageSlug: "p01", matcher }
  );
  assert.deepEqual(positive.linkedConceptIds, ["linear-map", "elem"]);
  console.log("[smoke] 1/6 config & configurable inject-concepts PASS");
}

async function testDualModeStarter() {
  const tmpOut = makeTmpDir("notes-site-dual-out-");
  try {
    const buildRes = await runBuild({
      root: STARTER_DIR,
      "out-dir": tmpOut,
    });
    assert.equal(buildRes.dualReadingStyle, true);
    assert.equal(buildRes.pagesBuilt, 2);
    assert.equal(buildRes.conceptsCompiled, 3);

    const verifyRes = runVerify({
      root: STARTER_DIR,
      "out-dir": tmpOut,
    });
    assert.equal(verifyRes.ok, true, `Dual-mode verify failed: ${JSON.stringify(verifyRes.errors)}`);
    assert.equal(verifyRes.warnings.length, 0, `Unexpected warnings: ${JSON.stringify(verifyRes.warnings)}`);

    // Check cross-page concept linking & negated-compound protection in rendered SSR page
    const p1Html = fs.readFileSync(path.join(tmpOut, "pages", "p01-derivative-intuition.html"), "utf8");
    const $p1 = cheerio.load(p1Html);
    assert.equal($p1('a.concept-ref[data-concept="linear-map"]').length, 1);
    assert.ok(p1Html.includes("非线性变换"), "Negated compound should remain intact plain text");
    assert.ok(!p1Html.includes('非<a'), "Must not split 非线性变换 into 非 + <a>");
    assert.equal($p1("body").attr("data-storage-prefix"), "course-demo:v1");
    assert.equal($p1("body").attr("data-dual-mode"), "true");

    const p2Html = fs.readFileSync(path.join(tmpOut, "pages", "p02-linear-transformation.html"), "utf8");
    const $p2 = cheerio.load(p2Html);
    assert.equal($p2("details.solution-box").length, 1);
    assert.equal($p2('a.concept-ref[data-concept="derivative"]').length, 1);
    assert.equal($p2('a.concept-ref[data-concept="continuity"]').length, 1);

    console.log("[smoke] 2/6 starter dual-mode build + verify PASS");
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}

async function testSingleModeInitAndCli() {
  const tmpWork = makeTmpDir("notes-site-single-");
  const targetDir = path.join(tmpWork, "single-course");
  try {
    execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "init",
        targetDir,
        "--title",
        "单模式物理讲义",
        "--slug",
        "physics-demo",
        "--single-mode",
      ],
      { stdio: "pipe" }
    );

    assert.ok(!fs.existsSync(path.join(targetDir, "content-explained")), "Single-mode init should omit content-explained/");
    const cfg = loadSiteConfig(targetDir);
    assert.equal(cfg.site.title, "单模式物理讲义");
    assert.equal(cfg.storage.prefix, "physics-demo:v1");
    assert.equal(cfg.storage.themeKey, "physics-demo-color-scheme");
    assert.equal(cfg.storage.syncHashPrefix, "physics-demo-sync-v1:");
    assert.equal(cfg.features.dualReadingStyle, false);

    // Verify .gitignore is written cleanly (from non-dotfile starter/gitignore) and covers secrets/build outputs
    const gitignorePath = path.join(targetDir, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath), "init must create target/.gitignore");
    assert.ok(!fs.existsSync(path.join(targetDir, "gitignore")), "init must not leave unrenamed starter/gitignore");
    const gitignoreText = fs.readFileSync(gitignorePath, "utf8");
    for (const pat of ["node_modules/", "dist/", ".cloudflare/", ".wrangler/", ".env", ".env.*", ".dev.vars"]) {
      assert.ok(gitignoreText.includes(pat), `scaffolded .gitignore missing "${pat}"`);
    }

    // Run `notes-site check --root <targetDir>` and `notes-site prepare-deploy --root <targetDir>` end-to-end via CLI
    assert.ok(fs.existsSync(path.join(targetDir, "migrations", "0001_init.sql")), "init should copy migrations/0001_init.sql");
    execFileSync(process.execPath, [CLI_PATH, "check", "--root", targetDir], { stdio: "pipe" });
    execFileSync(process.execPath, [CLI_PATH, "prepare-deploy", "--root", targetDir], { stdio: "pipe" });
    assert.ok(
      fs.existsSync(path.join(targetDir, ".cloudflare", "output", "v1", "config.json")),
      "prepare-deploy via CLI must emit .cloudflare/output/v1/config.json"
    );

    const distDir = path.join(targetDir, "dist");
    assert.ok(!fs.existsSync(path.join(distDir, "assets", "views")), "Single-mode must not emit assets/views/");

    const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    const $idx = cheerio.load(indexHtml);
    assert.equal($idx("body").attr("data-dual-mode"), "false");
    assert.equal($idx("body").attr("data-storage-prefix"), "physics-demo:v1");
    assert.equal($idx("[data-reading-style-btn]").length, 0);
    assert.equal($idx("[data-font-theme-btn]").length, 3);
    assert.ok(!$idx("head script").text().includes("readingStylePending"));

    const pageHtml = fs.readFileSync(
      path.join(distDir, "pages", "p01-derivative-intuition.html"),
      "utf8"
    );
    const $pg = cheerio.load(pageHtml);
    assert.equal($pg("body").attr("data-dual-mode"), "false");
    assert.equal($pg("body").attr("data-axiomatic-url"), undefined);
    assert.equal($pg("[data-reading-style-btn]").length, 0);
    assert.equal($pg("[data-font-theme-btn]").length, 3);

    console.log("[smoke] 3/6 CLI init (--single-mode) + single-mode check PASS");
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
}

async function testExtraStylesAndForbidEmDash() {
  const tmpWork = makeTmpDir("notes-site-extra-");
  const targetDir = path.join(tmpWork, "custom-course");
  try {
    execFileSync(
      process.execPath,
      [CLI_PATH, "init", targetDir, "--title", "主题覆盖测试", "--slug", "theme-test"],
      { stdio: "pipe" }
    );

    // Enable styles/custom.css explicitly
    const cfgPath = path.join(targetDir, "site.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.extraStyles = ["styles/custom.css"];
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(targetDir, "styles", "custom.css"),
      ":root { --accent-brand-light: #2b6cb0; }\n",
      "utf8"
    );

    const buildRes = await runBuild({ root: targetDir });
    assert.equal(buildRes.extraStyleRels.length, 1);
    assert.match(buildRes.extraStyleRels[0], /^assets\/custom\.[0-9a-f]{8}\.css$/);

    const verifyOk = runVerify({ root: targetDir });
    assert.equal(verifyOk.ok, true, `extraStyles verify failed: ${JSON.stringify(verifyOk.errors)}`);

    const indexHtml = fs.readFileSync(path.join(targetDir, "dist", "index.html"), "utf8");
    const $idx = cheerio.load(indexHtml);
    const cssHrefs = $idx('link[rel="stylesheet"]')
      .map((_, el) => $idx(el).attr("href") || "")
      .get();
    const mobileIdx = cssHrefs.findIndex((h) => /04-mobile\.[0-9a-f]{8}\.css$/.test(h));
    const customIdx = cssHrefs.findIndex((h) => /custom\.[0-9a-f]{8}\.css$/.test(h));
    assert.ok(mobileIdx !== -1 && customIdx > mobileIdx, "extraStyles must load after 04-mobile.<hash>.css");
    console.log("[smoke] 4/6 paths.extraStyles fingerprinting & cascade order PASS");

    // Negative test: forbidEmDash=true catches prose "——", forbidEmDash=false allows it
    const p1ExpPath = path.join(targetDir, "content-explained", "part1", "p01-derivative-intuition.md");
    fs.appendFileSync(p1ExpPath, "\n\n这是一句测试——带有破折号。\n", "utf8");
    await runBuild({ root: targetDir });
    const verifyFail = runVerify({ root: targetDir });
    assert.equal(verifyFail.ok, false, "Expected forbidEmDash=true to fail on prose em-dash");
    assert.ok(verifyFail.errors.some((e) => e.includes('forbidden em-dash "——"')));

    cfg.features.styleAudit.forbidEmDash = false;
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    const verifyAllowed = runVerify({ root: targetDir });
    assert.equal(verifyAllowed.ok, true, "Expected forbidEmDash=false to allow em-dash");
    console.log("[smoke] 5/6 styleAudit.forbidEmDash gate (true/false) PASS");
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
}

async function testNpmPackContents() {
  const rawJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(rawJson);
  const files = new Set((parsed[0]?.files || []).map((f) => f.path));
  assert.ok(files.has("starter/gitignore"), "npm pack must include starter/gitignore");
  assert.ok(!files.has("starter/.gitignore"), "starter/.gitignore must not exist");
  assert.ok(files.has("migrations/0001_init.sql"), "npm pack must include migrations/0001_init.sql");
  assert.ok(files.has("bin/notes-site.mjs"), "npm pack must include bin/notes-site.mjs");
  assert.ok(!files.has("scripts/test-smoke.mjs"), "npm pack must exclude internal scripts/test-smoke.mjs");
  assert.ok(!files.has("src/worker/test-worker.mjs"), "npm pack must exclude internal src/worker/test-worker.mjs");
  console.log(`[smoke] 6/6 npm pack tarball manifest (${files.size} files, starter/gitignore preserved, tests excluded) PASS`);
}

await testConfigAndConcepts();
await testDualModeStarter();
await testSingleModeInitAndCli();
await testExtraStylesAndForbidEmDash();
await testNpmPackContents();
console.log("\n[smoke] ALL 6 SMOKE TEST SUITES PASSED!");
