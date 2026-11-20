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
