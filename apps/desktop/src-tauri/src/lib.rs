#[cfg(test)]
mod context_e2e;
#[cfg(test)]
use std::sync::mpsc::Receiver;
use std::{
    borrow::Cow,
    fs::{create_dir_all, read_dir, remove_file, write, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use tauri::Manager;

mod credential_store;
mod dubbing_provider;
mod llm_stream;
mod model_contract;
mod novel_import;
mod official_video;
mod provider_connector;
mod provider_http;
mod request_guard;
mod research_bridge;
mod schema_validation;

use credential_store::{
    credential_copy, credential_delete, credential_exists, credential_read, credential_set,
    credential_status, is_profile_id, CredentialSecret,
};
#[cfg(test)]
use credential_store::{
    credential_target, ensure_credential_subject, validate_credential_provider,
};
use llm_stream::{llm_stream, llm_stream_cancel, LlmStreamState};
use novel_import::novel_import;
use provider_connector::provider_test_connection;
use provider_http::{
    assert_provider_output_host, parse_public_https_url, request_bytes, request_json,
    request_public_bytes, JsonHttpRequest, PublicHttpRequest,
};
use research_bridge::NativeResearchBridge;

const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const VOICE_REFERENCE_WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(13 * 60);
static MODEL_INPUT_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static OPENAI_VIDEO_MULTIPART_ID: AtomicUsize = AtomicUsize::new(0);
pub(crate) fn model_input_root() -> Option<PathBuf> {
    MODEL_INPUT_ROOT.get().cloned().or_else(|| {
        std::env::var("AI_VIDEO_MEDIA_INPUT_ROOT")
            .ok()
            .map(PathBuf::from)
    })
}
const MEDIA_WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const SIDECAR_ENVELOPE_MAX_BYTES: usize = 2 * 1024 * 1024;
const MODEL_REQUEST_ENVELOPE_MAX_BYTES: usize = 64 * 1024 * 1024;
const STDERR_TAIL_LIMIT: usize = 16 * 1024;
const PROVIDER_REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const PROVIDER_RESPONSE_BODY_LIMIT: usize = 2 * 1024 * 1024;
const UNICOMPAPI_IMAGE_INPUT_LIMIT: usize = 20 * 1024 * 1024;
const NATIVE_IMAGE_OUTPUT_LIMIT: usize = 25 * 1024 * 1024;
const NATIVE_IMAGE_RESULT_LIMIT: usize = 4;
const NATIVE_VIDEO_OUTPUT_LIMIT: usize = 512 * 1024 * 1024;
// Four maximum-size Base64 results need roughly 134 MiB before externalization.
const UNICOMPAPI_RESPONSE_BODY_LIMIT: usize = 140 * 1024 * 1024;
const NATIVE_IMAGE_STALE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const PROVIDER_POLL_INTERVAL: Duration = Duration::from_secs(1);
const PROVIDER_POLL_TIMEOUT: Duration = Duration::from_secs(120);
const PROVIDER_TASK_ID_LIMIT: usize = 256;
const MARKDOWN_IMPORT_LIMIT: u64 = 5 * 1024 * 1024;
const RUNTIME_EXIT_GRACE: Duration = Duration::from_secs(10);
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
const REFERENCE_VIDEO_NO_OFF_PEAK_FIELDS: &[&str] = &[
    "images",
    "prompt",
    "duration",
    "aspect_ratio",
    "resolution",
    "audio",
    "seed",
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

fn unicompapi_capability_template(capability: &str) -> Option<&'static str> {
    match capability {
        "TEXT_TO_IMAGE" => Some("openai-compatible-image"),
        "REFERENCE_TO_IMAGE" => Some("qwen-image-edit"),
        "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO" => Some("openai-compatible-video"),
        "REFERENCE_TO_VIDEO" => Some("vidu-compatible-reference"),
        "START_END_TO_VIDEO" => Some("vidu-compatible-start-end"),
        _ => None,
    }
}

fn unicompapi_template_capabilities(template: &str) -> Option<&'static [&'static str]> {
    match template {
        "openai-compatible-image" => Some(&["TEXT_TO_IMAGE"]),
        "qwen-image-edit" => Some(&["REFERENCE_TO_IMAGE"]),
        "openai-compatible-video" => Some(&["TEXT_TO_VIDEO", "IMAGE_TO_VIDEO"]),
        "vidu-compatible-reference" => Some(&["REFERENCE_TO_VIDEO"]),
        "vidu-compatible-start-end" => Some(&["START_END_TO_VIDEO"]),
        _ => None,
    }
}

struct UniCompAdapterParts<'a> {
    capability: &'a str,
    token: &'a str,
    template: Option<&'a str>,
}

fn parse_unicompapi_adapter_key(adapter_key: &str) -> Result<UniCompAdapterParts<'_>, String> {
    let parts = adapter_key.split(':').collect::<Vec<_>>();
    if parts.len() == 4
        && parts[1] == "unicompapi"
        && model_contract::is_contract_adapter(adapter_key)
    {
        model_contract::contract(adapter_key)?;
        return Ok(UniCompAdapterParts {
            capability: parts[0],
            token: parts[2],
            template: None,
        });
    }
    if parts.len() != 4 || parts[1] != "unicompapi" || parts[3] != "v1" {
        return Err("UniCompAPI adapter key is invalid".to_string());
    }
    let capability = parts[0];
    let token = parts[2];
    if token.is_empty()
        || token.len() > 256
        || token.trim() != token
        || token.chars().any(char::is_control)
    {
        return Err("UniCompAPI adapter token is invalid".to_string());
    }
    if unicompapi_capability_template(capability).is_none() {
        return Err("UniCompAPI adapter capability is not supported".to_string());
    }
    if let Some(supported) = unicompapi_template_capabilities(token) {
        if !supported.contains(&capability) {
            return Err("UniCompAPI template is not registered for this capability".to_string());
        }
        return Ok(UniCompAdapterParts {
            capability,
            token,
            template: Some(token),
        });
    }
    Ok(UniCompAdapterParts {
        capability,
        token,
        template: None,
    })
}

fn unicompapi_adapter_parts(adapter_key: &str) -> Result<(&str, &str), String> {
    let parsed = parse_unicompapi_adapter_key(adapter_key)?;
    Ok((parsed.capability, parsed.token))
}

fn unicompapi_adapter_model(adapter_key: &str) -> Result<&str, String> {
    unicompapi_adapter_parts(adapter_key).map(|(_, token)| token)
}

fn unicompapi_submit_template<'a>(adapter_key: &'a str) -> Result<(&'a str, &'a str), String> {
    let parsed = parse_unicompapi_adapter_key(adapter_key)?;
    let template = parsed
        .template
        .ok_or_else(|| "UniCompAPI adapter must use a registered parameter template".to_string())?;
    Ok((parsed.capability, template))
}

fn validate_remote_model_id(remote_model_id: &str) -> Result<(), String> {
    if remote_model_id.is_empty()
        || remote_model_id.len() > 256
        || remote_model_id.trim() != remote_model_id
        || remote_model_id.chars().any(char::is_control)
    {
        return Err("Provider remote model ID is invalid".to_string());
    }
    Ok(())
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
        "REFERENCE_TO_VIDEO:vidu:viduq3:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-ad:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-turbo:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: if adapter_key.contains(":viduq3-ad:") {
                "viduq3-ad"
            } else if adapter_key.contains(":viduq3-turbo:") {
                "viduq3-turbo"
            } else {
                "viduq3"
            },
            allowed_fields: REFERENCE_VIDEO_FIELDS,
        },
        "REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq3-drama",
            allowed_fields: REFERENCE_VIDEO_FIELDS,
        },
        "REFERENCE_TO_VIDEO:vidu:viduq3-mix:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq3-mix",
            allowed_fields: REFERENCE_VIDEO_NO_OFF_PEAK_FIELDS,
        },
        "REFERENCE_TO_VIDEO:vidu:viduq2-pro:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq2-pro",
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
    remote_model_id: String,
    base_url: String,
}

fn openai_images_provider(adapter_key: &str) -> Option<&'static str> {
    let parts = adapter_key.split(':').collect::<Vec<_>>();
    if parts.len() != 4
        || parts[0] != "TEXT_TO_IMAGE"
        || parts[2] != "openai-images"
        || parts[3] != "v1"
    {
        return None;
    }
    match parts[1] {
        "openai" => Some("openai"),
        "custom" => Some("custom"),
        _ => None,
    }
}

fn is_custom_openai_video_adapter(adapter_key: &str) -> bool {
    let parts = adapter_key.split(':').collect::<Vec<_>>();
    parts.len() == 4
        && matches!(parts[0], "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO")
        && parts[1] == "custom"
        && parts[2] == "openai-compatible-video"
        && parts[3] == "v1"
}

fn resolve_media_selection(
    adapter_key: &str,
    provider_profile_id: Option<&str>,
    provider_region: Option<&str>,
    state: &WorkerState,
) -> Result<MediaCredentialSelection, String> {
    let profile_id = provider_profile_id
        .filter(|value| !value.is_empty())
        .ok_or("A provider profile is required for media generation")?;
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
    let access_type = profile
        .get("accessType")
        .and_then(serde_json::Value::as_str)
        .ok_or("Provider profile is missing its access type")?;
    let openai_images = openai_images_provider(adapter_key);
    let custom_openai_video = is_custom_openai_video_adapter(adapter_key);
    let official_video_profile = matches!(
        (provider_type, protocol),
        ("wan-video", "dashscope-video")
            | ("seedance-video", "seedance-video")
            | ("minimax-video", "minimax-video-v2")
    );
    if !((provider_type == "vidu" && protocol == "vidu-v2")
        || official_video_profile
        || (provider_type == "unicompapi" && protocol == "openai-chat-completions")
        || (provider_type == "openai"
            && protocol == "openai-responses"
            && access_type == "official"
            && openai_images == Some("openai"))
        || (provider_type == "custom"
            && access_type == "custom"
            && matches!(protocol, "openai-responses" | "openai-chat-completions")
            && (openai_images == Some("custom") || custom_openai_video)))
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
        ("wan-video", Some("https://dashscope.aliyuncs.com"))
        | ("seedance-video", Some("https://ark.cn-beijing.volces.com"))
        | ("minimax-video", Some("https://api.minimax.cn")) => "cn",
        ("wan-video", Some(url)) if provider_http::wan_video_host(url).is_some() => "cn",
        ("openai", Some("https://api.openai.com/v1")) => "global",
        ("custom", Some(url)) if access_type == "custom" => {
            let target = openai_images_target(url, "custom")?;
            provider_http::assert_provider_api_host(&target.host)?;
            "global"
        }
        _ => return Err("Provider profile uses an unsupported media Base URL".to_string()),
    };
    if let Some(requested_region) = provider_region.filter(|value| !value.is_empty()) {
        if requested_region != region {
            return Err(
                "Selected provider profile does not match the requested region".to_string(),
            );
        }
    }
    let unicomp_parts = if provider_type == "unicompapi" {
        Some(parse_unicompapi_adapter_key(adapter_key)?)
    } else {
        None
    };
    let official_contract = if official_video_profile {
        if adapter_key.split(':').nth(1) != Some(provider_type) {
            return Err("Official provider and adapter do not match".into());
        }
        Some(model_contract::contract(adapter_key)?)
    } else {
        None
    };
    let adapter_model = if openai_images.is_some() || custom_openai_video {
        ""
    } else if let Some(contract) = official_contract.as_ref() {
        contract["officialModelName"]
            .as_str()
            .ok_or("Official model name is missing")?
    } else if provider_type == "unicompapi" {
        unicomp_parts
            .as_ref()
            .map(|parts| parts.token)
            .unwrap_or_default()
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
    let matching_model = models.iter().find(|model| {
        model.get("enabled").and_then(serde_json::Value::as_bool) == Some(true)
            && model
                .get("unavailableAt")
                .is_none_or(serde_json::Value::is_null)
            && model
                .pointer(&format!("/capabilities/{required_capability}"))
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            && if let Some(parts) = unicomp_parts.as_ref() {
                if model_contract::is_contract_adapter(adapter_key) {
                    model
                        .get("contractStatus")
                        .and_then(serde_json::Value::as_str)
                        == Some("enabled")
                        && model
                            .get("remoteModelId")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|id| model_contract::matches_model(adapter_key, id))
                } else if let Some(template) = parts.template {
                    model
                        .get("parameterTemplateKey")
                        .and_then(serde_json::Value::as_str)
                        == Some(template)
                } else {
                    model
                        .get("remoteModelId")
                        .and_then(serde_json::Value::as_str)
                        == Some(parts.token)
                }
            } else if openai_images == Some("openai") {
                model
                    .get("remoteModelId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| id.to_ascii_lowercase().starts_with("gpt-image-"))
            } else if openai_images == Some("custom") {
                true
            } else if custom_openai_video {
                true
            } else {
                model
                    .get("remoteModelId")
                    .and_then(serde_json::Value::as_str)
                    == Some(adapter_model)
            }
    });
    let remote_model_id = matching_model
        .and_then(|model| {
            model
                .get("remoteModelId")
                .and_then(serde_json::Value::as_str)
        })
        .filter(|value| !value.is_empty())
        .ok_or("Selected provider profile has no enabled model for this adapter")?;
    Ok(MediaCredentialSelection {
        credential_subject: normalized_profile_id,
        provider_region: region.to_string(),
        remote_model_id: remote_model_id.to_string(),
        base_url: profile
            .get("baseUrl")
            .and_then(serde_json::Value::as_str)
            .ok_or("Provider profile is missing its Base URL")?
            .to_string(),
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

struct OpenAiImagesTarget {
    host: String,
    port: u16,
    path: String,
}

struct OpenAiVideoPayload {
    body: Vec<u8>,
    multipart_boundary: Option<String>,
}

fn openai_images_target(base_url: &str, provider_type: &str) -> Result<OpenAiImagesTarget, String> {
    openai_compatible_target(base_url, provider_type, "/images/generations")
}

fn openai_compatible_video_target(base_url: &str) -> Result<OpenAiImagesTarget, String> {
    openai_compatible_target(base_url, "custom", "/videos")
}

fn openai_compatible_target(
    base_url: &str,
    provider_type: &str,
    endpoint: &str,
) -> Result<OpenAiImagesTarget, String> {
    if !matches!(endpoint, "/images/generations" | "/videos") {
        return Err("OpenAI-compatible endpoint is not allowed".into());
    }
    let url = tauri::Url::parse(base_url).map_err(|_| "Provider Base URL is invalid")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("OpenAI Images API requires a credential-free HTTPS Base URL".into());
    }
    let host = url.host_str().ok_or("Provider Base URL has no host")?;
    let base_path = url.path().trim_end_matches('/');
    if base_path.ends_with(endpoint)
        || base_path.split('/').any(|part| matches!(part, "." | ".."))
        || base_path.contains('%')
    {
        return Err("Provider Base URL must be an API root, not an endpoint URL".into());
    }
    if provider_type == "openai"
        && (endpoint != "/images/generations"
            || host != "api.openai.com"
            || base_path != "/v1"
            || url.port().is_some())
    {
        return Err("Official OpenAI Images requests require the OpenAI API Base URL".into());
    }
    if !matches!(provider_type, "openai" | "custom") {
        return Err("Provider is not allowed to use the OpenAI Images protocol".into());
    }
    let prefix = if base_path.is_empty() { "" } else { base_path };
    Ok(OpenAiImagesTarget {
        host: host.to_string(),
        port: url.port().unwrap_or(443),
        path: format!("{prefix}{endpoint}"),
    })
}

fn openai_images_payload(
    adapter_key: &str,
    remote_model_id: &str,
    payload: serde_json::Value,
) -> Result<Vec<u8>, String> {
    let provider = openai_images_provider(adapter_key)
        .ok_or("Selected adapter is not an OpenAI Images generation adapter")?;
    if provider != "openai" && provider != "custom" {
        return Err("Selected adapter is not an OpenAI Images generation adapter".into());
    }
    let is_custom = provider == "custom";
    validate_remote_model_id(remote_model_id)?;
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    validate_payload_fields(
        &object,
        if is_custom {
            &[
                "prompt",
                "size",
                "quality",
                "style",
                "response_format",
                "background",
                "output_format",
                "output_compression",
                "moderation",
                "n",
            ]
        } else {
            &[
                "prompt",
                "size",
                "quality",
                "background",
                "output_format",
                "output_compression",
                "moderation",
                "n",
            ]
        },
    )?;
    let prompt = object
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= 32_000)
        .ok_or("OpenAI Images requires a non-empty prompt")?;
    let _ = prompt;
    let valid_enum = |field: &str, values: &[&str]| {
        object
            .get(field)
            .is_none_or(|value| value.as_str().is_some_and(|value| values.contains(&value)))
    };
    let valid_string = |field: &str, max_chars: usize| {
        object.get(field).is_none_or(|value| {
            value.as_str().is_some_and(|value| {
                !value.trim().is_empty()
                    && value.chars().count() <= max_chars
                    && !value.contains(['\r', '\n'])
            })
        })
    };
    if (if is_custom {
        !valid_string("size", 64)
    } else {
        !valid_enum("size", &["auto", "1024x1024", "1536x1024", "1024x1536"])
    }) || (if is_custom {
        !valid_enum(
            "quality",
            &["auto", "low", "medium", "high", "standard", "hd"],
        ) || !valid_enum("style", &["standard", "vivid"])
            || !valid_enum("response_format", &["url", "b64_json"])
    } else {
        !valid_enum("quality", &["auto", "low", "medium", "high"])
    }) || !valid_enum("background", &["auto", "opaque", "transparent"])
        || !valid_enum("output_format", &["png", "jpeg", "webp"])
        || !valid_enum("moderation", &["auto", "low"])
    {
        return Err("OpenAI Images payload contains an unsupported option".into());
    }
    if object.get("n").is_some_and(|value| {
        value.as_u64().is_none_or(|count| {
            if is_custom {
                !(1..=10).contains(&count)
            } else {
                !(1..=4).contains(&count)
            }
        })
    }) {
        return Err(if is_custom {
            "OpenAI-compatible Images result count must be between 1 and 10".into()
        } else {
            "OpenAI Images result count must be between 1 and 4".into()
        });
    }
    if object.get("output_compression").is_some_and(|value| {
        value.as_u64().is_none_or(|compression| compression > 100)
            || !object
                .get("output_format")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|format| matches!(format, "jpeg" | "webp"))
    }) {
        return Err("Output compression requires JPEG or WebP and a value from 0 to 100".into());
    }
    if object.get("background").and_then(serde_json::Value::as_str) == Some("transparent")
        && object
            .get("output_format")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|format| format == "jpeg")
    {
        return Err("Transparent backgrounds require PNG or WebP output".into());
    }
    object.insert(
        "model".to_string(),
        serde_json::Value::String(remote_model_id.to_string()),
    );
    let encoded = serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to encode OpenAI Images parameters: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".into());
    }
    Ok(encoded)
}

fn openai_compatible_video_payload(
    adapter_key: &str,
    remote_model_id: &str,
    payload: serde_json::Value,
) -> Result<OpenAiVideoPayload, String> {
    if !is_custom_openai_video_adapter(adapter_key) {
        return Err("Selected adapter is not a custom OpenAI-compatible video adapter".into());
    }
    validate_remote_model_id(remote_model_id)?;
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    validate_payload_fields(
        &object,
        &["images", "prompt", "size", "duration", "seconds"],
    )?;
    let prompt = object
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= 5000)
        .ok_or("OpenAI-compatible video requires a non-empty prompt")?;
    let prompt = prompt.to_string();
    let images = object
        .remove("images")
        .and_then(|value| value.as_array().cloned());
    let image_to_video = adapter_key.starts_with("IMAGE_TO_VIDEO:");
    let image = images
        .as_deref()
        .and_then(|images| (images.len() == 1).then(|| images[0].as_str()).flatten());
    if (image_to_video && image.is_none()) || (!image_to_video && images.is_some()) {
        return Err("OpenAI-compatible video image inputs do not match the selected mode".into());
    }

    let mut wire = serde_json::Map::new();
    wire.insert(
        "model".to_string(),
        serde_json::Value::String(remote_model_id.to_string()),
    );
    wire.insert(
        "prompt".to_string(),
        serde_json::Value::String(prompt.clone()),
    );
    if let Some(size) = object.remove("size") {
        let size = size
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 32 && !value.contains(['\r', '\n']))
            .ok_or("OpenAI-compatible video size is invalid")?;
        wire.insert(
            "size".to_string(),
            serde_json::Value::String(size.to_string()),
        );
    }
    let seconds = object.remove("seconds");
    let duration = object.remove("duration");
    if seconds.is_some() && duration.is_some() {
        return Err("Specify either duration or seconds, not both".into());
    }
    if let Some(value) = seconds.or(duration) {
        let value = value
            .as_u64()
            .filter(|value| (1..=60).contains(value))
            .map(|value| value.to_string())
            .or_else(|| {
                value
                    .as_str()
                    .filter(|value| value.parse::<u8>().is_ok_and(|n| (1..=60).contains(&n)))
                    .map(str::to_string)
            })
            .ok_or("OpenAI-compatible video seconds must be between 1 and 60")?;
        wire.insert("seconds".to_string(), serde_json::Value::String(value));
    }

    if let Some(image) = image {
        if image.starts_with("https://") {
            parse_public_https_url(image)?;
            wire.insert(
                "input_reference".to_string(),
                serde_json::json!({ "image_url": image }),
            );
            let encoded = serde_json::to_vec(&wire).map_err(|error| {
                format!("Unable to encode OpenAI-compatible video parameters: {error}")
            })?;
            if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
                return Err("Provider payload exceeds the native transport limit".into());
            }
            return Ok(OpenAiVideoPayload {
                body: encoded,
                multipart_boundary: None,
            });
        }
        if !image.starts_with("data:image/") {
            return Err(
                "OpenAI-compatible video references must be HTTPS URLs or image data URLs".into(),
            );
        }
        let (image_bytes, content_type, extension) =
            decode_embedded_image(image, "input_reference")?;
        return openai_video_multipart_payload(
            wire,
            &prompt,
            &image_bytes,
            content_type,
            extension,
        );
    }

    let encoded = serde_json::to_vec(&wire)
        .map_err(|error| format!("Unable to encode OpenAI-compatible video parameters: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".into());
    }
    Ok(OpenAiVideoPayload {
        body: encoded,
        multipart_boundary: None,
    })
}

fn openai_video_multipart_payload(
    fields: serde_json::Map<String, serde_json::Value>,
    prompt: &str,
    image: &[u8],
    content_type: &str,
    extension: &str,
) -> Result<OpenAiVideoPayload, String> {
    let mut boundary_id = OPENAI_VIDEO_MULTIPART_ID.fetch_add(1, Ordering::Relaxed);
    let boundary = loop {
        let candidate = format!("xln-video-{}-{boundary_id}", std::process::id());
        let marker = format!("--{candidate}");
        let collides = image
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
            || prompt.contains(&marker);
        if !collides {
            break candidate;
        }
        boundary_id = OPENAI_VIDEO_MULTIPART_ID.fetch_add(1, Ordering::Relaxed);
    };

    let mut body = Vec::new();
    for key in ["model", "prompt", "size", "seconds"] {
        let Some(value) = fields.get(key).and_then(serde_json::Value::as_str) else {
            continue;
        };
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"input_reference\"; filename=\"reference.{extension}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(image);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    if body.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".into());
    }
    Ok(OpenAiVideoPayload {
        body,
        multipart_boundary: Some(boundary),
    })
}

