use std::{
    fs::{create_dir_all, write},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::Manager;

mod credential_store;
mod llm_stream;
mod provider_connector;
mod provider_http;

use credential_store::{
    credential_copy, credential_delete, credential_exists, credential_read, credential_set,
    credential_status, is_profile_id, CredentialSecret,
};
#[cfg(test)]
use credential_store::{
    credential_target, ensure_credential_subject, validate_credential_provider,
};
use llm_stream::{llm_stream, llm_stream_cancel, LlmStreamState};
use provider_connector::provider_test_connection;
use provider_http::{request_bytes, request_json, JsonHttpRequest};

const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_TAIL_LIMIT: usize = 16 * 1024;
const PROVIDER_REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const PROVIDER_RESPONSE_BODY_LIMIT: usize = 2 * 1024 * 1024;
const UNICOMPAPI_RESPONSE_BODY_LIMIT: usize = 32 * 1024 * 1024;
const PROVIDER_POLL_INTERVAL: Duration = Duration::from_secs(1);
const PROVIDER_POLL_TIMEOUT: Duration = Duration::from_secs(120);
const PROVIDER_TASK_ID_LIMIT: usize = 256;
const UNICOMPAPI_HOST: &str = "unicompapi.com";
const UNICOMPAPI_AUTHORIZATION_SCHEME: &str = "Bearer";
#[cfg(any(not(debug_assertions), test))]
const BUNDLED_WORKER_FILENAME: &str = "ai-video-worker.exe";

#[derive(Clone, Copy, Debug, PartialEq)]
struct ProviderTarget {
    credential_provider: &'static str,
    host: &'static str,
    path: &'static str,
    model: &'static str,
    allowed_fields: &'static [&'static str],
}

const IMAGE_FIELDS: &[&str] = &["prompt", "aspect_ratio", "resolution", "seed"];
const REFERENCE_IMAGE_FIELDS: &[&str] = &["images", "prompt", "aspect_ratio", "resolution", "seed"];
const TEXT_VIDEO_FIELDS: &[&str] = &[
    "prompt",
    "duration",
    "aspect_ratio",
    "resolution",
    "audio",
    "seed",
    "off_peak",
];
const REFERENCE_VIDEO_FIELDS: &[&str] = &[
    "images",
    "prompt",
    "duration",
    "aspect_ratio",
    "resolution",
    "audio",
    "seed",
    "off_peak",
];
const Q3_VIDEO_FIELDS: &[&str] = &[
    "images",
    "prompt",
    "is_rec",
    "duration",
    "resolution",
    "audio",
    "seed",
    "off_peak",
];
const V2_VIDEO_FIELDS: &[&str] = &[
    "images",
    "prompt",
    "duration",
    "resolution",
    "movement_amplitude",
    "seed",
];

const UNICOMPAPI_TEXT_TO_IMAGE_MODELS: &[&str] = &["doubao-seedream-5-0-260128", "qwen-image"];
const UNICOMPAPI_IMAGE_EDIT_MODELS: &[&str] = &["qwen-image-edit-2509"];
const UNICOMPAPI_TEXT_TO_VIDEO_MODELS: &[&str] = &[
    "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128",
    "happyhorse-1.0-t2v",
    "happyhorse-1.1-t2v",
    "kling-v3-turbo",
    "viduq3-pro",
    "viduq3-turbo",
];
const UNICOMPAPI_IMAGE_TO_VIDEO_MODELS: &[&str] = &[
    "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128",
    "happyhorse-1.0-i2v",
    "happyhorse-1.1-i2v",
    "kling-v3-turbo",
    "viduq3",
    "viduq3-mix",
    "viduq3-turbo",
];
const UNICOMPAPI_IMAGE_FIELDS: &[&str] = &["prompt", "size", "n", "response_format", "watermark"];
const UNICOMPAPI_IMAGE_EDIT_FIELDS: &[&str] = &["images", "prompt", "size", "response_format"];
const UNICOMPAPI_VIDEO_FIELDS: &[&str] = &[
    "images",
    "prompt",
    "size",
    "resolution",
    "duration",
    "seconds",
    "ratio",
    "generate_audio",
    "watermark",
];

fn unicompapi_adapter_parts(adapter_key: &str) -> Result<(&str, &str), String> {
    let parts = adapter_key.split(':').collect::<Vec<_>>();
    if parts.len() != 4 || parts[1] != "unicompapi" || parts[3] != "v1" {
        return Err("UniCompAPI adapter key is invalid".to_string());
    }
    let capability = parts[0];
    let model = parts[2];
    if model.is_empty()
        || model.len() > 256
        || model.trim() != model
        || model.chars().any(char::is_control)
    {
        return Err("UniCompAPI adapter model ID is invalid".to_string());
    }
    let models = match capability {
        "TEXT_TO_IMAGE" => UNICOMPAPI_TEXT_TO_IMAGE_MODELS,
        "REFERENCE_TO_IMAGE" => UNICOMPAPI_IMAGE_EDIT_MODELS,
        "TEXT_TO_VIDEO" => UNICOMPAPI_TEXT_TO_VIDEO_MODELS,
        "IMAGE_TO_VIDEO" => UNICOMPAPI_IMAGE_TO_VIDEO_MODELS,
        _ => return Err("UniCompAPI adapter capability is not supported".to_string()),
    };
    if !models.contains(&model) {
        return Err("UniCompAPI model is not registered for this capability".to_string());
    }
    Ok((capability, model))
}

fn unicompapi_adapter_model(adapter_key: &str) -> Result<&str, String> {
    unicompapi_adapter_parts(adapter_key).map(|(_, model)| model)
}

fn provider_region_target(provider_region: &str) -> Result<(&'static str, &'static str), String> {
    match provider_region {
        "global" => Ok(("vidu", "api.vidu.com")),
        "cn" => Ok(("vidu-cn", "api.vidu.cn")),
        _ => Err("Unsupported Vidu service region".to_string()),
    }
}

fn provider_target(adapter_key: &str, provider_region: &str) -> Result<ProviderTarget, String> {
    let (credential_provider, host) = provider_region_target(provider_region)?;
    let target = match adapter_key {
        "TEXT_TO_IMAGE:vidu:viduq2:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2image",
            model: "viduq2",
            allowed_fields: IMAGE_FIELDS,
        },
        "REFERENCE_TO_IMAGE:vidu:viduq2:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2image",
            model: "viduq2",
            allowed_fields: REFERENCE_IMAGE_FIELDS,
        },
        "REFERENCE_TO_IMAGE:vidu:viduq1:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2image",
            model: "viduq1",
            allowed_fields: REFERENCE_IMAGE_FIELDS,
        },
        "TEXT_TO_VIDEO:vidu:viduq3-pro:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/text2video",
            model: "viduq3-pro",
            allowed_fields: TEXT_VIDEO_FIELDS,
        },
        "REFERENCE_TO_VIDEO:vidu:viduq3:v2" | "IMAGE_TO_VIDEO:vidu:viduq3:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq3",
            allowed_fields: REFERENCE_VIDEO_FIELDS,
        },
        "REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq3-drama",
            allowed_fields: REFERENCE_VIDEO_FIELDS,
        },
        "START_END_TO_VIDEO:vidu:viduq3-pro:v2" | "IMAGE_TO_VIDEO:vidu:viduq3-pro:v2" => {
            ProviderTarget {
                credential_provider,
                host,
                path: "/ent/v2/start-end2video",
                model: "viduq3-pro",
                allowed_fields: Q3_VIDEO_FIELDS,
            }
        }
        "IMAGE_TO_VIDEO:vidu:vidu2.0:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/img2video",
            model: "vidu2.0",
            allowed_fields: V2_VIDEO_FIELDS,
        },
        _ => return Err("Adapter is not allowed to use a native provider credential".to_string()),
    };
    Ok(target)
}

