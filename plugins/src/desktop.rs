use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Vpn<R>> {
  Ok(Vpn(app.clone()))
}

/// Access to the vpn APIs.
pub struct Vpn<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Vpn<R> {
  pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
    Ok(PingResponse {
      value: payload.value,
    })
  }

  pub fn start_test(&self) -> crate::Result<TunnelStatus> {
    Ok(TunnelStatus {
      running: false,
      message: Some("Android VPN plugin is only available on Android".into()),
      ..Default::default()
    })
  }

  pub fn stop_test(&self) -> crate::Result<TunnelStatus> {
    Ok(TunnelStatus {
      running: false,
      message: Some("Android VPN plugin is only available on Android".into()),
      ..Default::default()
    })
  }

  pub fn status(&self) -> crate::Result<TunnelStatus> {
    Ok(TunnelStatus {
      running: false,
      message: Some("Android VPN plugin is only available on Android".into()),
      ..Default::default()
    })
  }

  pub fn android_connect(&self, _payload: AndroidConnectRequest) -> crate::Result<TunnelStatus> {
    self.status()
  }

  pub fn android_disconnect(&self) -> crate::Result<TunnelStatus> {
    self.status()
  }

  pub fn android_apps(&self) -> crate::Result<AndroidAppsResponse> {
    Ok(AndroidAppsResponse::default())
  }

  pub fn notification_permission(&self) -> crate::Result<NotificationPermission> {
    Ok(NotificationPermission { granted: false })
  }
}
