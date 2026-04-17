#!/usr/bin/env sh
LOCAL_PORT=""
next_is_L=""
for arg in "$@"; do
  if [ "$next_is_L" = "1" ]; then
    LOCAL_PORT=$(echo "$arg" | cut -d: -f1)
    next_is_L=""
    break
  fi
  if [ "$arg" = "-L" ]; then
    next_is_L="1"
  fi
done
if [ -z "$LOCAL_PORT" ]; then
  echo "fake-ssh-ignore-sigterm: no -L arg found" >&2
  exit 2
fi
exec node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(${LOCAL_PORT}, '127.0.0.1');
  process.on('SIGTERM', () => { /* ignore */ });
  setInterval(() => {}, 60000);
"