fn openai_compatible_video_task_path(
    target: &OpenAiImagesTarget,
    task_id: &str,
) -> Result<String, String> {
    provider_task_path(task_id)?;
    if !target.path.ends_with("/videos") {
        return Err("OpenAI-compatible video endpoint is invalid".into());
    }
    Ok(format!("{}/{task_id}", target.path))
}

fn openai_video_reference_host(payload: &serde_json::Value) -> Result<Option<String>, String> {
    let Some(image) = payload
        .get("images")
        .and_then(serde_json::Value::as_array)
        .and_then(|images| (images.len() == 1).then(|| images[0].as_str()).flatten())
    else {
        return Ok(None);
    };
    if image.starts_with("https://") {
        return Ok(Some(parse_public_https_url(image)?.host));
    }
    Ok(None)
}

fn provider_openai_images_submit_blocking(
    adapter_key: &str,
    provider_type: &str,
    base_url: &str,
    credential_subject: &str,
    payload: serde_json::Value,
    remote_model_id: &str,
) -> Result<ProviderHttpResponse, OpenAiImagesSubmitFailure> {
    if openai_images_provider(adapter_key) != Some(provider_type) {
        return Err(OpenAiImagesSubmitFailure::not_sent(
            "Provider and OpenAI Images adapter do not match",
        ));
    }
    let target = openai_images_target(base_url, provider_type)
        .map_err(OpenAiImagesSubmitFailure::not_sent)?;
    if provider_type == "custom" {
        provider_http::assert_provider_api_host(&target.host)
    } else {
        provider_http::assert_public_host(&target.host)
    }
    .map_err(OpenAiImagesSubmitFailure::not_sent)?;
    let body = openai_images_payload(adapter_key, remote_model_id, payload)
        .map_err(OpenAiImagesSubmitFailure::not_sent)?;
    let secret =
        credential_read(credential_subject).map_err(OpenAiImagesSubmitFailure::not_sent)?;
    let secret = secret
        .as_str()
        .map_err(OpenAiImagesSubmitFailure::not_sent)?;
    let response = provider_http::request_json_with_receive_timeout(
        JsonHttpRequest {
            host: &target.host,
            port: target.port,
            secure: true,
            method: "POST",
            path: &target.path,
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret,
            body: Some(&body),
            request_body_limit: PROVIDER_REQUEST_BODY_LIMIT,
            response_body_limit: UNICOMPAPI_RESPONSE_BODY_LIMIT,
        },
        Duration::from_secs(5 * 60),
    )
    .map_err(OpenAiImagesSubmitFailure::after_transport)?;
    let mut response = ProviderHttpResponse {
        status: response.status,
        body: response.body,
        retry_after_ms: response.retry_after_ms,
    };
    externalize_provider_images(&mut response)
        .map_err(OpenAiImagesSubmitFailure::after_submission)?;
    Ok(response)
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

fn unicompapi_payload(
    adapter_key: &str,
    payload: serde_json::Value,
    remote_model_id: &str,
) -> Result<Vec<u8>, String> {
    validate_remote_model_id(remote_model_id)?;
    if model_contract::is_contract_adapter(adapter_key) {
        let capability = adapter_key.split(':').next().unwrap_or_default();
        if matches!(capability, "TEXT_TO_IMAGE" | "REFERENCE_TO_IMAGE") {
            let encoded = model_contract::image_payload(adapter_key, payload, remote_model_id)?;
            if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
                return Err("Provider payload exceeds the native transport limit".into());
            }
            return Ok(encoded);
        }
        let encoded = model_contract::video_payload(adapter_key, payload, remote_model_id)?;
        if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
            return Err("Provider payload exceeds the native transport limit".into());
        }
        return Ok(encoded);
    }
    let (capability, template) = unicompapi_submit_template(adapter_key)?;
    if capability == "REFERENCE_TO_IMAGE" {
        return unicompapi_qwen_image_edit_payload(remote_model_id, payload);
    }
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    let allowed_fields = match capability {
        "TEXT_TO_IMAGE" => UNICOMPAPI_IMAGE_FIELDS,
        "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO" => UNICOMPAPI_VIDEO_FIELDS,
        "REFERENCE_TO_VIDEO" => REFERENCE_VIDEO_FIELDS,
        "START_END_TO_VIDEO" => Q3_VIDEO_FIELDS,
        _ => return Err("UniCompAPI adapter capability is not supported".to_string()),
    };
    validate_payload_fields(&object, allowed_fields)?;

    if template == "openai-compatible-video" {
        if object.contains_key("seconds") && object.contains_key("duration") {
            return Err("Specify either duration or seconds, not both".into());
        }
        if let Some(duration) = object.remove("duration") {
            let seconds = duration
                .as_u64()
                .filter(|value| (1..=60).contains(value))
                .ok_or("OpenAI-compatible video duration must be between 1 and 60 seconds")?;
            object.insert(
                "seconds".to_string(),
                serde_json::Value::String(seconds.to_string()),
            );
        }
    }

    if capability == "TEXT_TO_VIDEO" && object.contains_key("images") {
        return Err("UniCompAPI text-to-video does not accept an input image".to_string());
    }

    if capability == "IMAGE_TO_VIDEO" {
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
    if capability == "REFERENCE_TO_VIDEO" || capability == "START_END_TO_VIDEO" {
        let images = object
            .get("images")
            .and_then(serde_json::Value::as_array)
            .ok_or("UniCompAPI Vidu-compatible generation requires input images")?;
        let valid_count = if capability == "REFERENCE_TO_VIDEO" {
            (1..=7).contains(&images.len())
        } else {
            images.len() == 2
        };
        if !valid_count
            || images
                .iter()
                .any(|image| image.as_str().is_none_or(str::is_empty))
        {
            return Err(
                "UniCompAPI Vidu-compatible generation has an invalid image count".to_string(),
            );
        }
    }
    object.insert(
        "model".to_string(),
        serde_json::Value::String(remote_model_id.to_string()),
    );
    let encoded = serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to serialize provider payload: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".to_string());
    }
    Ok(encoded)
}

fn unicompapi_qwen_image_edit_payload(
    model: &str,
    payload: serde_json::Value,
) -> Result<Vec<u8>, String> {
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Provider payload must be a JSON object")?;
    validate_payload_fields(&object, UNICOMPAPI_IMAGE_EDIT_FIELDS)?;
    let images = object
        .remove("images")
        .and_then(|value| value.as_array().cloned())
        .ok_or("UniCompAPI image editing requires one input image")?;
    if images.len() != 1 {
        return Err("UniCompAPI image editing requires one input image".to_string());
    }
    let image_source = images[0]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("UniCompAPI image editing requires one input image")?
        .to_string();
    validate_image_edit_source(&image_source)?;
    let prompt = object
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("UniCompAPI image editing requires a prompt")?
        .to_string();
    if let Some(response_format) = object
        .remove("response_format")
        .and_then(|value| value.as_str().map(str::to_string))
    {
        if response_format != "b64_json" {
            return Err(
                "UniCompAPI qwen image editing only supports b64_json responses".to_string(),
            );
        }
    }
    let mut request = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "image": image_source,
        "response_format": "b64_json"
    });
    if let Some(size) = object
        .get("size")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        request
            .as_object_mut()
            .expect("image edit request is an object")
            .insert(
                "size".to_string(),
                serde_json::Value::String(size.to_string()),
            );
    }
    let encoded = serde_json::to_vec(&request)
        .map_err(|error| format!("Unable to serialize provider payload: {error}"))?;
    if encoded.len() > PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".to_string());
    }
    Ok(encoded)
}

fn validate_image_edit_source(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.starts_with("https://") {
        if value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("UniCompAPI image editing received an invalid HTTPS image URL".to_string());
        }
        return Ok(());
    }
    let (header, encoded) = value
        .split_once(',')
        .ok_or("UniCompAPI image editing requires a valid image Data URL")?;
    let normalized_header = header.trim().to_ascii_lowercase();
    let media_type = match normalized_header.as_str() {
        "data:image/png;base64" => "image/png",
        "data:image/jpeg;base64" | "data:image/jpg;base64" => "image/jpeg",
        "data:image/webp;base64" => "image/webp",
        _ => return Err("UniCompAPI image editing received an unsupported image type".to_string()),
    };
    let encoded = encoded.trim();
    if encoded.is_empty() || encoded.len() > (UNICOMPAPI_IMAGE_INPUT_LIMIT * 4 / 3) + 4 {
        return Err("UniCompAPI image editing input exceeds the native limit".to_string());
    }
    let image = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "UniCompAPI image editing received invalid Base64".to_string())?;
    if image.is_empty() || image.len() > UNICOMPAPI_IMAGE_INPUT_LIMIT {
        return Err("UniCompAPI image editing input exceeds the native limit".to_string());
    }
    let valid_signature = match media_type {
        "image/png" => image.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => image.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => image.len() >= 12 && &image[..4] == b"RIFF" && &image[8..12] == b"WEBP",
        _ => false,
    };
    if !valid_signature {
        return Err("UniCompAPI image editing image signature is invalid".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHttpResponse {
    status: u32,
    body: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

struct OpenAiImagesSubmitFailure {
    message: String,
    request_may_have_been_sent: bool,
}

impl OpenAiImagesSubmitFailure {
    fn not_sent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            request_may_have_been_sent: false,
        }
    }

    fn after_transport(error: provider_http::JsonHttpError) -> Self {
        Self {
            message: error.to_string(),
            request_may_have_been_sent: error.request_may_have_been_sent(),
        }
    }

    fn after_submission(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            request_may_have_been_sent: true,
        }
    }

    fn into_host_error(self) -> serde_json::Value {
        let code = if self.request_may_have_been_sent {
            "PROVIDER_FAILED"
        } else {
            "REQUEST_NOT_SENT"
        };
        host_error(code, self.message, false)
    }

    fn into_message(self) -> String {
        self.message
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTaskSubmitResponse {
    status: u32,
    task_id: Option<String>,
    state: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
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
    if official_video::family(adapter_key).is_some() {
        model_contract::contract(adapter_key)?;
        return Ok(());
    }
    if is_custom_openai_video_adapter(adapter_key) {
        return Ok(());
    }
    match adapter_key {
        "TEXT_TO_VIDEO:vidu:viduq3-pro:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-ad:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-mix:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-turbo:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq2-pro:v2"
        | "REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2"
        | "START_END_TO_VIDEO:vidu:viduq3-pro:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3-pro:v2"
        | "IMAGE_TO_VIDEO:vidu:vidu2.0:v2" => Ok(()),
        _ => match unicompapi_adapter_parts(adapter_key) {
            Ok((
                "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO" | "REFERENCE_TO_VIDEO" | "START_END_TO_VIDEO"
                | "VIDEO_TO_VIDEO",
                _,
            )) => Ok(()),
            _ => Err("Native video task commands require a registered video adapter".to_string()),
        },
    }
}

fn provider_task_id(body: &serde_json::Value) -> Option<&str> {
    [
        "/output/task_id",
        "/task_id",
        "/id",
        "/data/task_id",
        "/data/id",
    ]
    .iter()
    .find_map(|path| {
        body.pointer(path)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
    })
}

fn provider_state(body: &serde_json::Value) -> Option<&str> {
    [
        "/output/task_status",
        "/state",
        "/status",
        "/task_status",
        "/data/state",
        "/data/status",
        "/data/task_status",
    ]
    .iter()
    .find_map(|path| {
        body.pointer(path)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
    })
}

fn provider_video_source(value: &serde_json::Value) -> Option<&str> {
    for path in [
        "/video_url",
        "/url",
        "/data/video_url",
        "/data/url",
        "/output/video_url",
        "/output/results/video_url",
        "/content/video_url",
        "/data/content/video_url",
    ] {
        if let Some(source) = value
            .pointer(path)
            .and_then(serde_json::Value::as_str)
            .filter(|source| !source.trim().is_empty())
        {
            return Some(source);
        }
    }
    match value {
        serde_json::Value::Array(items) => items.iter().find_map(provider_video_source),
        serde_json::Value::Object(object) => {
            if let Some(source) = object.get("video_url").and_then(serde_json::Value::as_str) {
                return Some(source);
            }
            for key in ["creations", "Creations"] {
                if let Some(items) = object.get(key).and_then(serde_json::Value::as_array) {
                    for item in items {
                        for field in ["video_url", "videoUrl", "url", "uri"] {
                            if let Some(source) =
                                item.get(field).and_then(serde_json::Value::as_str)
                            {
                                return Some(source);
                            }
                        }
                    }
                }
            }
            ["data", "output", "result"]
                .iter()
                .find_map(|key| object.get(*key).and_then(provider_video_source))
        }
        _ => None,
    }
}

fn provider_numeric_field(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|item| provider_numeric_field(item, keys)),
        serde_json::Value::Object(object) => {
            for key in keys {
                if let Some(candidate) = object.get(*key) {
                    let amount = candidate.as_f64().or_else(|| {
                        candidate
                            .as_str()
                            .and_then(|text| text.trim().parse::<f64>().ok())
                    });
                    if amount.is_some_and(|number| number.is_finite() && number >= 0.0) {
                        return amount;
                    }
                }
            }
            object
                .values()
                .find_map(|item| provider_numeric_field(item, keys))
        }
        _ => None,
    }
}

fn provider_cost(body: &serde_json::Value) -> Option<serde_json::Value> {
    for (keys, unit) in [
        (&["credits_used", "creditsUsed", "credits"][..], "credits"),
        (&["cost"][..], "unknown"),
    ] {
        if let Some(amount) = provider_numeric_field(body, keys) {
            return Some(serde_json::json!({ "amount": amount, "unit": unit }));
        }
    }
    None
}

fn sanitize_provider_diagnostic(value: &str) -> String {
    let mut redacted = Vec::new();
    let mut redact_next = false;
    for word in value.split_whitespace() {
        let normalized = word.to_ascii_lowercase();
        if redact_next {
            redacted.push("[CREDENTIAL]");
            redact_next = false;
        } else if normalized.starts_with("http://") || normalized.starts_with("https://") {
            redacted.push("[URL]");
        } else if normalized == "bearer" || normalized == "token" {
            redacted.push("[CREDENTIAL]");
            redact_next = true;
        } else {
            redacted.push(word);
        }
    }
    redacted
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect()
}

fn provider_error_field(body: &serde_json::Value, keys: &[&str]) -> Option<String> {
    fn find<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
        let object = value.as_object()?;
        for key in keys {
            if let Some(candidate) = object.get(*key).and_then(serde_json::Value::as_str) {
                if !candidate.trim().is_empty() {
                    return Some(candidate);
                }
            }
        }
        for key in ["error", "data", "detail"] {
            if let Some(candidate) = object.get(key).and_then(|nested| find(nested, keys)) {
                return Some(candidate);
            }
        }
        None
    }

    find(body, keys).map(|value| value.trim().chars().take(500).collect())
}

fn provider_submit_error(body: &serde_json::Value) -> (Option<String>, Option<String>) {
    (
        provider_error_field(body, &["err_code", "error_code", "code", "type"]),
        provider_error_field(
            body,
            &[
                "message",
                "error",
                "error_description",
                "detail",
                "fail_reason",
            ],
        ),
    )
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

fn decoded_image_type(
    bytes: &[u8],
    declared_subtype: Option<&str>,
) -> Result<(&'static str, &'static str), String> {
    let detected = if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        ("image/png", "png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", "jpg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        ("image/webp", "webp")
    } else {
        return Err("Provider returned an unsupported embedded image".to_string());
    };
    if let Some(subtype) = declared_subtype {
        let normalized = subtype.to_ascii_lowercase();
        let matches = match detected.0 {
            "image/png" => normalized == "png",
            "image/jpeg" => normalized == "jpeg" || normalized == "jpg",
            "image/webp" => normalized == "webp",
            _ => false,
        };
        if !matches {
            return Err("Provider image media type does not match its signature".to_string());
        }
    }
    Ok(detected)
}

fn embedded_image_parts(value: &str) -> Result<(&str, Option<String>), String> {
    let trimmed = value.trim();
    if !trimmed
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        return Ok((trimmed, None));
    }
    let (header, encoded) = trimmed
        .split_once(',')
        .ok_or("Provider returned a malformed image Data URL")?;
    let normalized = header.to_ascii_lowercase();
    let media_type = normalized
        .strip_prefix("data:image/")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| !value.is_empty())
        .ok_or("Provider returned a malformed image Data URL")?;
    Ok((encoded.trim(), Some(media_type.to_string())))
}

fn decode_embedded_image(
    value: &str,
    location: &str,
) -> Result<(Vec<u8>, &'static str, &'static str), String> {
    let (encoded, declared_subtype) = embedded_image_parts(value)?;
    let compact = if encoded
        .chars()
        .any(|character| character.is_ascii_whitespace())
    {
        Cow::Owned(
            encoded
                .chars()
                .filter(|character| !character.is_ascii_whitespace())
                .collect::<String>(),
        )
    } else {
        Cow::Borrowed(encoded)
    };
    if compact.is_empty() || compact.len() > (NATIVE_IMAGE_OUTPUT_LIMIT * 4 / 3) + 4 {
        return Err(format!(
            "Provider image output at {location} exceeds the 25 MiB limit"
        ));
    }
    let padded = match compact.len() % 4 {
        0 => Cow::Borrowed(compact.as_ref()),
        2 | 3 if !compact.contains('=') => {
            let mut value = compact.to_string();
            for _ in 0..(4 - value.len() % 4) {
                value.push('=');
            }
            Cow::Owned(value)
        }
        _ => Cow::Borrowed(compact.as_ref()),
    };
    let bytes = BASE64_STANDARD.decode(padded.as_bytes()).map_err(|_| {
        format!(
            "Provider returned invalid image Base64 at {location} ({} characters{})",
            compact.len(),
            if declared_subtype.is_some() {
                ", Data URL"
            } else {
                ""
            }
        )
    })?;
    if bytes.is_empty() || bytes.len() > NATIVE_IMAGE_OUTPUT_LIMIT {
        return Err(format!(
            "Provider image output at {location} exceeds the 25 MiB limit"
        ));
    }
    let (content_type, extension) = decoded_image_type(&bytes, declared_subtype.as_deref())?;
    Ok((bytes, content_type, extension))
}

fn cleanup_stale_native_images(directory: &Path) {
    let Ok(entries) = read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_managed_image = path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("image-"))
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| matches!(value, "png" | "jpg" | "webp"));
        let is_stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= NATIVE_IMAGE_STALE_AGE);
        if is_managed_image && is_stale {
            let _ = remove_file(path);
        }
    }
}

fn store_embedded_image(
    value: &str,
    location: &str,
    directory: &Path,
    nonce: u128,
    index: usize,
) -> Result<(PathBuf, &'static str), String> {
    let (bytes, content_type, extension) = decode_embedded_image(value, location)?;
    store_native_image_bytes(&bytes, content_type, extension, directory, nonce, index)
}

fn store_native_image_bytes(
    bytes: &[u8],
    content_type: &'static str,
    extension: &'static str,
    directory: &Path,
    nonce: u128,
    index: usize,
) -> Result<(PathBuf, &'static str), String> {
    let temporary_path = directory.join(format!(
        "image-{}-{nonce}-{index}.{extension}",
        std::process::id()
    ));
    write(&temporary_path, bytes)
        .map_err(|error| format!("Unable to store provider image output: {error}"))?;
    Ok((temporary_path, content_type))
}

fn download_remote_image_with<F>(
    source: &str,
    mut fetch: F,
) -> Result<provider_http::RawHttpResponse, String>
where
    F: FnMut(&provider_http::PublicHttpsUrl) -> Result<provider_http::RawHttpResponse, String>,
{
    let mut url = tauri::Url::parse(source).map_err(|_| "Provider image URL is invalid")?;
    for redirect in 0..=5 {
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Provider image URL must not contain credentials".to_string());
        }
        url.set_fragment(None);
        let target = parse_public_https_url(url.as_str())?;
        let response = fetch(&target)?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            if redirect == 5 {
                return Err("Provider image download exceeded the redirect limit".to_string());
            }
            url = url
                .join(
                    response
                        .location
                        .as_deref()
                        .ok_or("Provider image redirect is missing its location")?,
                )
                .map_err(|_| "Provider image redirect URL is invalid")?;
            continue;
        }
        return Ok(response);
    }
    unreachable!("bounded redirect loop always returns")
}

fn download_remote_image(source: &str) -> Result<provider_http::RawHttpResponse, String> {
    download_remote_image_with(source, |target| {
        assert_provider_output_host(&target.host)?;
        request_public_bytes(PublicHttpRequest {
            host: &target.host,
            path: &target.path,
            accept: "image/png,image/jpeg,image/webp",
            response_body_limit: NATIVE_IMAGE_OUTPUT_LIMIT,
            cancellation: None,
        })
        .map_err(|error| error.to_string())
    })
}

fn store_provider_image<F>(
    source: &str,
    location: &str,
    directory: &Path,
    nonce: u128,
    index: usize,
    download: &mut F,
) -> Result<(PathBuf, &'static str), String>
where
    F: FnMut(&str) -> Result<provider_http::RawHttpResponse, String>,
{
    let source = source.trim();
    if !source.starts_with("https://") && !source.starts_with("http://") {
        return store_embedded_image(source, location, directory, nonce, index);
    }
    // Temporary signed output URLs are consumed in Native, never sent over IPC.
    let response = download(source)?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Provider image download failed at {location} with HTTP {}",
            response.status
        ));
    }
    if response.body.is_empty() || response.body.len() > NATIVE_IMAGE_OUTPUT_LIMIT {
        return Err(format!(
            "Provider image output at {location} exceeds the 25 MiB limit"
        ));
    }
    let declared = response
        .content_type
        .as_deref()
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let subtype = declared.strip_prefix("image/");
    if subtype.is_none() && !matches!(declared.as_str(), "" | "application/octet-stream") {
        return Err(format!(
            "Provider image download at {location} is not an image"
        ));
    }
    let (content_type, extension) = decoded_image_type(&response.body, subtype)?;
    store_native_image_bytes(
        &response.body,
        content_type,
        extension,
        directory,
        nonce,
        index,
    )
}

