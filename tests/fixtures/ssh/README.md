# Fake SSH fixtures

Shell scripts that stand in for `ssh` in unit tests. Each parses the `-L localPort:remoteHost:remotePort` arg and uses Node to simulate a specific scenario. Called by tests via the `spawnPath` option on `startTunnel`.
