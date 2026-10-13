#!/bin/sh
set -e

# Wazir Docker Entrypoint
# Supports controller (api), worker, and interactive CLI executions

# Ensure ~/.wazir exists and is writable
mkdir -p /home/wazir/.wazir /home/wazir/.wazir/logs

case "$1" in
  api|controller)
    shift
    exec wa api start "$@"
    ;;
  worker)
    shift
    exec wa worker start "$@"
    ;;
  doctor)
    shift
    exec wa doctor "$@"
    ;;
  wa)
    shift
    exec wa "$@"
    ;;
  sh|bash)
    exec "$@"
    ;;
  *)
    if [ $# -eq 0 ]; then
      exec wa doctor
    else
      exec wa "$@"
    fi
    ;;
esac
