import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const GITHUB_API = "https://api.github.com";
const TOKEN = requireEnv("GITHUB_TOKEN");
const USERNAME = process.env.GITHUB_USERNAME ?? "EmileDevGit";
const DRY_RUN = process.env.DRY_RUN === "true";
const ACTIVE_MONTHS = 6;
const TOOLS_PINNED = ["git", "github", "gitlab"];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function readJSON(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

function readFile(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function writeFile(relPath, content) {
  writeFileSync(path.join(REPO_ROOT, relPath), content);
}

async function gh(apiPath) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "EmileDevGit-skills-bot",
    },
  });
  return res;
}

async function ghJSON(apiPath) {
  const res = await gh(apiPath);
  if (!res.ok) throw new Error(`${apiPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function getContentsFile(owner, repo, filePath) {
  const res = await gh(`/repos/${owner}/${repo}/contents/${filePath}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`contents/${filePath} on ${repo} -> ${res.status} ${await res.text()}`);
  const json = await res.json();
  return Buffer.from(json.content, "base64").toString("utf8");
}

async function fileExists(owner, repo, filePath) {
  const res = await gh(`/repos/${owner}/${repo}/contents/${filePath}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`contents/${filePath} on ${repo} -> ${res.status} ${await res.text()}`);
  return true;
}

async function fetchActiveRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await ghJSON(`/users/${USERNAME}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ACTIVE_MONTHS);
  return repos.filter(
    (r) => !r.archived && !r.fork && new Date(r.pushed_at).getTime() >= cutoff.getTime()
  );
}

