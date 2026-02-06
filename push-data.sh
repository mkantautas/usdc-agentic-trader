#!/bin/bash
# Push dashboard data to GitHub every 5 minutes
cd /home/claude-user/crypto-agent/usdc-agentic-trader

# Only push if data.json has changed
if git diff --quiet docs/data.json 2>/dev/null; then
  echo "$(date): No changes to push"
  exit 0
fi

git add docs/data.json
git commit -m "Update live dashboard data ($(date +%H:%M))" --no-verify
git push origin main 2>&1
echo "$(date): Pushed dashboard update"