struct MediaCredentialSelection {
    credential_subject: String,
    provider_region: String,
}

fn resolve_media_selection(
    adapter_key: &str,
    provider_profile_id: Option<&str>,
    provider_region: Option<&str>,
    state: &WorkerState,
) -> Result<MediaCredentialSelection, String> {
    let Some(profile_id) = provider_profile_id.filter(|value| !value.is_empty()) else {
        let region = provider_region.ok_or("A provider profile is required")?;
        let (credential_subject, _) = provider_region_target(region)?;
        return Ok(MediaCredentialSelection {
            credential_subject: credential_subject.to_string(),
            provider_region: region.to_string(),
        });
    };
    if !is_profile_id(profile_id) {
        return Err("Provider profile ID is invalid".to_string());
    }
    let normalized_profile_id = profile_id.to_ascii_lowercase();
    let profile_response = state.request(&serde_json::json!({
        "id": format!("media-profile-{normalized_profile_id}"),
        "protocolVersion": 1,
        "method": "provider.profile.get",
        "params": { "profileId": normalized_profile_id }
    }))?;
    let profile = worker_response_result(&profile_response)?;
    if profile.is_null() {
        return Err("Provider profile does not exist or is archived".to_string());
    }
    if profile.get("id").and_then(serde_json::Value::as_str) != Some(normalized_profile_id.as_str())
    {
        return Err("Worker returned a mismatched provider profile".to_string());
    }
    let provider_type = profile
        .get("providerType")
        .and_then(serde_json::Value::as_str)
        .ok_or("Provider profile is missing a provider type")?;
    let protocol = profile
        .get("protocol")
        .and_then(serde_json::Value::as_str)
        .ok_or("Provider profile is missing a protocol")?;
    if !((provider_type == "vidu" && protocol == "vidu-v2")
        || (provider_type == "unicompapi" && protocol == "openai-chat-completions"))
    {
        return Err("Provider profile is not a supported media connection".to_string());
    }
    if profile.get("enabled").and_then(serde_json::Value::as_bool) != Some(true)
        || profile
            .get("connectionStatus")
            .and_then(serde_json::Value::as_str)
            != Some("ready")
    {
        return Err("Provider profile is not ready for media generation".to_string());
    }
    let region = match (
        provider_type,
        profile.get("baseUrl").and_then(serde_json::Value::as_str),
    ) {
        ("vidu", Some("https://api.vidu.com")) => "global",
        ("vidu", Some("https://api.vidu.cn")) => "cn",
        ("unicompapi", Some("https://unicompapi.com/v1")) => "unicompapi",
        _ => return Err("Provider profile uses an unsupported media Base URL".to_string()),
    };
    let adapter_model = if provider_type == "unicompapi" {
        unicompapi_adapter_model(adapter_key)?
    } else {
        provider_target(adapter_key, region)?.model
    };
    let models_response = state.request(&serde_json::json!({
        "id": format!("media-models-{normalized_profile_id}"),
        "protocolVersion": 1,
        "method": "provider.model.list",
        "params": { "profileId": normalized_profile_id }
    }))?;
    let models = worker_response_result(&models_response)?
        .as_array()
        .ok_or("Worker returned an invalid provider model list")?;
    let required_capability = if ensure_video_adapter(adapter_key).is_ok() {
        "videoGeneration"
    } else if adapter_key.starts_with("REFERENCE_TO_IMAGE:unicompapi:") {
        "imageEditing"
    } else {
        "imageGeneration"
    };
    let matching_model = models.iter().any(|model| {
        model
            .get("remoteModelId")
            .and_then(serde_json::Value::as_str)
            == Some(adapter_model)
            && model.get("enabled").and_then(serde_json::Value::as_bool) == Some(true)
            && model
                .get("unavailableAt")
                .is_none_or(serde_json::Value::is_null)
            && model
                .pointer(&format!("/capabilities/{required_capability}"))
                .and_then(serde_json::Value::as_bool)
                == Some(true)
    });
    if !matching_model {
        return Err("Selected provider profile has no enabled model for this adapter".to_string());
    }
    Ok(MediaCredentialSelection {
        credential_subject: normalized_profile_id,
        provider_region: region.to_string(),
    })
}

fn worker_response_result(response: &serde_json::Value) -> Result<&serde_json::Value, String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return response
            .get("result")
            .ok_or("Worker response did not contain a result".to_string());
    }
    Err(response
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Worker rejected the provider operation")
        .chars()
        .take(500)
        .collect())
}

fn provider_payload(target: ProviderTarget, payload: serde_json::Value) -> Result<Vec<u8>, String> {
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    if object
        .keys()
        .any(|key| !target.allowed_fields.contains(&key.as_str()))
    {
        return Err("Provider payload contains a field not allowed by the adapter".to_string());
    }
    if object.values().any(|value| {
        !(value.is_string()
            || value.is_number()
            || value.is_boolean()
            || value
                .as_array()
                .is_some_and(|items| items.iter().all(serde_json::Value::is_string)))
    }) {
        return Err("Provider payload contains an unsupported value type".to_string());
    }
    object.insert(
        "model".to_string(),
        serde_json::Value::String(target.model.to_string()),
    );
    let encoded = serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to serialize provider payload: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".to_string());
    }
    Ok(encoded)
}

fn validate_payload_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    allowed_fields: &[&str],
) -> Result<(), String> {
    if object
        .keys()
        .any(|key| !allowed_fields.contains(&key.as_str()))
    {
        return Err("Provider payload contains a field not allowed by the adapter".to_string());
    }
    if object.values().any(|value| {
        !(value.is_string()
            || value.is_number()
            || value.is_boolean()
            || value
                .as_array()
                .is_some_and(|items| items.iter().all(serde_json::Value::is_string)))
    }) {
        return Err("Provider payload contains an unsupported value type".to_string());
    }
    Ok(())
}