fn externalize_image_object<F>(
    values: &mut serde_json::Map<String, serde_json::Value>,
    location: &str,
    directory: &Path,
    nonce: u128,
    paths: &mut Vec<PathBuf>,
    download: &mut F,
) -> Result<bool, String>
where
    F: FnMut(&str) -> Result<provider_http::RawHttpResponse, String>,
{
    let base64_key = ["b64_json", "b64", "base64"].into_iter().find(|key| {
        values
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    let image_url_key = [
        "url",
        "uri",
        "image_url",
        "imageUrl",
        "cover_url",
        "coverUrl",
    ]
    .into_iter()
    .find(|key| {
        values
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| {
                is_image_source(value.trim())
                    || value
                        .trim()
                        .get(..11)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"))
            })
    });
    if base64_key.is_some() && image_url_key.is_some() {
        return Err(format!(
            "Provider returned multiple image payloads at {location}"
        ));
    }
    let Some(key) = base64_key.or(image_url_key) else {
        return Ok(false);
    };
    if paths.len() >= NATIVE_IMAGE_RESULT_LIMIT {
        return Err("Provider returned more than 4 image results".to_string());
    }
    let serde_json::Value::String(value) = values
        .remove(key)
        .expect("selected image field must still exist")
    else {
        unreachable!("selected image field must be a string")
    };
    let field_location = format!("{location}.{key}");
    let (path, content_type) = store_provider_image(
        &value,
        &field_location,
        directory,
        nonce,
        paths.len(),
        download,
    )?;
    paths.push(path.clone());
    values.insert(
        "nativeImageFilePath".to_string(),
        serde_json::Value::String(path.to_string_lossy().into_owned()),
    );
    values.insert(
        "contentType".to_string(),
        serde_json::Value::String(content_type.to_string()),
    );
    Ok(true)
}

fn externalize_image_value<F>(
    value: &mut serde_json::Value,
    location: &str,
    directory: &Path,
    nonce: u128,
    paths: &mut Vec<PathBuf>,
    download: &mut F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<provider_http::RawHttpResponse, String>,
{
    match value {
        serde_json::Value::Array(values) => {
            for (index, item) in values.iter_mut().enumerate() {
                externalize_image_value(
                    item,
                    &format!("{location}[{index}]"),
                    directory,
                    nonce,
                    paths,
                    download,
                )?;
            }
        }
        serde_json::Value::Object(values) => {
            if externalize_image_object(values, location, directory, nonce, paths, download)? {
                return Ok(());
            }
            for key in [
                "data",
                "images",
                "creations",
                "Creations",
                "results",
                "output",
            ] {
                if let Some(child) = values.get_mut(key) {
                    externalize_image_value(
                        child,
                        &format!("{location}.{key}"),
                        directory,
                        nonce,
                        paths,
                        download,
                    )?;
                }
            }
        }
        serde_json::Value::String(_) => {
            let serde_json::Value::String(source) = std::mem::take(value) else {
                unreachable!("image source must be a string")
            };
            let is_data_url = source
                .trim()
                .get(..11)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"));
            if !is_data_url && !is_image_source(source.trim()) {
                *value = serde_json::Value::String(source);
                return Ok(());
            }
            if paths.len() >= NATIVE_IMAGE_RESULT_LIMIT {
                return Err("Provider returned more than 4 image results".to_string());
            }
            let (path, content_type) =
                store_provider_image(&source, location, directory, nonce, paths.len(), download)?;
            paths.push(path.clone());
            *value = serde_json::json!({
                "nativeImageFilePath": path.to_string_lossy(),
                "contentType": content_type,
            });
        }
        _ => {}
    }
    Ok(())
}

fn externalize_provider_images(response: &mut ProviderHttpResponse) -> Result<(), String> {
    if let Err(error) = externalize_provider_images_with(response, download_remote_image) {
        // HTTP succeeded. This is a local output-processing failure, not an
        // ambiguous paid submission; return it without exposing the signed URL.
        response.body = serde_json::json!({
            "nativeImageOutputError": format!("Provider image response received; local output processing failed: {error}"),
        });
    }
    Ok(())
}

fn externalize_provider_images_with<F>(
    response: &mut ProviderHttpResponse,
    mut download: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<provider_http::RawHttpResponse, String>,
{
    if !(200..300).contains(&response.status) {
        return Ok(());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid")?
        .as_nanos();
    let directory = std::env::temp_dir().join("ai-video-workspace-unicompapi");
    create_dir_all(&directory)
        .map_err(|error| format!("Unable to create provider image directory: {error}"))?;
    cleanup_stale_native_images(&directory);
    let mut paths = Vec::new();
    match externalize_image_value(
        &mut response.body,
        "$",
        &directory,
        nonce,
        &mut paths,
        &mut download,
    ) {
        Ok(()) => {
            // Return only local results. Provider metadata can echo a signed URL
            // in multiple fields and must not invalidate an otherwise valid image.
            response.body = serde_json::json!({ "data": paths.iter().map(|path| {
                let content_type = match path.extension().and_then(|value| value.to_str()) {
                    Some("png") => "image/png",
                    Some("jpg") => "image/jpeg",
                    Some("webp") => "image/webp",
                    _ => unreachable!("stored images have a validated extension"),
                };
                serde_json::json!({ "nativeImageFilePath": path.to_string_lossy(), "contentType": content_type })
            }).collect::<Vec<_>>() });
            Ok(())
        }
        Err(error) => {
            for path in paths {
                let _ = remove_file(path);
            }
            Err(error)
        }
    }
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
    let dispatch = request_guard::try_dispatch().map_err(|error| error.to_string())?;
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _dispatch = dispatch;
        if let Some(provider_type) = openai_images_provider(&adapter_key) {
            provider_openai_images_submit_blocking(
                &adapter_key,
                provider_type,
                &selection.base_url,
                &selection.credential_subject,
                payload,
                &selection.remote_model_id,
            )
            .map_err(OpenAiImagesSubmitFailure::into_message)
        } else {
            provider_submit_blocking(
                &adapter_key,
                &selection.provider_region,
                &selection.credential_subject,
                payload,
                &selection.remote_model_id,
            )
        }
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
    let dispatch = request_guard::try_dispatch().map_err(|error| error.to_string())?;
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _dispatch = dispatch;
        provider_submit_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.base_url,
            &selection.credential_subject,
            payload,
            &selection.remote_model_id,
        )
    })
    .await
    .map_err(|error| format!("Native provider task submission failed: {error}"))?
}

fn provider_submit_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    base_url: &str,
    credential_subject: &str,
    payload: serde_json::Value,
    remote_model_id: &str,
) -> Result<ProviderTaskSubmitResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if provider_region == "unicompapi" {
        let body = unicompapi_payload(adapter_key, payload, remote_model_id)?;
        let secret = credential_read(credential_subject)?;
        let response = request_unicompapi_json(&secret, "POST", "/v1/videos", Some(&body))?;
        if response.status < 200 || response.status >= 300 {
            let (error_code, error_message) = provider_submit_error(&response.body);
            return Ok(ProviderTaskSubmitResponse {
                status: response.status,
                task_id: None,
                state: provider_state(&response.body).map(str::to_string),
                error_code,
                error_message,
            });
        }
        let task_id = provider_task_id(&response.body)
            .ok_or("Provider response did not contain a video task id")?;
        unicompapi_video_task_path(task_id)?;
        return Ok(ProviderTaskSubmitResponse {
            status: response.status,
            task_id: Some(task_id.to_string()),
            state: provider_state(&response.body).map(str::to_string),
            error_code: None,
            error_message: None,
        });
    }
    if is_custom_openai_video_adapter(adapter_key) {
        let target = openai_compatible_video_target(base_url)?;
        provider_http::assert_provider_api_host(&target.host)?;
        if let Some(host) = openai_video_reference_host(&payload)? {
            provider_http::assert_public_host(&host)?;
        }
        let request_body = openai_compatible_video_payload(adapter_key, remote_model_id, payload)?;
        let secret = credential_read(credential_subject)?;
        let response = if let Some(boundary) = request_body.multipart_boundary.as_deref() {
            request_openai_compatible_multipart_json(
                &target,
                &secret,
                &target.path,
                &request_body.body,
                boundary,
            )?
        } else {
            request_openai_compatible_json(
                &target,
                &secret,
                "POST",
                &target.path,
                Some(&request_body.body),
            )?
        };
        if response.status < 200 || response.status >= 300 {
            let (error_code, error_message) = provider_submit_error(&response.body);
            return Ok(ProviderTaskSubmitResponse {
                status: response.status,
                task_id: None,
                state: provider_state(&response.body).map(str::to_string),
                error_code,
                error_message,
            });
        }
        let task_id = provider_task_id(&response.body)
            .ok_or("Provider response did not contain a video task id")?;
        openai_compatible_video_task_path(&target, task_id)?;
        return Ok(ProviderTaskSubmitResponse {
            status: response.status,
            task_id: Some(task_id.to_string()),
            state: provider_state(&response.body).map(str::to_string),
            error_code: None,
            error_message: None,
        });
    }
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(credential_subject)?;
    let response = request_provider_json(target, &secret, "POST", target.path, Some(&body))?;
    if response.status < 200 || response.status >= 300 {
        let (error_code, error_message) = provider_submit_error(&response.body);
        return Ok(ProviderTaskSubmitResponse {
            status: response.status,
            task_id: None,
            state: provider_state(&response.body).map(str::to_string),
            error_code,
            error_message,
        });
    }
    let task_id = provider_task_id(&response.body)
        .ok_or("Provider response did not contain a video task id")?;
    provider_task_path(task_id)?;
    Ok(ProviderTaskSubmitResponse {
        status: response.status,
        task_id: Some(task_id.to_string()),
        state: provider_state(&response.body).map(str::to_string),
        error_code: None,
        error_message: None,
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
    let dispatch = request_guard::try_dispatch().map_err(|error| error.to_string())?;
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _dispatch = dispatch;
        provider_poll_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.base_url,
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
    base_url: &str,
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
    if is_custom_openai_video_adapter(adapter_key) {
        let target = openai_compatible_video_target(base_url)?;
        provider_http::assert_provider_api_host(&target.host)?;
        let path = openai_compatible_video_task_path(&target, task_id)?;
        let secret = credential_read(credential_subject)?;
        return request_openai_compatible_json(&target, &secret, "GET", &path, None);
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
    let dispatch = request_guard::try_dispatch().map_err(|error| error.to_string())?;
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _dispatch = dispatch;
        provider_download_task_blocking(
            &adapter_key,
            &selection.provider_region,
            &selection.base_url,
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
    base_url: &str,
    credential_subject: &str,
    task_id: &str,
) -> Result<ProviderBinaryDownloadResponse, String> {
    ensure_video_adapter(adapter_key)?;
    if is_custom_openai_video_adapter(adapter_key) {
        let target = openai_compatible_video_target(base_url)?;
        provider_http::assert_provider_api_host(&target.host)?;
        let task_path = openai_compatible_video_task_path(&target, task_id)?;
        let path = format!("{task_path}/content");
        let secret = credential_read(credential_subject)?;
        let response = request_openai_compatible_bytes(&target, &secret, &path)?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Provider video download failed with HTTP {}",
                response.status
            ));
        }
        if response.body.is_empty() {
            return Err("Provider video download returned an empty body".to_string());
        }
        let extension = openai_compatible_video_extension(response.content_type.as_deref())?;
        return store_native_video_output(
            &response.body,
            extension,
            response.content_type.as_deref(),
        );
    }
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
    store_native_video_output(&response.body, ".mp4", Some("video/mp4"))
}

fn provider_download_remote_video_blocking(
    source: &str,
) -> Result<ProviderBinaryDownloadResponse, String> {
    let target = parse_public_https_url(source)?;
    provider_http::assert_provider_output_host(&target.host)?;
    let response = request_public_bytes(PublicHttpRequest {
        host: &target.host,
        path: &target.path,
        accept: "video/mp4",
        response_body_limit: NATIVE_VIDEO_OUTPUT_LIMIT,
        cancellation: None,
    })
    .map_err(|error| error.to_string())?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Provider video output download failed with HTTP {}",
            response.status
        ));
    }
    if response.body.is_empty() {
        return Err("Provider video output download returned an empty body".to_string());
    }
    let extension = provider_video_extension(response.content_type.as_deref(), &target.path)?;
    store_native_video_output(&response.body, extension, response.content_type.as_deref())
}

fn provider_video_extension(
    content_type: Option<&str>,
    path: &str,
) -> Result<&'static str, String> {
    let content_type = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if content_type == "video/mp4" {
        return Ok(".mp4");
    }
    if content_type == "video/webm" {
        return Ok(".webm");
    }
    let path = path.split('?').next().unwrap_or(path).to_ascii_lowercase();
    if content_type == "application/octet-stream" && path.ends_with(".mp4") {
        return Ok(".mp4");
    }
    if content_type == "application/octet-stream" && path.ends_with(".webm") {
        return Ok(".webm");
    }
    Err("Downloaded result is not a supported MP4 or WebM video".to_string())
}

fn openai_compatible_video_extension(content_type: Option<&str>) -> Result<&'static str, String> {
    let content_type = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(content_type.as_str(), "" | "application/octet-stream") {
        return Ok(".mp4");
    }
    provider_video_extension(Some(&content_type), "/v1/videos/task/content")
}

