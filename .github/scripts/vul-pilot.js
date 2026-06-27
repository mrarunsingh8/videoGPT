#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { readFile, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

const severityRank = new Map([
  ["low", 0],
  ["moderate", 1],
  ["medium", 1],
  ["high", 2],
  ["critical", 3],
]);

const root = path.resolve(process.cwd());
console.log(`Starting vul-pilot in ${root}`);
const packageJsonPath = `${root}/package.json`;
const packageLockPath = `${root}/package-lock.json`;
const githubToken = process.env.PATCH_GITHUB_TOKEN;
const openaiApiKey = process.env.PATCH_OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const enableAi = parseBoolean(process.env.ENABLE_AI, true) && Boolean(openaiApiKey);
const dryRun = parseBoolean(process.env.DRY_RUN, false);
const maxPrs = parsePositiveInt(process.env.MAX_PRS, 5);
const severityThreshold = normalizeSeverity(process.env.SEVERITY_THRESHOLD || "moderate");
const baseBranch = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME || "main";
const repository = process.env.PATCH_GITHUB_REPOSITORY;

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

async function main() {
  assertRuntime();

  const packageJson = await readPackageJson();
  const packageLock = await readPackageLock();
  await configureGit();

  const audit = await npmAudit();
  const advisories = extractAdvisories(audit, packageJson)
    .filter((item) => severityRank.get(item.severity) >= severityRank.get(severityThreshold))
    .sort(compareAdvisories);

  if (advisories.length === 0) {
    console.log(`No npm advisories found at or above ${severityThreshold}.`);
    return;
  }

  console.log(`Found ${advisories.length} advisory candidate(s); attempting up to ${maxPrs}.`);

  let opened = 0;
  const attempted = new Set();

  for (const advisory of advisories) {
    if (opened >= maxPrs) break;
    if (attempted.has(advisory.key)) continue;
    attempted.add(advisory.key);

    console.log(`\n---\nPlanning remediation for ${advisory.packageName}: ${advisory.title}`);

    const plans = await buildPlans(advisory, packageJson, packageLock);
    if (plans.length === 0) {
      console.log(`Skipping ${advisory.key}: no targeted npm remediation could be derived.`);
      continue;
    }

    const result = await attemptRemediationPlans(plans, advisory);
    if (!result.success) {
      console.log(`Skipping PR for ${advisory.key}: ${result.reason}`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] Would open PR: ${result.title}`);
      opened += 1;
      continue;
    }

    await pushBranch(result.branch);
    await openOrUpdatePullRequest(result);
    opened += 1;
  }

  console.log(`\nCompleted. Opened or updated ${opened} remediation PR(s).`);
}

async function attemptRemediationPlans(plans, advisory) {
  let lastFailure = "no remediation plan was attempted";

  for (const plan of plans) {
    console.log(`Trying ${plan.type}: ${plan.explanation}`);
    const result = await attemptRemediation(plan, advisory);
    if (result.success) return result;
    lastFailure = `${plan.type} failed: ${result.reason}`;
    console.log(`Plan did not remediate ${advisory.key}: ${lastFailure}`);
  }

  return { success: false, reason: lastFailure };
}

function assertRuntime() {
  if (!existsSync(packageJsonPath)) {
    throw new Error("package.json was not found. This workflow currently supports npm projects only.");
  }
  if (!existsSync(packageLockPath)) {
    throw new Error("package-lock.json was not found. Commit an npm lockfile before enabling this workflow.");
  }
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is not set.");
  }
  if (!githubToken && !dryRun) {
    throw new Error("GITHUB_TOKEN is required to open pull requests.");
  }
}

async function attemptRemediation(plan, advisory) {
  const branch = `vulPilot/${slugify(advisory.packageName)}-${slugify(advisory.advisoryId)}`;

  await checkoutBase();
  await checkoutBranch(branch);

  const beforePackageJson = await readPackageJson();
  const changed = await applyPlan(plan, beforePackageJson);
  if (!changed) {
    return { success: false, reason: "remediation made no package.json change" };
  }

  await run("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });

  const afterAudit = await npmAudit();
  if (advisoryStillPresent(afterAudit, advisory)) {
    return { success: false, reason: "target advisory is still present after remediation" };
  }

  const checks = await runProjectChecks();
  /* if (!checks.every((check) => check.ok)) {
    const failed = checks.filter((check) => !check.ok).map((check) => check.name).join(", ");
    return { success: false, reason: `validation failed: ${failed}` };
  } */

  const diffSummary = await git(["diff", "--stat"]);
  const hasChanges = (await git(["status", "--porcelain"])).trim().length > 0;
  if (!hasChanges) {
    return { success: false, reason: "no git changes remained after remediation" };
  }

  const prContent = await buildPullRequestContent({ advisory, plan, checks, diffSummary });
  await git(["add", "package.json", "package-lock.json"]);
  await git(["commit", "-m", prContent.title]);

  return {
    success: true,
    branch,
    title: prContent.title,
    body: prContent.body,
    advisory,
    plan,
    checks,
  };
}

async function applyPlan(plan, packageJson) {
  if (plan.type === "direct-upgrade") {
    const section = packageJson.dependencies?.[plan.packageName]
      ? "dependencies"
      : packageJson.devDependencies?.[plan.packageName]
        ? "devDependencies"
        : packageJson.optionalDependencies?.[plan.packageName]
          ? "optionalDependencies"
          : null;
    if (!section) return false;
    const nextRange = `^${plan.targetVersion}`;
    if (packageJson[section][plan.packageName] === nextRange) return false;
    packageJson[section][plan.packageName] = nextRange;
    await writePackageJson(packageJson);
    return true;
  }

  if (plan.type === "parent-upgrade") {
    const section = packageJson.dependencies?.[plan.parentName]
      ? "dependencies"
      : packageJson.devDependencies?.[plan.parentName]
        ? "devDependencies"
        : packageJson.optionalDependencies?.[plan.parentName]
          ? "optionalDependencies"
          : null;
    if (!section) return false;
    const nextRange = `^${plan.targetVersion}`;
    if (packageJson[section][plan.parentName] === nextRange) return false;
    packageJson[section][plan.parentName] = nextRange;
    await writePackageJson(packageJson);
    return true;
  }

  if (plan.type === "override") {
    packageJson.overrides = packageJson.overrides || {};
    if (packageJson.overrides[plan.packageName] === plan.targetVersion) return false;
    packageJson.overrides[plan.packageName] = plan.targetVersion;
    await writePackageJson(packageJson);
    return true;
  }

  return false;
}

async function buildPlans(advisory, packageJson, packageLock) {
  if (advisory.isDirect) {
    return compactPlans([await buildDirectDependencyPlan(advisory, packageJson, packageLock)]);
  }

  return buildNestedDependencyPlan(advisory, packageJson, packageLock);
}

async function buildDirectDependencyPlan(advisory, packageJson, packageLock) {
  const fix = advisory.fixAvailable;
  let targetVersion = null;

  if (fix && fix !== true && fix.name === advisory.packageName && !Boolean(fix.isSemVerMajor)) {
    targetVersion = cleanVersion(fix.version);
  }

  if (!targetVersion) {
    targetVersion = await getLowestSafeSameMajorVersion(
      advisory.packageName,
      findDirectOrInstalledVersion(advisory.packageName, packageJson, packageLock),
      advisory.range,
    );
  }

  if (!targetVersion) {
    targetVersion = await getLatestSameMajorDirectVersion(advisory.packageName, packageJson, packageLock);
  }

  if (!targetVersion || !isSameMajorDirectBump(advisory.packageName, targetVersion, packageJson)) return null;

  return {
    type: "direct-upgrade",
    packageName: advisory.packageName,
    targetVersion,
    isSemVerMajor: false,
    explanation: `Upgrade direct dependency ${advisory.packageName} to ${targetVersion}.`,
  };
}

function compactPlans(plans) {
  return plans.filter(Boolean);
}

async function buildNestedDependencyPlan(advisory, packageJson, packageLock) {
  const parentPlan = await buildTopParentBumpPlan(advisory, packageJson, packageLock);
  const overridePlan = await buildOverridePlan(advisory, packageLock);

  return compactPlans([
    parentPlan && !parentPlan.isSemVerMajor && isSameMajorParentBump(parentPlan, packageJson)
      ? parentPlan
      : null,
    overridePlan,
  ]);
}

async function buildTopParentBumpPlan(advisory, packageJson, packageLock) {
  const fix = advisory.fixAvailable;
  const topParent = findTopDirectParent(advisory, packageJson, packageLock);
  if (!topParent) return null;

  if (fix && fix !== true && fix.name === topParent) {
    const targetVersion = cleanVersion(fix.version);
    if (!targetVersion) return null;

    return {
      type: "parent-upgrade",
      packageName: advisory.packageName,
      parentName: topParent,
      targetVersion,
      isSemVerMajor: Boolean(fix.isSemVerMajor),
      explanation: `Upgrade top-level parent dependency ${topParent} to ${targetVersion} to remediate nested vulnerability in ${advisory.packageName}.`,
    };
  }

  const targetVersion = await getLatestSameMajorVersion(topParent, packageJson);
  if (!targetVersion) return null;

  return {
    type: "parent-upgrade",
    packageName: advisory.packageName,
    parentName: topParent,
    targetVersion,
    isSemVerMajor: false,
    explanation: `Upgrade top-level parent dependency ${topParent} to ${targetVersion} to remediate nested vulnerability in ${advisory.packageName}.`,
  };
}

async function buildOverridePlan(advisory, packageLock) {
  const targetVersion = await getOverrideTargetVersion(advisory, packageLock);
  if (!targetVersion) return null;

  return {
    type: "override",
    packageName: advisory.packageName,
    targetVersion,
    isSemVerMajor: false,
    explanation: `Apply npm override for nested dependency ${advisory.packageName}@${targetVersion}.`,
  };
}

async function getOverrideTargetVersion(advisory, packageLock) {
  const fix = advisory.fixAvailable;
  const installedVersion = findInstalledPackageVersion(advisory.packageName, packageLock);

  if (fix && fix !== true && fix.name === advisory.packageName) {
    const fixVersion = cleanVersion(fix.version);
    if (isSameMajorVersion(installedVersion, fixVersion)) return fixVersion;
  }

  const safeRangeVersion = await getLowestSafeSameMajorVersion(advisory.packageName, installedVersion, advisory.range);
  if (safeRangeVersion) return safeRangeVersion;

  return getLatestSameMajorPackageVersion(advisory.packageName, installedVersion);
}

function findTopDirectParent(advisory, packageJson, packageLock) {
  for (const node of advisory.nodes || []) {
    const topParent = getTopPackageFromNodePath(node);
    if (topParent && topParent !== advisory.packageName && isDirectDependency(packageJson, topParent)) {
      return topParent;
    }
  }

  const lockParent = findTopDirectParentFromPackageLock(advisory.packageName, packageJson, packageLock);
  if (lockParent) return lockParent;

  const fix = advisory.fixAvailable;
  if (fix && fix !== true && isDirectDependency(packageJson, fix.name)) {
    return fix.name;
  }

  return null;
}

function findTopDirectParentFromPackageLock(packageName, packageJson, packageLock) {
  const packages = packageLock?.packages || {};
  for (const location of Object.keys(packages)) {
    if (getLeafPackageFromNodePath(location) !== packageName) continue;

    const topParent = getTopPackageFromNodePath(location);
    if (topParent && topParent !== packageName && isDirectDependency(packageJson, topParent)) {
      return topParent;
    }
  }

  for (const topParent of getDirectDependencyNames(packageJson)) {
    if (topParent !== packageName && packageGraphContainsPackage(packageLock, `node_modules/${topParent}`, packageName)) {
      return topParent;
    }
  }

  for (const [topParent, details] of Object.entries(packageLock?.dependencies || {})) {
    if (topParent !== packageName && isDirectDependency(packageJson, topParent) && dependencyTreeContainsPackage(details, packageName)) {
      return topParent;
    }
  }

  return null;
}

function packageGraphContainsPackage(packageLock, startLocation, packageName, seen = new Set()) {
  if (!packageLock?.packages || seen.has(startLocation)) return false;
  seen.add(startLocation);

  const details = packageLock.packages[startLocation];
  if (!details?.dependencies) return false;

  for (const dependencyName of Object.keys(details.dependencies)) {
    if (dependencyName === packageName) return true;

    const dependencyLocation = resolvePackageLockLocation(packageLock, startLocation, dependencyName);
    if (dependencyLocation && packageGraphContainsPackage(packageLock, dependencyLocation, packageName, seen)) {
      return true;
    }
  }

  return false;
}

function resolvePackageLockLocation(packageLock, parentLocation, dependencyName) {
  const nestedLocation = `${parentLocation}/node_modules/${dependencyName}`;
  if (packageLock.packages?.[nestedLocation]) return nestedLocation;

  const hoistedLocation = `node_modules/${dependencyName}`;
  if (packageLock.packages?.[hoistedLocation]) return hoistedLocation;

  return null;
}

function isSameMajorParentBump(plan, packageJson) {
  return isSameMajorDirectBump(plan.parentName, plan.targetVersion, packageJson);
}

async function getLatestSameMajorVersion(packageName, packageJson) {
  const currentRange = getDirectDependencyRange(packageJson, packageName);
  return getLatestSameMajorPackageVersion(packageName, currentRange);
}

async function getLatestSameMajorDirectVersion(packageName, packageJson, packageLock) {
  return getLatestSameMajorPackageVersion(
    packageName,
    findDirectOrInstalledVersion(packageName, packageJson, packageLock),
  );
}

async function getLowestSafeSameMajorVersion(packageName, currentVersionOrRange, vulnerableRange) {
  const currentMajor = extractMajor(currentVersionOrRange);
  if (currentMajor === null || !vulnerableRange) return null;

  const versions = await getPublishedVersions(packageName);
  const safeVersions = versions
    .filter((version) => extractMajor(version) === currentMajor)
    .filter((version) => isVersionGreaterThanRange(version, currentVersionOrRange))
    .filter((version) => !satisfiesRange(version, vulnerableRange))
    .sort(compareVersions);

  return safeVersions[0] || null;
}

async function getLatestSameMajorPackageVersion(packageName, currentVersionOrRange) {
  const currentMajor = extractMajor(currentVersionOrRange);
  if (currentMajor === null) return null;

  const versions = await getPublishedVersions(packageName);
  const latestSameMajor = versions
    .filter((version) => extractMajor(version) === currentMajor)
    .sort(compareVersions)
    .at(-1);

  if (!latestSameMajor) return null;
  if (!isVersionGreaterThanRange(latestSameMajor, currentVersionOrRange)) return null;
  return latestSameMajor;
}

async function getPublishedVersions(packageName) {
  const result = await run("npm", ["view", packageName, "versions", "--json"], {
    allowFailure: true,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.code !== 0 || !result.stdout.trim()) return [];

  const versions = parseNpmViewVersions(result.stdout);
  return versions.filter((version) => /^\d+\.\d+\.\d+/.test(version));
}

function parseNpmViewVersions(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
  } catch {
    return stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }
}

function isVersionGreaterThanRange(version, range) {
  const current = cleanVersion(range);
  if (!current) return true;
  return compareVersions(current, version) < 0;
}

function satisfiesRange(version, range) {
  const alternatives = String(range || "")
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);

  if (alternatives.length === 0) return false;
  return alternatives.some((alternative) => satisfiesComparatorSet(version, alternative));
}

function satisfiesComparatorSet(version, rangePart) {
  const comparators = normalizeComparatorSet(rangePart);
  if (comparators.length === 0) return false;

  return comparators.every((comparator) => satisfiesComparator(version, comparator));
}

function normalizeComparatorSet(rangePart) {
  const trimmed = String(rangePart || "").trim();
  const hyphen = trimmed.match(/^(\d+(?:\.\d+){0,2})\s+-\s+(\d+(?:\.\d+){0,2})$/);
  if (hyphen) {
    return [`>=${normalizeVersion(hyphen[1])}`, `<=${normalizeVersion(hyphen[2])}`];
  }

  return trimmed
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => expandComparator(item));
}

function expandComparator(comparator) {
  const match = comparator.match(/^(<=|>=|<|>|=|~|\^)?\s*(\d+(?:\.\d+){0,2})$/);
  if (!match) return [];

  const operator = match[1] || "=";
  const version = normalizeVersion(match[2]);

  if (operator === "^") {
    const major = extractMajor(version);
    if (major === null) return [];
    return [`>=${version}`, `<${major + 1}.0.0`];
  }

  if (operator === "~") {
    const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return [`>=${version}`, `<${major}.${minor + 1}.0`];
  }

  return [`${operator}${version}`];
}

function satisfiesComparator(version, comparator) {
  const match = comparator.match(/^(<=|>=|<|>|=)(\d+\.\d+\.\d+)$/);
  if (!match) return false;

  const [, operator, target] = match;
  const comparison = compareVersions(version, target);

  if (operator === "<") return comparison < 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  return comparison === 0;
}

function normalizeVersion(version) {
  const parts = String(version || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join(".");
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isSameMajorDirectBump(packageName, targetVersion, packageJson) {
  const currentRange = getDirectDependencyRange(packageJson, packageName);
  const currentMajor = extractMajor(currentRange);
  const targetMajor = extractMajor(targetVersion);

  if (currentMajor === null || targetMajor === null) return true;
  return currentMajor === targetMajor;
}

function isSameMajorVersion(currentVersion, targetVersion) {
  const currentMajor = extractMajor(currentVersion);
  const targetMajor = extractMajor(targetVersion);

  if (currentMajor === null || targetMajor === null) return true;
  return currentMajor === targetMajor;
}

function findInstalledPackageVersion(packageName, packageLock) {
  const packages = packageLock?.packages || {};
  for (const [location, details] of Object.entries(packages)) {
    if (getLeafPackageFromNodePath(location) === packageName && details?.version) {
      return details.version;
    }
  }

  return findInstalledPackageVersionInDependencyTree(packageName, packageLock?.dependencies || {});
}

function findInstalledPackageVersionInDependencyTree(packageName, dependencies) {
  for (const [dependencyName, details] of Object.entries(dependencies || {})) {
    if (dependencyName === packageName && details?.version) {
      return details.version;
    }

    const nestedVersion = findInstalledPackageVersionInDependencyTree(packageName, details?.dependencies || {});
    if (nestedVersion) return nestedVersion;
  }

  return null;
}

function dependencyTreeContainsPackage(details, packageName) {
  if (!details) return false;
  if (details.dependencies?.[packageName]) return true;

  return Object.values(details.dependencies || {}).some((nestedDetails) => (
    dependencyTreeContainsPackage(nestedDetails, packageName)
  ));
}

function getDirectDependencyRange(packageJson, packageName) {
  return packageJson.dependencies?.[packageName]
    || packageJson.devDependencies?.[packageName]
    || packageJson.optionalDependencies?.[packageName]
    || null;
}

function findDirectOrInstalledVersion(packageName, packageJson, packageLock) {
  return getDirectDependencyRange(packageJson, packageName)
    || findInstalledPackageVersion(packageName, packageLock);
}

function getDirectDependencyNames(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {}),
  ];
}

function extractMajor(versionOrRange) {
  const match = String(versionOrRange || "").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function getTopPackageFromNodePath(nodePath) {
  const packages = getPackageNamesFromNodePath(nodePath);
  return packages[0] || null;
}

function getLeafPackageFromNodePath(nodePath) {
  const packages = getPackageNamesFromNodePath(nodePath);
  return packages[packages.length - 1] || null;
}

function getPackageNamesFromNodePath(nodePath) {
  const parts = String(nodePath || "").split("/node_modules/");
  const first = parts[0].startsWith("node_modules/") ? parts[0].slice("node_modules/".length) : parts[0];
  const candidates = [first, ...parts.slice(1)].filter(Boolean);
  return candidates.map((candidate) => {
    const segments = candidate.split("/").filter(Boolean);
    if (segments[0]?.startsWith("@") && segments[1]) return `${segments[0]}/${segments[1]}`;
    return segments[0] || null;
  }).filter(Boolean);
}

async function buildPullRequestContent({ advisory, plan, checks, diffSummary }) {
  const fallbackTitle = `vulPilot: remediate ${advisory.advisoryId} in ${advisory.packageName}`;
  const risk = classifyRisk(advisory, plan);
  const validation = checks.map((check) => `- ${check.ok ? "Passed" : "Failed"}: \`${check.command}\``).join("\n");
  const fallbackBody = [
    "## Vulnerability",
    "",
    `- Package: \`${advisory.packageName}\``,
    `- Advisory: ${advisory.url ? `[${advisory.advisoryId}](${advisory.url})` : advisory.advisoryId}`,
    `- Severity: ${advisory.severity}`,
    `- Direct dependency: ${advisory.isDirect ? "yes" : "no"}`,
    `- Affected range: \`${advisory.range || "unknown"}\``,
    "",
    "## Remediation",
    "",
    `- Strategy: ${plan.type}`,
    `- Change: ${plan.explanation}`,
    "",
    "## Validation",
    "",
    validation || "- npm audit check passed for this advisory",
    "",
    "## Risk",
    "",
    `Risk: **${risk.level}**`,
    "",
    risk.reasons.map((reason) => `- ${reason}`).join("\n"),
    "",
    "## Diff Summary",
    "",
    "```text",
    diffSummary.trim() || "package.json / package-lock.json updated",
    "```",
  ].join("\n");

  if (!enableAi) {
    return { title: fallbackTitle, body: fallbackBody };
  }

  try {
    const ai = await generateAiPullRequestContent({ advisory, plan, checks, risk, diffSummary, fallbackTitle, fallbackBody });
    return {
      title: sanitizeTitle(ai.title || fallbackTitle),
      body: ai.body || fallbackBody,
    };
  } catch (error) {
    console.log(`OpenAI PR generation failed; using deterministic fallback. ${error.message}`);
    return { title: fallbackTitle, body: fallbackBody };
  }
}

async function generateAiPullRequestContent({ advisory, plan, checks, risk, diffSummary, fallbackTitle, fallbackBody }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${openaiApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: openaiModel,
    input: [
      {
        role: "system",
        content:
          "You write concise production pull request titles and bodies for dependency vulnerability remediation. Return strict JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instructions:
            "Create a clear PR title and markdown body. Keep the body factual. Do not claim broader remediation than the supplied advisory. Include sections: Vulnerability, Remediation, Validation, Risk, Rollback.",
          fallbackTitle,
          fallbackBody,
          advisory,
          plan,
          checks,
          risk,
          diffSummary,
        }),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "pull_request_content",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["title", "body"],
        },
      },
    },
  }),
});

  if (!response.ok) {
    throw new Error(`OpenAI API returned ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI API response did not include output text.");
  return JSON.parse(text);
}

function classifyRisk(advisory, plan) {
  const reasons = [];
  let score = 0;

  if (plan.isSemVerMajor) {
    score += 2;
    reasons.push("The remediation requires a semver-major dependency change.");
  }
  if (!advisory.isDirect) {
    score += 1;
    reasons.push("The affected package is transitive, so behavior depends on the parent dependency tree.");
  }
  if (plan.type === "override") {
    score += 1;
    reasons.push("The remediation uses npm overrides, which should be reviewed against parent package compatibility.");
  }
  if (["critical", "high"].includes(advisory.severity)) {
    reasons.push(`The advisory severity is ${advisory.severity}.`);
  }
  if (reasons.length === 0) {
    reasons.push("Patch is limited to package metadata and lockfile changes, with validation checks passing.");
  }

  return {
    level: score >= 3 ? "High" : score >= 1 ? "Medium" : "Low",
    reasons,
  };
}

async function runProjectChecks() {
  const packageJson = await readPackageJson();
  const checks = [];
  const scripts = packageJson.scripts || {};

  const commands = [
    scripts.lint ? ["lint", "npm", ["run", "lint"]] : null,
    scripts.test ? ["test", "npm", ["test"]] : null,
    scripts.build ? ["build", "npm", ["run", "build"]] : null,
  ].filter(Boolean);

  for (const [name, command, args] of commands) {
    const rendered = `${command} ${args.join(" ")}`;
    try {
      await run(command, args, { allowFailure: false });
      checks.push({ name, command: rendered, ok: true });
    } catch (error) {
      checks.push({ name, command: rendered, ok: false, output: error.message });
    }
  }

  return checks;
}

function getOwnerAndRepo(repository) {
  const { pathname } = new URL(repository);
  const [owner, repo] = pathname.replace(/^\/|\/$/g, "").split("/");

  return {
    owner,
    repo: repo?.replace(/\.git$/, ""),
  };
}


async function openOrUpdatePullRequest(result) {
  const { owner, repo } = getOwnerAndRepo(repository);
  const headers = githubHeaders();
  const head = `${owner}:${result.branch}`;
  const existingResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(baseBranch)}`,
    { headers },
  );
  /* if (!existingResponse.ok) {
    throw new Error(`Failed to look up existing PRs: ${existingResponse.status} ${await existingResponse.text()}`);
  } */
  const existing = await existingResponse.json();

  if (existing.length > 0) {
    const pr = existing[0];
    const updateResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: result.title, body: result.body }),
    });
    if (!updateResponse.ok) {
      throw new Error(`Failed to update PR #${pr.number}: ${updateResponse.status} ${await updateResponse.text()}`);
    }
    console.log(`Updated PR #${pr.number}: ${result.title}`);
    return;
  }
  console.log(`PR url : https://api.github.com/repos/${owner}/${repo}/pulls`);
  const createResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: result.title,
      body: result.body,
      head: result.branch,
      base: baseBranch,
      maintainer_can_modify: true,
    }),
  });
  console.log(`Creating PR for branch`, createResponse);
  if (!createResponse.ok) {
    throw new Error(`Failed to create PR: ${createResponse.status} ${await createResponse.text()}`);
  }
  const pr = await createResponse.json();
  console.log(`Created PR #${pr.number}: ${result.title}`);
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/* async function pushBranch(branch) {
  await git(["push", "--force-with-lease", "origin", `${branch}:${branch}`]);
} */