fn unicompapi_payload(adapter_key: &str, payload: serde_json::Value) -> Result<Vec<u8>, String> {
    let (capability, model) = unicompapi_adapter_parts(adapter_key)?;
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    let allowed_fields = match capability {
        "TEXT_TO_IMAGE" => UNICOMPAPI_IMAGE_FIELDS,
        "REFERENCE_TO_IMAGE" => UNICOMPAPI_IMAGE_EDIT_FIELDS,
        "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO" => UNICOMPAPI_VIDEO_FIELDS,
        _ => return Err("UniCompAPI adapter capability is not supported".to_string()),
    };
    validate_payload_fields(&object, allowed_fields)?;

    if capability == "TEXT_TO_VIDEO" && object.contains_key("images") {
        return Err("UniCompAPI text-to-video does not accept an input image".to_string());
    }

    if matches!(capability, "REFERENCE_TO_IMAGE" | "IMAGE_TO_VIDEO") {
        let images = object
            .remove("images")
            .and_then(|value| value.as_array().cloned())
            .ok_or("UniCompAPI reference generation requires one input image")?;
        if images.len() != 1 {
            return Err("UniCompAPI reference generation requires one input image".to_string());
        }
        let image = images[0]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("UniCompAPI reference generation requires one input image")?;
        object.insert(
            "image".to_string(),
            serde_json::Value::String(image.to_string()),
        );
    }
    object.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    let encoded = serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to serialize provider payload: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".to_string());
    }
    Ok(encoded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHttpResponse {
    status: u32,
    body: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTaskSubmitResponse {
    status: u32,
    task_id: Option<String>,
    state: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCancelResponse {
    supported: bool,
    cancelled: bool,
    status: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBinaryDownloadResponse {
    path: String,
    content_type: Option<String>,
}

fn provider_task_path(task_id: &str) -> Result<String, String> {
    if task_id.is_empty()
        || task_id.len() > PROVIDER_TASK_ID_LIMIT
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Provider returned an invalid task id".to_string());
    }
    Ok(format!("/ent/v2/tasks/{task_id}/creations"))
}

fn provider_cancel_path(task_id: &str) -> Result<String, String> {
    provider_task_path(task_id)?;
    Ok(format!("/ent/v2/tasks/{task_id}/cancel"))
}

fn unicompapi_video_task_path(task_id: &str) -> Result<String, String> {
    provider_task_path(task_id)?;
    Ok(format!("/v1/videos/{task_id}"))
}

fn unicompapi_video_content_path(task_id: &str) -> Result<String, String> {
    provider_task_path(task_id)?;
    Ok(format!("/v1/videos/{task_id}/content"))
}

fn ensure_video_adapter(adapter_key: &str) -> Result<(), String> {
    match adapter_key {
        "TEXT_TO_VIDEO:vidu:viduq3-pro:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2"
        | "START_END_TO_VIDEO:vidu:viduq3-pro:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3-pro:v2"
        | "IMAGE_TO_VIDEO:vidu:vidu2.0:v2" => Ok(()),
        _ => match unicompapi_adapter_parts(adapter_key) {
            Ok(("TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO", _)) => Ok(()),
            _ => Err("Native video task commands require a registered video adapter".to_string()),
        },
    }
}

fn provider_task_id(body: &serde_json::Value) -> Option<&str> {
    body.get("task_id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| body.get("id").and_then(serde_json::Value::as_str))
        .or_else(|| {
            body.get("data")
                .and_then(|data| data.get("task_id").or_else(|| data.get("id")))
                .and_then(serde_json::Value::as_str)
        })
}

fn provider_state(body: &serde_json::Value) -> Option<&str> {
    body.get("state")
        .or_else(|| body.get("status"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            body.get("data")
                .and_then(|data| data.get("state").or_else(|| data.get("status")))
                .and_then(serde_json::Value::as_str)
        })
}

fn contains_image_source(value: &serde_json::Value) -> bool {
    find_creation_image_source(value).is_some()
}

fn find_creation_image_source(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::Array(values) => values.iter().find_map(find_creation_image_source),
        serde_json::Value::Object(values) => {
            for key in ["creations", "Creations"] {
                if let Some(serde_json::Value::Array(creations)) = values.get(key) {
                    for creation in creations {
                        if let Some(source) = creation_image_source(creation) {
                            return Some(source);
                        }
                    }
                }
            }
            values.values().find_map(find_creation_image_source)
        }
        _ => None,
    }
}

fn creation_image_source(value: &serde_json::Value) -> Option<&str> {
    let object = value.as_object()?;
    for key in [
        "url",
        "uri",
        "image_url",
        "imageUrl",
        "cover_url",
        "coverUrl",
    ] {
        if let Some(source) = object.get(key).and_then(serde_json::Value::as_str) {
            if is_image_source(source) {
                return Some(source);
            }
        }
    }
    None
}

fn is_image_source(value: &str) -> bool {
    value.starts_with("data:image/")
        || value.starts_with("http://")
        || value.starts_with("https://")
}

fn provider_task_error(body: &serde_json::Value) -> String {
    let code = body
        .get("err_code")
        .and_then(serde_json::Value::as_str)
        .or_else(|| body.get("error").and_then(serde_json::Value::as_str));
    match code {
        Some(code) if !code.is_empty() => format!("Provider task failed ({code})."),
        _ => "Provider task failed.".to_string(),
    }
}

#[tauri::command]
async fn provider_submit(
    adapter_key: String,
    payload: serde_json::Value,
    provider_profile_id: Option<String>,
    provider_region: Option<String>,
    state: tauri::State<'_, WorkerState>,
) -> Result<ProviderHttpResponse, String> {
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_submit_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.credential_subject,
            payload,
        )
    })
    .await
    .map_err(|error| format!("Native provider task failed: {error}"))?
}

#[tauri::command]
async fn provider_submit_task(
    adapter_key: String,
    payload: serde_json::Value,
    provider_profile_id: Option<String>,
    provider_region: Option<String>,
    state: tauri::State<'_, WorkerState>,
) -> Result<ProviderTaskSubmitResponse, String> {
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_submit_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.credential_subject,
            payload,
        )
    })
    .await
    .map_err(|error| format!("Native provider task submission failed: {error}"))?
}

fn provider_submit_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    credential_subject: &str,
    payload: serde_json::Value,
) -> Result<ProviderTaskSubmitResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if provider_region == "unicompapi" {
        let body = unicompapi_payload(adapter_key, payload)?;
        let secret = credential_read(credential_subject)?;
        let response = request_unicompapi_json(&secret, "POST", "/v1/videos", Some(&body))?;
        if response.status < 200 || response.status >= 300 {
            return Ok(ProviderTaskSubmitResponse {
                status: response.status,
                task_id: None,
                state: provider_state(&response.body).map(str::to_string),
            });
        }
        let task_id = provider_task_id(&response.body)
            .ok_or("Provider response did not contain a video task id")?;
        unicompapi_video_task_path(task_id)?;
        return Ok(ProviderTaskSubmitResponse {
            status: response.status,
            task_id: Some(task_id.to_string()),
            state: provider_state(&response.body).map(str::to_string),
        });
    }
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(credential_subject)?;
    let response = request_provider_json(target, &secret, "POST", target.path, Some(&body))?;
    if response.status < 200 || response.status >= 300 {
        return Ok(ProviderTaskSubmitResponse {
            status: response.status,
            task_id: None,
            state: provider_state(&response.body).map(str::to_string),
        });
    }
    let task_id = provider_task_id(&response.body)
        .ok_or("Provider response did not contain a video task id")?;
    provider_task_path(task_id)?;
    Ok(ProviderTaskSubmitResponse {
        status: response.status,
        task_id: Some(task_id.to_string()),
        state: provider_state(&response.body).map(str::to_string),
    })
}

#[tauri::command]
async fn provider_poll_task(
    adapter_key: String,
    task_id: String,
    provider_profile_id: Option<String>,
    provider_region: Option<String>,
    state: tauri::State<'_, WorkerState>,
) -> Result<ProviderHttpResponse, String> {
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_poll_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.credential_subject,
            &task_id,
        )
    })
    .await
    .map_err(|error| format!("Native provider task query failed: {error}"))?
}

fn provider_poll_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    credential_subject: &str,
    task_id: &str,
) -> Result<ProviderHttpResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if provider_region == "unicompapi" {
        unicompapi_adapter_model(adapter_key)?;
        let path = unicompapi_video_task_path(task_id)?;
        let secret = credential_read(credential_subject)?;
        return request_unicompapi_json(&secret, "GET", &path, None);
    }
    let target = provider_target(adapter_key, provider_region)?;
    let path = provider_task_path(task_id)?;
    let secret = credential_read(credential_subject)?;
    request_provider_json(target, &secret, "GET", &path, None)
}

#[tauri::command]
async fn provider_download_task(
    adapter_key: String,
    task_id: String,
    provider_profile_id: Option<String>,
    provider_region: Option<String>,
    state: tauri::State<'_, WorkerState>,
) -> Result<ProviderBinaryDownloadResponse, String> {
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_download_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.credential_subject,
            &task_id,
        )
    })
    .await
    .map_err(|error| format!("Native provider video download failed: {error}"))?
}

