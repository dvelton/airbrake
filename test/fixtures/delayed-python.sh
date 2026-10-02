#!/bin/sh
set -eu

sleep "${AIRBRAKE_TEST_PYTHON_DELAY:-0.8}"
exec python3 "$@"
