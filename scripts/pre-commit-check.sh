#!/usr/bin/env bash
# Pre-commit secret scan — enforces AGENTS.md §2 sensitive information policy.
# Any match → exit 1 → commit aborted.
#
# Install as git hook:
#   ln -sf ../../scripts/pre-commit-check.sh .git/hooks/pre-commit
#   chmod +x scripts/pre-commit-check.sh
#
# Or run manually before committing:
#   ./scripts/pre-commit-check.sh

set -euo pipefail

echo "==> [AGENTS.md §2] Pre-commit secret scan"

# Patterns that indicate a leaked secret. Ordered by type.
PATTERNS='ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
# *_API_KEY= followed by a non-empty, non-placeholder value
KEY_ASSIGN='(ARK_API_KEY|MODEL_PROXY_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY)=[A-Za-z0-9/+_=-]{12,}'

LEAKS=0

# 1. Scan staged content (diff --cached) — catches new secrets about to be committed
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git diff --cached --name-only 2>/dev/null | grep -q .; then
    if git diff --cached 2>/dev/null | grep -E "^\+" | grep -E "$PATTERNS|$KEY_ASSIGN" >/dev/null; then
      echo "FAIL: staged diff contains secret pattern"
      git diff --cached 2>/dev/null | grep -E "^\+" | grep -nE "$PATTERNS|$KEY_ASSIGN" | head -5
      LEAKS=$((LEAKS+1))
    fi
  fi
fi

# 2. Scan all tracked files
TRACKED_HITS=$(git ls-files 2>/dev/null | while read -r f; do
  [ -f "$f" ] || continue
  if grep -nE "$PATTERNS|$KEY_ASSIGN" "$f" 2>/dev/null; then
    echo "  in: $f"
  fi
done)
if [ -n "$TRACKED_HITS" ]; then
  echo "FAIL: tracked files contain secret pattern"
  echo "$TRACKED_HITS" | head -10
  LEAKS=$((LEAKS+1))
fi

# 3. Confirm .env and other sensitive files are NOT tracked
for forbidden in .env .env.local .npmrc .pypirc id_rsa id_ed25519; do
  if git ls-files --error-unmatch "$forbidden" 2>/dev/null | grep -q .; then
    echo "FAIL: sensitive file '$forbidden' is tracked"
    LEAKS=$((LEAKS+1))
  fi
done

# 4. Scan full git history for tokens (best-effort, slow on large repos)
HISTORY_HITS=$(git log --all -p 2>/dev/null | grep -E "$PATTERNS" | head -3 || true)
if [ -n "$HISTORY_HITS" ]; then
  echo "WARN: git history may contain secrets (requires filter-repo to clean):"
  echo "$HISTORY_HITS"
  LEAKS=$((LEAKS+1))
fi

if [ "$LEAKS" -gt 0 ]; then
  echo "==> BLOCKED: $LEAKS leak(s) detected. Commit aborted per AGENTS.md §2."
  exit 1
fi

echo "==> OK: no secrets detected. Safe to commit."
exit 0