fn provider_download_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    credential_subject: &str,
    task_id: &str,
) -> Result<ProviderBinaryDownloadResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if provider_region != "unicompapi" {
        return Err(
            "This provider does not use the authenticated video download bridge".to_string(),
        );
    }
    unicompapi_adapter_model(adapter_key)?;
    let path = unicompapi_video_content_path(task_id)?;
    let secret = credential_read(credential_subject)?;
    let response = request_unicompapi_bytes(&secret, &path)?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Provider video download failed with HTTP {}",
            response.status
        ));
    }
    if response.body.is_empty() {
        return Err("Provider video download returned an empty body".to_string());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid")?
        .as_nanos();
    let directory = std::env::temp_dir().join("ai-video-workspace-unicompapi");
    create_dir_all(&directory)
        .map_err(|error| format!("Unable to create provider download directory: {error}"))?;
    let temporary_path = directory.join(format!("video-{}-{nonce}.mp4", std::process::id()));
    write(&temporary_path, &response.body)
        .map_err(|error| format!("Unable to store provider video download: {error}"))?;
    Ok(ProviderBinaryDownloadResponse {
        path: temporary_path.to_string_lossy().into_owned(),
        content_type: Some("video/mp4".to_string()),
    })
}

#[tauri::command]
async fn provider_cancel_task(
    adapter_key: String,
    task_id: String,
    provider_profile_id: Option<String>,
    provider_region: Option<String>,
    state: tauri::State<'_, WorkerState>,
) -> Result<ProviderCancelResponse, String> {
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_cancel_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.credential_subject,
            &task_id,
        )
    })
    .await
    .map_err(|error| format!("Native provider task cancellation failed: {error}"))?
}

fn provider_cancel_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    credential_subject: &str,
    task_id: &str,
) -> Result<ProviderCancelResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if provider_region == "unicompapi" {
        unicompapi_adapter_model(adapter_key)?;
        unicompapi_video_task_path(task_id)?;
        return Ok(ProviderCancelResponse {
            supported: false,
            cancelled: false,
            status: 0,
        });
    }
    let target = provider_target(adapter_key, provider_region)?;
    let path = provider_cancel_path(task_id)?;
    let body = serde_json::to_vec(&serde_json::json!({ "id": task_id }))
        .map_err(|error| format!("Unable to serialize provider cancellation: {error}"))?;
    let secret = credential_read(credential_subject)?;
    let response = request_provider_json(target, &secret, "POST", &path, Some(&body))?;
    Ok(ProviderCancelResponse {
        supported: true,
        cancelled: (200..300).contains(&response.status),
        status: response.status,
    })
}

