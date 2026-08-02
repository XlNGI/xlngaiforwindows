use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(any(not(debug_assertions), test))]
use std::path::Path;

use serde::Serialize;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NOT_FOUND},
    Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
        WinHttpSetTimeouts, INTERNET_DEFAULT_HTTPS_PORT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    },
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    },
};

const CREDENTIAL_SERVICE: &str = "com.ai-video.workspace";
const SUPPORTED_CREDENTIAL_PROVIDERS: &[&str] = &["vidu", "vidu-cn"];
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_TAIL_LIMIT: usize = 16 * 1024;
const PROVIDER_REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const PROVIDER_RESPONSE_BODY_LIMIT: usize = 2 * 1024 * 1024;
const PROVIDER_POLL_INTERVAL: Duration = Duration::from_secs(1);
const PROVIDER_POLL_TIMEOUT: Duration = Duration::from_secs(120);
const PROVIDER_TASK_ID_LIMIT: usize = 256;
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
        "IMAGE_TO_VIDEO:vidu:viduq3:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/reference2video",
            model: "viduq3",
            allowed_fields: REFERENCE_VIDEO_FIELDS,
        },
        "IMAGE_TO_VIDEO:vidu:viduq3-pro:v2" => ProviderTarget {
            credential_provider,
            host,
            path: "/ent/v2/start-end2video",
            model: "viduq3-pro",
            allowed_fields: Q3_VIDEO_FIELDS,
        },
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    provider: String,
    configured: bool,
}

fn validate_credential_provider(provider: &str) -> Result<(), String> {
    if SUPPORTED_CREDENTIAL_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Unsupported credential provider".to_string())
    }
}

fn credential_target(provider: &str) -> Result<Vec<u16>, String> {
    validate_credential_provider(provider)?;
    Ok(format!("{CREDENTIAL_SERVICE}:{provider}\0")
        .encode_utf16()
        .collect())
}

#[tauri::command]
fn credential_status(provider: String) -> Result<CredentialStatus, String> {
    let target = credential_target(&provider)?;
    let mut credential = std::ptr::null_mut::<CREDENTIALW>();
    let configured = unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) != 0 {
            CredFree(credential.cast());
            true
        } else if GetLastError() == ERROR_NOT_FOUND {
            false
        } else {
            return Err("Unable to read Windows secure credential status".to_string());
        }
    };
    Ok(CredentialStatus {
        provider,
        configured,
    })
}

#[tauri::command]
fn credential_set(provider: String, secret: String) -> Result<CredentialStatus, String> {
    let value = secret.trim();
    if value.is_empty()
        || value.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("Credential length is outside the Windows secure storage limit".to_string());
    }
    if (value.len() >= 6 && value[..6].eq_ignore_ascii_case("token "))
        || (value.len() >= 7 && value[..7].eq_ignore_ascii_case("bearer "))
    {
        return Err("Enter the raw API key without a Token or Bearer prefix".to_string());
    }
    let mut target = credential_target(&provider)?;
    let mut username: Vec<u16> = provider.encode_utf16().chain(std::iter::once(0)).collect();
    let mut credential_blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: credential_blob.len() as u32,
        CredentialBlob: credential_blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    let written = unsafe { CredWriteW(&credential, 0) } != 0;
    credential_blob.fill(0);
    if !written {
        return Err("Unable to write Windows secure credential".to_string());
    }
    Ok(CredentialStatus {
        provider,
        configured: true,
    })
}

struct CredentialSecret(Vec<u8>);

impl CredentialSecret {
    fn as_str(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.0).map_err(|_| "Stored credential is not valid UTF-8".to_string())
    }
}

impl Drop for CredentialSecret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

fn credential_read(provider: &str) -> Result<CredentialSecret, String> {
    let target = credential_target(provider)?;
    let mut credential = std::ptr::null_mut::<CREDENTIALW>();
    let read = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } != 0;
    if !read {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Err("Provider credential is not configured".to_string())
        } else {
            Err("Unable to read Windows secure credential".to_string())
        };
    }
    let value = unsafe { &*credential };
    if value.CredentialBlob.is_null() || value.CredentialBlobSize == 0 {
        unsafe { CredFree(credential.cast()) };
        return Err("Stored provider credential is empty".to_string());
    }
    let secret = unsafe {
        std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize).to_vec()
    };
    unsafe { CredFree(credential.cast()) };
    Ok(CredentialSecret(secret))
}