function parsePackageJsonDeps(content) {
  try {
    const json = JSON.parse(content);
    return new Set(
      Object.keys({ ...json.dependencies, ...json.devDependencies }).map((d) => d.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

function parseRequirementsTxt(content) {
  const deps = new Set();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const name = trimmed.split(/[=<>!~\[; ]/)[0].trim().toLowerCase();
    if (name) deps.add(name);
  }
  return deps;
}

function parsePyprojectToml(content) {
  const deps = new Set();
  const re = /["']([a-zA-Z0-9_.\-]+)["']\s*(?:=|>=|==)/g;
  for (const match of content.matchAll(re)) {
    deps.add(match[1].toLowerCase());
  }
  return deps;
}

async function fetchRepoSignals(repo) {
  const owner = USERNAME;
  const name = repo.name;

  const languages = await ghJSON(`/repos/${owner}/${name}/languages`);

  const deps = new Set();
  const packageJson = await getContentsFile(owner, name, "package.json");
  if (packageJson) for (const d of parsePackageJsonDeps(packageJson)) deps.add(d);

  const requirementsTxt = await getContentsFile(owner, name, "requirements.txt");
  if (requirementsTxt) for (const d of parseRequirementsTxt(requirementsTxt)) deps.add(d);

  const pyprojectToml = await getContentsFile(owner, name, "pyproject.toml");
  if (pyprojectToml) for (const d of parsePyprojectToml(pyprojectToml)) deps.add(d);

  let gradleExists = await fileExists(owner, name, "build.gradle");
  if (!gradleExists) gradleExists = await fileExists(owner, name, "build.gradle.kts");

  const androidExists = await fileExists(owner, name, "app/src/main/AndroidManifest.xml");

  return { languages, deps, gradleExists, androidExists };
}

async function mapBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

function aggregateLanguages(perRepo, languageMap) {
  const signal = new Map();
  for (const { languages } of perRepo) {
    for (const [lang, bytes] of Object.entries(languages)) {
      if (lang === "Dockerfile") continue; // routed to tools signal only
      const slug = languageMap[lang];
      if (!slug) {
        console.warn(`[skip] no slug mapping for language "${lang}"`);
        continue;
      }
      signal.set(slug, (signal.get(slug) ?? 0) + bytes);
    }
  }
  return signal;
}

function aggregateFrameworks(perRepo, frameworkMap) {
  const signal = new Map();
  for (const { deps } of perRepo) {
    const slugsInThisRepo = new Set();
    for (const [depName, slug] of Object.entries(frameworkMap)) {
      if (deps.has(depName.toLowerCase())) slugsInThisRepo.add(slug);
    }
    for (const slug of slugsInThisRepo) {
      signal.set(slug, (signal.get(slug) ?? 0) + 1);
    }
  }
  return signal;
}

function aggregateTools(perRepo, toolsMap) {
  const signal = new Map();
  for (const entry of toolsMap) {
    let total = 0;
    if (entry.source === "language-bytes") {
      for (const { languages } of perRepo) total += languages[entry.key] ?? 0;
    } else if (entry.source === "dependency") {
      const names = entry.names.map((n) => n.toLowerCase());
      for (const { deps } of perRepo) {
        if (names.some((n) => deps.has(n))) total += 1;
      }
    } else if (entry.source === "file-exists") {
      for (const repoSignals of perRepo) {
        if (entry.slug === "gradle" && repoSignals.gradleExists) total += 1;
        if (entry.slug === "androidstudio" && repoSignals.androidExists) total += 1;
      }
    }
    if (total > 0) signal.set(entry.slug, total);
  }
  return signal;
}

function mergeRanked(prevRanked, currentSignalMap, pinnedPrefix) {
  const prevSlugs = new Set(prevRanked.map((e) => e.slug));

  const updated = prevRanked.map((e) => ({
    slug: e.slug,
    signal: currentSignalMap.has(e.slug) ? currentSignalMap.get(e.slug) : 0,
  }));

  for (const [slug, signal] of currentSignalMap) {
    if (!prevSlugs.has(slug)) updated.push({ slug, signal });
  }

  const nonzero = updated
    .filter((e) => e.signal > 0)
    .sort((a, b) => b.signal - a.signal || a.slug.localeCompare(b.slug));
  const zero = updated.filter((e) => e.signal === 0);

  const newRanked = [...nonzero, ...zero];
  const newState = newRanked.map((e) => ({ slug: e.slug, lastSignal: e.signal }));
  const finalSlugs = [...pinnedPrefix, ...newRanked.map((e) => e.slug)];

  return { finalSlugs, newState };
}

function replaceMarkerBlock(content, markerName, slugs) {
  const re = new RegExp(
    `(<!-- SKILLS:${markerName}:START -->\\n!\\[([^\\]]*)\\]\\(https://skillicons\\.dev/icons\\?i=)[^)]*(\\)\\n<!-- SKILLS:${markerName}:END -->)`
  );
  return content.replace(re, (_match, prefix, _alt, suffix) => `${prefix}${slugs.join(",")}${suffix}`);
}

async function main() {
  const state = readJSON(".github/scripts/skills-state.json");
  const languageMap = readJSON(".github/scripts/language-icon-map.json");
  const frameworkMap = readJSON(".github/scripts/framework-icon-map.json");
  const toolsMap = readJSON(".github/scripts/tools-icon-map.json");

  console.log(`Fetching repos for ${USERNAME}...`);
  const activeRepos = await fetchActiveRepos();
  console.log(`Found ${activeRepos.length} active repos: ${activeRepos.map((r) => r.name).join(", ")}`);

  const perRepo = await mapBatches(activeRepos, 4, fetchRepoSignals);

  const languageSignal = aggregateLanguages(perRepo, languageMap);
  const frameworkSignal = aggregateFrameworks(perRepo, frameworkMap);
  const toolsSignal = aggregateTools(perRepo, toolsMap);

  const lang = mergeRanked(state.languages.ranked, languageSignal, []);
  const fw = mergeRanked(state.frameworks.ranked, frameworkSignal, []);
  const tools = mergeRanked(state.tools.ranked, toolsSignal, TOOLS_PINNED);

  console.log("Languages:", lang.finalSlugs.join(","));
  console.log("Frameworks:", fw.finalSlugs.join(","));
  console.log("Tools:", tools.finalSlugs.join(","));

  let anyChanged = false;
  for (const file of ["README.md", "README.en.md"]) {
    const original = readFile(file);
    let updated = original;
    updated = replaceMarkerBlock(updated, "LANGUAGES", lang.finalSlugs);
    updated = replaceMarkerBlock(updated, "FRAMEWORKS", fw.finalSlugs);
    updated = replaceMarkerBlock(updated, "TOOLS", tools.finalSlugs);
    if (updated !== original) {
      anyChanged = true;
      console.log(`[${file}] content changed`);
      if (!DRY_RUN) writeFile(file, updated);
    } else {
      console.log(`[${file}] no change`);
    }
  }

  const newState = {
    languages: { pinned: [], ranked: lang.newState },
    frameworks: { pinned: [], ranked: fw.newState },
    tools: { pinned: TOOLS_PINNED, ranked: tools.newState },
    lastRunAt: new Date().toISOString(),
  };

  if (DRY_RUN) {
    console.log("[dry-run] would write state:", JSON.stringify(newState, null, 2));
  } else {
    writeFile(".github/scripts/skills-state.json", JSON.stringify(newState, null, 2) + "\n");
  }

  if (!anyChanged) console.log("No README changes this run.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