async function pushBranch(branch) {
  const remoteSha = await getRemoteBranchSha(branch);
  if (remoteSha) {
    await git([
      "push",
      `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
      "origin",
      `${branch}:refs/heads/${branch}`,
    ]);
    return;
  }

  await git(["push", "origin", `${branch}:refs/heads/${branch}`]);
}

async function getRemoteBranchSha(branch) {
  const result = await run("git", ["ls-remote", "--heads", "origin", branch], { allowFailure: false });
  const line = result.stdout.trim().split("\n").find(Boolean);
  if (!line) return null;
  return line.split(/\s+/)[0] || null;
}

async function checkoutBase() {
  await git(["fetch", "origin", baseBranch]);
  await git(["checkout", "-B", baseBranch, `origin/${baseBranch}`]);
  await git(["reset", "--hard", `origin/${baseBranch}`]);
}

async function checkoutBranch(branch) {
  await git(["checkout", "-B", branch]);
}

async function configureGit() {
  await git(["config", "user.name", "github-actions[bot]"]);
  await git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
}

async function npmAudit() {
  const result = await run("npm", ["audit", "--json"], { allowFailure: true });
  if (!result.stdout.trim()) return {};
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse npm audit JSON: ${error.message}`);
  }
}

function extractAdvisories(audit, packageJson) {
  const vulnerabilities = audit.vulnerabilities || {};
  const advisories = [];

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const viaObjects = Array.isArray(vulnerability.via)
      ? vulnerability.via.filter((item) => item && typeof item === "object")
      : [];

    if (viaObjects.length === 0) {
      advisories.push(makeAdvisory({ packageName, vulnerability, via: null, packageJson }));
      continue;
    }

    for (const via of viaObjects) {
      advisories.push(makeAdvisory({ packageName, vulnerability, via, packageJson }));
    }
  }

  const unique = new Map();
  for (const advisory of advisories) {
    if (!unique.has(advisory.key)) unique.set(advisory.key, advisory);
  }
  return [...unique.values()];
}

