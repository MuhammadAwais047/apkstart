#!/usr/bin/env bash
# One command to push docs/promo/wechat-article.md to the WeChat MP draft box
# Usage:
#   1) set env vars WECHAT_APP_ID / WECHAT_APP_SECRET, or
#   2) write them to $HOME/.baoyu-skills/.env (or the file named by WECHAT_ENV_FILE)
# Prerequisite: the MP console "Basic configuration -> IP whitelist" must include this machine's public IP
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${WECHAT_ENV_FILE:-$HOME/.baoyu-skills/.env}"
EXTRA=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  EXTRA+=(--env-file "$ENV_FILE")
fi

if [ -z "$WECHAT_APP_ID" ] || [ -z "$WECHAT_APP_SECRET" ]; then
  echo "Missing credentials: set WECHAT_APP_ID / WECHAT_APP_SECRET, or write them to $ENV_FILE" >&2
  exit 1
fi

wenyan publish \
  "${EXTRA[@]}" \
  -f docs/promo/wechat-article.md \
  -t lapis -h solarized-light --no-footnote

echo "Pushed to the draft box: log in to https://mp.weixin.qq.com -> Content management -> Drafts, review, then publish"