fn store_native_video_output(
    bytes: &[u8],
    extension: &str,
    content_type: Option<&str>,
) -> Result<ProviderBinaryDownloadResponse, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid")?
        .as_nanos();
    let directory = std::env::temp_dir().join("ai-video-workspace-unicompapi");
    create_dir_all(&directory)
        .map_err(|error| format!("Unable to create provider download directory: {error}"))?;
    let temporary_path = directory.join(format!("video-{}-{nonce}{extension}", std::process::id()));
    write(&temporary_path, bytes)
        .map_err(|error| format!("Unable to store provider video download: {error}"))?;
    Ok(ProviderBinaryDownloadResponse {
        path: temporary_path.to_string_lossy().into_owned(),
        content_type: content_type.map(str::to_string),
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
    let dispatch = request_guard::try_dispatch().map_err(|error| error.to_string())?;
    let selection = resolve_media_selection(
        &adapter_key,
        provider_profile_id.as_deref(),
        provider_region.as_deref(),
        &state,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _dispatch = dispatch;
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
    if is_custom_openai_video_adapter(adapter_key) {
        return Ok(ProviderCancelResponse {
            supported: false,
            cancelled: false,
            status: 0,
        });
    }
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
    remote_model_id: &str,
) -> Result<ProviderHttpResponse, String> {
    if ensure_video_adapter(adapter_key).is_ok() {
        return Err("Video adapters must use the asynchronous provider task bridge".to_string());
    }
    if provider_region == "unicompapi" {
        if model_contract::is_contract_adapter(adapter_key) {
            let body = unicompapi_payload(adapter_key, payload, remote_model_id)?;
            let secret = credential_read(credential_subject)?;
            let mut response =
                request_unicompapi_json(&secret, "POST", "/v1/images/generations", Some(&body))?;
            externalize_provider_images(&mut response)?;
            return Ok(response);
        }
        let (capability, _) = unicompapi_submit_template(adapter_key)?;
        let secret = credential_read(credential_subject)?;
        let mut response = match capability {
            "TEXT_TO_IMAGE" => {
                let body = unicompapi_payload(adapter_key, payload, remote_model_id)?;
                request_unicompapi_json(&secret, "POST", "/v1/images/generations", Some(&body))
            }
            "REFERENCE_TO_IMAGE" => {
                let body = unicompapi_payload(adapter_key, payload, remote_model_id)?;
                request_unicompapi_json(&secret, "POST", "/v1/images/generations", Some(&body))
            }
            _ => Err("UniCompAPI adapter must use the matching media bridge".to_string()),
        }?;
        externalize_provider_images(&mut response)?;
        return Ok(response);
    }
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(credential_subject)?;
    let mut response = request_provider_json(target, &secret, "POST", target.path, Some(&body))?;
    if response.status < 200 || response.status >= 300 {
        return Ok(response);
    }
    if contains_image_source(&response.body) {
        externalize_provider_images(&mut response)?;
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
        // The initial POST was accepted. A rejected poll must never claim the
        // paid submission was not sent, which could make a retry unsafe.
        let mut poll =
            request_provider_json(target, &secret, "GET", &task_path, None).map_err(|error| {
                format!("Provider image task already submitted; polling failed: {error}")
            })?;
        if poll.status < 200 || poll.status >= 300 {
            return Ok(poll);
        }
        if contains_image_source(&poll.body) {
            externalize_provider_images(&mut poll)?;
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
        retry_after_ms: response.retry_after_ms,
    })
}

fn request_unicompapi_json(
    secret: &CredentialSecret,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<ProviderHttpResponse, String> {
    if !matches!(path, "/v1/images/generations" | "/v1/videos")
        && !path
            .strip_prefix("/v1/videos/")
            .is_some_and(|task_id| unicompapi_video_task_path(task_id).as_deref() == Ok(path))
    {
        return Err("UniCompAPI request path is not allowed".to_string());
    }
    let response = provider_http::request_json_with_receive_timeout(
        JsonHttpRequest {
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
        },
        unicompapi_receive_timeout(method, path),
    )
    .map_err(|error| error.to_string())?;
    Ok(ProviderHttpResponse {
        status: response.status,
        body: response.body,
        retry_after_ms: response.retry_after_ms,
    })
}

fn request_openai_compatible_json(
    target: &OpenAiImagesTarget,
    secret: &CredentialSecret,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<ProviderHttpResponse, String> {
    if path != target.path
        && !path
            .strip_prefix(&format!("{}/", target.path))
            .is_some_and(|task_id| {
                openai_compatible_video_task_path(target, task_id).as_deref() == Ok(path)
            })
    {
        return Err("OpenAI-compatible provider request path is not allowed".to_string());
    }
    let timeout = if method == "POST" {
        Duration::from_secs(5 * 60)
    } else {
        provider_http::DEFAULT_RECEIVE_TIMEOUT
    };
    let response = provider_http::request_json_with_receive_timeout(
        JsonHttpRequest {
            host: &target.host,
            port: target.port,
            secure: true,
            method,
            path,
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: secret.as_str()?,
            body,
            request_body_limit: PROVIDER_REQUEST_BODY_LIMIT,
            response_body_limit: PROVIDER_RESPONSE_BODY_LIMIT,
        },
        timeout,
    )
    .map_err(|error| error.to_string())?;
    Ok(ProviderHttpResponse {
        status: response.status,
        body: response.body,
        retry_after_ms: response.retry_after_ms,
    })
}

fn request_openai_compatible_multipart_json(
    target: &OpenAiImagesTarget,
    secret: &CredentialSecret,
    path: &str,
    body: &[u8],
    boundary: &str,
) -> Result<ProviderHttpResponse, String> {
    if path != target.path || !target.path.ends_with("/videos") {
        return Err("OpenAI-compatible video submission path is not allowed".to_string());
    }
    let response = provider_http::request_multipart_json_with_receive_timeout(
        JsonHttpRequest {
            host: &target.host,
            port: target.port,
            secure: true,
            method: "POST",
            path,
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: secret.as_str()?,
            body: Some(body),
            request_body_limit: PROVIDER_REQUEST_BODY_LIMIT,
            response_body_limit: PROVIDER_RESPONSE_BODY_LIMIT,
        },
        Duration::from_secs(5 * 60),
        boundary,
    )
    .map_err(|error| error.to_string())?;
    Ok(ProviderHttpResponse {
        status: response.status,
        body: response.body,
        retry_after_ms: response.retry_after_ms,
    })
}

fn request_openai_compatible_bytes(
    target: &OpenAiImagesTarget,
    secret: &CredentialSecret,
    path: &str,
) -> Result<provider_http::RawHttpResponse, String> {
    let task_path = path
        .strip_suffix("/content")
        .ok_or("OpenAI-compatible video content path is not allowed")?;
    let task_id = task_path
        .strip_prefix(&format!("{}/", target.path))
        .ok_or("OpenAI-compatible video content path is not allowed")?;
    if format!(
        "{}/content",
        openai_compatible_video_task_path(target, task_id)?
    ) != path
    {
        return Err("OpenAI-compatible video content path is not allowed".to_string());
    }
    request_bytes(JsonHttpRequest {
        host: &target.host,
        port: target.port,
        secure: true,
        method: "GET",
        path,
        authorization_scheme: "Bearer",
        accept: "video/mp4, video/webm",
        secret: secret.as_str()?,
        body: None,
        request_body_limit: 1,
        response_body_limit: NATIVE_VIDEO_OUTPUT_LIMIT,
    })
    .map_err(|error| error.to_string())
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

fn unicompapi_receive_timeout(method: &str, path: &str) -> Duration {
    if method == "POST" && matches!(path, "/v1/images/generations" | "/v1/videos") {
        // Paid submissions can wait for inference or large-reference processing
        // before returning. Keep queries on their short timeout and never replay POSTs.
        Duration::from_secs(5 * 60)
    } else {
        provider_http::DEFAULT_RECEIVE_TIMEOUT
    }
}

struct WorkerProcess {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    #[cfg(test)]
    responses: Mutex<Receiver<Result<String, String>>>,
    replies: Arc<Mutex<WorkerReplies>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    available: Arc<AtomicBool>,
    host_streams: Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
}

#[derive(Default)]
struct WorkerReplies {
    pending: std::collections::HashMap<String, Sender<Result<String, String>>>,
    recent_ids: std::collections::VecDeque<String>,
}

fn fail_worker_replies(replies: &Mutex<WorkerReplies>, message: &str) {
    if let Ok(mut replies) = replies.lock() {
        for (_, sender) in replies.pending.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

fn route_worker_reply(
    replies: &Mutex<WorkerReplies>,
    line: String,
    unclaimed: &Sender<Result<String, String>>,
) -> bool {
    let response = match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => value,
        Err(error) => {
            fail_worker_replies(replies, &format!("Worker returned invalid JSON: {error}"));
            return false;
        }
    };
    let mut replies = match replies.lock() {
        Ok(replies) => replies,
        Err(_) => return false,
    };
    if let Some(id) = response.get("id").and_then(serde_json::Value::as_str) {
        if let Some(sender) = replies.pending.remove(id) {
            let _ = sender.send(Ok(line));
            return true;
        }
        // A timed-out or completed request must not consume another request's response.
        if replies.recent_ids.iter().any(|seen| seen == id) {
            return true;
        }
    }
    if replies.pending.is_empty() {
        let _ = unclaimed.send(Ok(line));
    } else {
        for (_, sender) in replies.pending.drain() {
            let _ = sender.send(Err(
                "Worker returned a response with a mismatched correlation ID".to_string(),
            ));
        }
        return false;
    }
    true
}

fn worker_request_timeout(request: &serde_json::Value) -> Duration {
    match request.get("method").and_then(serde_json::Value::as_str) {
        Some(
            "characterVoiceReference.generate"
            | "characterVoiceReference.confirm"
            | "audio.sample.confirm",
        ) => VOICE_REFERENCE_WORKER_REQUEST_TIMEOUT,
        Some(
            "media.generation.confirmSubmission"
            | "media.review.submit"
            | "agent.generation.confirmMediaSubmission"
            | "agent.generation.selectMedia"
            | "image.generate.complete"
            | "audio.import"
            | "dubbing.job.submit"
            | "project.integrity",
        ) => MEDIA_WORKER_REQUEST_TIMEOUT,
        _ => WORKER_REQUEST_TIMEOUT,
    }
}

struct ActiveHostStream {
    project_session_id: String,
    cancellation: Arc<llm_stream::LlmCancellation>,
}

fn cancel_worker_host_streams(
    streams: &Mutex<std::collections::HashMap<String, ActiveHostStream>>,
) {
    let cancellations = streams
        .lock()
        .map(|mut streams| {
            streams
                .drain()
                .map(|(_, stream)| stream.cancellation)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for cancellation in cancellations {
        cancellation.cancel();
    }
}

impl WorkerProcess {
    #[cfg(test)]
    fn spawn() -> Result<Self, String> {
        Self::spawn_command(worker_command()?)
    }

    fn spawn_for_app(
        app_data_dir: &Path,
        research_bridge: &NativeResearchBridge,
    ) -> Result<Self, String> {
        let mut command = worker_command()?;
        command.env("AI_VIDEO_APP_DATA_DIR", app_data_dir);
        let _ = MODEL_INPUT_ROOT.set(app_data_dir.to_path_buf());
        command.env("AI_VIDEO_MEDIA_INPUT_ROOT", app_data_dir);
        command.env("AI_VIDEO_RESEARCH_BRIDGE_URL", research_bridge.url());
        command.env("AI_VIDEO_RESEARCH_BRIDGE_TOKEN", research_bridge.token());
        Self::spawn_command(command)
    }

    fn spawn_command(mut command: Command) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Keep the console Worker in the background while retaining its IPC pipes.
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start worker: {error}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Worker stdin is unavailable")?,
        ));
        let stdout = child.stdout.take().ok_or("Worker stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Worker stderr is unavailable")?;
        let host_streams = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let host_writer = Arc::clone(&stdin);
        let stdout_host_streams = Arc::clone(&host_streams);
        let available = Arc::new(AtomicBool::new(true));
        let stdout_available = Arc::clone(&available);
        let (response_tx, responses) = mpsc::channel();
        let replies = Arc::new(Mutex::new(WorkerReplies::default()));
        let stdout_replies = Arc::clone(&replies);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        fail_worker_replies(
                            &stdout_replies,
                            "Worker exited before returning a response",
                        );
                        let _ = response_tx
                            .send(Err("Worker exited before returning a response".to_string()));
                        break;
                    }
                    Ok(_) => {
                        if line.len() > MODEL_REQUEST_ENVELOPE_MAX_BYTES {
                            fail_worker_replies(
                                &stdout_replies,
                                "Worker message exceeds the 2 MiB sidecar limit",
                            );
                            let _ =
                                response_tx
                                    .send(Err("Worker message exceeds the 2 MiB sidecar limit"
                                        .to_string()));
                            break;
                        }
                        let host_request = serde_json::from_str::<serde_json::Value>(&line)
                            .ok()
                            .filter(|value| {
                                value.get("kind").and_then(serde_json::Value::as_str)
                                    == Some("host.request")
                            });
                        if let Some(value) = host_request {
                            dispatch_host_request(
                                value,
                                Arc::clone(&host_writer),
                                Arc::clone(&stdout_host_streams),
                                Arc::clone(&stdout_available),
                            );
                            continue;
                        }
                        if line.len() > SIDECAR_ENVELOPE_MAX_BYTES {
                            fail_worker_replies(
                                &stdout_replies,
                                "Worker reply exceeds sidecar limit",
                            );
                            break;
                        }
                        if !route_worker_reply(&stdout_replies, line, &response_tx) {
                            break;
                        }
                    }
                    Err(error) => {
                        fail_worker_replies(
                            &stdout_replies,
                            &format!("Failed to read worker response: {error}"),
                        );
                        let _ = response_tx
                            .send(Err(format!("Failed to read worker response: {error}")));
                        break;
                    }
                }
            }
            stdout_available.store(false, Ordering::Release);
            cancel_worker_host_streams(&stdout_host_streams);
            fail_worker_replies(&stdout_replies, "Worker transport closed");
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
            child: Mutex::new(child),
            stdin,
            #[cfg(test)]
            responses: Mutex::new(responses),
            replies,
            stderr_tail,
            available,
            host_streams,
        })
    }

    fn request(&self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.request_with_timeout(request, worker_request_timeout(request))
    }

    fn request_with_timeout(
        &self,
        request: &serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        if !self.available.load(Ordering::Acquire) {
            return Err("WORKER_UNAVAILABLE: Worker transport is closed".to_string());
        }
        // Validate before touching the transport. A caller error never poisons the process.
        if serde_json::to_vec(request)
            .map_err(|error| error.to_string())?
            .len()
            + 1
            > SIDECAR_ENVELOPE_MAX_BYTES
        {
            return Err("Sidecar message exceeds the 2 MiB limit".to_string());
        }
        let request_id = request
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or("Worker request is missing its correlation ID")?;
        let (sender, response) = mpsc::channel();
        {
            let mut replies = self
                .replies
                .lock()
                .map_err(|_| "Worker reply lock is poisoned")?;
            if replies.pending.contains_key(request_id) {
                return Err("Worker request correlation ID is already pending".to_string());
            }
            replies.pending.insert(request_id.to_string(), sender);
            replies.recent_ids.push_back(request_id.to_string());
            while replies.recent_ids.len() > 4096 {
                replies.recent_ids.pop_front();
            }
        }
        let result = (|| {
            if let Err(error) = write_sidecar_value(&self.stdin, request) {
                self.available.store(false, Ordering::Release);
                return Err(error);
            }
            let line = match response.recv_timeout(timeout) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => return Err(self.with_diagnostics(error)),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "WORKER_REQUEST_TIMEOUT: Worker request timed out after {} ms; execution may still be in progress. The request was not replayed and the Worker was retained",
                        timeout.as_millis()
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.with_diagnostics("Worker response channel closed".to_string()));
                }
            };
            let value: serde_json::Value = serde_json::from_str(&line)
                .map_err(|error| format!("Worker returned invalid JSON: {error}"))?;
            if value.get("id").and_then(serde_json::Value::as_str) != Some(request_id) {
                return Err(
                    "Worker returned a response with a mismatched correlation ID".to_string(),
                );
            }
            Ok(value)
        })();
        if let Ok(mut replies) = self.replies.lock() {
            replies.pending.remove(request_id);
        }
        result
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

    fn stop(&self) {
        self.available.store(false, Ordering::Release);
        cancel_worker_host_streams(&self.host_streams);
        fail_worker_replies(&self.replies, "WORKER_UNAVAILABLE: Worker is stopping");
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }

    fn shutdown(&self) {
        if self.available.load(Ordering::Acquire) {
            let acknowledged = self.request_with_timeout(
                &serde_json::json!({
                    "id": format!("host-shutdown-{}", std::process::id()),
                    "kind": "host.control", "version": 1,
                    "method": "worker.shutdown", "reason": "host_shutdown"
                }),
                Duration::from_secs(8),
            );
            if acknowledged
                .as_ref()
                .is_ok_and(|reply| reply["ok"] == true && reply["result"]["stopped"] == true)
            {
                // The acknowledgement follows durable flush. Allow normal exit
                // before using the fallback kill/reap path.
                let deadline = std::time::Instant::now() + Duration::from_millis(500);
                while std::time::Instant::now() < deadline {
                    if self
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut child| child.try_wait().ok().flatten())
                        .is_some()
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
        self.stop();
    }
}

fn write_sidecar_value(
    writer: &Arc<Mutex<ChildStdin>>,
    value: &serde_json::Value,
) -> Result<(), String> {
    let mut payload = serde_json::to_vec(value)
        .map_err(|error| format!("Failed to serialize sidecar message: {error}"))?;
    payload.push(b'\n');
    if payload.len() > SIDECAR_ENVELOPE_MAX_BYTES {
        return Err("Sidecar message exceeds the 2 MiB limit".to_string());
    }
    let mut stdin = writer
        .lock()
        .map_err(|_| "Worker writer lock is poisoned".to_string())?;
    stdin
        .write_all(&payload)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to write Worker message: {error}"))
}

fn dispatch_host_request(
    value: serde_json::Value,
    writer: Arc<Mutex<ChildStdin>>,
    streams: Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
    available: Arc<AtomicBool>,
) {
    if !available.load(Ordering::Acquire) {
        return;
    }
    let request_id = value
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("invalid-host-request")
        .to_string();
    if let Err(error) = validate_host_request_envelope(&value) {
        let _ = send_host_response(
            &writer,
            &request_id,
            Err(host_error("INVALID_ENVELOPE", error, false)),
        );
        return;
    }
    let method = value["method"].as_str().unwrap_or_default();
    let params = value["params"].clone();
    // Reserve before spawning: bounded network waiting must not create an
    // unbounded number of Native threads. Local cancellation stays available.
    let dispatch = if matches!(
        method,
        "provider.media.submit"
            | "provider.media.poll"
            | "provider.media.cancel"
            | "provider.dubbing.speech"
            | "provider.dubbing.submit"
            | "provider.dubbing.poll"
            | "provider.stream.start"
    ) {
        match request_guard::try_dispatch() {
            Ok(permit) => Some(permit),
            Err(error) => {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error("REQUEST_NOT_SENT", error.to_string(), true)),
                );
                return;
            }
        }
    } else {
        None
    };
    match method {
        "provider.dubbing.speech" | "provider.dubbing.submit" | "provider.dubbing.poll" => {
            let method = method.to_string();
            thread::spawn(move || {
                let _dispatch = dispatch;
                let result = dubbing_provider::handle(&method, &params, &request_id);
                let _ = send_host_response(&writer, &request_id, result);
            });
        }
        "provider.dubbing.cancel" => {
            let result = dubbing_provider::handle(method, &params, &request_id);
            let _ = send_host_response(&writer, &request_id, result);
        }
        "provider.media.submit" => {
            if let Err(error) = validate_provider_media_submit_params(&params) {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error("INVALID_PARAMETERS", error, false)),
                );
                return;
            }
            thread::spawn(move || {
                let _dispatch = dispatch;
                let result = provider_media_submit_blocking(&params, &streams);
                let _ = send_host_response(&writer, &request_id, result);
            });
        }
        "provider.media.cancel" => {
            if let Err(error) = validate_provider_media_cancel_params(&params) {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error("INVALID_PARAMETERS", error, false)),
                );
                return;
            }
            thread::spawn(move || {
                let _dispatch = dispatch;
                let result = provider_media_cancel_blocking(&params, &streams);
                let _ = send_host_response(&writer, &request_id, result);
            });
        }
        "provider.media.poll" => {
            if let Err(error) = validate_provider_media_cancel_params(&params) {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error("INVALID_PARAMETERS", error, false)),
                );
                return;
            }
            thread::spawn(move || {
                let _dispatch = dispatch;
                let result = provider_media_poll_blocking(&params, &streams);
                let _ = send_host_response(&writer, &request_id, result);
            });
        }
        "provider.stream.start" => {
            if let Err(error) = validate_provider_stream_params(&params) {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error("INVALID_PARAMETERS", error, false)),
                );
                return;
            }
            let project_session_id = params["projectSessionId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let cancellation = Arc::new(llm_stream::LlmCancellation::default());
            let inserted = streams.lock().ok().is_some_and(|mut active| {
                if !available.load(Ordering::Acquire) || active.contains_key(&request_id) {
                    false
                } else {
                    active.insert(
                        request_id.clone(),
                        ActiveHostStream {
                            project_session_id: project_session_id.clone(),
                            cancellation: Arc::clone(&cancellation),
                        },
                    );
                    true
                }
            });
            if !inserted {
                let _ = send_host_response(
                    &writer,
                    &request_id,
                    Err(host_error(
                        "INVALID_PARAMETERS",
                        "Native Provider request ID is already active",
                        false,
                    )),
                );
                return;
            }
            thread::spawn(move || {
                let _dispatch = dispatch;
                run_host_provider_stream(
                    &request_id,
                    &project_session_id,
                    params,
                    Arc::clone(&cancellation),
                    &writer,
                );
                if let Ok(mut active) = streams.lock() {
                    if active
                        .get(&request_id)
                        .is_some_and(|current| Arc::ptr_eq(&current.cancellation, &cancellation))
                    {
                        active.remove(&request_id);
                    }
                }
            });
        }
        "provider.stream.cancel" => {
            let outcome = cancel_host_provider_stream(&params, &streams);
            let _ = send_host_response(&writer, &request_id, outcome.map(serde_json::Value::Bool));
        }
        "provider.confirmation.wait" | "provider.confirmation.resolve" => {
            let _ = send_host_response(
                &writer,
                &request_id,
                Err(host_error(
                    "PROVIDER_UNAVAILABLE",
                    "Native Provider confirmations are not active in P3",
                    false,
                )),
            );
        }
        _ => {
            let _ = send_host_response(
                &writer,
                &request_id,
                Err(host_error("METHOD_NOT_FOUND", "Unknown host method", false)),
            );
        }
    }
}

fn validate_provider_media_submit_params(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Media submit params must be an object")?;
    let allowed = [
        "projectSessionId",
        "operationId",
        "baseUrl",
        "providerProfileId",
        "adapterKey",
        "providerRegion",
        "modelId",
        "remoteModelId",
        "parameters",
        "inputs",
        "kind",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Media submit params contain unknown fields".to_string());
    }
    for key in [
        "projectSessionId",
        "providerProfileId",
        "adapterKey",
        "modelId",
        "remoteModelId",
        "kind",
    ] {
        if value[key].as_str().is_none_or(str::is_empty) {
            return Err(format!(
                "Media submit field {key} must be a non-empty string"
            ));
        }
    }
    if !matches!(
        value["providerRegion"].as_str(),
        Some("global" | "cn" | "unicompapi")
    ) {
        return Err("Media submit providerRegion is invalid".to_string());
    }
    if !value["parameters"].is_object() {
        return Err("Media submit parameters must be an object".to_string());
    }
    if value["kind"].as_str() != Some("image") && value["kind"].as_str() != Some("video") {
        return Err("Media submit kind is invalid".to_string());
    }
    if contains_sensitive_host_data(value) {
        return Err("Sensitive data cannot cross the Native Provider boundary".to_string());
    }
    Ok(())
}

fn validate_provider_media_cancel_params(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Media cancel params must be an object")?;
    let allowed = [
        "projectSessionId",
        "providerProfileId",
        "adapterKey",
        "providerRegion",
        "providerTaskId",
    ];
    if object
        .keys()
        .any(|key| !allowed.contains(&key.as_str()) && key != "operationId" && key != "baseUrl")
        || allowed.iter().any(|key| !object.contains_key(*key))
    {
        return Err("Media cancel params contain unknown or missing fields".to_string());
    }
    for key in allowed {
        if value[key].as_str().is_none_or(str::is_empty) {
            return Err(format!(
                "Media cancel field {key} must be a non-empty string"
            ));
        }
    }
    if !matches!(
        value["providerRegion"].as_str(),
        Some("global" | "cn" | "unicompapi")
    ) {
        return Err("Media cancel providerRegion is invalid".to_string());
    }
    if contains_sensitive_host_data(value) {
        return Err("Sensitive data cannot cross the Native Provider boundary".to_string());
    }
    Ok(())
}

fn provider_media_submit_blocking(
    params: &serde_json::Value,
    _streams: &Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
) -> Result<serde_json::Value, serde_json::Value> {
    let provider_profile_id = params["providerProfileId"].as_str().unwrap_or_default();
    let adapter_key = params["adapterKey"].as_str().unwrap_or_default();
    let provider_region = params["providerRegion"].as_str().unwrap_or_default();
    let base_url = params["baseUrl"].as_str().unwrap_or_default();
    let mut parameters = params["parameters"].clone();
    if official_video::family(adapter_key).is_some() {
        return official_video::submit(params);
    }
    resolve_controlled_media_inputs(&mut parameters, params.get("inputs"))?;
    let kind = params["kind"].as_str().unwrap_or_default();
    let remote_model_id = params["remoteModelId"].as_str().unwrap_or_default();
    if kind == "image" {
        let response = if let Some(provider_type) = openai_images_provider(adapter_key) {
            let base_url = params["baseUrl"].as_str().ok_or_else(|| {
                host_error(
                    "INVALID_PARAMETERS",
                    "OpenAI Images requires the frozen provider Base URL",
                    false,
                )
            })?;
            if provider_region != "global" {
                return Err(host_error(
                    "INVALID_PARAMETERS",
                    "OpenAI Images uses the global provider route",
                    false,
                ));
            }
            provider_openai_images_submit_blocking(
                adapter_key,
                provider_type,
                base_url,
                provider_profile_id,
                parameters,
                remote_model_id,
            )
            .map_err(OpenAiImagesSubmitFailure::into_host_error)?
        } else {
            provider_submit_blocking(
                adapter_key,
                provider_region,
                provider_profile_id,
                parameters,
                remote_model_id,
            )
            .map_err(|error| provider_transport_host_error(&error, false))?
        };
        return serde_json::to_value(response)
            .map_err(|error| host_error("INTERNAL_ERROR", error.to_string(), true));
    }
    let response = provider_submit_task_blocking(
        adapter_key,
        provider_region,
        base_url,
        provider_profile_id,
        parameters,
        remote_model_id,
    )
    .map_err(|error| provider_transport_host_error(&error, false))?;
    serde_json::to_value(response)
        .map_err(|error| host_error("INTERNAL_ERROR", error.to_string(), true))
}

fn resolve_controlled_media_inputs(
    value: &mut serde_json::Value,
    inputs: Option<&serde_json::Value>,
) -> Result<(), serde_json::Value> {
    // Text-to-video and URL-only media requests have no local controlled files.
    // Do not require the optional shared input root for those requests.
    if !contains_controlled_file_reference(value) {
        return Ok(());
    }
    let root = model_input_root().ok_or_else(|| {
        host_error(
            "INVALID_PARAMETERS",
            "Controlled media input root is unavailable",
            true,
        )
    })?;
    resolve_controlled_media_inputs_at_root(value, inputs, &root)
}

fn resolve_controlled_media_inputs_at_root(
    value: &mut serde_json::Value,
    inputs: Option<&serde_json::Value>,
    root: &Path,
) -> Result<(), serde_json::Value> {
    let Some(items) = inputs.and_then(serde_json::Value::as_array) else {
        return if contains_controlled_file_reference(value) {
            Err(host_error(
                "INVALID_PARAMETERS",
                "Controlled media input reference is not registered",
                false,
            ))
        } else {
            Ok(())
        };
    };
    if !root.is_absolute() {
        return Err(host_error(
            "INVALID_PARAMETERS",
            "Controlled media input root is invalid",
            true,
        ));
    }
    let root = root.canonicalize().map_err(|_| {
        host_error(
            "INVALID_PARAMETERS",
            "Controlled media input root is unavailable",
            true,
        )
    })?;
    let mut replacements = std::collections::HashMap::new();
    for item in items {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("controlled_temporary_file")
        {
            continue;
        }
        let handle = item
            .get("handle")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if handle.contains("..")
            || !handle.starts_with("cache/media-inputs/")
            || handle.contains('\\')
        {
            return Err(host_error(
                "INVALID_PARAMETERS",
                "Controlled media file handle is invalid",
                false,
            ));
        }
        let path = root.join(handle);
        let canonical = path.canonicalize().map_err(|_| {
            host_error(
                "INVALID_PARAMETERS",
                "Controlled media input file is unavailable",
                false,
            )
        })?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(host_error(
                "INVALID_PARAMETERS",
                "Controlled media input file is invalid",
                false,
            ));
        }
        // These legacy/gateway channels accept image URLs or Data URLs. A local
        // Windows path cannot be read by a remote Provider. Official upload
        // channels use their own resolver before reaching this function.
        let content_type = item
            .get("contentType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !["image/png", "image/jpeg", "image/webp"].contains(&content_type) {
            return Err(host_error(
                "INVALID_PARAMETERS",
                "This channel requires a public audio/video URL; local media upload is unavailable",
                false,
            ));
        }
        let metadata = canonical.metadata().map_err(|_| {
            host_error(
                "INVALID_PARAMETERS",
                "Controlled image is unavailable",
                false,
            )
        })?;
        if metadata.len() == 0 || metadata.len() > UNICOMPAPI_IMAGE_INPUT_LIMIT as u64 {
            return Err(host_error(
                "INVALID_PARAMETERS",
                "Controlled image exceeds the transport limit",
                false,
            ));
        }
        let bytes = std::fs::read(&canonical).map_err(|_| {
            host_error(
                "INVALID_PARAMETERS",
                "Controlled image is unavailable",
                false,
            )
        })?;
        let valid_signature = match content_type {
            "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
            "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            _ => false,
        };
        if !valid_signature
            || item
                .get("sizeBytes")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|size| size != bytes.len() as u64)
        {
            return Err(host_error(
                "INVALID_PARAMETERS",
                "Controlled image content changed or has an invalid signature",
                false,
            ));
        }
        if let Some(hash) = item.get("sha256").and_then(serde_json::Value::as_str) {
            use sha2::{Digest, Sha256};
            if format!("{:x}", Sha256::digest(&bytes)) != hash {
                return Err(host_error(
                    "INVALID_PARAMETERS",
                    "Controlled image content changed",
                    false,
                ));
            }
        }
        replacements.insert(
            format!("controlled-file://{handle}"),
            format!(
                "data:{content_type};base64,{}",
                BASE64_STANDARD.encode(bytes)
            ),
        );
    }
    fn walk(
        value: &mut serde_json::Value,
        replacements: &std::collections::HashMap<String, String>,
    ) {
        match value {
            serde_json::Value::String(text) => {
                if let Some(path) = replacements.get(text) {
                    *text = path.clone();
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, replacements);
                }
            }
            serde_json::Value::Object(items) => {
                for item in items.values_mut() {
                    walk(item, replacements);
                }
            }
            _ => {}
        }
    }
    walk(value, &replacements);
    if contains_controlled_file_reference(value) {
        return Err(host_error(
            "INVALID_PARAMETERS",
            "Controlled media input reference is not registered",
            false,
        ));
    }
    Ok(())
}

fn contains_controlled_file_reference(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => text.starts_with("controlled-file://"),
        serde_json::Value::Array(items) => items.iter().any(contains_controlled_file_reference),
        serde_json::Value::Object(items) => items.values().any(contains_controlled_file_reference),
        _ => false,
    }
}

fn provider_media_cancel_blocking(
    params: &serde_json::Value,
    _streams: &Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
) -> Result<serde_json::Value, serde_json::Value> {
    if official_video::family(params["adapterKey"].as_str().unwrap_or_default()).is_some() {
        return official_video::cancel(params);
    }
    let result = provider_cancel_task_blocking(
        params["adapterKey"].as_str().unwrap_or_default(),
        params["providerRegion"].as_str().unwrap_or_default(),
        params["providerProfileId"].as_str().unwrap_or_default(),
        params["providerTaskId"].as_str().unwrap_or_default(),
    )
    .map_err(|error| provider_transport_host_error(&error, true))?;
    serde_json::to_value(result)
        .map_err(|error| host_error("INTERNAL_ERROR", error.to_string(), true))
}

