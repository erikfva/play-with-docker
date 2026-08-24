# Codespace VM Scripts

Create, list, or delete GitHub Codespace VMs using `codespace-vm.js`.

## Create A Codespace VM

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create
```

Create and stop the Codespace after it appears in the Codespaces list:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create \
  --stop
```

Create without waiting for the Codespace to appear in `/codespaces`:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create \
  --no-wait
```

Create options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
- `--action create`: Required.
- `--template <name>`: Template name. Defaults to `blank`.
- `--stop`: Stop the Codespace after creation.
- `--no-wait`: Do not wait for the Codespace to appear in the Codespaces list.

## List Codespace VMs

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action list
```

List options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
- `--action list`: Required.

## Delete A Codespace VM

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action delete \
  --target <codespace-name-or-slug>
```

Stop and delete an active Codespace:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action delete \
  --target <codespace-name-or-slug> \
  --force
```

Delete options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
- `--action delete`: Required.
- `--target <name-or-slug>`: Required. Codespace name or slug to delete.
- `--force`: Stop an active Codespace before deleting it.
