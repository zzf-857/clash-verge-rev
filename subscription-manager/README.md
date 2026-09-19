# Local subscription manager

This fork adds a subscription manager to the desktop Profiles page and a standalone browser entry point using the same React component.

## Manual isolated preview

The private configuration copy is in .subscription-workspace. The original snapshot is in .subscription-original. Both are excluded from Git.

Run from this repository:

    MIHOMO_BIN=/path/to/verge-mihomo bash scripts/start-subscription-manager.sh

Open http://127.0.0.1:17891. The launcher starts a separate test Mihomo and the web manager. The test core uses mixed proxy port 17897 and a private Unix socket, with TUN disabled and no system proxy changes. Ctrl+C stops only these test processes.

Changes affect the copied configuration only. They are not applied to the installed client. Existing routing rules, DNS settings and provider options are retained. Saving validates the candidate using the core, backs up files under .subscription-workspace/backups, and restores the previous files on application failure.

The forms accept Clash/Mihomo YAML subscription URLs. Generic Base64 subscription conversion is not included. Removing the only source of a routing group is rejected; give that group another source first. Remote profile cards are separate from the current profile's providers.

## Safety boundaries and remaining limitations

The launcher checks isolation before executing the test core: TUN and automatic routing must be disabled, listeners must be loopback-only on the reserved test ports, the controller must be the private workspace socket, and provider/dashboard paths must stay inside the workspace. Linked workspace files are refused. Occupied ports or an existing socket cause startup to stop without removing another process's resources. A startup timeout or either child failing shuts down only the launcher's own children. Save operations also recheck runtime isolation before core validation.

The subscription editor's native Save action can fall back to restarting/replacing the active core, and its runtime rollback and atomic revision checking still need further work. For subscription edits that require an uninterrupted production core, use the isolated browser copy. WebDAV restore is a separate, explicitly confirmed overwrite and restart operation described below.

The browser edits both the copied local source and copied runtime; it does not execute global extension scripts or reproduce native configuration generation. Regenerating through the native client still requires a new isolation review. External file changes and port races are not prevented by an OS sandbox. On an edit conflict, reload the browser page before editing again. Live statistics update after manager actions, not continuously.

## Development

    corepack pnpm subscriptions:build
    corepack pnpm exec vitest run src/utils/subscription-config.test.ts
    corepack pnpm web:build

The standalone manager requires Node.js 22.18+ (verified here with 22.23.2), a Mihomo executable selected with `MIHOMO_BIN` (or `verge-mihomo` on PATH), and the prepared configuration copy. Full desktop packaging additionally requires the Rust/GTK dependencies in CONTRIBUTING.md. The browser entry point does not replace the installed desktop app.

## WebDAV backup / sync

On the desktop Profiles page, choose **WebDAV backup / sync** (Chinese: **WebDAV 备份/同步**). The same action is available inside the subscription manager. Configure WebDAV in the backup panel (HTTPS requires a trusted server certificate), upload a backup, and open WebDAV history to restore or delete it. Both deletion and restore require confirmation. The standalone browser displays instructions to open the desktop app; it does not call desktop backup APIs.

Backups contain flat profile files, their index, provider definitions, groups and rules, Merge/Script, Clash/Verge settings and optional DNS overrides. External provider files and nested caches are not included. WebDAV credentials are excluded from newly created archives and target credentials are retained on restore.

Cross-device restore is the default. It preserves target Clash, Verge and DNS settings and rejects scripts, network overrides and provider file paths requiring manual migration. Full overwrite is intended for compatible devices and may change TUN, interfaces, ports, DNS and system proxy settings. Neither mode merges subscriptions.

Restore validates the archive and index before staging files. Before replacing files it creates a private `restore-point-*` directory under the application data directory, containing the original configuration. File commit failures roll back; rollback failure is reported separately. The running core is unchanged until the application restarts after a successful file restore. This does not guarantee network compatibility after restart. For offline recovery, stop the client, replace the managed configuration files and `profiles` directory with their counterparts under the restore point's `original` directory, and remove `dns_config.yaml` if absent from the original. Keep recovery points private: they retain the target's original credentials for offline recovery.