struct WinHttpHandle(*mut core::ffi::c_void);

impl WinHttpHandle {
    fn new(handle: *mut core::ffi::c_void, operation: &str) -> Result<Self, String> {
        if handle.is_null() {
            Err(winhttp_error(operation))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for WinHttpHandle {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
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

fn ensure_video_adapter(adapter_key: &str) -> Result<(), String> {
    match adapter_key {
        "IMAGE_TO_VIDEO:vidu:viduq3:v2"
        | "IMAGE_TO_VIDEO:vidu:viduq3-pro:v2"
        | "IMAGE_TO_VIDEO:vidu:vidu2.0:v2" => Ok(()),
        _ => Err("Native video task commands require an IMAGE_TO_VIDEO adapter".to_string()),
    }
}

fn provider_task_id(body: &serde_json::Value) -> Option<&str> {
    body.get("task_id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            body.get("data")
                .and_then(|data| data.get("task_id"))
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
    provider_region: String,
    payload: serde_json::Value,
) -> Result<ProviderHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        provider_submit_blocking(&adapter_key, &provider_region, payload)
    })
    .await
    .map_err(|error| format!("Native provider task failed: {error}"))?
}

#[tauri::command]
async fn provider_submit_task(
    adapter_key: String,
    provider_region: String,
    payload: serde_json::Value,
) -> Result<ProviderTaskSubmitResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        provider_submit_task_blocking(&adapter_key, &provider_region, payload)
    })
    .await
    .map_err(|error| format!("Native provider task submission failed: {error}"))?
}

fn provider_submit_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    payload: serde_json::Value,
) -> Result<ProviderTaskSubmitResponse, String> {
    ensure_video_adapter(adapter_key)?;
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(target.credential_provider)?;
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
    provider_region: String,
    task_id: String,
) -> Result<ProviderHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        provider_poll_task_blocking(&adapter_key, &provider_region, &task_id)
    })
    .await
    .map_err(|error| format!("Native provider task query failed: {error}"))?
}

fn provider_poll_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    task_id: &str,
) -> Result<ProviderHttpResponse, String> {
    ensure_video_adapter(adapter_key)?;
    let target = provider_target(adapter_key, provider_region)?;
    let path = provider_task_path(task_id)?;
    let secret = credential_read(target.credential_provider)?;
    request_provider_json(target, &secret, "GET", &path, None)
}

#[tauri::command]
async fn provider_cancel_task(
    adapter_key: String,
    provider_region: String,
    task_id: String,
) -> Result<ProviderCancelResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        provider_cancel_task_blocking(&adapter_key, &provider_region, &task_id)
    })
    .await
    .map_err(|error| format!("Native provider task cancellation failed: {error}"))?
}

