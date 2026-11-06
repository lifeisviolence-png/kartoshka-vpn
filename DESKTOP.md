# КартошкаVPN Desktop

КартошкаVPN desktop uses Tauri 2 and bundles sing-box as a sidecar. sing-box exposes a local mixed HTTP/SOCKS proxy on `127.0.0.1:2080` and manages the operating-system proxy while connected. TUN is intentionally not enabled in this first native version because the current user workflow relies on proxy mode.

## Local development

A Rust toolchain and the platform prerequisites for Tauri are required. Then run:

```bash
pnpm install
pnpm tauri icon src-tauri/icons/potato-mark.svg
pnpm desktop:dev
```

The application accepts a 3x-ui subscription URL, decodes common `vless://`, `vmess://`, `trojan://` and `ss://` entries, writes a sing-box configuration, starts the bundled sidecar, and enables the system proxy through sing-box.

## Release builds

GitHub Actions builds Windows x64, macOS Intel and macOS Apple Silicon installers. Push a tag such as `v0.2.0` or start the `Desktop builds` workflow manually. The workflow pins sing-box `1.14.4` and downloads official release archives from the SagerNet repository.

The split-routing option currently keeps private IPs and `.ru`/`.рф` domains direct. Full geosite/geoip rule-set management and signed application updates are intentionally separate follow-up work; the application does not claim TUN support.