fn provider_media_poll_blocking(
    params: &serde_json::Value,
    _streams: &Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
) -> Result<serde_json::Value, serde_json::Value> {
    if official_video::family(params["adapterKey"].as_str().unwrap_or_default()).is_some() {
        return official_video::poll(params);
    }
    let adapter_key = params["adapterKey"].as_str().unwrap_or_default();
    let provider_region = params["providerRegion"].as_str().unwrap_or_default();
    let base_url = params["baseUrl"].as_str().unwrap_or_default();
    let provider_profile_id = params["providerProfileId"].as_str().unwrap_or_default();
    let provider_task_id = params["providerTaskId"].as_str().unwrap_or_default();
    let response = provider_poll_task_blocking(
        adapter_key,
        provider_region,
        base_url,
        provider_profile_id,
        provider_task_id,
    )
    .map_err(|error| provider_transport_host_error(&error, true))?;
    let succeeded = (200..300).contains(&response.status)
        && provider_state(&response.body).is_some_and(|state| {
            matches!(
                state.trim().to_ascii_lowercase().as_str(),
                "success" | "succeeded" | "completed"
            )
        });
    let output = if succeeded {
        let source = provider_video_source(&response.body);
        let authenticated_content = source
            .and_then(|source| tauri::Url::parse(source).ok())
            .is_some_and(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some(UNICOMPAPI_HOST)
                    && unicompapi_video_content_path(provider_task_id)
                        .is_ok_and(|path| url.path() == path)
            });
        if is_custom_openai_video_adapter(adapter_key)
            || (provider_region == "unicompapi" && (source.is_none() || authenticated_content))
        {
            Some(provider_download_task_blocking(
                adapter_key,
                provider_region,
                base_url,
                provider_profile_id,
                provider_task_id,
            ))
        } else {
            Some(
                provider_video_source(&response.body)
                    .ok_or_else(|| {
                        "Provider reported success without a video output URL".to_string()
                    })
                    .and_then(provider_download_remote_video_blocking),
            )
        }
        .transpose()
        .map_err(|error| host_error("PROVIDER_FAILED", error, true))?
    } else {
        None
    };
    normalize_provider_media_poll(
        &response,
        if model_contract::is_contract_adapter(adapter_key) {
            "official-contract"
        } else {
            provider_region
        },
        output.as_ref(),
    )
    .map_err(|error| host_error("INTERNAL_ERROR", error, false))
}

fn normalize_provider_media_poll(
    response: &ProviderHttpResponse,
    provider_region: &str,
    output: Option<&ProviderBinaryDownloadResponse>,
) -> Result<serde_json::Value, String> {
    let provider_state = provider_state(&response.body)
        .map(str::trim)
        .filter(|state| !state.is_empty() && state.len() <= 64)
        .map(str::to_ascii_lowercase);
    let state = if response.status == 429 || response.status >= 500 {
        "running"
    } else if !(200..300).contains(&response.status) {
        "failed"
    } else {
        match provider_state.as_deref() {
            Some("created" | "queueing" | "queued" | "pending" | "submitted" | "not_start") => {
                "queued"
            }
            Some("in_progress" | "processing" | "running") => "running",
            Some("unknown") if provider_region == "unicompapi" => "running",
            Some("success" | "succeeded" | "completed") => "succeeded",
            Some("cancelled" | "canceled") => "cancelled",
            Some("failed" | "failure" | "error" | "expired") | None => "failed",
            Some(_) => "failed",
        }
    };
    if state == "succeeded" && output.is_none() {
        return Err("Successful Provider task is missing its downloaded output".to_string());
    }

    let mut normalized = serde_json::Map::from_iter([
        (
            "providerStatus".to_string(),
            serde_json::json!(response.status),
        ),
        ("state".to_string(), serde_json::json!(state)),
    ]);
    if let Some(provider_state) = provider_state {
        normalized.insert(
            "providerState".to_string(),
            serde_json::json!(provider_state),
        );
    }
    if let Some(retry_after_ms) = response.retry_after_ms {
        normalized.insert(
            "retryAfterMs".to_string(),
            serde_json::json!(retry_after_ms),
        );
    }
    if matches!(state, "queued" | "running") {
        if let Some(progress) = provider_numeric_field(&response.body, &["progress"]) {
            normalized.insert("progress".to_string(), serde_json::json!(progress));
        }
    }
    if let Some(cost) = provider_cost(&response.body) {
        normalized.insert("cost".to_string(), cost);
    }
    if let Some(output) = output {
        let mut value = serde_json::json!({
            "type": "native_temporary_file",
            "path": output.path,
        });
        if let Some(content_type) = &output.content_type {
            value["contentType"] = serde_json::json!(content_type);
        }
        normalized.insert("output".to_string(), value);
    }
    if state == "failed" {
        let (code, message) = provider_submit_error(&response.body);
        let message = sanitize_provider_diagnostic(
            message
                .as_deref()
                .unwrap_or("Provider returned a failed or unsupported task state"),
        );
        normalized.insert(
            "error".to_string(),
            serde_json::json!({
                "code": code.map(|value| sanitize_provider_diagnostic(&value)),
                "message": message,
                "retryable": false,
            }),
        );
    }
    Ok(serde_json::Value::Object(normalized))
}

fn run_host_provider_stream(
    request_id: &str,
    project_session_id: &str,
    params: serde_json::Value,
    cancellation: Arc<llm_stream::LlmCancellation>,
    writer: &Arc<Mutex<ChildStdin>>,
) {
    let mut sequence = 0_u64;
    let mut emit = |mut event: serde_json::Value| -> Result<(), llm_stream::StreamFailure> {
        event["projectSessionId"] = serde_json::Value::String(project_session_id.to_string());
        let envelope = serde_json::json!({
            "kind": "host.event",
            "requestId": request_id,
            "sequence": sequence,
            "event": event,
        });
        write_sidecar_value(writer, &envelope).map_err(|message| llm_stream::StreamFailure {
            message,
            retryable: true,
            cancelled: false,
            provider_status: None,
            provider_error_code: None,
            usage: None,
            guard_outcome: request_guard::Outcome::Neutral,
            admission_rejected: false,
        })?;
        sequence += 1;
        Ok(())
    };
    let result = llm_stream::native_provider_stream(params, Arc::clone(&cancellation), |event| {
        emit_native_provider_event(event, &mut emit)
    });
    match result {
        Ok(()) => {
            let _ = send_host_response(
                writer,
                request_id,
                Ok(serde_json::json!({ "projectSessionId": project_session_id })),
            );
        }
        Err(failure) => {
            if let Some(usage) = failure.usage.as_ref() {
                let _ = emit(serde_json::json!({ "type": "usage", "usage": usage }));
            }
            let code = if failure.cancelled {
                "CANCELLED"
            } else if failure.admission_rejected {
                "REQUEST_NOT_SENT"
            } else if failure.message.to_ascii_lowercase().contains("timeout")
                || failure.message.contains("超时")
            {
                "TIMEOUT"
            } else {
                "PROVIDER_FAILED"
            };
            let terminal = if failure.cancelled {
                serde_json::json!({ "type": "cancelled" })
            } else {
                serde_json::json!({
                    "type": "failed",
                    "error": provider_host_error(
                        code,
                        &failure.message,
                        failure.retryable,
                        failure.provider_status,
                        failure.provider_error_code.as_deref(),
                    ),
                })
            };
            let _ = emit(terminal);
            let _ = send_host_response(
                writer,
                request_id,
                Err(provider_host_error(
                    code,
                    failure.message,
                    failure.retryable,
                    failure.provider_status,
                    failure.provider_error_code.as_deref(),
                )),
            );
        }
    }
}

fn emit_native_provider_event<F>(
    event: llm_stream::LlmStreamEvent,
    emit: &mut F,
) -> Result<(), llm_stream::StreamFailure>
where
    F: FnMut(serde_json::Value) -> Result<(), llm_stream::StreamFailure>,
{
    match event {
        llm_stream::LlmStreamEvent::RequestProgress {
            stage,
            argument_bytes,
            tool_name,
            received_bytes,
            request_body_hash,
            request_body_bytes,
            wire_context,
        } => {
            let mut value = serde_json::json!({ "type": "request_progress", "stage": stage });
            if let Some(bytes) = argument_bytes {
                value["argumentBytes"] = serde_json::json!(bytes);
            }
            if let Some(name) = tool_name {
                value["toolName"] = serde_json::json!(name);
            }
            if let Some(bytes) = received_bytes {
                value["receivedBytes"] = serde_json::json!(bytes);
            }
            if let Some(hash) = request_body_hash {
                value["requestBodyHash"] = serde_json::json!(hash);
            }
            if let Some(wire) = wire_context {
                value["wireContext"] = wire;
            }
            if let Some(bytes) = request_body_bytes {
                value["requestBodyBytes"] = serde_json::json!(bytes);
            }
            emit(value)
        }
        llm_stream::LlmStreamEvent::Started => emit(serde_json::json!({ "type": "started" })),
        llm_stream::LlmStreamEvent::Delta { delta } => {
            emit(serde_json::json!({ "type": "text_delta", "delta": delta }))
        }
        llm_stream::LlmStreamEvent::ThinkingDelta { delta } => {
            emit(serde_json::json!({ "type": "thinking_delta", "delta": delta }))
        }
        llm_stream::LlmStreamEvent::ToolCalls {
            calls,
            finish_reason,
            provider_response_id,
            usage,
        } => {
            for call in calls {
                let value = serde_json::to_value(&call).map_err(|_| llm_stream::StreamFailure {
                    message: "Provider tool call could not be serialized".to_string(),
                    retryable: false,
                    cancelled: false,
                    provider_status: None,
                    provider_error_code: None,
                    usage: None,
                    guard_outcome: request_guard::Outcome::Neutral,
                    admission_rejected: false,
                })?;
                let call_id = value["id"].as_str().unwrap_or_default();
                let name = value["name"].as_str().unwrap_or_default();
                let arguments = value["argumentsJson"].as_str().unwrap_or_default();
                emit(serde_json::json!({
                    "type": "tool_call_start",
                    "callId": call_id,
                    "name": name,
                }))?;
                if !arguments.is_empty() {
                    emit(serde_json::json!({
                        "type": "tool_call_delta",
                        "callId": call_id,
                        "delta": arguments,
                    }))?;
                }
                emit(serde_json::json!({
                    "type": "tool_call_end",
                    "call": {
                        "id": call_id,
                        "name": name,
                        "argumentsJson": arguments,
                    },
                }))?;
            }
            if let Some(usage) = usage {
                emit(serde_json::json!({ "type": "usage", "usage": usage }))?;
            }
            emit(serde_json::json!({
                "type": "complete",
                "providerResponseId": provider_response_id,
                "finishReason": finish_reason,
            }))
        }
        llm_stream::LlmStreamEvent::Complete {
            provider_response_id,
            finish_reason,
            usage,
        } => {
            if let Some(usage) = usage {
                emit(serde_json::json!({ "type": "usage", "usage": usage }))?;
            }
            emit(serde_json::json!({
                "type": "complete",
                "providerResponseId": provider_response_id,
                "finishReason": finish_reason,
            }))
        }
        llm_stream::LlmStreamEvent::Failed {
            error,
            retryable,
            provider_status,
            provider_error_code,
            usage,
        } => {
            if let Some(usage) = usage {
                emit(serde_json::json!({ "type": "usage", "usage": usage }))?;
            }
            emit(serde_json::json!({
                "type": "failed",
                "error": provider_host_error(
                    "PROVIDER_FAILED",
                    error,
                    retryable,
                    provider_status,
                    provider_error_code.as_deref(),
                ),
            }))
        }
        llm_stream::LlmStreamEvent::Cancelled => emit(serde_json::json!({ "type": "cancelled" })),
    }
}

fn cancel_host_provider_stream(
    params: &serde_json::Value,
    streams: &Arc<Mutex<std::collections::HashMap<String, ActiveHostStream>>>,
) -> Result<bool, serde_json::Value> {
    let Some(object) = params.as_object() else {
        return Err(host_error(
            "INVALID_PARAMETERS",
            "Cancellation params must be an object",
            false,
        ));
    };
    if !has_exact_keys(object, &["streamRequestId", "projectSessionId"]) {
        return Err(host_error(
            "INVALID_PARAMETERS",
            "Cancellation params contain unknown fields",
            false,
        ));
    }
    let stream_request_id = params["streamRequestId"].as_str().unwrap_or_default();
    let project_session_id = params["projectSessionId"].as_str().unwrap_or_default();
    let active = streams.lock().map_err(|_| {
        host_error(
            "INTERNAL_ERROR",
            "Native Provider registry lock is poisoned",
            true,
        )
    })?;
    let Some(stream) = active.get(stream_request_id) else {
        return Ok(false);
    };
    if stream.project_session_id != project_session_id {
        return Err(host_error(
            "STALE_SESSION",
            "Cancellation belongs to a stale project session",
            false,
        ));
    }
    stream.cancellation.cancel();
    Ok(true)
}

fn validate_host_request_envelope(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Host request envelope must be an object")?;
    if !has_exact_keys(object, &["kind", "requestId", "method", "params"]) {
        return Err("Host request envelope contains unknown or missing fields".to_string());
    }
    if value["kind"].as_str() != Some("host.request")
        || value["requestId"].as_str().is_none_or(str::is_empty)
        || value["method"].as_str().is_none_or(str::is_empty)
        || !value["params"].is_object()
    {
        return Err("Host request envelope fields are invalid".to_string());
    }
    if serde_json::to_vec(value)
        .map_err(|_| "Host request cannot be serialized".to_string())?
        .len()
        > if value["method"].as_str() == Some("provider.stream.start") {
            MODEL_REQUEST_ENVELOPE_MAX_BYTES
        } else {
            SIDECAR_ENVELOPE_MAX_BYTES
        }
    {
        return Err("Host request exceeds the 2 MiB limit".to_string());
    }
    Ok(())
}

fn validate_provider_stream_params(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Native Provider params must be an object")?;
    let allowed = [
        "generationId",
        "inferenceSettings",
        "modelCapabilities",
        "contextTurns",
        "attemptId",
        "projectId",
        "projectSessionId",
        "conversationId",
        "providerProfileId",
        "modelId",
        "remoteModelId",
        "protocol",
        "baseUrl",
        "systemInstruction",
        "context",
        "prompt",
        "attachments",
        "tools",
        "continuation",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Native Provider params contain an unknown field".to_string());
    }
    for key in [
        "generationId",
        "attemptId",
        "projectId",
        "projectSessionId",
        "conversationId",
        "providerProfileId",
        "modelId",
        "remoteModelId",
        "protocol",
        "baseUrl",
    ] {
        if value[key].as_str().is_none_or(str::is_empty) {
            return Err(format!(
                "Native Provider field {key} must be a non-empty string"
            ));
        }
    }
    if contains_sensitive_host_data(value) {
        return Err("Sensitive data cannot cross the Native Provider boundary".to_string());
    }
    if let Some(settings) = value.get("inferenceSettings") {
        llm_stream::validate_provider_inference_settings(
            value["protocol"].as_str().unwrap_or_default(),
            settings,
        )?;
    }
    Ok(())
}

fn contains_sensitive_host_data(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => {
            let lower = value.to_ascii_lowercase();
            lower.starts_with("http")
                && lower.contains('?')
                && ["x-amz-signature=", "signature=", "sig=", "token="]
                    .iter()
                    .any(|needle| lower.contains(needle))
        }
        serde_json::Value::Array(values) => values.iter().any(contains_sensitive_host_data),
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            let normalized = key
                .chars()
                .filter(char::is_ascii_alphabetic)
                .collect::<String>()
                .to_ascii_lowercase();
            matches!(
                normalized.as_str(),
                "secret" | "authorization" | "headers" | "apikey" | "signedurl"
            ) || normalized.starts_with("authorization")
                || contains_sensitive_host_data(value)
        }),
        _ => false,
    }
}

fn has_exact_keys(object: &serde_json::Map<String, serde_json::Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn host_error(code: &str, message: impl AsRef<str>, retryable: bool) -> serde_json::Value {
    serde_json::json!({
        "code": code,
        "message": message.as_ref().chars().take(500).collect::<String>(),
        "retryable": retryable,
    })
}

fn provider_host_error(
    code: &str,
    message: impl AsRef<str>,
    retryable: bool,
    provider_status: Option<u32>,
    provider_error_code: Option<&str>,
) -> serde_json::Value {
    let mut error = host_error(code, message, retryable);
    if let Some(status) = provider_status {
        error["providerStatus"] = serde_json::json!(status);
    }
    if let Some(provider_code) = provider_error_code {
        error["providerErrorCode"] = serde_json::json!(provider_code);
    }
    error
}

fn provider_transport_host_error(message: &str, retryable: bool) -> serde_json::Value {
    if request_guard::is_admission_error(message) {
        host_error("REQUEST_NOT_SENT", message, true)
    } else {
        host_error("PROVIDER_FAILED", message, retryable)
    }
}

fn send_host_response(
    writer: &Arc<Mutex<ChildStdin>>,
    request_id: &str,
    result: Result<serde_json::Value, serde_json::Value>,
) -> Result<(), String> {
    let envelope = match result {
        Ok(result) => serde_json::json!({
            "kind": "host.response", "requestId": request_id, "ok": true, "result": result,
        }),
        Err(error) => serde_json::json!({
            "kind": "host.response", "requestId": request_id, "ok": false, "error": error,
        }),
    };
    write_sidecar_value(writer, &envelope)
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(debug_assertions)]
fn worker_command() -> Result<Command, String> {
    // Opt-in acceptance runs freeze their own Worker without replacing a live desktop build.
    #[cfg(test)]
    if let Some(entry) = std::env::var_os("AI_VIDEO_CONTEXT_E2E_WORKER_ENTRY") {
        let entry = PathBuf::from(entry);
        if !entry.is_absolute() || !entry.is_file() {
            return Err("Acceptance Worker entry must be an existing absolute file path".into());
        }
        let mut command = Command::new("node");
        command
            .current_dir(
                entry
                    .parent()
                    .ok_or("Acceptance Worker directory is missing")?,
            )
            .arg(entry);
        return Ok(command);
    }
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
    process: Mutex<Option<Arc<WorkerProcess>>>,
    stopping: AtomicBool,
    app_data_dir: PathBuf,
    research_bridge: NativeResearchBridge,
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

#[derive(Clone, Default)]
struct RuntimeExitState {
    started: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownImportResult {
    pub(crate) title: String,
    pub(crate) content_markdown: String,
}

pub(crate) fn read_markdown_document(path: &Path) -> Result<MarkdownImportResult, String> {
    if !path.is_absolute() {
        return Err("Markdown import path must be absolute".to_string());
    }
    let supported_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        });
    if !supported_extension {
        return Err("Only .md and .markdown files can be imported".to_string());
    }

    let mut file =
        File::open(path).map_err(|error| format!("Could not open Markdown file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect Markdown file: {error}"))?;
    if !metadata.is_file() {
        return Err("Markdown import path must identify a file".to_string());
    }
    if metadata.len() > MARKDOWN_IMPORT_LIMIT {
        return Err("Markdown file exceeds the 5 MiB import limit".to_string());
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Markdown file: {error}"))?;
    if bytes.len() as u64 > MARKDOWN_IMPORT_LIMIT {
        return Err("Markdown file exceeds the 5 MiB import limit".to_string());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "Markdown files must use UTF-8 encoding".to_string())?;
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Markdown file name cannot be used as a document title")?;

    Ok(MarkdownImportResult {
        title: title.to_string(),
        content_markdown: content
            .strip_prefix('\u{feff}')
            .unwrap_or(&content)
            .to_string(),
    })
}

#[tauri::command]
fn markdown_import(path: String) -> Result<MarkdownImportResult, String> {
    read_markdown_document(Path::new(&path))
}

impl WorkerState {
    fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            process: Mutex::new(None),
            stopping: AtomicBool::new(false),
            app_data_dir,
            research_bridge: NativeResearchBridge::start()?,
        })
    }

    fn request(&self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.request_with_timeout(request, worker_request_timeout(request))
    }

    fn request_with_timeout(
        &self,
        request: &serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("WORKER_STOPPING: The application is closing".into());
        }
        let worker = {
            let mut guard = self.process.lock().map_err(|_| "Worker lock is poisoned")?;
            if self.stopping.load(Ordering::Acquire) {
                return Err("WORKER_STOPPING: The application is closing".into());
            }
            if let Some(worker) = guard
                .as_ref()
                .filter(|worker| !worker.available.load(Ordering::Acquire))
            {
                // Reap under the supervisor lock, even while old callers retain an Arc.
                worker.stop();
                *guard = None;
            }
            if guard.is_none() {
                *guard = Some(Arc::new(WorkerProcess::spawn_for_app(
                    &self.app_data_dir,
                    &self.research_bridge,
                )?));
            }
            Arc::clone(guard.as_ref().ok_or("Worker failed to start")?)
        };
        let result = worker.request_with_timeout(request, timeout);
        if !worker.available.load(Ordering::Acquire) {
            let mut guard = self.process.lock().map_err(|_| "Worker lock is poisoned")?;
            if guard
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &worker))
            {
                worker.stop();
                *guard = None;
            }
        }
        result
    }

    fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        if let Ok(mut guard) = self.process.lock() {
            if let Some(worker) = guard.take() {
                worker.shutdown();
            }
        }
    }
}

#[tauri::command]
async fn worker_request(
    request: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let media_source = matches!(
        request.get("method").and_then(serde_json::Value::as_str),
        Some("asset.mediaSource" | "asset.thumbnail" | "audio.mediaSource")
    );
    let worker_app = app.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        worker_app.state::<WorkerState>().request(&request)
    })
    .await
    .map_err(|error| format!("Worker request task failed: {error}"))??;
    if media_source && response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        if let Some(path) = response
            .pointer("/result/path")
            .and_then(serde_json::Value::as_str)
        {
            let content_type = response
                .pointer("/result/contentType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !matches!(
                content_type,
                "image/png"
                    | "image/jpeg"
                    | "image/webp"
                    | "image/gif"
                    | "video/mp4"
                    | "video/webm"
                    | "video/quicktime"
                    | "video/x-matroska"
                    | "audio/mpeg"
                    | "audio/wav"
                    | "audio/x-wav"
            ) {
                return Err("Project media has an unsupported playback type".into());
            }
            let path = Path::new(path)
                .canonicalize()
                .map_err(|_| "Project media playback file is unavailable".to_string())?;
            if !path.is_file() {
                return Err("Project media playback file is invalid".into());
            }
            app.asset_protocol_scope().allow_file(path).map_err(|_| {
                "Project media could not be added to the playback scope".to_string()
            })?;
        }
    }
    Ok(response)
}

