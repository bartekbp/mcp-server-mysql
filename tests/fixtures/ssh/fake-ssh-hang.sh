#!/usr/bin/env sh
# Block forever without binding anything. Exercises the readiness timeout.
exec node -e "setInterval(() => {}, 60000);"