fn provider_cancel_task_blocking(
    adapter_key: &str,
    provider_region: &str,
    task_id: &str,
) -> Result<ProviderCancelResponse, String> {
    ensure_video_adapter(adapter_key)?;
    let target = provider_target(adapter_key, provider_region)?;
    let path = provider_cancel_path(task_id)?;
    let body = serde_json::to_vec(&serde_json::json!({ "id": task_id }))
        .map_err(|error| format!("Unable to serialize provider cancellation: {error}"))?;
    let secret = credential_read(target.credential_provider)?;
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
    payload: serde_json::Value,
) -> Result<ProviderHttpResponse, String> {
    if ensure_video_adapter(adapter_key).is_ok() {
        return Err("Video adapters must use the asynchronous provider task bridge".to_string());
    }
    let target = provider_target(adapter_key, provider_region)?;
    let body = provider_payload(target, payload)?;
    let secret = credential_read(target.credential_provider)?;
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
    let agent = wide("AI Video Workspace/0.1");
    let host = wide(target.host);
    let verb = wide(method);
    let path = wide(path);
    let session = WinHttpHandle::new(
        unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        },
        "Unable to initialize provider transport",
    )?;
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 30_000) } == 0 {
        return Err(winhttp_error("Unable to configure provider timeouts"));
    }
    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.0, host.as_ptr(), INTERNET_DEFAULT_HTTPS_PORT, 0) },
        "Unable to connect provider transport",
    )?;
    let request = WinHttpHandle::new(
        unsafe {
            WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        },
        "Unable to create provider request",
    )?;
    let disabled_features = WINHTTP_DISABLE_REDIRECTS;
    if unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disabled_features as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(winhttp_error("Unable to disable provider redirects"));
    }

    let mut headers: Vec<u16> = "Content-Type: application/json\r\nAuthorization: Token "
        .encode_utf16()
        .collect();
    headers.extend(secret.as_str()?.encode_utf16());
    headers.extend("\r\n".encode_utf16());
    let sent = unsafe {
        WinHttpSendRequest(
            request.0,
            headers.as_ptr(),
            headers.len() as u32,
            body.map(|value| value.as_ptr().cast())
                .unwrap_or(std::ptr::null()),
            body.map_or(0, |value| value.len() as u32),
            body.map_or(0, |value| value.len() as u32),
            0,
        )
    };
    headers.fill(0);
    if sent == 0 {
        return Err(winhttp_error("Provider request could not be sent"));
    }
    if unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) } == 0 {
        return Err(winhttp_error("Provider response could not be received"));
    }

    let mut status = 0_u32;
    let mut status_size = std::mem::size_of::<u32>() as u32;
    let mut header_index = 0_u32;
    if unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut status_size,
            &mut header_index,
        )
    } == 0
    {
        return Err(winhttp_error("Provider status could not be read"));
    }

    let mut response = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        let mut read = 0_u32;
        if unsafe {
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(winhttp_error("Provider response body could not be read"));
        }
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read as usize]);
        if response.len() > PROVIDER_RESPONSE_BODY_LIMIT {
            return Err("Provider response exceeds the native transport limit".to_string());
        }
    }
    let parsed = if response.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&response)
            .map_err(|_| "Provider returned a non-JSON response".to_string())?
    };
    Ok(ProviderHttpResponse {
        status,
        body: parsed,
    })
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn winhttp_error(operation: &str) -> String {
    format!("{operation} (Windows error {})", unsafe { GetLastError() })
}

#[tauri::command]
fn credential_delete(provider: String) -> Result<CredentialStatus, String> {
    let target = credential_target(&provider)?;
    let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0;
    let missing = !deleted && unsafe { GetLastError() } == ERROR_NOT_FOUND;
    if !deleted && !missing {
        return Err("Unable to delete Windows secure credential".to_string());
    }
    Ok(CredentialStatus {
        provider,
        configured: false,
    })
}

struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<Result<String, String>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

impl WorkerProcess {
    fn spawn() -> Result<Self, String> {
        Self::spawn_command(worker_command()?)
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

struct WorkerState(Mutex<Option<WorkerProcess>>);

#[tauri::command]
fn worker_request(
    request: serde_json::Value,
    state: tauri::State<'_, WorkerState>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|_| "Worker lock is poisoned")?;
    if guard.is_none() {
        *guard = Some(WorkerProcess::spawn()?);
    }

    let result = guard
        .as_mut()
        .ok_or("Worker failed to start")?
        .request(&request);

    if result.is_err() {
        *guard = None;
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            worker_request,
            credential_status,
            credential_set,
            credential_delete,
            provider_submit,
            provider_submit_task,
            provider_poll_task,
            provider_cancel_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Video Workspace");
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_worker_path, contains_image_source, ensure_video_adapter, provider_cancel_path,
        provider_payload, provider_state, provider_target, provider_task_error, provider_task_id,
        provider_task_path, validate_credential_provider, WorkerProcess, BUNDLED_WORKER_FILENAME,
        PROVIDER_REQUEST_BODY_LIMIT,
    };
    use serde_json::json;
    use std::{path::Path, process::Command, time::Duration};

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
        assert!(validate_credential_provider("../../project.sqlite").is_err());
    }

    #[test]
    fn provider_bridge_is_bound_to_an_exact_adapter_and_injects_its_model() {
        let target = provider_target("IMAGE_TO_VIDEO:vidu:viduq3-pro:v2", "global")
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
        let reference = provider_target("IMAGE_TO_VIDEO:vidu:viduq3:v2", "global")
            .expect("reference video adapter should resolve");
        assert_eq!(reference.path, "/ent/v2/reference2video");
        assert_eq!(reference.model, "viduq3");
        assert!(provider_target("IMAGE_TO_VIDEO:evil:viduq3-pro:v2", "global").is_err());
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
    }

    #[test]
    fn video_task_contract_extracts_only_declared_task_fields() {
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3:v2").is_ok());
        assert!(ensure_video_adapter("IMAGE_TO_VIDEO:vidu:viduq3-pro:v2").is_ok());
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