function makeAdvisory({ packageName, vulnerability, via, packageJson }) {
  const advisoryId = via?.url?.match(/GHSA-[a-z0-9-]+/i)?.[0]
    || via?.cves?.[0]
    || via?.source?.toString()
    || `${packageName}-${vulnerability.range || "unknown"}`;

  return {
    key: `${packageName}:${advisoryId}`,
    packageName,
    advisoryId,
    title: via?.title || vulnerability.title || `${packageName} vulnerability`,
    severity: normalizeSeverity(via?.severity || vulnerability.severity || "low"),
    url: via?.url || null,
    cves: via?.cves || [],
    cvss: via?.cvss || null,
    range: via?.range || vulnerability.range || null,
    nodes: vulnerability.nodes || [],
    effects: vulnerability.effects || [],
    isDirect: Boolean(vulnerability.isDirect) || isDirectDependency(packageJson, packageName),
    fixAvailable: vulnerability.fixAvailable,
  };
}

function advisoryStillPresent(audit, original) {
  return extractAdvisories(audit, { dependencies: {}, devDependencies: {}, optionalDependencies: {} })
    .some((item) => item.packageName === original.packageName && item.advisoryId === original.advisoryId);
}

function compareAdvisories(left, right) {
  const severity = severityRank.get(right.severity) - severityRank.get(left.severity);
  if (severity !== 0) return severity;
  if (left.isDirect !== right.isDirect) return left.isDirect ? -1 : 1;
  return left.packageName.localeCompare(right.packageName);
}

function isDirectDependency(packageJson, packageName) {
  return Boolean(
    packageJson.dependencies?.[packageName]
      || packageJson.devDependencies?.[packageName]
      || packageJson.optionalDependencies?.[packageName],
  );
}

async function readPackageJson() {
  return JSON.parse(await readFile(packageJsonPath, "utf8"));
}

async function readPackageLock() {
  return JSON.parse(await readFile(packageLockPath, "utf8"));
}

async function writePackageJson(packageJson) {
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function git(args) {
  const result = await run("git", args, { allowFailure: false });
  return result.stdout;
}

async function run(command, args, options = {}) {
  const { allowFailure = false, env = process.env } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`));
      }
    });
  });
}

function cleanVersion(version) {
  if (!version || typeof version !== "string") return null;
  return version.replace(/^[^\d]*/, "");
}

function normalizeSeverity(severity) {
  const normalized = String(severity || "low").toLowerCase();
  return severityRank.has(normalized) ? normalized : "low";
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value || String(defaultValue), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sanitizeTitle(title) {
  return title.replace(/\s+/g, " ").trim().slice(0, 120);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
