use serde::Deserialize;

use super::{
    credential_store::{credential_read, ensure_credential_subject, CredentialSecret},
    provider_http::{request_json, JsonHttpErrorKind, JsonHttpRequest, JsonHttpResponse},
    WorkerState,
};

const MODEL_RESPONSE_BODY_LIMIT: usize = 2 * 1024 * 1024;
const MODEL_LIST_LIMIT: usize = 10_000;
const MODEL_ID_LIMIT: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProviderProfile {
    profile_id: String,
    provider_type: String,
    protocol: String,
    base_url: String,
}

struct ProviderEndpoint {
    host: String,
    port: u16,
    models_path: String,
}

#[derive(Clone, Debug, PartialEq)]
struct RemoteModel {
    id: String,
    display_name: Option<String>,
}

struct ProviderTestOutcome {
    status: &'static str,
    error_code: Option<&'static str>,
    error_message: Option<String>,
    models: Option<Vec<RemoteModel>>,
}

impl ProviderTestOutcome {
    fn ready(models: Option<Vec<RemoteModel>>) -> Self {
        Self {
            status: "ready",
            error_code: None,
            error_message: None,
            models,
        }
    }

    fn failed(status: &'static str, error_code: &'static str, error_message: String) -> Self {
        Self {
            status,
            error_code: Some(error_code),
            error_message: Some(error_message),
            models: None,
        }
    }

    fn into_worker_params(self, profile_id: &str) -> serde_json::Value {
        let mut params = serde_json::json!({
            "profileId": profile_id,
            "status": self.status,
        });
        if let Some(error_code) = self.error_code {
            params["errorCode"] = serde_json::Value::String(error_code.to_string());
        }
        if let Some(error_message) = self.error_message {
            params["errorMessage"] = serde_json::Value::String(error_message);
        }
        if let Some(models) = self.models {
            params["models"] = serde_json::Value::Array(
                models
                    .into_iter()
                    .map(|model| {
                        let mut value = serde_json::json!({ "id": model.id });
                        if let Some(display_name) = model.display_name {
                            value["displayName"] = serde_json::Value::String(display_name);
                        }
                        value
                    })
                    .collect(),
            );
        }
        params
    }
}

#[tauri::command]
pub(crate) async fn provider_test_connection(
    profile_id: String,
    state: tauri::State<'_, WorkerState>,
) -> Result<serde_json::Value, String> {
    ensure_credential_subject(&profile_id, &state)?;
    let begin = state.request(&serde_json::json!({
        "id": format!("provider-connection-begin-{profile_id}"),
        "protocolVersion": 1,
        "method": "provider.connection.begin",
        "params": { "profileId": profile_id }
    }))?;
    let runtime: RuntimeProviderProfile = serde_json::from_value(worker_result(begin)?.clone())
        .map_err(|_| "Worker returned an invalid provider runtime profile".to_string())?;
    if runtime.profile_id != profile_id {
        return Err("Worker returned a mismatched provider profile".to_string());
    }

    let outcome = match credential_read(&profile_id) {
        Ok(secret) => {
            tauri::async_runtime::spawn_blocking(move || test_connection(runtime, secret))
                .await
                .map_err(|_| "Provider connection task could not be joined".to_string())?
        }
        Err(_) => ProviderTestOutcome::failed(
            "auth-failed",
            "credential-missing",
            "Provider credential is not configured.".to_string(),
        ),
    };
    let complete = state.request(&serde_json::json!({
        "id": format!("provider-connection-complete-{profile_id}"),
        "protocolVersion": 1,
        "method": "provider.connection.complete",
        "params": outcome.into_worker_params(&profile_id)
    }))?;
    Ok(worker_result(complete)?.clone())
}

