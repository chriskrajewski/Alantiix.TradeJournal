# Docker / local-volume hosting is **unsupported** on this Vercel + Turso line of work.
# Prefer deploying apps/web on Vercel with TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
# This Dockerfile previously built a standalone Next server with better-sqlite3 on a volume.
# It will not work without restoring a local SQLite driver and `output: "standalone"`.
FROM scratch
LABEL unsupported="true" \
  description="Docker self-host is unsupported; use Vercel + Turso. See README and docs."