fn provider_submit_blocking(
    adapter_key: &str,
    provider_region: &str,
    credential_subject: &str,
    payload: serde_json::Value,
) -> Result<ProviderHttpResponse, String> {
    if ensure_video_adapter(adapter_key).is_ok() {
        return Err("Video adapters must use the asynchronous provider task bridge".to_string());
    }
    if provider_region == "unicompapi" {
        let (capability, _) = unicompapi_adapter_parts(adapter_key)?;
        let path = match capability {
            "TEXT_TO_IMAGE" => "/v1/images/generations",
            "REFERENCE_TO_IMAGE" => "/v1/images/edits",
            _ => return Err("UniCompAPI adapter must use the matching media bridge".to_string()),
        };
        let body = unicompapi_payload(adapter_key, payload)?;
        let secret = credential_read(credential_subject)?;
        return request_unicompapi_json(&secret, "POST", path, Some(&body));
    }
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(credential_subject)?;
    let response = request_provider_json(target, &secret, "POST", target.path, Some(&body))?;
    if response.status < 200 || response.status >= 300 {
        return Ok(response);
    }
    if contains_image_source(&response.body) {
        return Ok(response);
    }

    let task_id = response
        .body
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Provider response did not contain an image or task id".to_string())?;
    let task_path = provider_task_path(task_id)?;
    let deadline = Instant::now() + PROVIDER_POLL_TIMEOUT;
    loop {
        let poll = request_provider_json(target, &secret, "GET", &task_path, None)?;
        if poll.status < 200 || poll.status >= 300 {
            return Ok(poll);
        }
        if contains_image_source(&poll.body) {
            return Ok(poll);
        }
        match poll.body.get("state").and_then(serde_json::Value::as_str) {
            Some("failed") => return Err(provider_task_error(&poll.body)),
            Some("success") => {
                return Err("Provider reported success without image output".to_string())
            }
            Some("created" | "queueing" | "processing") => {}
            Some(_) => return Err("Provider returned an unsupported task state".to_string()),
            None => {
                return Err(
                    "Provider polling response did not contain a task state or image output"
                        .to_string(),
                )
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Provider task timed out after {} seconds",
                PROVIDER_POLL_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(PROVIDER_POLL_INTERVAL.min(remaining));
    }
}

fn request_provider_json(
    target: ProviderTarget,
    secret: &CredentialSecret,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<ProviderHttpResponse, String> {
    let response = request_json(JsonHttpRequest {
        host: target.host,
        port: 443,
        secure: true,
        method,
        path,
        authorization_scheme: "Token",
        accept: "application/json",
        secret: secret.as_str()?,
        body,
        request_body_limit: PROVIDER_REQUEST_BODY_LIMIT,
        response_body_limit: PROVIDER_RESPONSE_BODY_LIMIT,
    })
    .map_err(|error| error.to_string())?;
    Ok(ProviderHttpResponse {
        status: response.status,
        body: response.body,
    })
}

fn request_unicompapi_json(
    secret: &CredentialSecret,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<ProviderHttpResponse, String> {
    if !matches!(
        path,
        "/v1/images/generations" | "/v1/images/edits" | "/v1/videos"
    ) && !path
        .strip_prefix("/v1/videos/")
        .is_some_and(|task_id| unicompapi_video_task_path(task_id).as_deref() == Ok(path))
    {
        return Err("UniCompAPI request path is not allowed".to_string());
    }
    let response = request_json(JsonHttpRequest {
        host: UNICOMPAPI_HOST,
        port: 443,
        secure: true,
        method,
        path,
        authorization_scheme: UNICOMPAPI_AUTHORIZATION_SCHEME,
        accept: "application/json",
        secret: secret.as_str()?,
        body,
        request_body_limit: PROVIDER_REQUEST_BODY_LIMIT,
        response_body_limit: UNICOMPAPI_RESPONSE_BODY_LIMIT,
    })
    .map_err(|error| error.to_string())?;
    Ok(ProviderHttpResponse {
        status: response.status,
        body: response.body,
    })
}

fn request_unicompapi_bytes(
    secret: &CredentialSecret,
    path: &str,
) -> Result<provider_http::RawHttpResponse, String> {
    let task_id = path
        .strip_prefix("/v1/videos/")
        .and_then(|value| value.strip_suffix("/content"))
        .ok_or("UniCompAPI video content path is not allowed")?;
    if unicompapi_video_content_path(task_id).as_deref() != Ok(path) {
        return Err("UniCompAPI video content path is not allowed".to_string());
    }
    request_bytes(JsonHttpRequest {
        host: UNICOMPAPI_HOST,
        port: 443,
        secure: true,
        method: "GET",
        path,
        authorization_scheme: UNICOMPAPI_AUTHORIZATION_SCHEME,
        accept: "video/mp4",
        secret: secret.as_str()?,
        body: None,
        request_body_limit: 1,
        response_body_limit: 512 * 1024 * 1024,
    })
    .map_err(|error| error.to_string())
}

struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<Result<String, String>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

impl WorkerProcess {
    #[cfg(test)]
    fn spawn() -> Result<Self, String> {
        Self::spawn_command(worker_command()?)
    }

    fn spawn_for_app(app_data_dir: &Path) -> Result<Self, String> {
        let mut command = worker_command()?;
        command.env("AI_VIDEO_APP_DATA_DIR", app_data_dir);
        Self::spawn_command(command)
    }

    fn spawn_command(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start worker: {error}"))?;
        let stdin = child.stdin.take().ok_or("Worker stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("Worker stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Worker stderr is unavailable")?;
        let (response_tx, responses) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = response_tx
                            .send(Err("Worker exited before returning a response".to_string()));
                        break;
                    }
                    Ok(_) => {
                        if response_tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = response_tx
                            .send(Err(format!("Failed to read worker response: {error}")));
                        break;
                    }
                }
            }
        });

        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let stderr_buffer = Arc::clone(&stderr_tail);
        thread::spawn(move || {
            let mut stderr = stderr;
            let mut chunk = [0_u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        if let Ok(mut tail) = stderr_buffer.lock() {
                            tail.extend_from_slice(&chunk[..length]);
                            if tail.len() > STDERR_TAIL_LIMIT {
                                let excess = tail.len() - STDERR_TAIL_LIMIT;
                                tail.drain(..excess);
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            responses,
            stderr_tail,
        })
    }

    fn request(&mut self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.request_with_timeout(request, WORKER_REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &mut self,
        request: &serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let payload = serde_json::to_string(request)
            .map_err(|error| format!("Failed to serialize worker request: {error}"))?;
        writeln!(self.stdin, "{payload}")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Failed to write worker request: {error}"))?;

        let line = match self.responses.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => return Err(self.with_diagnostics(error)),
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "Worker request timed out after {} ms; the Worker will be restarted",
                    timeout.as_millis()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(self.with_diagnostics("Worker response channel closed".to_string()));
            }
        };
        serde_json::from_str(&line)
            .map_err(|error| format!("Worker returned invalid JSON: {error}"))
    }

    fn with_diagnostics(&self, message: String) -> String {
        let diagnostics = self
            .stderr_tail
            .lock()
            .map(|tail| String::from_utf8_lossy(&tail).trim().to_string())
            .unwrap_or_default();
        if diagnostics.is_empty() {
            message
        } else {
            format!("{message}: {diagnostics}")
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(debug_assertions)]
fn worker_command() -> Result<Command, String> {
    let worker_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../worker")
        .canonicalize()
        .map_err(|_| {
            "Worker is not built. Run `pnpm --filter @ai-video/worker build`.".to_string()
        })?;
    let mut command = Command::new("node");
    command.current_dir(worker_directory).arg("dist/index.js");
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn worker_command() -> Result<Command, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate desktop executable: {error}"))?;
    let application_dir = executable
        .parent()
        .ok_or("Cannot locate application directory")?;
    let worker = bundled_worker_path(application_dir);
    Ok(Command::new(worker))
}

#[cfg(any(not(debug_assertions), test))]
fn bundled_worker_path(application_dir: &Path) -> PathBuf {
    application_dir.join(BUNDLED_WORKER_FILENAME)
}

struct WorkerState {
    process: Mutex<Option<WorkerProcess>>,
    app_data_dir: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviderMigrationEntry {
    source: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviderMigrationReport {
    entries: Vec<LegacyProviderMigrationEntry>,
}

struct LegacyProviderMigrationState(LegacyProviderMigrationReport);

impl WorkerState {
    fn new(app_data_dir: PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            app_data_dir,
        }
    }

    fn request(&self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let mut guard = self.process.lock().map_err(|_| "Worker lock is poisoned")?;
        if guard.is_none() {
            *guard = Some(WorkerProcess::spawn_for_app(&self.app_data_dir)?);
        }
        let result = guard
            .as_mut()
            .ok_or("Worker failed to start")?
            .request(request);
        if result.is_err() {
            *guard = None;
        }
        result
    }
}

#[tauri::command]
fn worker_request(
    request: serde_json::Value,
    state: tauri::State<'_, WorkerState>,
) -> Result<serde_json::Value, String> {
    state.request(&request)
}

fn migrate_legacy_provider_credentials(state: &WorkerState) -> LegacyProviderMigrationReport {
    LegacyProviderMigrationReport {
        entries: ["vidu", "vidu-cn"]
            .into_iter()
            .map(|source| migrate_legacy_provider_credential(state, source))
            .collect(),
    }
}

fn migrate_legacy_provider_credential(
    state: &WorkerState,
    source: &str,
) -> LegacyProviderMigrationEntry {
    let legacy_exists = match credential_exists(source) {
        Ok(value) => value,
        Err(error) => return migration_failure(source, None, error),
    };
    if !legacy_exists {
        return LegacyProviderMigrationEntry {
            source: source.to_string(),
            status: "not-found".to_string(),
            profile_id: None,
            message: None,
        };
    }
    let response = match state.request(&serde_json::json!({
        "id": format!("legacy-profile-migration-{source}"),
        "protocolVersion": 1,
        "method": "provider.profile.migrateLegacy",
        "params": { "source": source }
    })) {
        Ok(value) => value,
        Err(error) => return migration_failure(source, None, error),
    };
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let message = response
            .pointer("/error/message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Worker rejected the legacy provider migration")
            .to_string();
        return migration_failure(source, None, message);
    }
    let result = &response["result"];
    if result.get("state").and_then(serde_json::Value::as_str) == Some("archived") {
        return LegacyProviderMigrationEntry {
            source: source.to_string(),
            status: "archived".to_string(),
            profile_id: None,
            message: Some(
                "The prior migrated profile was deleted; the legacy credential remains available."
                    .to_string(),
            ),
        };
    }
    let Some(profile_id) = result
        .pointer("/profile/id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
    else {
        return migration_failure(source, None, "Migrated provider profile is missing an ID");
    };
    let profile_status = result
        .pointer("/profile/connectionStatus")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let target_exists = match credential_exists(&profile_id) {
        Ok(value) => value,
        Err(error) => return migration_failure(source, Some(profile_id), error),
    };
    if !target_exists {
        match credential_copy(source, &profile_id) {
            Ok(true) => {}
            Ok(false) => {
                return migration_failure(
                    source,
                    Some(profile_id),
                    "Legacy credential disappeared during migration",
                );
            }
            Err(error) => return migration_failure(source, Some(profile_id), error),
        }
    }
    if result.get("state").and_then(serde_json::Value::as_str) == Some("created")
        || profile_status == "draft"
    {
        let completion = state.request(&serde_json::json!({
            "id": format!("legacy-profile-ready-{source}"),
            "protocolVersion": 1,
            "method": "provider.connection.complete",
            "params": { "profileId": profile_id, "status": "ready" }
        }));
        match completion {
            Ok(value) if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) => {}
            Ok(value) => {
                let message = value
                    .pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Migrated profile could not be activated")
                    .to_string();
                return migration_failure(source, Some(profile_id), message);
            }
            Err(error) => return migration_failure(source, Some(profile_id), error),
        }
    }
    LegacyProviderMigrationEntry {
        source: source.to_string(),
        status: if target_exists {
            "existing"
        } else {
            "migrated"
        }
        .to_string(),
        profile_id: Some(profile_id),
        message: Some("The legacy credential was retained for rollback.".to_string()),
    }
}

fn migration_failure(
    source: &str,
    profile_id: Option<String>,
    message: impl Into<String>,
) -> LegacyProviderMigrationEntry {
    LegacyProviderMigrationEntry {
        source: source.to_string(),
        status: "failed".to_string(),
        profile_id,
        message: Some(message.into()),
    }
}

#[tauri::command]
fn provider_legacy_migration_status(
    state: tauri::State<'_, LegacyProviderMigrationState>,
) -> LegacyProviderMigrationReport {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            create_dir_all(&app_data_dir)?;
            let worker_state = WorkerState::new(app_data_dir);
            let migration_report = migrate_legacy_provider_credentials(&worker_state);
            app.manage(LegacyProviderMigrationState(migration_report));
            app.manage(worker_state);
            app.manage(LlmStreamState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            worker_request,
            credential_status,
            credential_set,
            credential_delete,
            provider_legacy_migration_status,
            provider_test_connection,
            llm_stream,
            llm_stream_cancel,
            provider_submit,
            provider_submit_task,
            provider_poll_task,
            provider_download_task,
            provider_cancel_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Video Workspace");
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_worker_path, contains_image_source, credential_target, ensure_credential_subject,
        ensure_video_adapter, is_profile_id, provider_cancel_path, provider_payload,
        provider_state, provider_target, provider_task_error, provider_task_id, provider_task_path,
        resolve_media_selection, unicompapi_adapter_model, unicompapi_payload,
        unicompapi_video_content_path, unicompapi_video_task_path, validate_credential_provider,
        WorkerProcess, WorkerState, BUNDLED_WORKER_FILENAME, PROVIDER_REQUEST_BODY_LIMIT,
        UNICOMPAPI_AUTHORIZATION_SCHEME, UNICOMPAPI_HOST,
    };
    use serde_json::json;
    use std::{
        fs::{create_dir_all, remove_dir_all},
        path::Path,
        process::Command,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn release_worker_filename_matches_tauri_external_binary() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let configured = config["bundle"]["externalBin"][0]
            .as_str()
            .expect("one external binary");
        let configured_name = Path::new(configured)
            .file_name()
            .and_then(|name| name.to_str())
            .expect("external binary filename");

        assert_eq!(BUNDLED_WORKER_FILENAME, format!("{configured_name}.exe"));
        assert_eq!(
            bundled_worker_path(Path::new(r"C:\Program Files\AI Video Workspace")),
            Path::new(r"C:\Program Files\AI Video Workspace\ai-video-worker.exe")
        );
    }

    #[test]
    fn worker_supports_health_and_sqlite_round_trips() {
        let mut worker = WorkerProcess::spawn().expect("worker should start");

        let health = worker
            .request(&json!({
                "id": "rust-health",
                "protocolVersion": 1,
                "method": "health",
                "params": {}
            }))
            .expect("health response should be valid");
        assert_eq!(health["ok"], true);
        assert_eq!(health["result"]["protocolVersion"], 1);

        let sqlite = worker
            .request(&json!({
                "id": "rust-sqlite",
                "protocolVersion": 1,
                "method": "sqlite.probe",
                "params": {}
            }))
            .expect("SQLite response should be valid");
        assert_eq!(sqlite["ok"], true);
        assert_eq!(sqlite["result"]["writeVerified"], true);
    }

    #[test]
    fn credential_provider_allowlist_rejects_unknown_targets() {
        assert!(validate_credential_provider("vidu").is_ok());
        assert!(validate_credential_provider("vidu-cn").is_ok());
        assert!(validate_credential_provider("123e4567-e89b-42d3-a456-426614174000").is_ok());
        assert!(is_profile_id("123e4567-e89b-42d3-a456-426614174000"));
        assert!(!is_profile_id("123e4567-e89b-12d3-a456-426614174000"));
        assert!(validate_credential_provider("../../project.sqlite").is_err());
    }

    #[test]
    fn profile_credentials_use_an_isolated_target_namespace() {
        let profile_id = "123e4567-e89b-42d3-a456-426614174000";
        let profile_target =
            String::from_utf16(&credential_target(profile_id).expect("valid UUID"))
                .expect("target should be UTF-16");
        let legacy_target = String::from_utf16(&credential_target("vidu").expect("legacy target"))
            .expect("target should be UTF-16");

        assert_eq!(
            profile_target,
            format!("com.ai-video.workspace:provider-profile:{profile_id}\0")
        );
        assert_eq!(legacy_target, "com.ai-video.workspace:vidu\0");
    }

    #[test]
    fn credential_subject_requires_an_active_registered_profile() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-profile-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state = WorkerState::new(app_data_dir.clone());
            let missing_id = "123e4567-e89b-42d3-a456-426614174000";
            assert!(ensure_credential_subject("vidu", &state).is_ok());
            assert!(ensure_credential_subject(missing_id, &state).is_err());

            let created = state
                .request(&json!({
                    "id": "rust-profile-create",
                    "protocolVersion": 1,
                    "method": "provider.profile.create",
                    "params": {
                        "name": "Rust credential bridge",
                        "category": "llm",
                        "providerType": "openai",
                        "accessType": "official",
                        "protocol": "openai-responses",
                        "baseUrl": "https://api.openai.com/v1"
                    }
                }))
                .expect("profile create response should be valid");
            assert_eq!(created["ok"], true);
            let profile_id = created["result"]["id"]
                .as_str()
                .expect("created profile should have an ID");
            assert!(ensure_credential_subject(profile_id, &state).is_ok());
            assert!(ensure_credential_subject(&profile_id.to_uppercase(), &state).is_ok());

            let archived = state
                .request(&json!({
                    "id": "rust-profile-archive",
                    "protocolVersion": 1,
                    "method": "provider.profile.archive",
                    "params": { "profileId": profile_id }
                }))
                .expect("profile archive response should be valid");
            assert_eq!(archived["ok"], true);
            assert!(ensure_credential_subject(profile_id, &state).is_err());
        }

        remove_dir_all(&app_data_dir).expect("temporary app data directory should be removed");
    }

    #[test]
    fn legacy_profile_migration_worker_method_is_idempotent() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-legacy-profile-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state = WorkerState::new(app_data_dir.clone());
            let first = state
                .request(&json!({
                    "id": "rust-legacy-profile-first",
                    "protocolVersion": 1,
                    "method": "provider.profile.migrateLegacy",
                    "params": { "source": "vidu-cn" }
                }))
                .expect("first migration response should be valid");
            assert_eq!(first["ok"], true);
            assert_eq!(first["result"]["state"], "created");
            assert_eq!(first["result"]["profile"]["migrationSource"], "vidu-cn");
            let profile_id = first["result"]["profile"]["id"]
                .as_str()
                .expect("migrated profile should have an ID");

            let second = state
                .request(&json!({
                    "id": "rust-legacy-profile-second",
                    "protocolVersion": 1,
                    "method": "provider.profile.migrateLegacy",
                    "params": { "source": "vidu-cn" }
                }))
                .expect("second migration response should be valid");
            assert_eq!(second["ok"], true);
            assert_eq!(second["result"]["state"], "existing");
            assert_eq!(second["result"]["profile"]["id"], profile_id);
        }

        remove_dir_all(&app_data_dir).expect("temporary app data directory should be removed");
    }

    #[test]
    fn media_profile_resolution_requires_a_ready_vidu_profile_and_enabled_model() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-media-profile-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state = WorkerState::new(app_data_dir.clone());
            let created = state
                .request(&json!({
                    "id": "rust-media-profile-create",
                    "protocolVersion": 1,
                    "method": "provider.profile.create",
                    "params": {
                        "name": "Vidu China A",
                        "category": "multi",
                        "providerType": "vidu",
                        "accessType": "official",
                        "protocol": "vidu-v2",
                        "baseUrl": "https://api.vidu.cn"
                    }
                }))
                .expect("profile create response should be valid");
            let profile_id = created["result"]["id"]
                .as_str()
                .expect("created profile should have an ID");
            assert!(resolve_media_selection(
                "TEXT_TO_IMAGE:vidu:viduq2:v2",
                Some(profile_id),
                None,
                &state
            )
            .is_err());

            let completed = state
                .request(&json!({
                    "id": "rust-media-profile-ready",
                    "protocolVersion": 1,
                    "method": "provider.connection.complete",
                    "params": { "profileId": profile_id, "status": "ready" }
                }))
                .expect("profile completion response should be valid");
            assert_eq!(completed["ok"], true);
            let selection = resolve_media_selection(
                "TEXT_TO_IMAGE:vidu:viduq2:v2",
                Some(profile_id),
                None,
                &state,
            )
            .expect("ready Vidu profile should resolve");
            assert_eq!(selection.credential_subject, profile_id);
            assert_eq!(selection.provider_region, "cn");

            let q2 = completed["result"]["models"]
                .as_array()
                .expect("built-in model list")
                .iter()
                .find(|model| model["remoteModelId"] == "viduq2")
                .expect("Vidu Q2 model");
            let disabled = state
                .request(&json!({
                    "id": "rust-media-model-disable",
                    "protocolVersion": 1,
                    "method": "provider.model.update",
                    "params": {
                        "profileId": profile_id,
                        "modelId": q2["id"],
                        "displayName": q2["displayName"],
                        "capabilities": q2["capabilities"],
                        "enabled": false
                    }
                }))
                .expect("model update response should be valid");
            assert_eq!(disabled["ok"], true);
            assert!(resolve_media_selection(
                "TEXT_TO_IMAGE:vidu:viduq2:v2",
                Some(profile_id),
                None,
                &state
            )
            .is_err());
        }

        remove_dir_all(&app_data_dir).expect("temporary app data directory should be removed");
    }

    #[test]
    fn unicompapi_media_resolution_requires_synced_enabled_exact_capabilities() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-unicompapi-profile-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state = WorkerState::new(app_data_dir.clone());
            let created = state
                .request(&json!({
                    "id": "rust-unicompapi-profile-create",
                    "protocolVersion": 1,
                    "method": "provider.profile.create",
                    "params": {
                        "name": "UniCompAPI Rust",
                        "category": "multi",
                        "providerType": "unicompapi",
                        "accessType": "official",
                        "protocol": "openai-chat-completions",
                        "baseUrl": "https://unicompapi.com/v1"
                    }
                }))
                .expect("profile create response should be valid");
            let profile_id = created["result"]["id"]
                .as_str()
                .expect("created profile should have an ID");
            let completed = state
                .request(&json!({
                    "id": "rust-unicompapi-profile-ready",
                    "protocolVersion": 1,
                    "method": "provider.connection.complete",
                    "params": {
                        "profileId": profile_id,
                        "status": "ready",
                        "models": [
                            { "id": "qwen-image", "displayName": "Qwen Image" },
                            { "id": "qwen-image-edit-2509", "displayName": "Qwen Image Edit" },
                            { "id": "kling-v3-turbo", "displayName": "Kling v3 Turbo" },
                            { "id": "vendor-experimental-model", "displayName": "Experimental" }
                        ]
                    }
                }))
                .expect("connection completion response should be valid");
            assert_eq!(completed["ok"], true);
            let models = completed["result"]["models"]
                .as_array()
                .expect("synced model list");
            assert!(models.iter().all(|model| model["enabled"] == false));
            let unknown = models
                .iter()
                .find(|model| model["remoteModelId"] == "vendor-experimental-model")
                .expect("unknown model should be synchronized");
            assert!(unknown["capabilities"]
                .as_object()
                .expect("capability object")
                .values()
                .all(|value| value.as_bool() == Some(false)));
            assert!(resolve_media_selection(
                "TEXT_TO_IMAGE:unicompapi:qwen-image:v1",
                Some(profile_id),
                None,
                &state
            )
            .is_err());

            for remote_model_id in ["qwen-image", "qwen-image-edit-2509", "kling-v3-turbo"] {
                let model = models
                    .iter()
                    .find(|model| model["remoteModelId"] == remote_model_id)
                    .expect("known model should be synchronized");
                let updated = state
                    .request(&json!({
                        "id": format!("rust-unicompapi-enable-{remote_model_id}"),
                        "protocolVersion": 1,
                        "method": "provider.model.update",
                        "params": {
                            "profileId": profile_id,
                            "modelId": model["id"],
                            "displayName": model["displayName"],
                            "capabilities": model["capabilities"],
                            "enabled": true
                        }
                    }))
                    .expect("model update response should be valid");
                assert_eq!(updated["ok"], true);
            }

            for adapter_key in [
                "TEXT_TO_IMAGE:unicompapi:qwen-image:v1",
                "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit-2509:v1",
                "TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1",
                "IMAGE_TO_VIDEO:unicompapi:kling-v3-turbo:v1",
            ] {
                let selection =
                    resolve_media_selection(adapter_key, Some(profile_id), None, &state)
                        .expect("enabled exact-capability model should resolve");
                assert_eq!(selection.credential_subject, profile_id);
                assert_eq!(selection.provider_region, "unicompapi");
            }
            assert!(resolve_media_selection(
                "TEXT_TO_VIDEO:unicompapi:qwen-image:v1",
                Some(profile_id),
                None,
                &state
            )
            .is_err());
        }

        remove_dir_all(&app_data_dir).expect("temporary app data directory should be removed");
    }

    #[test]
    fn provider_bridge_is_bound_to_an_exact_adapter_and_injects_its_model() {
        let target = provider_target("START_END_TO_VIDEO:vidu:viduq3-pro:v2", "global")
            .expect("known adapter should resolve");
        assert_eq!(target.host, "api.vidu.com");
        assert_eq!(target.path, "/ent/v2/start-end2video");
        let body = provider_payload(
            target,
            json!({"images": ["https://example.com/start.png", "https://example.com/end.png"], "duration": 5}),
        )
        .expect("adapter payload should serialize");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(parsed["model"], "viduq3-pro");
        let reference = provider_target("REFERENCE_TO_VIDEO:vidu:viduq3:v2", "global")
            .expect("reference video adapter should resolve");
        assert_eq!(reference.path, "/ent/v2/reference2video");
        assert_eq!(reference.model, "viduq3");
        let drama = provider_target("REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2", "global")
            .expect("Q3-Drama reference video adapter should resolve");
        assert_eq!(drama.path, "/ent/v2/reference2video");
        let drama_body = provider_payload(
            drama,
            json!({
                "images": ["https://example.com/reference.png"],
                "prompt": "dialogue scene",
                "duration": 8,
                "aspect_ratio": "16:9",
                "resolution": "1080p",
                "audio": true
            }),
        )
        .expect("Q3-Drama payload should serialize");
        let parsed_drama: serde_json::Value =
            serde_json::from_slice(&drama_body).expect("valid Q3-Drama JSON");
        assert_eq!(parsed_drama["model"], "viduq3-drama");
        let text = provider_target("TEXT_TO_VIDEO:vidu:viduq3-pro:v2", "global")
            .expect("text video adapter should resolve");
        assert_eq!(text.path, "/ent/v2/text2video");
        assert_eq!(text.model, "viduq3-pro");
        assert!(provider_payload(text, json!({"prompt": "frame", "images": []})).is_err());
        assert!(provider_target("START_END_TO_VIDEO:evil:viduq3-pro:v2", "global").is_err());
    }

    #[test]
    fn provider_bridge_routes_domestic_region_to_domestic_credential_target() {
        let target = provider_target("TEXT_TO_IMAGE:vidu:viduq2:v2", "cn")
            .expect("domestic region should resolve");
        assert_eq!(target.host, "api.vidu.cn");
        assert_eq!(target.credential_provider, "vidu-cn");
        assert!(provider_target("TEXT_TO_IMAGE:vidu:viduq2:v2", "unknown").is_err());
    }

    #[test]
    fn provider_bridge_rejects_credential_and_endpoint_fields() {
        let target = provider_target("TEXT_TO_IMAGE:vidu:viduq2:v2", "global")
            .expect("known adapter should resolve");
        assert!(provider_payload(target, json!({"prompt": "frame", "apiKey": "secret"})).is_err());
        assert!(provider_payload(
            target,
            json!({"prompt": "frame", "endpoint": "https://attacker.invalid"})
        )
        .is_err());
    }

    #[test]
    fn provider_bridge_accepts_bounded_data_urls_and_rejects_oversized_json() {
        let target = provider_target("REFERENCE_TO_IMAGE:vidu:viduq2:v2", "global")
            .expect("known adapter should resolve");
        assert!(provider_payload(
            target,
            json!({
                "images": ["data:image/png;base64,iVBORw0KGgo="],
                "prompt": "frame",
                "aspect_ratio": "16:9",
                "resolution": "1080p"
            })
        )
        .is_ok());

        let oversized = "x".repeat(PROVIDER_REQUEST_BODY_LIMIT);
        let error = provider_payload(target, json!({ "prompt": oversized }))
            .expect_err("oversized request must be rejected");
        assert!(error.contains("native transport limit"));
    }

    #[test]
    fn unicompapi_bridge_preserves_exact_registered_model_ids() {
        let adapter_key = "TEXT_TO_IMAGE:unicompapi:doubao-seedream-5-0-260128:v1";
        assert_eq!(
            unicompapi_adapter_model(adapter_key).expect("registered model should resolve"),
            "doubao-seedream-5-0-260128"
        );
        let body = unicompapi_payload(
            adapter_key,
            json!({"prompt": "frame", "size": "1024x1024", "n": 1}),
        )
        .expect("image request should serialize");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(parsed["model"], "doubao-seedream-5-0-260128");
        assert_eq!(parsed["prompt"], "frame");
        assert_eq!(UNICOMPAPI_HOST, "unicompapi.com");
        assert_eq!(UNICOMPAPI_AUTHORIZATION_SCHEME, "Bearer");
    }

    #[test]
    fn unicompapi_bridge_projects_one_reference_image() {
        let image = "data:image/png;base64,iVBORw0KGgo=";
        let edit = unicompapi_payload(
            "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit-2509:v1",
            json!({"images": [image], "prompt": "remove the sign"}),
        )
        .expect("image edit request should serialize");
        let parsed_edit: serde_json::Value =
            serde_json::from_slice(&edit).expect("valid image edit JSON");
        assert_eq!(parsed_edit["image"], image);
        assert!(parsed_edit.get("images").is_none());

        let video = unicompapi_payload(
            "IMAGE_TO_VIDEO:unicompapi:kling-v3-turbo:v1",
            json!({"images": [image], "prompt": "camera push", "duration": 5}),
        )
        .expect("image-to-video request should serialize");
        let parsed_video: serde_json::Value =
            serde_json::from_slice(&video).expect("valid video JSON");
        assert_eq!(parsed_video["image"], image);
        assert_eq!(parsed_video["model"], "kling-v3-turbo");
        assert!(parsed_video.get("images").is_none());
    }

    #[test]
    fn unicompapi_bridge_rejects_unknown_models_and_adapter_injection() {
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:unknown:v1").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:evil:qwen-image:v1").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:qwen-image:v1:extra").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_VIDEO:unicompapi:qwen-image:v1").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:qwen-image\n:v1").is_err());
        assert!(unicompapi_payload(
            "TEXT_TO_IMAGE:unicompapi:qwen-image:v1",
            json!({"prompt": "frame", "apiKey": "secret"})
        )
        .is_err());
        assert!(unicompapi_payload(
            "IMAGE_TO_VIDEO:unicompapi:kling-v3-turbo:v1",
            json!({"images": ["one", "two"], "prompt": "frame"})
        )
        .is_err());
        assert!(unicompapi_payload(
            "TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1",
            json!({"images": ["https://example.com/frame.png"], "prompt": "frame"})
        )
        .is_err());
    }

    #[test]
    fn provider_task_path_accepts_safe_ids_and_rejects_path_injection() {
        assert_eq!(
            provider_task_path("task-123.A").expect("safe task id"),
            "/ent/v2/tasks/task-123.A/creations"
        );
        assert!(provider_task_path("../secrets").is_err());
        assert!(provider_task_path("task/123").is_err());
        assert!(provider_task_path("").is_err());
        assert_eq!(
            provider_cancel_path("task-123.A").expect("safe cancellation id"),
            "/ent/v2/tasks/task-123.A/cancel"
        );
        assert!(provider_cancel_path("../secrets").is_err());
        assert_eq!(
            unicompapi_video_task_path("video-123.A").expect("safe UniCompAPI video id"),
            "/v1/videos/video-123.A"
        );
        assert!(unicompapi_video_task_path("../secrets").is_err());
        assert_eq!(
            unicompapi_video_content_path("video-123.A").expect("safe UniCompAPI video content id"),
            "/v1/videos/video-123.A/content"
        );
        assert!(unicompapi_video_content_path("../secrets").is_err());
    }

    #[test]
    fn video_task_contract_extracts_only_declared_task_fields() {
        assert!(ensure_video_adapter("TEXT_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2").is_ok());
        assert!(ensure_video_adapter("START_END_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3:v2").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
        assert!(ensure_video_adapter("TEXT_TO_VIDEO:unicompapi:viduq3-pro:v1").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:unicompapi:viduq3:v1").is_ok());
        assert!(ensure_video_adapter("TEXT_TO_IMAGE:vidu:viduq2:v2").is_err());
        assert_eq!(
            provider_task_id(&json!({"task_id": "task-direct"})),
            Some("task-direct")
        );
        assert_eq!(
            provider_task_id(&json!({"data": {"task_id": "task-nested"}})),
            Some("task-nested")
        );
        assert_eq!(
            provider_task_id(&json!({"id": "video-direct"})),
            Some("video-direct")
        );
        assert_eq!(
            provider_task_id(&json!({"data": {"id": "video-nested"}})),
            Some("video-nested")
        );
        assert_eq!(
            provider_state(&json!({"data": {"status": "queueing"}})),
            Some("queueing")
        );
        assert_eq!(provider_task_id(&json!({"input": {"id": "wrong"}})), None);
    }

    #[test]
    fn provider_polling_requires_a_creation_output_source_on_success() {
        assert!(contains_image_source(&json!({
            "state": "success",
            "creations": [{ "url": "https://cdn.example/image.png" }]
        })));
        assert!(contains_image_source(&json!({
            "data": {
                "creations": [{ "cover_url": "data:image/png;base64,iVBORw0KGgo=" }]
            }
        })));
        assert!(!contains_image_source(&json!({
            "state": "processing",
            "input": { "images": ["https://cdn.example/input.png"] }
        })));
        assert!(!contains_image_source(&json!({ "state": "processing" })));
        assert_eq!(
            provider_task_error(&json!({ "state": "failed", "err_code": "quota" })),
            "Provider task failed (quota)."
        );
    }

    #[test]
    fn worker_stderr_is_drained_while_waiting_for_stdout() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "process.stdin.once('data',()=>{process.stderr.write('x'.repeat(1024*1024),()=>process.stdout.write('{\"ok\":true}\\n'))})",
        ]);
        let mut worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let result = worker
            .request_with_timeout(&json!({"id": "stderr"}), Duration::from_secs(5))
            .expect("stderr output must not block the response");

        assert_eq!(result["ok"], true);
    }

    #[test]
    fn worker_request_timeout_is_bounded() {
        let mut command = Command::new("node");
        command.args(["-e", "process.stdin.resume(); setInterval(()=>{}, 1000)"]);
        let mut worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let error = worker
            .request_with_timeout(&json!({"id": "timeout"}), Duration::from_millis(50))
            .expect_err("fixture must time out");

        assert!(error.contains("timed out after 50 ms"));
        assert!(error.contains("restarted"));
    }
}