fn test_connection(
    profile: RuntimeProviderProfile,
    secret: CredentialSecret,
) -> ProviderTestOutcome {
    if !matches!(
        profile.protocol.as_str(),
        "openai-responses" | "openai-chat-completions" | "vidu-v2"
    ) {
        return ProviderTestOutcome::failed(
            "protocol-failed",
            "unsupported-protocol",
            "The selected provider protocol does not support native connection testing."
                .to_string(),
        );
    }
    let endpoint = match parse_https_base_url(&profile.base_url) {
        Ok(endpoint) => endpoint,
        Err(message) => {
            return ProviderTestOutcome::failed("protocol-failed", "invalid-base-url", message)
        }
    };
    let secret = match secret.as_str() {
        Ok(secret) => secret,
        Err(message) => {
            return ProviderTestOutcome::failed("auth-failed", "credential-invalid", message)
        }
    };
    let (authorization_scheme, models_path) = if profile.protocol == "vidu-v2" {
        ("Token", "/ent/v2/models")
    } else {
        ("Bearer", endpoint.models_path.as_str())
    };
    let response = match request_json(JsonHttpRequest {
        host: &endpoint.host,
        port: endpoint.port,
        secure: true,
        method: "GET",
        path: models_path,
        authorization_scheme,
        accept: "application/json",
        secret,
        body: None,
        request_body_limit: 1,
        response_body_limit: MODEL_RESPONSE_BODY_LIMIT,
    }) {
        Ok(response) => response,
        Err(error) => return classify_request_error(error.kind(), error.to_string()),
    };
    classify_models_response(response, &profile.provider_type)
}

fn classify_request_error(kind: JsonHttpErrorKind, message: String) -> ProviderTestOutcome {
    match kind {
        JsonHttpErrorKind::InvalidRequest => {
            ProviderTestOutcome::failed("protocol-failed", "invalid-provider-endpoint", message)
        }
        JsonHttpErrorKind::Timeout => {
            ProviderTestOutcome::failed("network-failed", "request-timeout", message)
        }
        JsonHttpErrorKind::Tls => {
            ProviderTestOutcome::failed("network-failed", "tls-error", message)
        }
        JsonHttpErrorKind::InvalidResponse | JsonHttpErrorKind::ResponseTooLarge => {
            ProviderTestOutcome::failed("sync-failed", "invalid-model-response", message)
        }
        JsonHttpErrorKind::Transport => {
            ProviderTestOutcome::failed("network-failed", "transport-error", message)
        }
    }
}

fn classify_models_response(
    response: JsonHttpResponse,
    provider_type: &str,
) -> ProviderTestOutcome {
    match response.status {
        200..=299 if provider_type == "vidu" => ProviderTestOutcome::ready(None),
        200..=299 => match parse_models(&response.body, provider_type) {
            Ok(models) => ProviderTestOutcome::ready(Some(models)),
            Err(message) => {
                ProviderTestOutcome::failed("sync-failed", "invalid-model-list", message)
            }
        },
        401 | 403 => ProviderTestOutcome::failed(
            "auth-failed",
            "authentication-rejected",
            format!(
                "Provider rejected the credential with HTTP {}.",
                response.status
            ),
        ),
        404 | 405 => ProviderTestOutcome::ready(None),
        408 => ProviderTestOutcome::failed(
            "network-failed",
            "request-timeout",
            "Provider model request timed out.".to_string(),
        ),
        429 => ProviderTestOutcome::failed(
            "network-failed",
            "rate-limited",
            "Provider rate-limited the connection test.".to_string(),
        ),
        500..=599 => ProviderTestOutcome::failed(
            "network-failed",
            "provider-server-error",
            format!("Provider returned HTTP {}.", response.status),
        ),
        _ => ProviderTestOutcome::failed(
            "protocol-failed",
            "unexpected-http-status",
            format!(
                "Provider model endpoint returned unexpected HTTP {}.",
                response.status
            ),
        ),
    }
}

fn parse_models(body: &serde_json::Value, provider_type: &str) -> Result<Vec<RemoteModel>, String> {
    let data = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or("Provider model response must contain a data array.".to_string())?;
    if data.len() > MODEL_LIST_LIMIT {
        return Err("Provider model list exceeds the supported limit.".to_string());
    }
    let mut models = std::collections::BTreeMap::new();
    for item in data {
        let id = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| {
                !id.is_empty() && id.len() <= MODEL_ID_LIMIT && !id.chars().any(char::is_control)
            })
            .ok_or("Provider model entry contains an invalid ID.".to_string())?;
        let display_name = item
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty() && name.len() <= MODEL_ID_LIMIT)
            .map(str::to_string);
        models.insert(
            id.to_string(),
            RemoteModel {
                id: id.to_string(),
                display_name,
            },
        );
    }
    if provider_type.trim().is_empty() {
        return Err("Provider runtime profile is missing a provider type.".to_string());
    }
    Ok(models.into_values().collect())
}

