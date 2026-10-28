# Run as a systemd user service

[Home](../../../README.md) · [Documentation](README.md)

Use the source checkout as a background service on a Linux devbox. The repository includes a unit template at `scripts/systemd/copilot-api.service.in` and an installer at `scripts/install-service.ts`. The desktop app is not required.

The installer detects the checkout and Bun executable paths, installs `copilot-api.service` in `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`, reloads the user manager, and enables the service for future user sessions. It **does not start or restart the server**, build the project, authenticate providers, enable lingering, or change network access. It does not need sudo.

## Prerequisites

- Linux with a running systemd user manager. Check with `systemctl --user show-environment`.
- Git and a patched Bun runtime, **Bun >= 1.4.4**. Use the patched runtime versions listed in the [quick start](../../../README.md#quick-start).
- A supported, patched Node.js version for the build tools; see [building from source](getting-started.md#running-from-source). The running service uses Bun.
- A Copilot subscription or credentials for another supported provider, and network access to that provider.

On WSL, systemd must be enabled and the distribution must be running. User lingering does not launch a WSL distribution when Windows boots, and cannot keep the gateway running while Windows sleeps or the distribution is stopped.

Systemd does not accept quotes or backslashes in executable paths. Install Bun in a path without those characters. Checkout paths can contain spaces, quotes, backslashes, `%`, and `$`; the installer handles systemd's path rules. Paths containing control characters or newlines are rejected.

## Clone and build

```sh
mkdir -p ~/src
git clone --branch dev https://github.com/gingi/copilot-api.git ~/src/copilot-api
cd ~/src/copilot-api

bun install --frozen-lockfile
bun run build
```

The installer requires `dist/main.js` to exist. It points the service at this checkout, so keep the checkout and Bun executable in place. If either moves, install a replacement unit using the steps below.

## Authenticate before starting the service

For Bun behind a corporate HTTPS proxy, enable system certificate trust for the interactive commands as well as the service:

```sh
export NODE_USE_SYSTEM_CA=1
bun run dist/main.js auth login --provider copilot
```

Follow the sign-in instructions. To use a different provider instead, see the [authentication commands](cli.md#auth-command-options).

Configuration and credentials are not part of the checkout. By default they live in `~/.local/share/copilot-api`, including `config.json` and provider credentials. Treat this directory as sensitive: `config.json` can contain API keys. Prefer signing in again on a new devbox rather than copying tokens. Recreate or securely transfer any custom provider settings and model mappings you need.

If you use `COPILOT_API_HOME` or other environment overrides, use the same settings for interactive authentication and the service; see [service environment](#service-environment).

## Install and start

`XDG_CONFIG_HOME` must select a unit directory that the running user manager already searches. Changing it only in your shell does not change the manager's search path. The installer checks the manager's `UnitPath` and refuses an undiscoverable destination before writing. If it reports a mismatch, use the manager's configured directory or unset a shell-only override. Inspect the active search paths with:

```sh
systemctl --user show --property=UnitPath --value
```

From the built checkout:

```sh
bun run scripts/install-service.ts
systemctl --user start copilot-api.service
systemctl --user status copilot-api.service
curl --fail http://127.0.0.1:4141/v1/models
```

If gateway API keys are configured, supply one when checking the endpoint, for example with `-H "x-api-key: $COPILOT_GATEWAY_KEY"`. That example variable is for the curl command; it does not configure the server.

The unit runs `bun run dist/main.js start`, with production mode and system CA trust enabled. It restarts on failure after ten seconds and sends logs to the user journal:

```sh
journalctl --user -u copilot-api.service -f
```

Rerunning the installer with an identical unit is safe and retries reload/enable if a previous attempt failed. A command failure returns a nonzero exit status; an already-created unit remains in place for inspection and retry. The installer will not overwrite a different existing unit or a symlink.

### Replace an existing unit

Inspect the existing unit and preserve any custom settings before replacing it:

```sh
systemctl --user cat copilot-api.service
```

Move the unit aside, then rerun the installer. This keeps a backup rather than overwriting your existing configuration:

```sh
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mv -i "$unit_dir/copilot-api.service" \
  "$unit_dir/copilot-api.service.backup-$(date +%Y%m%d-%H%M%S)"
bun run scripts/install-service.ts
```

Reapply required custom settings as a drop-in before starting or restarting. Existing drop-ins are not removed by the installer. If the service is already running, `start` will not apply a changed executable or working directory; restart it when ready:

```sh
systemctl --user restart copilot-api.service
```

A restart interrupts in-flight requests. If the existing unit was installed somewhere other than the user configuration directory above, inspect its location with `systemctl --user show copilot-api.service --property=FragmentPath` before moving anything.

## Service environment

The installer does not copy your interactive shell environment, provider credentials, or custom home directory into the unit. The service uses the account's default application data directory unless you configure an override.

For example, authenticate with a custom data directory:

```sh
COPILOT_API_HOME="$HOME/.local/share/copilot-api-work" \
  NODE_USE_SYSTEM_CA=1 bun run dist/main.js auth login --provider copilot
```

Then use `systemctl --user edit copilot-api.service` to add:

```ini
[Service]
Environment="COPILOT_API_HOME=%h/.local/share/copilot-api-work"
```

Use drop-ins for other required environment settings, such as a proxy URL. Avoid putting tokens in command-line arguments; do not commit credentials or secret-bearing drop-ins. See the [CLI reference](cli.md) and [configuration reference](configuration.md).

After editing a drop-in, reload and restart when ready:

```sh
systemctl --user daemon-reload
systemctl --user restart copilot-api.service
```

## Start at boot and keep running after logout

Enabling the unit starts it with the user's systemd session. To start that user manager at Linux boot and keep it after logout, an administrator can enable lingering:

```sh
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" --property=Linger
```

Lingering is a separate host policy decision; the installer does not change it. On WSL, the distribution still needs to be started separately.

## Access from another machine

The default listener is `127.0.0.1:4141`. Prefer an SSH tunnel from your workstation; this example uses local port 4142 so an existing local gateway on 4141 can keep running:

```sh
ssh -N -L 4142:127.0.0.1:4141 your-devbox
```

Point the client at `http://127.0.0.1:4142`. Gateway authentication still applies if keys are configured. For direct network access, configure gateway API keys before changing the listener, and use appropriate firewall and TLS controls; see [API and authentication](api.md). The installer does not expose a network listener.

## Update the checkout

```sh
cd ~/src/copilot-api
git pull --ff-only origin dev
bun install --frozen-lockfile
bun run build
systemctl --user restart copilot-api.service
```

Pulling source does not update the built server or restart the service. Check the build succeeds before restarting; the restart interrupts in-flight requests. If Bun moves or the unit template changes, rerun the installer and follow [replacement instructions](#replace-an-existing-unit) if it reports a conflict.

## Remove the service

Stop and disable the service, then remove its unit file:

```sh
systemctl --user disable --now copilot-api.service
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
rm -i "$unit_dir/copilot-api.service"
systemctl --user daemon-reload
```

These steps leave your checkout, provider credentials, configuration, backups, and drop-ins intact. Inspect any remaining drop-ins with `systemctl --user cat copilot-api.service` before deleting them manually. Do not remove the application data directory unless you intend to delete credentials and usage data. If you enabled lingering only for this service, an administrator can disable it with `sudo loginctl disable-linger "$USER"`; first check that no other user services rely on it.
