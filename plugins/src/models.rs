use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingRequest {
  pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
  pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
  pub running: bool,
  pub message: Option<String>,
  #[serde(default)]
  pub started_at: Option<i64>,
  #[serde(default)]
  pub country: Option<String>,
  #[serde(default)]
  pub node_label: Option<String>,
  #[serde(default)]
  pub config_available: bool,
  #[serde(default)]
  pub consent_required: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidConnectRequest {
  pub config_json: String,
  #[serde(default)]
  pub split_mode: Option<String>,
  #[serde(default)]
  pub include_packages: Option<Vec<String>>,
  #[serde(default)]
  pub exclude_packages: Option<Vec<String>>,
  #[serde(default)]
  pub local_network: bool,
  #[serde(default)]
  pub node_label: Option<String>,
  #[serde(default)]
  pub country: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidApp {
  pub package: String,
  pub label: String,
  #[serde(default)]
  pub system: bool,
  #[serde(default)]
  pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAppsResponse {
  #[serde(default)]
  pub apps: Vec<AndroidApp>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermission {
  #[serde(default)]
  pub granted: bool,
}