fn parse_https_base_url(value: &str) -> Result<ProviderEndpoint, String> {
    if !value.is_ascii() || value.chars().any(char::is_control) || value.contains(['?', '#', '\\'])
    {
        return Err("Provider Base URL contains unsupported characters.".to_string());
    }
    let remainder = value
        .strip_prefix("https://")
        .ok_or("Provider Base URL must use HTTPS.".to_string())?;
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, ""), |(authority, path)| (authority, path));
    if authority.is_empty() || authority.contains('@') || authority.starts_with('[') {
        return Err("Provider Base URL authority is invalid.".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port
                .parse::<u16>()
                .map_err(|_| "Provider Base URL port is invalid.".to_string())?;
            if port == 0 {
                return Err("Provider Base URL port is invalid.".to_string());
            }
            (host, port)
        }
        None => (authority, 443),
    };
    if host.is_empty()
        || host.split('.').any(|label| {
            label.is_empty()
                || !label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
        })
        || host
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
    {
        return Err("Provider Base URL host is invalid.".to_string());
    }
    let base_path = path.trim_end_matches('/');
    if base_path.split('/').any(|segment| segment == "..")
        || base_path.to_ascii_lowercase().contains("%2e")
    {
        return Err("Provider Base URL path cannot contain parent traversal.".to_string());
    }
    let models_path = if base_path.is_empty() {
        "/models".to_string()
    } else {
        format!("/{base_path}/models")
    };
    Ok(ProviderEndpoint {
        host: host.to_ascii_lowercase(),
        port,
        models_path,
    })
}

fn worker_result(response: serde_json::Value) -> Result<serde_json::Value, String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return response
            .get("result")
            .cloned()
            .ok_or("Worker response did not contain a result".to_string());
    }
    let message = response
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Worker rejected the provider operation");
    Err(message.chars().take(500).collect())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_models_response, classify_request_error, parse_https_base_url, parse_models,
        JsonHttpResponse,
    };
    use crate::provider_http::JsonHttpErrorKind;
    use serde_json::json;

    #[test]
    fn parses_safe_https_base_urls_and_rejects_unsafe_variants() {
        let endpoint =
            parse_https_base_url("https://relay.example:8443/v1").expect("safe URL should parse");
        assert_eq!(endpoint.host, "relay.example");
        assert_eq!(endpoint.port, 8443);
        assert_eq!(endpoint.models_path, "/v1/models");
        assert!(parse_https_base_url("http://relay.example/v1").is_err());
        assert!(parse_https_base_url("https://user@relay.example/v1").is_err());
        assert!(parse_https_base_url("https://relay.example/v1?key=secret").is_err());
        assert!(parse_https_base_url("https://relay.example/../admin").is_err());
    }

    #[test]
    fn normalizes_and_deduplicates_remote_models() {
        let models = parse_models(
            &json!({
                "data": [
                    { "id": "gpt-5", "name": "GPT-5" },
                    { "id": "gpt-5" },
                    { "id": "vendor-model" }
                ]
            }),
            "openai",
        )
        .expect("valid model list should parse");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5");
        assert!(parse_models(&json!({ "data": [{ "id": "" }] }), "openai").is_err());
    }

    #[test]
    fn classifies_auth_rate_limit_and_unsupported_model_listing() {
        let auth = classify_models_response(
            JsonHttpResponse {
                status: 401,
                body: json!({}),
            },
            "openai",
        );
        assert_eq!(auth.status, "auth-failed");
        assert_eq!(auth.error_code, Some("authentication-rejected"));

        let limited = classify_models_response(
            JsonHttpResponse {
                status: 429,
                body: json!({}),
            },
            "openai",
        );
        assert_eq!(limited.error_code, Some("rate-limited"));

        let unsupported = classify_models_response(
            JsonHttpResponse {
                status: 404,
                body: json!({}),
            },
            "relay",
        );
        assert_eq!(unsupported.status, "ready");
        assert!(unsupported.models.is_none());
    }

    #[test]
    fn classifies_native_timeout_and_tls_failures_separately() {
        let timeout =
            classify_request_error(JsonHttpErrorKind::Timeout, "Provider timed out".to_string());
        assert_eq!(timeout.status, "network-failed");
        assert_eq!(timeout.error_code, Some("request-timeout"));

        let tls = classify_request_error(
            JsonHttpErrorKind::Tls,
            "Provider TLS validation failed".to_string(),
        );
        assert_eq!(tls.status, "network-failed");
        assert_eq!(tls.error_code, Some("tls-error"));
    }
}
