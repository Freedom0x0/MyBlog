#!/usr/bin/env bash
#
# Whole-database backup, and the restore half of it.
#
# Why this exists next to the content export (GET /api/v1/admin/articles/export):
# the export is portability — markdown the import endpoint can consume — and it
# demonstrably does not restore state. Import always lands a draft and mints a new id,
# so a restored-from-export blog has every article unpublished, published_at = NULL and
# every comment, user and media reference gone. pg_dump is the only path back to "the
# database as it was". The two are not substitutes and the runbook says so in those
# words.
#
# A copy on the same disk is not a backup. This script writes locally, verifies
# locally, and then prints the one command that gets the file off the machine —
# deliberately not running it itself, because the credentials and the destination are
# the operator's, not the repo's.

set -euo pipefail

# Windows' Git Bash rewrites absolute POSIX paths passed as arguments (so "/tmp/x.dump"
# becomes "C:/Users/.../x.dump" before docker ever sees it), which breaks every
# container-side path below. The variable is unknown and harmless on Linux, so setting it
# unconditionally is the cheap way to keep one script that runs identically on the
# deploy box and on the laptop where it was written — and where a backup script that only
# works on Linux is a script nobody has actually run.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

CONTAINER="${CONTAINER:-myblog-infra-postgres-1}"
PGUSER="${PGUSER:-myblog}"
PGDATABASE="${PGDATABASE:-myblog}"
DEST_DIR="${DEST_DIR:-$(dirname "$0")/pgdata-backups}"
KEEP="${KEEP:-14}"                     # days of local history kept
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"   # UTC so a filename never lies about ordering
OUT="${DEST_DIR}/${PGDATABASE}-${STAMP}.dump"

mkdir -p "${DEST_DIR}"

echo "backing up ${PGDATABASE} from ${CONTAINER} -> ${OUT}"

# -Fc (custom format) rather than plain SQL: it compresses, it restores with
# pg_restore so a single object can be picked out of it, and `--list` works on it
# without executing anything. A plain dump can only be verified by running it
# somewhere, which is not a verification step anybody performs at 3am.
docker exec "${CONTAINER}" pg_dump --format=custom --no-owner --no-privileges \
  --file="/tmp/${PGDATABASE}-${STAMP}.dump" -U "${PGUSER}" "${PGDATABASE}"

# `docker cp` rather than piping stdout: pg_dump's custom format is binary, and a shell
# pipe through `docker exec` has no framing guarantee worth trusting for a restore file.
docker cp "${CONTAINER}:/tmp/${PGDATABASE}-${STAMP}.dump" "${OUT}"

# --- verification, the part that is usually skipped -----------------------------------
# Reading the archive's table of contents proves three things at once: the file is not
# truncated, it is a real pg_dump archive, and the tables we care about are in it.
# Without the grep, an empty-but-valid archive (a mis-targeted PGDATABASE, say) would
# pass — which is the exact shape of a backup that is discovered to be nothing a year
# later, when it is the only copy.
#
# `pg_restore` runs **inside the container**, measured rather than assumed: this host has
# no postgres client tools at all (`command -v pg_restore` → nothing) while the server
# image does. A verification step that needs a host binary is a script that fails on the
# machine you actually deployed to, and the failure looks like the backup failed too.
# The archive is listed before the /tmp copy is removed for exactly that reason.
TOC="$(docker exec "${CONTAINER}" pg_restore --list "/tmp/${PGDATABASE}-${STAMP}.dump")"
printf '%s\n' "${TOC}" | grep -q 'TABLE DATA public articles' \
  || { echo "FAIL: no articles table in ${OUT} — refusing to call this a backup"; exit 1; }
printf '%s\n' "${TOC}" | grep -q 'TABLE DATA public comments' \
  || { echo "FAIL: no comments table in ${OUT}"; exit 1; }

docker exec "${CONTAINER}" rm -f "/tmp/${PGDATABASE}-${STAMP}.dump"

ARTICLES_IN="$(docker exec "${CONTAINER}" psql -U "${PGUSER}" -d "${PGDATABASE}" -tAc \
  'select count(*) from articles')"
echo "verified: archive lists articles+comments; database currently holds ${ARTICLES_IN} articles"

# --- retention and the off-box step ---------------------------------------------------
find "${DEST_DIR}" -name "${PGDATABASE}-*.dump" -mtime "+${KEEP}" -delete

BACKUP_HOST="${BACKUP_HOST:-}"
if [ -n "${BACKUP_HOST}" ]; then
  rsync -a --delete "${DEST_DIR}/" "${BACKUP_HOST}:${BACKUP_DIR:-backups/myblog}/"
  echo "copied to ${BACKUP_HOST} (off-box)"
else
  cat <<EOF

NEXT STEP, NOT OPTIONAL — this file is on the same disk as the database it protects:
    rsync -a ${DEST_DIR}/ <somewhere-else>:/backups/myblog/
Set BACKUP_HOST=you@host and BACKUP_DIR=... to have this script do it, or wire the
output into whatever object storage you already trust. A server that dies takes its
own backups with it; that is the whole reason this line is printed rather than assumed.
EOF
fi

echo "OK ${OUT} ($(du -h "${OUT}" | cut -f1))"

# --- restore ---------------------------------------------------------------------------
# Kept in the same file so a backup without a restore command is not a backup.
#
#   docker cp infra/backup/pgdata-backups/myblog-<stamp>.dump myblog-infra-postgres-1:/tmp/r.dump
#   # into a THROWAWAY database first — restoring over live data is destructive:
#   docker exec myblog-infra-postgres-1 psql -U myblog -d postgres -c 'create database restore_check'
#   docker exec myblog-infra-postgres-1 pg_restore -U myblog -d restore_check --no-owner /tmp/r.dump
#   docker exec myblog-infra-postgres-1 psql -U myblog -d restore_check -tAc 'select count(*) from articles'
#   docker exec myblog-infra-postgres-1 psql -U myblog -d postgres -c 'drop database restore_check'
#
# Run that drill on a schedule, not just once: an archive nobody has restored is a
# hypothesis about a backup.
