# Local subscription manager

This fork adds a subscription manager to the desktop Profiles page and a standalone browser entry point using the same React component.

## Manual isolated preview

No personal configurations, subscription URLs, caches or snapshots are shipped with this repository. The optional Linux-only browser preview expects a separately prepared private configuration copy in .subscription-workspace; an optional original snapshot can be kept in .subscription-original. Both are excluded from Git. A fresh clone cannot run this preview until its isolated configuration has been prepared.

Run from this repository:

    bash scripts/start-subscription-manager.sh

Open http://127.0.0.1:17891. The launcher starts a separate test Mihomo and the web manager. The test core uses mixed proxy port 17897 and a private Unix socket, with TUN disabled and no system proxy changes. Ctrl+C stops only these test processes.

Changes affect the copied configuration only. They are not applied to the installed client. Existing routing rules, DNS settings and provider options are retained. Saving validates the candidate using the core, backs up files under .subscription-workspace/backups, and restores the previous files on application failure.

The forms accept Clash/Mihomo YAML subscription URLs. Generic Base64 subscription conversion is not included. Removing the only source of a routing group is rejected; give that group another source first. Remote profile cards are separate from the current profile's providers.

## Safety boundaries and remaining limitations

The launcher checks isolation before executing the test core: TUN and automatic routing must be disabled, listeners must be loopback-only on the reserved test ports, the controller must be the private workspace socket, and provider/dashboard paths must stay inside the workspace. Linked workspace files are refused. Occupied ports or an existing socket cause startup to stop without removing another process's resources. A startup timeout or either child failing shuts down only the launcher's own children. Save operations also recheck runtime isolation before core validation.

The native Profiles entry is not yet safe for a no-restart workflow: its existing native save command can fall back to restarting/replacing the active core, and runtime rollback and atomic revision checking need further work. Do not use the native entry on the protected production instance. Use the isolated browser preview only until those native issues are resolved and deployment is explicitly approved.

The browser edits both the copied local source and copied runtime; it does not execute global extension scripts or reproduce native configuration generation. Regenerating through the native client still requires a new isolation review. External file changes and port races are not prevented by an OS sandbox. On an edit conflict, reload the browser page before editing again. Live statistics update after manager actions, not continuously.

## Development

    corepack pnpm subscriptions:build
    corepack pnpm exec vitest run src/utils/subscription-config.test.ts
    corepack pnpm web:build

The standalone manager requires Node.js 22.18+ (verified here with 22.23.2), /usr/bin/verge-mihomo and the prepared configuration copy. Full desktop packaging additionally requires the Rust/GTK dependencies in CONTRIBUTING.md. The browser entry point does not replace the installed desktop app.
