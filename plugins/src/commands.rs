use tauri::{AppHandle, command, Runtime};

use crate::models::*;
use crate::Result;
use crate::VpnExt;

#[command]
pub(crate) async fn ping<R: Runtime>(
    app: AppHandle<R>,
    payload: PingRequest,
) -> Result<PingResponse> {
    app.vpn().ping(payload)
}

#[command]
pub(crate) async fn start_test<R: Runtime>(app: AppHandle<R>) -> Result<TunnelStatus> {
    app.vpn().start_test()
}

#[command]
pub(crate) async fn stop_test<R: Runtime>(app: AppHandle<R>) -> Result<TunnelStatus> {
    app.vpn().stop_test()
}

#[command]
pub(crate) async fn status<R: Runtime>(app: AppHandle<R>) -> Result<TunnelStatus> {
  app.vpn().status()
}

#[command]
pub(crate) async fn android_connect<R: Runtime>(
    app: AppHandle<R>,
    payload: AndroidConnectRequest,
) -> Result<TunnelStatus> {
    app.vpn().android_connect(payload)
}

#[command]
pub(crate) async fn android_disconnect<R: Runtime>(app: AppHandle<R>) -> Result<TunnelStatus> {
    app.vpn().android_disconnect()
}

#[command]
pub(crate) async fn android_apps<R: Runtime>(app: AppHandle<R>) -> Result<AndroidAppsResponse> {
    app.vpn().android_apps()
}

#[command]
pub(crate) async fn android_notification_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationPermission> {
    app.vpn().notification_permission()
}
