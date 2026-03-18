#!/bin/sh
set -eu

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "${S3_BUCKET:-}" ] && is_truthy "${S3FS_ENABLED:-1}"; then
  MOUNT_DIR="${S3_MOUNT_DIR:-/mnt/s3}"
  case "$MOUNT_DIR" in
    /*) : ;;
    *) echo "S3_MOUNT_DIR must be an absolute path (got: $MOUNT_DIR)" >&2; exit 2 ;;
  esac

  mkdir -p "$MOUNT_DIR" /tmp/s3fs

  PASSWD_OPT=""
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    printf '%s:%s\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > /etc/passwd-s3fs
    chmod 600 /etc/passwd-s3fs
    PASSWD_OPT="-o passwd_file=/etc/passwd-s3fs"
  fi

  S3FS_OPTS="-o allow_other -o use_cache=/tmp/s3fs $PASSWD_OPT"

  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    S3FS_OPTS="$S3FS_OPTS -o session_token=$AWS_SESSION_TOKEN"
  fi

  if [ -n "${S3_REGION:-}" ]; then
    S3FS_OPTS="$S3FS_OPTS -o endpoint=$S3_REGION"
  fi

  if [ -n "${S3_ENDPOINT:-}" ]; then
    S3FS_OPTS="$S3FS_OPTS -o url=$S3_ENDPOINT -o use_path_request_style"
  fi

  if [ -n "${S3FS_EXTRA_OPTS:-}" ]; then
    S3FS_OPTS="$S3FS_OPTS $S3FS_EXTRA_OPTS"
  fi

  if ! s3fs "$S3_BUCKET" "$MOUNT_DIR" $S3FS_OPTS; then
    echo "s3fs mount failed" >&2
    exit 1
  fi
elif [ -n "${S3_BUCKET:-}" ]; then
  echo "S3FS mount disabled (S3FS_ENABLED=${S3FS_ENABLED:-0})"
fi

exec "$@"
