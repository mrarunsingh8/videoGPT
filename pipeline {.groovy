pipeline {

  agent any

  tools {
    nodejs "node25"
  }

  environment {
    PIPELINE_NAME         = 'patchpilot'
    GITHUB_CREDENTIALS_ID = 'jenkins-github-ssh'
    ANTHROPIC_API_KEY     = credentials('anthropic-key')
    VULN_COUNT            = '0'
  }

  triggers {
    cron('H 2 * * *')
  }

  parameters {
    string(name: 'REPO_URL',
           defaultValue: 'https://github.com/mrarunsingh8/videoGPT.git',
           description: 'Repository URL to scan')
    string(name: 'BASE_BRANCH',
           defaultValue: 'main',
           description: 'Base branch to branch off and target for PRs')
  }

  stages {

    // ─────────────────────────────────────────────
    stage('PatchPilot Init') {
      steps {
        script {
          currentBuild.displayName = "${PIPELINE_NAME}-#${env.BUILD_NUMBER}"
          currentBuild.description = "Automated vulnerability remediation — ${params.REPO_URL}"
        }
      }
    }

    // ─────────────────────────────────────────────
    stage('Clean Workspace') {
      steps {
        sh "rm -rf repo audit.json claude_request.json claude_response.json fix_commands.txt"
      }
    }

    // ─────────────────────────────────────────────
    stage('Clone Repository') {
      steps {
        dir('repo') {
          checkout([
            $class: 'GitSCM',
            branches: [[name: params.BASE_BRANCH]],
            userRemoteConfigs: [[
              url: params.REPO_URL,
              credentialsId: GITHUB_CREDENTIALS_ID
            ]]
          ])
        }
      }
    }

    // ─────────────────────────────────────────────
    stage('Install Dependencies') {
      steps {
        dir('repo') {
          sh "npm install"
        }
      }
    }

    // ─────────────────────────────────────────────
    stage('Run Vulnerability Scan') {
      steps {
        dir('repo') {
          sh "npm audit --json > ../audit.json || true"
        }
      }
    }

    // ─────────────────────────────────────────────
    // Sets env.VULN_COUNT so downstream stages can use a `when` guard.
    stage('Check Vulnerabilities') {
      steps {
        script {
          def count = sh(
            script: '''node -e "
              const fs = require('fs');
              let obj = {};
              try { obj = JSON.parse(fs.readFileSync('audit.json', 'utf8')); } catch (e) { console.log(0); process.exit(0); }
              let n = 0;
              if (obj.metadata && obj.metadata.vulnerabilities) {
                const v = obj.metadata.vulnerabilities;
                n = (v.info||0) + (v.low||0) + (v.moderate||0) + (v.high||0) + (v.critical||0);
              } else if (obj.vulnerabilities && typeof obj.vulnerabilities === 'object') {
                n = Object.keys(obj.vulnerabilities).length;
              }
              console.log(n);
            "''',
            returnStdout: true
          ).trim().toInteger()

          env.VULN_COUNT = count.toString()

          if (count == 0) {
            echo "No vulnerabilities found — pipeline will stop here."
          } else {
            echo "Vulnerabilities found: ${count}. Proceeding to remediation."
          }
        }
      }
    }

    // ─────────────────────────────────────────────
    // Calls Claude and writes fix_commands.txt.
    // Each line: PACKAGE_NAME|SEVERITY|CVE_OR_NA|npm install pkg@version
    stage('Ask Claude for Fixes') {
      when { expression { env.VULN_COUNT.toInteger() > 0 } }
      steps {
        script {
          def auditJson = readFile("audit.json")

          def prompt = "You are a Node.js/Express security remediation assistant.\n" +
            "Analyse the npm audit JSON below and return one line per vulnerable package.\n\n" +
            "Output format (pipe-separated, no markdown, no blank lines, no explanation):\n" +
            "PACKAGE_NAME|SEVERITY|CVE_OR_NA|npm install PACKAGE@SAFE_VERSION\n\n" +
            "Rules:\n" +
            "- SEVERITY must be one of: critical, high, moderate, low, info\n" +
            "- CVE_OR_NA: the CVE identifier (e.g. CVE-2023-1234) if present, otherwise the literal NA\n" +
            "- The install command must pin to the lowest safe version available\n" +
            "- Only emit lines for packages that have a known fix available\n" +
            "- Each line must fix exactly one package\n\n" +
            "Audit JSON:\n${auditJson.take(8000)}"

          def payload = groovy.json.JsonOutput.toJson([
            model      : 'claude-sonnet-4-6',
            max_tokens : 1024,
            temperature: 0,
            messages   : [[role: 'user', content: prompt]]
          ])

          writeFile file: "claude_request.json", text: payload

          sh '''
            curl -sf https://api.anthropic.com/v1/messages \
              -H "x-api-key: $ANTHROPIC_API_KEY" \
              -H "anthropic-version: 2023-06-01" \
              -H "content-type: application/json" \
              --data @claude_request.json \
              -o claude_response.json

            node - <<'NODE'
const fs = require('fs');

const r = JSON.parse(fs.readFileSync('claude_response.json', 'utf8'));
if (r.error) {
  console.error('Claude API error:', r.error.message);
  process.exit(1);
}

const raw = (r.content || [])
  .filter(c => c.type === 'text')
  .map(c => c.text)
  .join('\\n');

// Allowlist: letters, digits, common package/version/URL chars, pipe separator
const safeChars = /^[a-zA-Z0-9@\/._^~\-= |]+$/;
const validSeverities = new Set(['critical', 'high', 'moderate', 'low', 'info']);

const seen = new Map();

for (let line of raw.split('\\n')) {
  line = line.trim();
  if (!line) continue;

  // Strip leading list markers that Claude sometimes adds
  line = line.replace(/^[-*\d.)]+\s*/, '').trim();

  const parts = line.split('|');
  if (parts.length !== 4) continue;

  const [pkgName, severity, cve, cmd] = parts.map(p => p.trim());

  if (!cmd.startsWith('npm install'))           continue;
  if (!validSeverities.has(severity.toLowerCase())) continue;
  if (!safeChars.test(line))                    continue;

  const normalised = [pkgName, severity.toLowerCase(), cve || 'NA', cmd].join('|');

  // Deduplicate by install command
  if (!seen.has(cmd)) {
    seen.set(cmd, normalised);
  }
}

const fixes = [...seen.values()];
fs.writeFileSync('fix_commands.txt', fixes.join('\\n') + (fixes.length ? '\\n' : ''));
console.log('PatchPilot: ' + fixes.length + ' fix(es) queued.');
NODE
          '''
        }
      }
    }

    // ─────────────────────────────────────────────
    // One branch + PR per vulnerability fix line.
    stage('Create PRs Per Vulnerability') {
      when { expression { env.VULN_COUNT.toInteger() > 0 } }
      steps {
        script {
          def fixes = readFile("fix_commands.txt").trim()

          if (!fixes) {
            echo "Claude returned no actionable fixes — skipping PR creation."
            return
          }

          sshagent(credentials: [GITHUB_CREDENTIALS_ID]) {
            withEnv(["BASE_BRANCH=${params.BASE_BRANCH}"]) {
              dir('repo') {
                sh '''
git config user.email "mrarunsingh8@gmail.com"
git config user.name "mrarunsingh8"

ORIGIN_PATH=$(git config --get remote.origin.url | sed 's#.*github.com[:/]##; s#[.]git$##')
git remote set-url origin git@github.com:$ORIGIN_PATH.git
git fetch origin "$BASE_BRANCH"
ssh -o StrictHostKeyChecking=accept-new -T git@github.com || true

INDEX=0
while IFS= read -r LINE || [ -n "$LINE" ]; do

  LINE=$(echo "$LINE" | sed 's/^ *//; s/ *$//')
  [ -z "$LINE" ] && continue

  # Parse pipe-separated fields
  PKG_NAME=$(echo "$LINE" | cut -d'|' -f1 | sed 's/^ *//; s/ *$//')
  SEVERITY=$(echo "$LINE" | cut -d'|' -f2 | sed 's/^ *//; s/ *$//')
  CVE=$(echo      "$LINE" | cut -d'|' -f3 | sed 's/^ *//; s/ *$//')
  CMD=$(echo      "$LINE" | cut -d'|' -f4 | sed 's/^ *//; s/ *$//')

  case "$CMD" in "npm install"*) ;; *) continue ;; esac

  INDEX=$((INDEX + 1))
  PKG_VER=$(echo "$CMD" | awk '{print $3}')
  SAFE_PKG=$(echo "$PKG_VER" | tr '@/:' '---' | tr -cd 'a-zA-Z0-9._-')
  [ -z "$SAFE_PKG" ] && SAFE_PKG="pkg${INDEX}"

  # Stable branch name — same branch reused on re-runs (push -f updates it)
  BRANCH_NAME="patchpilot/${SEVERITY}-${SAFE_PKG}-fix"

  git checkout -B "$BRANCH_NAME" "origin/$BASE_BRANCH"

  echo "──────────────────────────────────────────"
  echo "Fix #${INDEX} [${SEVERITY}]: ${CMD}"

  eval "$CMD" || {
    echo "Command failed — skipping: $CMD"
    git checkout "origin/$BASE_BRANCH" -- . 2>/dev/null || true
    continue
  }

  git add package.json package-lock.json 2>/dev/null || true

  if git diff --cached --quiet; then
    echo "No dependency file changes for: $CMD — skipping."
    continue
  fi

  CVE_LINE=""
  [ "$CVE" != "NA" ] && CVE_LINE="CVE     : $CVE"

  git commit -m "fix(deps): patch ${SEVERITY} vulnerability in ${PKG_NAME}

PatchPilot automated remediation
Package : ${PKG_VER}
Severity: ${SEVERITY}
${CVE_LINE}"

  git push -f origin "$BRANCH_NAME"

  COMPARE_URL="https://github.com/$ORIGIN_PATH/compare/$BASE_BRANCH...$BRANCH_NAME?expand=1"

  CVE_CELL="$CVE"
  [ "$CVE" = "NA" ] && CVE_CELL="—"

  PR_BODY=$(cat <<PRBODY
## PatchPilot — Automated Vulnerability Remediation

| Field | Value |
|-------|-------|
| Package | \`${PKG_VER}\` |
| Severity | **${SEVERITY}** |
| CVE | ${CVE_CELL} |
| Fix command | \`${CMD}\` |

This pull request was generated automatically by the **PatchPilot** Jenkins pipeline.
Please review the dependency diff before merging.
PRBODY
)

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then

    EXISTING=$(gh pr list \
      --repo "$ORIGIN_PATH" \
      --head "$BRANCH_NAME" \
      --state open \
      --json number \
      --jq '.[0].number' 2>/dev/null || true)

    if [ -n "$EXISTING" ]; then
      echo "PR #${EXISTING} already open for ${PKG_NAME} — branch updated via force-push."
    else
      PR_URL=$(gh pr create \
        --repo "$ORIGIN_PATH" \
        --base "$BASE_BRANCH" \
        --head "$BRANCH_NAME" \
        --title "[PatchPilot] fix(${SEVERITY}): ${PKG_NAME} vulnerability" \
        --body "$PR_BODY" 2>/dev/null || true)

      if [ -n "$PR_URL" ]; then
        echo "PatchPilot PR created: $PR_URL"
      else
        echo "Could not auto-create PR for ${PKG_NAME}. Compare URL: $COMPARE_URL"
      fi
    fi

  else
    echo "gh CLI not available in this Jenkins agent."
    echo "Open a PR manually: $COMPARE_URL"
  fi

done < ../fix_commands.txt
                '''
              }
            }
          }
        }
      }
    }

  }

  // ─────────────────────────────────────────────
  post {
    always {
      archiveArtifacts artifacts: 'audit.json, fix_commands.txt',
                       allowEmptyArchive: true
    }
    success {
      echo "PatchPilot completed. Check archived artifacts for audit details."
    }
    failure {
      echo "PatchPilot failed. Review the logs and re-run if needed."
    }
  }

}
