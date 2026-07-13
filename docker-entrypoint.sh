#!/bin/sh
set -e

# The data volume may already exist from a prior run as root (or be freshly created by Docker,
# which inherits root ownership too) — fix ownership every boot rather than requiring a manual
# one-time migration, then drop from root to the unprivileged app user before exec'ing node.
chown -R jobtracker:jobtracker /app/data
exec su-exec jobtracker "$@"