fn shutdown_runtimes(app: tauri::AppHandle, exit_state: RuntimeExitState) {
    let worker_app = app.clone();
    let worker_exit_state = exit_state.clone();
    thread::spawn(move || {
        // Worker owns Pi checkpoints; stop it before cancelling native transport resources.
        worker_app.state::<WorkerState>().shutdown();
        worker_app.state::<LlmStreamState>().interrupt_all();
        dubbing_provider::cancel_all();
        if !worker_exit_state.completed.swap(true, Ordering::AcqRel) {
            worker_app.exit(0);
        }
    });
    thread::spawn(move || {
        thread::sleep(RUNTIME_EXIT_GRACE);
        if !exit_state.completed.swap(true, Ordering::AcqRel) {
            app.exit(0);
        }
    });
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
            let worker_state = WorkerState::new(app_data_dir)?;
            let migration_report = migrate_legacy_provider_credentials(&worker_state);
            app.manage(LegacyProviderMigrationState(migration_report));
            app.manage(worker_state);
            app.manage(LlmStreamState::default());
            app.manage(RuntimeExitState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            worker_request,
            markdown_import,
            novel_import,
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
        .build(tauri::generate_context!())
        .expect("error while building unicomp")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let exit_state = app.state::<RuntimeExitState>().inner().clone();
                if exit_state.completed.load(Ordering::Acquire) {
                    return;
                }
                api.prevent_exit();
                if !exit_state.started.swap(true, Ordering::AcqRel) {
                    shutdown_runtimes(app.clone(), exit_state);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_worker_path, contains_image_source, credential_target, ensure_credential_subject,
        ensure_video_adapter, externalize_provider_images, is_profile_id,
        normalize_provider_media_poll, openai_compatible_video_extension, openai_images_payload,
        openai_images_provider, openai_images_target, provider_cancel_path, provider_payload,
        provider_state, provider_submit_error, provider_target, provider_task_error,
        provider_task_id, provider_task_path, provider_video_extension,
        resolve_controlled_media_inputs, resolve_controlled_media_inputs_at_root,
        resolve_media_selection, unicompapi_adapter_model, unicompapi_payload,
        unicompapi_video_content_path, unicompapi_video_task_path, validate_credential_provider,
        validate_host_request_envelope, validate_provider_media_cancel_params,
        validate_provider_stream_params, ProviderBinaryDownloadResponse, ProviderHttpResponse,
        WorkerProcess, WorkerState, BASE64_STANDARD, BUNDLED_WORKER_FILENAME,
        MARKDOWN_IMPORT_LIMIT, PROVIDER_REQUEST_BODY_LIMIT, SIDECAR_ENVELOPE_MAX_BYTES,
        UNICOMPAPI_AUTHORIZATION_SCHEME, UNICOMPAPI_HOST,
    };
    use base64::Engine as _;
    use serde_json::json;
    use std::{
        fs::{create_dir_all, remove_dir_all, write},
        path::Path,
        process::Command,
        sync::Arc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn official_video_contract_round_trip_uses_the_existing_protocol_bridge() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let body_start;
            loop {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    body_start = index + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&bytes[..body_start]);
            assert!(headers.starts_with("POST /v1/videos HTTP/1.1"));
            assert!(headers.contains("Authorization: Bearer local-contract-key"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|length| length.trim().parse().ok())
                })
                .unwrap();
            while bytes.len() < body_start + length {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap();
            assert_eq!(body["model"], "happyhorse-1.1-r2v");
            assert_eq!(body["images"].as_array().unwrap().len(), 9);
            assert_eq!(body["seed"], 2147483647);
            assert!(body.get("generate_audio").is_none());
            let response = json!({"output":{"task_id":"mock-task","task_status":"SUCCEEDED","video_url":"https://example.com/output.mp4"}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        let body = unicompapi_payload("REFERENCE_TO_VIDEO:unicompapi:cn.happyhorse.1.1.r2v:contract-1",json!({"prompt":"A horse running", "images":vec!["https://example.com/reference.png";9],"seed":2147483647}),"happyhorse-1.1-r2v").unwrap();
        let response = super::request_json(super::JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "POST",
            path: "/v1/videos",
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: "local-contract-key",
            body: Some(&body),
            request_body_limit: 1024 * 1024,
            response_body_limit: 1024 * 1024,
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(provider_task_id(&response.body), Some("mock-task"));
        assert_eq!(provider_state(&response.body), Some("SUCCEEDED"));
        assert_eq!(
            super::provider_video_source(&response.body),
            Some("https://example.com/output.mp4")
        );
    }

    #[test]
    fn seedance_gateway_submit_encodes_integer_durations_as_strings_in_all_modes() {
        #[derive(serde::Deserialize)]
        struct GatewayVideoRequest {
            seconds: String,
        }

        for (id, model, max_duration) in [
            (
                "cn.bytedance.seedance2-0.video",
                "doubao-seedance-2-0-260128",
                15,
            ),
            (
                "cn.bytedance.seedance2-5.video",
                "doubao-seedance-2-5-260628",
                30,
            ),
        ] {
            for mode in [
                "TEXT_TO_VIDEO",
                "IMAGE_TO_VIDEO",
                "REFERENCE_TO_VIDEO",
                "START_END_TO_VIDEO",
            ] {
                let key = format!("{mode}:unicompapi:{id}:contract-2");
                let mut content = vec![json!({"type":"text","text":"人物在雨中回头"})];
                let roles: &[&str] = match mode {
                    "IMAGE_TO_VIDEO" => &["first_frame"],
                    "REFERENCE_TO_VIDEO" => {
                        &["reference_image", "reference_image", "reference_image"]
                    }
                    "START_END_TO_VIDEO" => &["first_frame", "last_frame"],
                    _ => &[],
                };
                for (index, role) in roles.iter().enumerate() {
                    content.push(json!({"type":"image_url","role":role,"image_url":{"url":format!("https://example.com/image-{index}.png")}}));
                }
                for duration in [7, -1, 4, max_duration] {
                    let parameters =
                        json!({"content":content,"duration":duration,"generate_audio":false});
                    let body = unicompapi_payload(&key, parameters.clone(), model).unwrap();
                    let request: GatewayVideoRequest = serde_json::from_slice(&body)
                        .expect("UniComp /v1/videos requires string seconds");
                    assert_eq!(request.seconds, duration.to_string());
                    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(
                        parsed,
                        json!({"model":model,"prompt":"人物在雨中回头","seconds":duration.to_string(),"metadata":{"content":content,"generate_audio":false}})
                    );
                    assert_eq!(parameters["duration"], duration);
                }
                assert!(
                    unicompapi_payload(&key, json!({"content":content,"duration":"7"}), model)
                        .is_err()
                );
            }
        }
    }

    #[test]
    fn official_wan3_contract_projects_qwen_video_parameters() {
        let adapter_key = "TEXT_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-1";
        let body = unicompapi_payload(
            adapter_key,
            json!({
                "prompt": "一只小猫在月光下奔跑",
                "resolution": "720P",
                "ratio": "adaptive",
                "duration": 5,
                "audio": true,
                "prompt_extend": true,
                "watermark": false,
                "seed": -1
            }),
            "wan3.0-video",
        )
        .expect("Wan 3 contract should project through the video bridge");
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["model"], "wan3.0-video");
        assert_eq!(parsed["audio"], true);
        assert_eq!(parsed["prompt_extend"], true);
        assert_eq!(parsed["seed"], -1);
        assert!(parsed.get("generate_audio").is_none());
    }

    #[test]
    fn official_qwen_image_contract_projects_openai_image_parameters() {
        let adapter_key = "TEXT_TO_IMAGE:unicompapi:cn.qwen.qwen-image-3-0-pro:contract-1";
        let body = unicompapi_payload(
            adapter_key,
            json!({
                "prompt": "一只小猫在月光下奔跑",
                "size": "1024x1024",
                "n": 1,
                "prompt_extend": true,
                "watermark": false
            }),
            "qwen-image-3.0-pro",
        )
        .expect("Qwen Image contract should project through the image bridge");
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["model"], "qwen-image-3.0-pro");
        assert_eq!(parsed["n"], 1);
        assert_eq!(parsed["size"], "1024*1024");
        assert!(parsed.get("generate_audio").is_none());
        let auto = unicompapi_payload(
            adapter_key,
            json!({"prompt": "一只小猫", "size": "auto"}),
            "qwen-image-3.0-pro",
        )
        .expect("auto size should use the provider default");
        assert!(serde_json::from_slice::<serde_json::Value>(&auto)
            .unwrap()
            .get("size")
            .is_none());
    }

    #[test]
    fn admission_refusals_are_unsent_but_post_submit_poll_failures_are_not() {
        for code in [
            "REQUEST_QUEUE_FULL",
            "REQUEST_QUEUE_TIMEOUT",
            "PROVIDER_CIRCUIT_OPEN",
            "PROVIDER_COOLDOWN",
        ] {
            let error = format!("{code}: 请求尚未发送");
            let unsent = super::provider_transport_host_error(&error, false);
            assert_eq!(unsent["code"], "REQUEST_NOT_SENT");
            assert_eq!(unsent["retryable"], true);
            let submitted = super::provider_transport_host_error(
                &format!("Provider image task already submitted; polling failed: {error}"),
                false,
            );
            assert_eq!(submitted["code"], "PROVIDER_FAILED");
        }
        let ambiguous = super::provider_transport_host_error("Connection reset after send", false);
        assert_eq!(ambiguous["code"], "PROVIDER_FAILED");
    }

    #[test]
    fn openai_images_preflight_errors_are_distinguished_from_transport_ambiguity() {
        let preflight = super::OpenAiImagesSubmitFailure::not_sent(
            "Provider API hostname is outside the network boundary",
        )
        .into_host_error();
        assert_eq!(preflight["code"], "REQUEST_NOT_SENT");

        let before_send = super::OpenAiImagesSubmitFailure::after_transport(
            super::provider_http::JsonHttpError::dubbing_test_error(
                super::provider_http::JsonHttpErrorKind::Transport,
                false,
                None,
            ),
        )
        .into_host_error();
        assert_eq!(before_send["code"], "REQUEST_NOT_SENT");

        let after_send = super::OpenAiImagesSubmitFailure::after_transport(
            super::provider_http::JsonHttpError::dubbing_test_error(
                super::provider_http::JsonHttpErrorKind::Transport,
                true,
                None,
            ),
        )
        .into_host_error();
        assert_eq!(after_send["code"], "PROVIDER_FAILED");
    }

    #[test]
    fn paid_unicompapi_submissions_use_the_long_receive_timeout() {
        for path in ["/v1/images/generations", "/v1/videos"] {
            assert_eq!(
                super::unicompapi_receive_timeout("POST", path),
                Duration::from_secs(300)
            );
        }
        for (method, path) in [
            ("GET", "/v1/models"),
            ("POST", "/v1/unknown"),
            ("GET", "/v1/videos/task"),
        ] {
            assert_eq!(
                super::unicompapi_receive_timeout(method, path),
                Duration::from_secs(30)
            );
        }
    }

    #[test]
    fn markdown_import_accepts_utf8_markdown_and_rejects_unsafe_inputs() {
        let root = std::env::temp_dir().join(format!(
            "unicomp-markdown-import-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        create_dir_all(&root).expect("create Markdown import fixture directory");

        let markdown = root.join("第一章.md");
        write(&markdown, "\u{feff}# 第一章\n\n故事开始。").expect("write Markdown fixture");
        let imported = super::read_markdown_document(&markdown).expect("import Markdown fixture");
        assert_eq!(imported.title, "第一章");
        assert_eq!(imported.content_markdown, "# 第一章\n\n故事开始。");

        let unsupported = root.join("notes.txt");
        write(&unsupported, "not Markdown").expect("write unsupported fixture");
        assert!(super::read_markdown_document(&unsupported).is_err());

        let invalid_utf8 = root.join("invalid.markdown");
        write(&invalid_utf8, [0xff, 0xfe]).expect("write invalid UTF-8 fixture");
        assert!(super::read_markdown_document(&invalid_utf8).is_err());

        let oversized = root.join("oversized.md");
        let oversized_file = std::fs::File::create(&oversized).expect("create oversized fixture");
        oversized_file
            .set_len(MARKDOWN_IMPORT_LIMIT + 1)
            .expect("size oversized fixture");
        assert!(super::read_markdown_document(&oversized).is_err());

        remove_dir_all(root).expect("remove Markdown import fixture directory");
    }

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
            bundled_worker_path(Path::new(r"C:\Program Files\unicomp")),
            Path::new(r"C:\Program Files\unicomp\ai-video-worker.exe")
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
            let state =
                WorkerState::new(app_data_dir.clone()).expect("research bridge should start");
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
            let state =
                WorkerState::new(app_data_dir.clone()).expect("research bridge should start");
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
            let state =
                WorkerState::new(app_data_dir.clone()).expect("research bridge should start");
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
    fn media_profile_resolution_rejects_an_unmatched_requested_region() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-media-region-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state =
                WorkerState::new(app_data_dir.clone()).expect("research bridge should start");
            let created = state
                .request(&json!({
                    "id": "rust-media-region-profile-create",
                    "protocolVersion": 1,
                    "method": "provider.profile.create",
                    "params": {
                        "name": "Vidu China Region",
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
            state
                .request(&json!({
                    "id": "rust-media-region-profile-ready",
                    "protocolVersion": 1,
                    "method": "provider.connection.complete",
                    "params": { "profileId": profile_id, "status": "ready" }
                }))
                .expect("connection completion response should be valid");
            let result = resolve_media_selection(
                "TEXT_TO_IMAGE:vidu:viduq2:v2",
                Some(profile_id),
                Some("global"),
                &state,
            );
            assert!(result.is_err());
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
            let state =
                WorkerState::new(app_data_dir.clone()).expect("research bridge should start");
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
                            { "id": "vendor-hosted-video-model", "displayName": "Hosted Video" },
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
                "TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1",
                Some(profile_id),
                None,
                &state
            )
            .is_err());

            let bindings = [
                (
                    "qwen-image",
                    "openai-compatible-image",
                    json!({
                        "text": false,
                        "vision": false,
                        "streaming": false,
                        "reasoning": false,
                        "tools": false,
                        "structuredOutput": false,
                        "embeddings": false,
                        "imageGeneration": true,
                        "imageEditing": false,
                        "videoGeneration": false
                    }),
                ),
                (
                    "qwen-image-edit-2509",
                    "qwen-image-edit",
                    json!({
                        "text": false,
                        "vision": false,
                        "streaming": false,
                        "reasoning": false,
                        "tools": false,
                        "structuredOutput": false,
                        "embeddings": false,
                        "imageGeneration": false,
                        "imageEditing": true,
                        "videoGeneration": false
                    }),
                ),
                (
                    "vendor-hosted-video-model",
                    "openai-compatible-video",
                    json!({
                        "text": false,
                        "vision": false,
                        "streaming": false,
                        "reasoning": false,
                        "tools": false,
                        "structuredOutput": false,
                        "embeddings": false,
                        "imageGeneration": false,
                        "imageEditing": false,
                        "videoGeneration": true
                    }),
                ),
            ];
            for (remote_model_id, template, capabilities) in bindings {
                let model = models
                    .iter()
                    .find(|model| model["remoteModelId"] == remote_model_id)
                    .expect("synced model should be present");
                let updated = state
                    .request(&json!({
                        "id": format!("rust-unicompapi-enable-{remote_model_id}"),
                        "protocolVersion": 1,
                        "method": "provider.model.update",
                        "params": {
                            "profileId": profile_id,
                            "modelId": model["id"],
                            "displayName": model["displayName"],
                            "capabilities": capabilities,
                            "enabled": true,
                            "parameterTemplateKey": template
                        }
                    }))
                    .expect("model update response should be valid");
                assert_eq!(updated["ok"], true);
            }

            let image = resolve_media_selection(
                "TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1",
                Some(profile_id),
                None,
                &state,
            )
            .expect("bound image template should resolve");
            assert_eq!(image.credential_subject, profile_id);
            assert_eq!(image.provider_region, "unicompapi");
            assert_eq!(image.remote_model_id, "qwen-image");

            let edit = resolve_media_selection(
                "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit:v1",
                Some(profile_id),
                None,
                &state,
            )
            .expect("bound image-edit template should resolve");
            assert_eq!(edit.remote_model_id, "qwen-image-edit-2509");

            let video = resolve_media_selection(
                "TEXT_TO_VIDEO:unicompapi:openai-compatible-video:v1",
                Some(profile_id),
                None,
                &state,
            )
            .expect("newly synced video ID should resolve after template binding");
            assert_eq!(video.remote_model_id, "vendor-hosted-video-model");
            let image_to_video = resolve_media_selection(
                "IMAGE_TO_VIDEO:unicompapi:openai-compatible-video:v1",
                Some(profile_id),
                None,
                &state,
            )
            .expect("generic video template should also bind image-to-video");
            assert_eq!(image_to_video.remote_model_id, "vendor-hosted-video-model");

            let historical = resolve_media_selection(
                "TEXT_TO_IMAGE:unicompapi:qwen-image:v1",
                Some(profile_id),
                None,
                &state,
            )
            .expect("historical UniComp adapter keys should still resolve by remote model ID");
            assert_eq!(historical.remote_model_id, "qwen-image");

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
    fn openai_images_resolution_uses_image_capability_without_a_model_binding() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "ai-video-rust-openai-images-profile-{}-{nonce}",
            std::process::id()
        ));
        create_dir_all(&app_data_dir).expect("temporary app data directory should be created");

        {
            let state = WorkerState::new(app_data_dir.clone()).expect("worker bridge should start");
            let created = state
                .request(&json!({
                    "id": "rust-openai-images-profile-create",
                    "protocolVersion": 1,
                    "method": "provider.profile.create",
                    "params": {
                        "name": "OpenAI Images Rust",
                        "category": "llm",
                        "providerType": "openai",
                        "accessType": "official",
                        "protocol": "openai-responses",
                        "baseUrl": "https://api.openai.com/v1"
                    }
                }))
                .expect("profile create response should be valid");
            let profile_id = created["result"]["id"]
                .as_str()
                .expect("created profile should have an ID");
            let completed = state
                .request(&json!({
                    "id": "rust-openai-images-profile-ready",
                    "protocolVersion": 1,
                    "method": "provider.connection.complete",
                    "params": {
                        "profileId": profile_id,
                        "status": "ready",
                        "models": [{ "id": "dall-e-3" }, { "id": "gpt-image-1" }]
                    }
                }))
                .expect("connection completion response should be valid");
            assert_eq!(completed["ok"], true);
            let models = completed["result"]["models"]
                .as_array()
                .expect("synced model list");
            for model in models {
                let mut capabilities = model["capabilities"].clone();
                capabilities["imageGeneration"] = json!(true);
                let updated = state
                    .request(&json!({
                        "id": format!(
                            "rust-openai-images-enable-{}",
                            model["remoteModelId"].as_str().expect("remote model ID")
                        ),
                        "protocolVersion": 1,
                        "method": "provider.model.update",
                        "params": {
                            "profileId": profile_id,
                            "modelId": model["id"],
                            "displayName": model["displayName"],
                            "capabilities": capabilities,
                            "enabled": true
                        }
                    }))
                    .expect("model update response should be valid");
                assert_eq!(updated["ok"], true);
            }

            let selection = resolve_media_selection(
                "TEXT_TO_IMAGE:openai:openai-images:v1",
                Some(profile_id),
                Some("global"),
                &state,
            )
            .expect("enabled GPT Image model should resolve without a binding");
            assert_eq!(selection.remote_model_id, "gpt-image-1");
            assert_eq!(selection.base_url, "https://api.openai.com/v1");
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
        for model in ["viduq3-ad", "viduq3-turbo", "viduq2-pro"] {
            let target = provider_target(&format!("REFERENCE_TO_VIDEO:vidu:{model}:v2"), "global")
                .expect("new Vidu reference-video adapter should resolve");
            assert_eq!(target.path, "/ent/v2/reference2video");
            assert_eq!(target.model, model);
        }
        let mix = provider_target("REFERENCE_TO_VIDEO:vidu:viduq3-mix:v2", "global")
            .expect("Q3-Mix reference video adapter should resolve");
        assert_eq!(mix.model, "viduq3-mix");
        assert!(provider_payload(
            mix,
            json!({
                "images": ["https://example.com/reference.png"],
                "prompt": "mixed scene",
                "off_peak": true
            }),
        )
        .is_err());
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
    fn provider_bridge_resolves_only_registered_controlled_media_files() {
        let root = std::env::temp_dir().join(format!(
            "unicomp-controlled-media-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let directory = root.join("cache").join("media-inputs");
        create_dir_all(&directory).expect("create controlled media fixture directory");
        let image = directory.join("input.png");
        write(&image, [137, 80, 78, 71, 13, 10, 26, 10]).expect("write media fixture");
        let handle = "cache/media-inputs/input.png";
        let mut parameters = json!({ "images": [format!("controlled-file://{handle}")] });
        let inputs = json!([{
            "type": "controlled_temporary_file",
            "handle": handle,
            "contentType": "image/png"
        }]);

        resolve_controlled_media_inputs_at_root(&mut parameters, Some(&inputs), &root)
            .expect("resolve controlled media fixture");
        assert_eq!(
            parameters["images"][0].as_str().expect("resolved image"),
            "data:image/png;base64,iVBORw0KGgo="
        );
        let mut nested = json!({"media":[{"type":"reference_image","url":format!("controlled-file://{handle}")}]});
        resolve_controlled_media_inputs_at_root(&mut nested, Some(&inputs), &root).unwrap();
        assert_eq!(
            nested["media"][0]["url"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        let audio_inputs =
            json!([{"type":"controlled_temporary_file","handle":handle,"contentType":"audio/wav"}]);
        let mut audio = json!({"media":[{"type":"reference_audio","url":format!("controlled-file://{handle}")}]});
        assert!(
            resolve_controlled_media_inputs_at_root(&mut audio, Some(&audio_inputs), &root)
                .is_err()
        );

        let mut unregistered = json!({
            "images": ["controlled-file://cache/media-inputs/other.png"]
        });
        assert!(
            resolve_controlled_media_inputs_at_root(&mut unregistered, Some(&inputs), &root)
                .is_err()
        );
        let traversal_inputs = json!([{
            "type": "controlled_temporary_file",
            "handle": "cache/media-inputs/../input.png",
            "contentType": "image/png"
        }]);
        let mut traversal = json!({
            "images": ["controlled-file://cache/media-inputs/../input.png"]
        });
        assert!(resolve_controlled_media_inputs_at_root(
            &mut traversal,
            Some(&traversal_inputs),
            &root
        )
        .is_err());

        remove_dir_all(root).expect("remove controlled media fixture directory");
    }

    #[test]
    fn gateway_video_responses_use_video_urls_and_real_terminal_states() {
        assert_eq!(
            provider_task_id(&json!({"id":"", "data":{"task_id":"nested-id"}})),
            Some("nested-id")
        );
        assert_eq!(
            provider_state(&json!({"state":"", "data":{"status":"completed"}})),
            Some("completed")
        );
        for body in [
            json!({"url":"https://example.com/video.mp4"}),
            json!({"data":{"url":"https://example.com/video.mp4"}}),
            json!({"output":{"results":{"video_url":"https://example.com/video.mp4"}}}),
        ] {
            assert_eq!(
                super::provider_video_source(&body),
                Some("https://example.com/video.mp4")
            );
        }
        assert!(super::provider_video_source(
            &json!({"metadata":{"url":"https://example.com/cover.png"}})
        )
        .is_none());
        let response = ProviderHttpResponse {
            status: 200,
            body: json!({"status":"FAILURE","fail_reason":"blocked"}),
            retry_after_ms: None,
        };
        let failure = normalize_provider_media_poll(&response, "unicompapi", None).unwrap();
        assert_eq!(failure["state"], "failed");
        assert_eq!(failure["error"]["message"], "blocked");
        let success = ProviderHttpResponse {
            status: 200,
            body: json!({"status":"completed","url":"https://example.com/video.mp4"}),
            retry_after_ms: None,
        };
        assert!(normalize_provider_media_poll(&success, "unicompapi", None).is_err());
        let key = "REFERENCE_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-3";
        assert!(ensure_video_adapter(key).is_ok());
        assert!(unicompapi_payload(key,json!({"prompt":"test","audio":true,"media":[{"type":"reference_audio","url":"https://example.com/voice.wav"}]}),"wan3.0-video").is_ok());
    }

    #[test]
    fn provider_bridge_allows_url_only_media_without_a_controlled_input_root() {
        let mut parameters = json!({
            "prompt": "A horse running",
            "resolution": "1080P",
            "ratio": "16:9",
            "duration": 5,
            "watermark": true
        });
        std::env::remove_var("AI_VIDEO_MEDIA_INPUT_ROOT");
        resolve_controlled_media_inputs(&mut parameters, None)
            .expect("URL-only video submission must not require a local input root");
    }

    #[test]
    fn unicompapi_bridge_injects_catalog_remote_model_ids() {
        let adapter_key = "TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1";
        assert_eq!(
            unicompapi_adapter_model(adapter_key).expect("registered template should resolve"),
            "openai-compatible-image"
        );
        let body = unicompapi_payload(
            adapter_key,
            json!({"prompt": "frame", "size": "1024x1024", "n": 1}),
            "doubao-seedream-5-0-260128",
        )
        .expect("image request should serialize");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(parsed["model"], "doubao-seedream-5-0-260128");
        assert_eq!(parsed["prompt"], "frame");
        assert_eq!(UNICOMPAPI_HOST, "unicompapi.com");
        assert_eq!(UNICOMPAPI_AUTHORIZATION_SCHEME, "Bearer");
    }

    #[test]
    fn unicompapi_generic_image_template_allows_optional_size() {
        let adapter_key = "TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1";
        let body = unicompapi_payload(adapter_key, json!({"prompt": "frame"}), "qwen-image")
            .expect("generic image template should not require size");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(parsed["model"], "qwen-image");
        assert!(parsed.get("size").is_none());
        let with_size = unicompapi_payload(
            adapter_key,
            json!({"prompt": "frame", "size": "1024x1024", "n": 1}),
            "qwen-image",
        )
        .expect("generic image request with size should serialize");
        let parsed_size: serde_json::Value =
            serde_json::from_slice(&with_size).expect("valid JSON");
        assert_eq!(parsed_size["size"], "1024x1024");
    }

    #[test]
    #[ignore = "Opt-in download of a public static image; never submits a paid generation"]
    fn provider_image_download_real_network_smoke() {
        let source =
            std::env::var("AI_VIDEO_IMAGE_SMOKE_URL").expect("set a public static image URL");
        let mut response = ProviderHttpResponse {
            status: 200,
            retry_after_ms: None,
            body: json!({ "data": [{ "url": source }] }),
        };
        externalize_provider_images(&mut response).unwrap();
        assert!(
            response.body.get("nativeImageOutputError").is_none(),
            "{}",
            response.body
        );
        assert!(!super::contains_sensitive_host_data(&response.body));
        let path = Path::new(
            response.body["data"][0]["nativeImageFilePath"]
                .as_str()
                .unwrap(),
        );
        let bytes = std::fs::read(path).unwrap();
        let (content_type, _) = super::decoded_image_type(&bytes, None).unwrap();
        if let Ok(result_path) = std::env::var("AI_VIDEO_IMAGE_SMOKE_RESULT_PATH") {
            let envelope = json!({ "kind": "host.response", "requestId": "network-smoke", "ok": true, "result": response });
            std::fs::write(result_path, envelope.to_string()).unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
        }
        println!(
            "Native downloaded and validated {} bytes ({content_type})",
            bytes.len()
        );
    }

    #[test]
    fn provider_image_output_processing_error_preserves_successful_submission() {
        let mut response = ProviderHttpResponse {
            status: 200,
            retry_after_ms: None,
            body: json!({ "data": [{ "url": "https://localhost/output.png?signature=temporary" }] }),
        };
        externalize_provider_images(&mut response).unwrap();
        assert_eq!(response.status, 200);
        assert!(response.body["nativeImageOutputError"]
            .as_str()
            .unwrap()
            .starts_with("Provider image response received; local output processing failed:"));
        assert!(!super::contains_sensitive_host_data(&response.body));
        assert!(!response.body.to_string().contains("temporary"));
    }

    #[test]
    fn openai_images_builds_only_supported_generation_fields() {
        assert_eq!(
            openai_images_provider("TEXT_TO_IMAGE:openai:openai-images:v1"),
            Some("openai")
        );
        assert_eq!(
            openai_images_provider("TEXT_TO_IMAGE:custom:openai-images:v1"),
            Some("custom")
        );
        assert_eq!(
            openai_images_provider("TEXT_TO_IMAGE:unicompapi:openai-images:v1"),
            None
        );

        let official = openai_images_target("https://api.openai.com/v1", "openai")
            .expect("official OpenAI Base URL should resolve");
        assert_eq!(official.host, "api.openai.com");
        assert_eq!(official.path, "/v1/images/generations");
        let custom = openai_images_target("https://images.example/gateway/v1/", "custom")
            .expect("custom API root should resolve");
        assert_eq!(custom.path, "/gateway/v1/images/generations");
        for base_url in [
            "http://images.example/v1",
            "https://user:secret@images.example/v1",
            "https://images.example/v1/images/generations",
            "https://images.example/v1?token=secret",
        ] {
            assert!(
                openai_images_target(base_url, "custom").is_err(),
                "{base_url}"
            );
        }

        let body = openai_images_payload(
            "TEXT_TO_IMAGE:openai:openai-images:v1",
            "gpt-image-1",
            json!({
                "prompt": "A mountain lake at sunrise",
                "size": "1536x1024",
                "quality": "high",
                "background": "transparent",
                "output_format": "webp",
                "output_compression": 80,
                "moderation": "auto",
                "n": 1
            }),
        )
        .expect("valid GPT Image payload should serialize");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(parsed["model"], "gpt-image-1");
        assert_eq!(parsed["output_compression"], 80);
        assert!(parsed.get("response_format").is_none());
        assert!(openai_images_payload(
            "TEXT_TO_IMAGE:openai:openai-images:v1",
            "gpt-image-1",
            json!({ "prompt": "A lake", "response_format": "url" }),
        )
        .is_err());
        assert!(openai_images_payload(
            "TEXT_TO_IMAGE:openai:openai-images:v1",
            "gpt-image-1",
            json!({ "prompt": "A lake", "output_format": "png", "output_compression": 80 }),
        )
        .is_err());

        let custom_body = openai_images_payload(
            "TEXT_TO_IMAGE:custom:openai-images:v1",
            "vendor-image-model",
            json!({
                "prompt": "A mountain lake at sunrise",
                "size": "1792x1024",
                "response_format": "url",
                "quality": "hd",
                "style": "vivid"
            }),
        )
        .expect("valid generic OpenAI-compatible image payload should serialize");
        let custom_json: serde_json::Value =
            serde_json::from_slice(&custom_body).expect("valid custom image JSON");
        assert_eq!(custom_json["model"], "vendor-image-model");
        assert_eq!(custom_json["response_format"], "url");
        assert_eq!(custom_json["style"], "vivid");
        assert!(custom_json.get("background").is_none());
        assert!(custom_json.get("output_format").is_none());
        assert!(openai_images_payload(
            "TEXT_TO_IMAGE:custom:openai-images:v1",
            "vendor-image-model",
            json!({ "prompt": "A lake", "n": 11 }),
        )
        .is_err());
    }

    #[test]
    fn provider_bridge_receives_signed_image_urls_and_returns_only_local_results() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let signed_url = "https://cdn.example.invalid/output.png?X-Amz-Signature=temporary";
        let body = json!({
            "data": [{ "url": signed_url, "cover_url": signed_url }],
            "metadata": { "signedUrl": signed_url },
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            loop {
                let mut chunk = [0_u8; 4096];
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                received.extend_from_slice(&chunk[..count]);
                if let Some(end) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let received = super::request_json(super::JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "POST",
            path: "/v1/images/generations",
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: "local-fixture",
            body: Some(b"{}"),
            request_body_limit: 1024,
            response_body_limit: 4096,
        })
        .unwrap();
        server.join().unwrap();
        let mut response = ProviderHttpResponse {
            status: received.status,
            body: received.body,
            retry_after_ms: None,
        };
        let png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        super::externalize_provider_images_with(&mut response, |source| {
            assert_eq!(source, signed_url);
            Ok(super::provider_http::RawHttpResponse {
                status: 200,
                body: png.clone(),
                content_type: Some("image/png".to_string()),
                location: None,
                retry_after: None,
            })
        })
        .expect("signed output must be downloaded before IPC");
        let envelope = json!({ "kind": "host.response", "requestId": "image-result",
            "ok": true, "result": response });
        assert!(!super::contains_sensitive_host_data(&envelope));
        assert!(!envelope.to_string().contains("temporary"));
        let path = Path::new(
            envelope["result"]["body"]["data"][0]["nativeImageFilePath"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(std::fs::read(path).unwrap(), png);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn provider_image_download_preserves_signatures_and_validates_each_redirect() {
        let mut requests = Vec::new();
        super::download_remote_image_with(
            "https://cdn.example.invalid/output.png?token=one#preview",
            |target| {
                requests.push((target.host.clone(), target.path.clone()));
                Ok(super::provider_http::RawHttpResponse {
                    status: if requests.len() == 1 { 302 } else { 200 },
                    body: Vec::new(),
                    content_type: None,
                    retry_after: None,
                    location: Some("/final.png?signature=two".to_string()),
                })
            },
        )
        .unwrap();
        assert_eq!(
            requests,
            vec![
                (
                    "cdn.example.invalid".to_string(),
                    "/output.png?token=one".to_string()
                ),
                (
                    "cdn.example.invalid".to_string(),
                    "/final.png?signature=two".to_string()
                ),
            ]
        );
        for unsafe_location in [
            "http://cdn.example.invalid/image.png",
            "https://localhost/image.png",
            "https://user:secret@cdn.example.invalid/image.png",
        ] {
            let mut calls = 0;
            let result =
                super::download_remote_image_with("https://cdn.example.invalid/start", |_| {
                    calls += 1;
                    Ok(super::provider_http::RawHttpResponse {
                        status: 302,
                        body: Vec::new(),
                        content_type: None,
                        retry_after: None,
                        location: Some(unsafe_location.to_string()),
                    })
                });
            assert!(result.is_err());
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn provider_bridge_removes_partial_images_when_a_remote_download_is_invalid() {
        let mut response = ProviderHttpResponse {
            status: 200,
            retry_after_ms: None,
            body: json!({ "data": ["data:image/png;base64,iVBORw0KGgo=", "https://cdn.example.invalid/output.png?signature=temporary"] }),
        };
        let error = super::externalize_provider_images_with(&mut response, |_| {
            Ok(super::provider_http::RawHttpResponse {
                status: 200,
                body: b"<html>error</html>".to_vec(),
                content_type: Some("text/html".to_string()),
                location: None,
                retry_after: None,
            })
        })
        .unwrap_err();
        assert!(error.contains("is not an image"));
        assert!(!error.contains("temporary"));
        let path = Path::new(
            response.body["data"][0]["nativeImageFilePath"]
                .as_str()
                .unwrap(),
        );
        assert!(!path.exists());
    }

    #[test]
    fn provider_bridge_externalizes_base64_image_outputs_before_ipc() {
        let png = [137, 80, 78, 71, 13, 10, 26, 10];
        let mut response = ProviderHttpResponse {
            status: 200,
            body: json!({ "data": [{ "b64_json": BASE64_STANDARD.encode(png) }] }),
            retry_after_ms: None,
        };

        externalize_provider_images(&mut response).expect("externalize provider image");

        let path = response.body["data"][0]["nativeImageFilePath"]
            .as_str()
            .map(Path::new)
            .expect("native image path");
        assert!(path.exists());
        assert_eq!(response.body["data"][0]["contentType"], "image/png");
        assert_eq!(std::fs::read(path).expect("read native image"), png);
        std::fs::remove_file(path).expect("remove native image fixture");
    }

    #[test]
    fn provider_bridge_externalizes_all_data_url_images_with_ascii_whitespace() {
        let png = [137, 80, 78, 71, 13, 10, 26, 10];
        let mut response = ProviderHttpResponse {
            status: 200,
            body: json!({
                "data": [
                    { "b64_json": "data:image/png;base64,\niVBORw0K Ggo\r\n" },
                    { "url": "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=" }
                ]
            }),
            retry_after_ms: None,
        };

        externalize_provider_images(&mut response).expect("externalize provider images");

        for item in response.body["data"].as_array().expect("image results") {
            let path = item["nativeImageFilePath"]
                .as_str()
                .map(Path::new)
                .expect("native image path");
            assert!(path.exists());
            assert_eq!(item["contentType"], "image/png");
            assert_eq!(std::fs::read(path).expect("read native image"), png);
            std::fs::remove_file(path).expect("remove native image fixture");
        }
    }

    #[test]
    fn provider_bridge_removes_partial_outputs_when_any_image_is_invalid() {
        let mut response = ProviderHttpResponse {
            status: 200,
            body: json!({
                "data": [
                    { "b64_json": "iVBORw0KGgo=" },
                    { "b64_json": "not-valid-base64" }
                ]
            }),
            retry_after_ms: None,
        };

        let error = super::externalize_provider_images_with(&mut response, |_| {
            unreachable!("Base64 does not require download")
        })
        .expect_err("invalid second image");

        assert!(error.contains("$.data[1].b64_json"));
        let first_path = response.body["data"][0]["nativeImageFilePath"]
            .as_str()
            .map(Path::new)
            .expect("first image was externalized before the failure");
        assert!(!first_path.exists());
    }

    #[test]
    fn custom_openai_video_payload_uses_the_video_api_contract() {
        let text = super::openai_compatible_video_payload(
            "TEXT_TO_VIDEO:custom:openai-compatible-video:v1",
            "vendor-video-model",
            json!({
                "prompt": "A slow camera move",
                "duration": 8,
                "size": "1280x720"
            }),
        )
        .expect("text-to-video parameters should serialize");
        let text_json: serde_json::Value = serde_json::from_slice(&text.body).unwrap();
        assert_eq!(text_json["model"], "vendor-video-model");
        assert_eq!(text_json["prompt"], "A slow camera move");
        assert_eq!(text_json["seconds"], "8");
        assert_eq!(text_json["size"], "1280x720");
        assert!(text_json.get("duration").is_none());
        assert!(text.multipart_boundary.is_none());

        let remote_image = super::openai_compatible_video_payload(
            "IMAGE_TO_VIDEO:custom:openai-compatible-video:v1",
            "vendor-video-model",
            json!({
                "images": ["https://images.example/reference.png"],
                "prompt": "Animate the reference",
                "duration": 4
            }),
        )
        .expect("remote image reference should use the JSON form");
        let image_json: serde_json::Value = serde_json::from_slice(&remote_image.body).unwrap();
        assert_eq!(
            image_json["input_reference"]["image_url"],
            "https://images.example/reference.png"
        );
        assert!(image_json.get("images").is_none());

        let local_image = super::openai_compatible_video_payload(
            "IMAGE_TO_VIDEO:custom:openai-compatible-video:v1",
            "vendor-video-model",
            json!({
                "images": ["data:image/png;base64,iVBORw0KGgo="],
                "prompt": "Animate the local reference",
                "duration": 4
            }),
        )
        .expect("local image reference should use the multipart form");
        let boundary = local_image
            .multipart_boundary
            .as_deref()
            .expect("local image request should be multipart");
        assert!(local_image
            .body
            .windows(b"name=\"input_reference\"; filename=\"reference.png\"".len())
            .any(|window| window == b"name=\"input_reference\"; filename=\"reference.png\""));
        assert!(local_image
            .body
            .windows(8)
            .any(|window| window == [137, 80, 78, 71, 13, 10, 26, 10]));
        assert!(local_image
            .body
            .windows(format!("--{boundary}--\r\n").len())
            .any(|window| window == format!("--{boundary}--\r\n").as_bytes()));
    }

    #[test]
    fn unicompapi_bridge_projects_one_reference_image() {
        let image = "data:image/png;base64,iVBORw0KGgo=";
        let edit = unicompapi_payload(
            "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit:v1",
            json!({
                "images": [image],
                "prompt": "remove the sign",
                "size": "1024x1024",
                "response_format": "b64_json"
            }),
            "qwen-image-edit-2509",
        )
        .expect("image edit request should serialize as ModelArts MaaS JSON");
        let parsed_edit: serde_json::Value =
            serde_json::from_slice(&edit).expect("valid ModelArts MaaS image edit JSON");
        assert_eq!(parsed_edit["model"], "qwen-image-edit-2509");
        assert_eq!(parsed_edit["image"], image);
        assert_eq!(parsed_edit["prompt"], "remove the sign");
        assert_eq!(parsed_edit["size"], "1024x1024");
        assert_eq!(parsed_edit["response_format"], "b64_json");
        assert!(parsed_edit.get("input").is_none());

        let video = unicompapi_payload(
            "IMAGE_TO_VIDEO:unicompapi:openai-compatible-video:v1",
            json!({"images": [image], "prompt": "camera push", "duration": 5}),
            "vendor-hosted-video-model",
        )
        .expect("image-to-video request should serialize");
        let parsed_video: serde_json::Value =
            serde_json::from_slice(&video).expect("valid video JSON");
        assert_eq!(parsed_video["image"], image);
        assert_eq!(parsed_video["model"], "vendor-hosted-video-model");
        assert_eq!(parsed_video["seconds"], "5");
        assert!(parsed_video.get("duration").is_none());
        assert!(parsed_video.get("images").is_none());
    }

    #[test]
    fn unicompapi_bridge_preserves_vidu_compatible_video_images_and_fields() {
        let reference = unicompapi_payload(
            "REFERENCE_TO_VIDEO:unicompapi:vidu-compatible-reference:v1",
            json!({
                "images": ["https://example.com/one.png", "https://example.com/two.png"],
                "prompt": "camera circles the character",
                "duration": 5,
                "aspect_ratio": "16:9",
                "resolution": "720p",
                "audio": true,
                "seed": 42,
                "off_peak": false
            }),
            "viduq3",
        )
        .expect("reference-to-video request should preserve Vidu fields");
        let parsed_reference: serde_json::Value =
            serde_json::from_slice(&reference).expect("valid reference-to-video JSON");
        assert_eq!(parsed_reference["model"], "viduq3");
        assert_eq!(parsed_reference["images"].as_array().map(Vec::len), Some(2));
        assert_eq!(parsed_reference["aspect_ratio"], "16:9");
        assert_eq!(parsed_reference["audio"], true);
        assert!(parsed_reference.get("image").is_none());

        let start_end = unicompapi_payload(
            "START_END_TO_VIDEO:unicompapi:vidu-compatible-start-end:v1",
            json!({
                "images": ["https://example.com/start.png", "https://example.com/end.png"],
                "prompt": "slow camera move",
                "is_rec": false,
                "duration": 5,
                "resolution": "720p",
                "audio": true
            }),
            "viduq3-pro",
        )
        .expect("start-end request should preserve ordered Vidu fields");
        let parsed_start_end: serde_json::Value =
            serde_json::from_slice(&start_end).expect("valid start-end JSON");
        assert_eq!(parsed_start_end["model"], "viduq3-pro");
        assert_eq!(
            parsed_start_end["images"][0],
            "https://example.com/start.png"
        );
        assert_eq!(parsed_start_end["images"][1], "https://example.com/end.png");
        assert!(unicompapi_payload(
            "START_END_TO_VIDEO:unicompapi:vidu-compatible-start-end:v1",
            json!({"images": ["https://example.com/start.png"], "duration": 5}),
            "viduq3-pro",
        )
        .is_err());
    }

    #[test]
    fn unicompapi_qwen_image_edit_rejects_invalid_images_and_fields() {
        let adapter_key = "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit:v1";
        let remote_model_id = "qwen-image-edit-2509";
        assert!(unicompapi_payload(
            adapter_key,
            json!({"images": ["http://example.invalid/image.png"], "prompt": "edit"}),
            remote_model_id,
        )
        .is_err());
        assert!(unicompapi_payload(
            adapter_key,
            json!({"images": ["data:image/png;base64,bm90LXBuZw=="], "prompt": "edit"}),
            remote_model_id,
        )
        .is_err());
        assert!(unicompapi_payload(
            adapter_key,
            json!({
                "images": ["data:image/png;base64,iVBORw0KGgo="],
                "prompt": "edit",
                "apiKey": "must-not-leave-webview"
            }),
            remote_model_id,
        )
        .is_err());
        assert!(unicompapi_payload(
            adapter_key,
            json!({
                "images": ["data:image/png;base64,iVBORw0KGgo="],
                "prompt": "edit",
                "response_format": "url"
            }),
            remote_model_id,
        )
        .is_err());
        let remote = unicompapi_payload(
            adapter_key,
            json!({"images": ["https://example.com/image.png"], "prompt": "edit"}),
            remote_model_id,
        )
        .expect("public HTTPS images should be preserved");
        let parsed: serde_json::Value = serde_json::from_slice(&remote).expect("valid JSON");
        assert_eq!(parsed["image"], "https://example.com/image.png");
        assert_eq!(parsed["model"], remote_model_id);
    }

    #[test]
    fn unicompapi_qwen_image_edit_accepts_trimmed_data_url_headers() {
        let remote = unicompapi_payload(
            "REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit:v1",
            json!({
                "images": ["  DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=  "],
                "prompt": "edit"
            }),
            "qwen-image-edit-2509",
        )
        .expect("trimmed/case-insensitive image data URL should be accepted");
        let parsed: serde_json::Value = serde_json::from_slice(&remote).expect("valid JSON");
        assert_eq!(parsed["image"], "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=");
    }

    #[test]
    fn unicompapi_bridge_rejects_unknown_templates_and_adapter_injection() {
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:unknown:v1").is_ok());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:evil:qwen-image:v1").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:qwen-image:v1:extra").is_err());
        assert!(unicompapi_adapter_model("TEXT_TO_VIDEO:unicompapi:qwen-image:v1").is_ok());
        assert!(unicompapi_adapter_model("TEXT_TO_IMAGE:unicompapi:qwen-image\n:v1").is_err());
        assert!(
            unicompapi_adapter_model("TEXT_TO_VIDEO:unicompapi:openai-compatible-image:v1")
                .is_err()
        );
        assert!(unicompapi_payload(
            "TEXT_TO_IMAGE:unicompapi:unknown:v1",
            json!({"prompt": "frame"}),
            "unknown",
        )
        .is_err());
        assert!(unicompapi_payload(
            "TEXT_TO_IMAGE:unicompapi:openai-compatible-image:v1",
            json!({"prompt": "frame", "apiKey": "secret"}),
            "qwen-image",
        )
        .is_err());
        assert!(unicompapi_payload(
            "IMAGE_TO_VIDEO:unicompapi:openai-compatible-video:v1",
            json!({"images": ["one", "two"], "prompt": "frame"}),
            "vendor-hosted-video-model",
        )
        .is_err());
        assert!(unicompapi_payload(
            "TEXT_TO_VIDEO:unicompapi:openai-compatible-video:v1",
            json!({"images": ["https://example.com/frame.png"], "prompt": "frame"}),
            "vendor-hosted-video-model",
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
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3-ad:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3-mix:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3-turbo:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq2-pro:v2").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2").is_ok());
        assert!(ensure_video_adapter("START_END_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3:v2").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
        assert!(ensure_video_adapter("TEXT_TO_VIDEO:unicompapi:viduq3-pro:v1").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:unicompapi:viduq3:v1").is_ok());
        assert!(ensure_video_adapter("REFERENCE_TO_VIDEO:unicompapi:viduq3:v1").is_ok());
        assert!(ensure_video_adapter("START_END_TO_VIDEO:unicompapi:viduq3-pro:v1").is_ok());
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
    fn provider_submit_error_extracts_only_bounded_diagnostic_fields() {
        assert_eq!(
            provider_submit_error(&json!({
                "error": { "code": "invalid_request", "message": "images is required" },
                "request_id": "must-not-leave-native-boundary"
            })),
            (
                Some("invalid_request".to_string()),
                Some("images is required".to_string())
            )
        );
        assert_eq!(
            provider_submit_error(&json!({ "error": "unsupported content type" })),
            (None, Some("unsupported content type".to_string()))
        );
        let long_message = "x".repeat(700);
        assert_eq!(
            provider_submit_error(&json!({ "message": long_message }))
                .1
                .map(|message| message.chars().count()),
            Some(500)
        );
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
            "process.stdin.once('data',()=>{process.stderr.write('x'.repeat(1024*1024),()=>process.stdout.write('{\"id\":\"stderr\",\"ok\":true}\\n'))})",
        ]);
        let mut worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let result = worker
            .request_with_timeout(&json!({"id": "stderr"}), Duration::from_secs(5))
            .expect("stderr output must not block the response");

        assert_eq!(result["ok"], true);
    }

    #[test]
    fn reviewed_media_form_uses_the_paid_submission_timeout() {
        assert_eq!(
            super::worker_request_timeout(&json!({"method": "characterVoiceReference.generate"})),
            super::VOICE_REFERENCE_WORKER_REQUEST_TIMEOUT
        );
        assert_eq!(
            super::worker_request_timeout(&json!({"method": "characterVoiceReference.confirm"})),
            super::VOICE_REFERENCE_WORKER_REQUEST_TIMEOUT
        );
        assert_eq!(
            super::worker_request_timeout(&json!({"method": "audio.sample.confirm"})),
            super::VOICE_REFERENCE_WORKER_REQUEST_TIMEOUT
        );
        assert_eq!(
            super::worker_request_timeout(&json!({"method": "agent.generation.selectMedia"})),
            super::MEDIA_WORKER_REQUEST_TIMEOUT
        );
        assert_eq!(
            super::worker_request_timeout(&json!({"method": "conversation.runtime.selectMedia"})),
            super::WORKER_REQUEST_TIMEOUT
        );
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
        assert!(error.contains("Worker was retained"));
    }

    #[test]
    fn worker_supervisor_retains_shared_process_after_timeout_and_local_rejection() {
        let mut command = Command::new("node");
        command.args(["-e", "require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,ok:true,result:{pid:process.pid}})+'\\n'),r.delay||0)})"]);
        let worker = Arc::new(WorkerProcess::spawn_command(command).unwrap());
        let original_pid = worker.child.lock().unwrap().id();
        let dir = std::env::temp_dir().join(format!(
            "worker-supervisor-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let state = WorkerState::new(dir).unwrap();
        *state.process.lock().unwrap() = Some(Arc::clone(&worker));
        let slow = state.request_with_timeout(
            &json!({"id":"slow", "delay":200}),
            Duration::from_millis(30),
        );
        assert!(slow.unwrap_err().contains("Worker was retained"));
        assert_eq!(
            state.request(&json!({"id":"healthy"})).unwrap()["result"]["pid"],
            original_pid
        );
        let error = state
            .request(&json!({"id":"large", "data":"x".repeat(SIDECAR_ENVELOPE_MAX_BYTES)}))
            .unwrap_err();
        assert!(error.contains("2 MiB"));
        assert!(Arc::ptr_eq(
            state.process.lock().unwrap().as_ref().unwrap(),
            &worker
        ));
        assert_eq!(
            state.request(&json!({"id":"after-rejection"})).unwrap()["result"]["pid"],
            original_pid
        );
        worker.stop();
        assert!(worker.child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn worker_supervisor_isolates_a_timeout_from_a_concurrent_healthy_request() {
        let mut command = Command::new("node");
        command.args(["-e", "require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,ok:true,result:{pid:process.pid}})+'\\n'),r.delay||0)})"]);
        let worker = Arc::new(WorkerProcess::spawn_command(command).unwrap());
        let pid = worker.child.lock().unwrap().id();
        let state = WorkerState::new(std::env::temp_dir()).unwrap();
        *state.process.lock().unwrap() = Some(Arc::clone(&worker));
        std::thread::scope(|scope| {
            let slow = scope.spawn(|| {
                state.request_with_timeout(
                    &json!({"id":"concurrent-slow", "delay":400}),
                    Duration::from_millis(150),
                )
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            while !worker
                .replies
                .lock()
                .unwrap()
                .pending
                .contains_key("concurrent-slow")
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                state.request(&json!({"id":"concurrent-healthy"})).unwrap()["result"]["pid"],
                pid
            );
            assert!(slow
                .join()
                .unwrap()
                .unwrap_err()
                .contains("Worker was retained"));
        });
        assert!(worker.available.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            state
                .request(&json!({"id":"after-concurrent-timeout"}))
                .unwrap()["result"]["pid"],
            pid
        );
        worker.stop();
    }

    #[test]
    fn worker_supervisor_waits_for_graceful_shutdown_and_refuses_replacement() {
        let mut command = Command::new("node");
        command.args(["-e", "require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.kind==='host.control'&&r.method==='worker.shutdown'){process.stdout.write(JSON.stringify({id:r.id,ok:true,result:{stopped:true}})+'\\n',()=>setTimeout(()=>process.exit(0),10))}})"]);
        let worker = Arc::new(WorkerProcess::spawn_command(command).unwrap());
        let state = WorkerState::new(std::env::temp_dir()).unwrap();
        *state.process.lock().unwrap() = Some(Arc::clone(&worker));
        state.shutdown();
        assert!(worker.child.lock().unwrap().wait().unwrap().success());
        assert!(state.process.lock().unwrap().is_none());
        assert!(state
            .request(&json!({"id":"after-shutdown"}))
            .unwrap_err()
            .contains("WORKER_STOPPING"));
    }

    #[test]
    fn worker_transport_close_cleans_its_host_stream_registry() {
        let mut command = Command::new("node");
        command.args(["-e", "setTimeout(()=>process.exit(0),100)"]);
        let worker = WorkerProcess::spawn_command(command).unwrap();
        worker.host_streams.lock().unwrap().insert(
            "owned".into(),
            super::ActiveHostStream {
                project_session_id: "session".into(),
                cancellation: Arc::new(crate::llm_stream::LlmCancellation::default()),
            },
        );
        assert!(worker
            .request_with_timeout(&json!({"id":"exit"}), Duration::from_secs(2))
            .is_err());
        worker.stop();
        assert!(!worker.available.load(std::sync::atomic::Ordering::Acquire));
        assert!(worker.host_streams.lock().unwrap().is_empty());
    }

    #[test]
    fn worker_multiplexes_host_requests_while_correlating_the_legacy_response() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "const r=require('readline').createInterface({input:process.stdin});let legacy;r.on('line',l=>{const v=JSON.parse(l);if(!legacy){legacy=v;process.stdout.write(JSON.stringify({kind:'host.request',requestId:'host-from-worker',method:'unknown.method',params:{}})+'\\n')}else if(v.kind==='host.response'){process.stdout.write(JSON.stringify({id:legacy.id,ok:true,result:{multiplexed:true}})+'\\n')}})",
        ]);
        let mut worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let result = worker
            .request_with_timeout(&json!({"id": "legacy-request"}), Duration::from_secs(5))
            .expect("host request must not steal the legacy response slot");

        assert_eq!(result["id"], "legacy-request");
        assert_eq!(result["result"]["multiplexed"], true);
    }

    #[test]
    fn worker_dispatches_background_host_requests_without_a_legacy_request() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "const r=require('readline').createInterface({input:process.stdin});process.stdout.write(JSON.stringify({kind:'host.request',requestId:'background-host',method:'unknown.method',params:{}})+'\\n');r.on('line',l=>{const v=JSON.parse(l);if(v.kind==='host.response'&&v.requestId==='background-host'){process.stdout.write(JSON.stringify({id:'background-proof',ok:true,result:{dispatched:v.ok===false}})+'\\n')}})",
        ]);
        let worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let line = worker
            .responses
            .lock()
            .expect("response receiver lock")
            .recv_timeout(Duration::from_secs(5))
            .expect("background host response should be dispatched")
            .expect("fixture output should be readable");
        let value: serde_json::Value =
            serde_json::from_str(&line).expect("fixture output should be valid JSON");

        assert_eq!(value["id"], "background-proof");
        assert_eq!(value["result"]["dispatched"], true);
    }

    #[test]
    fn worker_rejects_a_mismatched_legacy_response_id() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "process.stdin.once('data',()=>process.stdout.write('{\"id\":\"other\",\"ok\":true}\\n'))",
        ]);
        let mut worker = WorkerProcess::spawn_command(command).expect("fixture should start");

        let error = worker
            .request_with_timeout(&json!({"id": "expected"}), Duration::from_secs(5))
            .expect_err("correlation mismatch must terminate the request");

        assert!(error.contains("mismatched correlation ID"));
    }

    fn native_provider_stream_fixture() -> serde_json::Value {
        json!({
            "generationId": "generation",
            "attemptId": "attempt",
            "projectId": "project",
            "projectSessionId": "session",
            "conversationId": "conversation",
            "providerProfileId": "123e4567-e89b-42d3-a456-426614174000",
            "modelId": "model",
            "remoteModelId": "remote",
            "protocol": "openai-responses",
            "baseUrl": "https://example.com/v1",
            "systemInstruction": "system",
            "context": "context",
            "prompt": "prompt",
            "attachments": [{
                "name": "reference.png",
                "mimeType": "image/png",
                "dataUrl": "data:image/png;base64,AAAA"
            }]
        })
    }

    #[test]
    fn native_provider_forwards_visual_tool_results_for_both_protocols() {
        for protocol in ["openai-responses", "openai-chat-completions"] {
            let mut value = native_provider_stream_fixture();
            value["protocol"] = json!(protocol);
            let outputs = json!([{"callId":"frames", "output":"manual visualInputs", "images":[{"mimeType":"image/jpeg", "data":"AAAA"}]}]);
            value["continuation"] = if protocol == "openai-responses" {
                json!({"protocol":protocol, "previousResponseId":"read-response", "outputs":outputs})
            } else {
                json!({"protocol":protocol, "providerResponseId":"read-response", "calls":[{"id":"frames", "name":"shot.continuity.read", "argumentsJson":"{}"}], "outputs":outputs})
            };
            assert!(validate_provider_stream_params(&value).is_ok());
            let body = crate::llm_stream::request_body_for_contract_test(value.clone()).unwrap();
            let image_message = if protocol == "openai-responses" {
                body["input"].as_array().unwrap().last().unwrap()
            } else {
                body["messages"].as_array().unwrap().last().unwrap()
            };
            assert_eq!(image_message["role"], "user");
            assert!(image_message["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("frames"));
            if protocol == "openai-responses" {
                assert_eq!(
                    image_message["content"][1]["image_url"],
                    "data:image/jpeg;base64,AAAA"
                );
            } else {
                assert_eq!(
                    image_message["content"][1]["image_url"]["url"],
                    "data:image/jpeg;base64,AAAA"
                );
            }
            value["continuation"]["outputs"][0]["images"][0]["mimeType"] = json!("video/mp4");
            assert!(crate::llm_stream::request_body_for_contract_test(value).is_err());
        }
    }

    #[test]
    fn native_provider_host_contract_accepts_inference_settings_through_request_body() {
        for (protocol, parameter) in [
            ("openai-responses", "max_output_tokens"),
            ("openai-chat-completions", "max_tokens"),
            ("openai-chat-completions", "max_completion_tokens"),
        ] {
            let mut value = native_provider_stream_fixture();
            value["protocol"] = json!(protocol);
            value["inferenceSettings"] = json!({
                "maxOutputTokens": 8192,
                "outputTokenParameter": parameter,
                "reasoning": "provider_default",
            });
            value["continuation"] = if protocol == "openai-responses" {
                json!({"protocol": protocol, "previousResponseId": "response-1",
                    "outputs": [{"callId": "read", "output": "source"}],
                    "userMessages": ["Keep blue clothes", "Keep dialogue"]})
            } else {
                json!({"protocol": protocol, "providerResponseId": "response-1",
                    "history": [{"content": "Earlier text", "calls": [], "outputs": [],
                        "userMessages": ["Earlier supplement"]}],
                    "calls": [{"id": "read", "name": "library.read", "argumentsJson": "{}"}],
                    "outputs": [{"callId": "read", "output": "source"}],
                    "userMessages": ["Keep blue clothes", "Keep dialogue"]})
            };
            assert!(validate_provider_stream_params(&value).is_ok());
            let body = crate::llm_stream::request_body_for_contract_test(value).unwrap();
            assert_eq!(body[parameter], 8192);
            let messages = if protocol == "openai-responses" {
                body["input"].as_array().unwrap()
            } else {
                body["messages"].as_array().unwrap()
            };
            let tail = &messages[messages.len() - 2..];
            assert_eq!(
                tail[0],
                json!({"role": "user", "content": "Keep blue clothes"})
            );
            assert_eq!(tail[1], json!({"role": "user", "content": "Keep dialogue"}));
            assert!(body.get("inferenceSettings").is_none());
        }
        let value = native_provider_stream_fixture();
        assert!(validate_provider_stream_params(&value).is_ok());
        let body = crate::llm_stream::request_body_for_contract_test(value).unwrap();
        assert!(body.get("max_output_tokens").is_none());
    }

    #[test]
    fn native_provider_host_contract_rejects_invalid_inference_settings() {
        for settings in [
            json!(null),
            json!([]),
            json!({}),
            json!({"maxOutputTokens": 0, "outputTokenParameter": "max_output_tokens", "reasoning": "provider_default"}),
            json!({"maxOutputTokens": 4294967296_u64, "outputTokenParameter": "max_output_tokens", "reasoning": "provider_default"}),
            json!({"maxOutputTokens": 1.5, "outputTokenParameter": "max_output_tokens", "reasoning": "provider_default"}),
            json!({"maxOutputTokens": 8192, "outputTokenParameter": "max_tokens", "reasoning": "provider_default"}),
            json!({"maxOutputTokens": 8192, "outputTokenParameter": "max_output_tokens", "reasoning": "off"}),
            json!({"maxOutputTokens": 8192, "outputTokenParameter": "max_output_tokens", "reasoning": "provider_default", "extra": true}),
        ] {
            let mut value = native_provider_stream_fixture();
            value["inferenceSettings"] = settings;
            assert!(validate_provider_stream_params(&value).is_err());
        }
    }

    #[test]
    fn native_provider_host_contract_accepts_actual_worker_envelopes_with_settings() {
        let worker_directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
        let script = r#"
            import { NativeProviderBridge, createPiStreamFunction } from './dist/native-provider-bridge.js';
            const cases = JSON.parse(process.argv[1]);
            const envelopes = [];
            const bridge = new NativeProviderBridge({ send: async (envelope) => { envelopes.push(envelope); } });
            const model = { id: 'mock', name: 'mock', api: 'openai-responses', provider: 'test', baseUrl: 'https://example.com/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
            for (const params of cases) {
                createPiStreamFunction(bridge, () => params)(model, { messages: [] });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            process.stdout.write(JSON.stringify(envelopes));
        "#;
        let cases = ["openai-responses", "openai-chat-completions"].map(|protocol| {
            let mut value = native_provider_stream_fixture();
            value["protocol"] = json!(protocol);
            value["inferenceSettings"] = json!({
                "maxOutputTokens": 8192,
                "outputTokenParameter": if protocol == "openai-responses" { "max_output_tokens" } else { "max_completion_tokens" },
                "reasoning": "provider_default",
            });
            value["continuation"] = if protocol == "openai-responses" {
                json!({"protocol": protocol, "previousResponseId": "response-1", "outputs": [],
                    "userMessages": ["New user instruction"]})
            } else {
                json!({"protocol": protocol, "providerResponseId": "response-1", "calls": [], "outputs": [],
                    "content": "Observed text", "userMessages": ["New user instruction"]})
            };
            value
        });
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "-e",
                script,
                &serde_json::to_string(&cases).unwrap(),
            ])
            .current_dir(worker_directory)
            .output()
            .expect("Worker bridge fixture should start");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let envelopes: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelopes.len(), 2);
        for envelope in envelopes {
            validate_host_request_envelope(&envelope).unwrap();
            let params = &envelope["params"];
            validate_provider_stream_params(params).unwrap();
            let body = crate::llm_stream::request_body_for_contract_test(params.clone()).unwrap();
            let parameter = params["inferenceSettings"]["outputTokenParameter"]
                .as_str()
                .unwrap();
            assert_eq!(body[parameter], 8192);
            let messages = if params["protocol"] == "openai-responses" {
                body["input"].as_array().unwrap()
            } else {
                body["messages"].as_array().unwrap()
            };
            assert_eq!(
                messages.last().unwrap(),
                &json!({"role": "user", "content": "New user instruction"})
            );
        }
    }

    #[test]
    fn native_provider_host_contract_rejects_secrets_unknown_fields_and_oversize() {
        let valid = native_provider_stream_fixture();
        assert!(validate_provider_stream_params(&valid).is_ok());
        let mut with_api_key = valid.clone();
        with_api_key["apiKey"] = json!("secret");
        let mut with_headers = valid.clone();
        with_headers["headers"] = json!({ "Authorization": "secret" });
        let mut with_signed_url = valid.clone();
        with_signed_url["baseUrl"] = json!("https://example.com/v1?X-Amz-Signature=secret");
        let mut with_attachment_secret = valid.clone();
        with_attachment_secret["attachments"][0]["apiKey"] = json!("secret");
        let mut with_unknown = valid.clone();
        with_unknown["unknown"] = json!(true);
        for invalid in [
            with_api_key,
            with_headers,
            with_signed_url,
            with_attachment_secret,
            with_unknown,
        ] {
            assert!(validate_provider_stream_params(&invalid).is_err());
        }

        let envelope = json!({
            "kind": "host.request",
            "requestId": "request",
            "method": "provider.stream.start",
            "params": valid,
        });
        assert!(validate_host_request_envelope(&envelope).is_ok());
        let oversized = json!({
            "kind": "host.request",
            "requestId": "request",
            "method": "provider.stream.start",
            "params": { "value": "x".repeat(SIDECAR_ENVELOPE_MAX_BYTES) },
        });
        assert!(validate_host_request_envelope(&oversized).is_ok());
        let mut ordinary = oversized.clone();
        ordinary["method"] = json!("provider.media.poll");
        assert!(validate_host_request_envelope(&ordinary).is_err());
        let too_large = json!({"kind":"host.request","requestId":"request","method":"provider.stream.start","params":{"value":"x".repeat(super::MODEL_REQUEST_ENVELOPE_MAX_BYTES)}});
        assert!(validate_host_request_envelope(&too_large).is_err());
    }

    #[test]
    fn provider_media_poll_contract_rejects_unknown_and_sensitive_fields() {
        let valid = json!({
            "projectSessionId": "session",
            "providerProfileId": "123e4567-e89b-42d3-a456-426614174000",
            "adapterKey": "TEXT_TO_VIDEO:vidu:viduq3-pro:v2",
            "providerRegion": "global",
            "providerTaskId": "task-123"
        });
        assert!(validate_provider_media_cancel_params(&valid).is_ok());

        let mut unknown = valid.clone();
        unknown["extra"] = json!(true);
        let mut sensitive = valid.clone();
        sensitive["apiKey"] = json!("secret");
        let mut invalid_region = valid.clone();
        invalid_region["providerRegion"] = json!("other");
        for invalid in [unknown, sensitive, invalid_region] {
            assert!(validate_provider_media_cancel_params(&invalid).is_err());
        }
    }

    #[test]
    fn provider_media_poll_normalizes_success_without_exposing_provider_body_or_signed_url() {
        let response = ProviderHttpResponse {
            status: 200,
            body: json!({
                "state": "success",
                "credits_used": "4",
                "creations": [{
                    "url": "https://cdn.example/video.mp4?X-Amz-Signature=must-not-leave-native"
                }],
                "request_id": "provider-request-secret"
            }),
            retry_after_ms: None,
        };
        let output = ProviderBinaryDownloadResponse {
            path: r"C:\Temp\ai-video-workspace-unicompapi\video.mp4".to_string(),
            content_type: Some("video/mp4".to_string()),
        };

        let normalized = normalize_provider_media_poll(&response, "global", Some(&output))
            .expect("successful poll should normalize");
        let serialized = normalized.to_string();

        assert_eq!(normalized["state"], "succeeded");
        assert_eq!(
            normalized["cost"],
            json!({ "amount": 4.0, "unit": "credits" })
        );
        assert_eq!(normalized["output"]["type"], "native_temporary_file");
        assert!(!serialized.contains("X-Amz-Signature"));
        assert!(!serialized.contains("provider-request-secret"));
        assert!(normalized.get("body").is_none());
    }

    #[test]
    fn provider_media_poll_redacts_failed_diagnostics_and_keeps_retry_after_bounded() {
        let response = ProviderHttpResponse {
            status: 400,
            body: json!({
                "state": "failed",
                "error": {
                    "code": "bad_request",
                    "message": "download https://signed.example/video?token=secret with Bearer secret"
                }
            }),
            retry_after_ms: Some(17_000),
        };

        let normalized = normalize_provider_media_poll(&response, "global", None)
            .expect("failed poll should normalize");

        assert_eq!(normalized["state"], "failed");
        assert_eq!(normalized["retryAfterMs"], 17_000);
        assert_eq!(normalized["error"]["code"], "bad_request");
        assert_eq!(
            normalized["error"]["message"],
            "download [URL] with [CREDENTIAL] [CREDENTIAL]"
        );
    }

    #[test]
    fn provider_video_output_type_requires_supported_media() {
        assert_eq!(
            provider_video_extension(Some("video/mp4; charset=binary"), "/output"),
            Ok(".mp4")
        );
        assert_eq!(
            provider_video_extension(Some("video/webm"), "/output"),
            Ok(".webm")
        );
        assert_eq!(
            provider_video_extension(Some("application/octet-stream"), "/output/video.webm?sig=x"),
            Ok(".webm")
        );
        assert!(provider_video_extension(Some("text/html"), "/output/video.mp4").is_err());
    }

    #[test]
    fn openai_compatible_video_content_defaults_untyped_content_to_mp4() {
        assert_eq!(openai_compatible_video_extension(None), Ok(".mp4"));
        assert_eq!(
            openai_compatible_video_extension(Some("application/octet-stream")),
            Ok(".mp4")
        );
        assert_eq!(
            openai_compatible_video_extension(Some("video/webm")),
            Ok(".webm")
        );
        assert!(openai_compatible_video_extension(Some("text/html")).is_err());
    }
}
