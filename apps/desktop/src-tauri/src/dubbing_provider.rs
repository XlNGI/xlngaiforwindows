//! Official fixed-voice TTS and lip-sync file bridge. Media and signed URLs stay Native.
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    mem::ManuallyDrop,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};
use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetFinalPathNameByHandleW};

use crate::{
    credential_store::{credential_read, is_profile_id},
    host_error,
    provider_http::{
        self, DubbingCancellation, DubbingHttpBody, DubbingHttpRequest, DubbingHttpTarget,
        JsonHttpError, JsonHttpErrorKind,
    },
};

const AUDIO_LIMIT: u64 = 20 * 1024 * 1024;
const VIDEO_LIMIT: u64 = 512 * 1024 * 1024;
const JSON_LIMIT: usize = 2 * 1024 * 1024;
const REPARSE_POINT: u32 = 0x400;
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const BACKUP_SEMANTICS: u32 = 0x0200_0000;
const SHARE_READ: u32 = 1;
const DISK_RESERVE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechParams {
    project_root: String,
    provider_profile_id: String,
    model: String,
    voice_id: String,
    text: String,
    speed: f64,
    pitch: i32,
    emotion: Option<String>,
    output_relative_path: String,
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitParams {
    project_root: String,
    provider_profile_id: String,
    video_relative_path: String,
    audio_relative_path: String,
    idempotency_key: String,
    speaker_coordinates: Option<[u32; 2]>,
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PollParams {
    project_root: String,
    provider_profile_id: String,
    provider_task_id: String,
    output_relative_path: String,
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelParams {
    provider_profile_id: Option<String>,
    provider_task_id: Option<String>,
    operation_id: Option<String>,
}

#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<DubbingCancellation>>,
    cancelled: HashMap<String, Instant>,
}

type OperationRegistry = Mutex<Registry>;

fn operations() -> &'static OperationRegistry {
    static REGISTRY: OnceLock<OperationRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

/// Stop detached Native transfers when their Worker owner exits or restarts.
pub(crate) fn cancel_all() {
    if let Ok(registry) = operations().lock() {
        for cancellation in registry.active.values() {
            cancellation.cancel();
        }
    }
}

pub(crate) struct Operation {
    id: String,
    pub(crate) cancellation: Arc<DubbingCancellation>,
}

impl Operation {
    pub(crate) fn register(id: &str) -> Result<Self, Value> {
        Self::register_with_policy(id, true)
    }

    fn register_with_policy(id: &str, paid: bool) -> Result<Self, Value> {
        let mut registry = operations()
            .lock()
            .map_err(|_| invalid("Dubbing operation registry is unavailable"))?;
        registry
            .cancelled
            .retain(|_, time| time.elapsed() < Duration::from_secs(3600));
        if paid && registry.cancelled.contains_key(id) {
            return Err(host_error(
                "INTERRUPTED",
                "Dubbing operation was cancelled before dispatch",
                false,
            ));
        }
        if registry.active.len() >= 48 {
            return Err(host_error(
                "REQUEST_NOT_SENT",
                "Dubbing operation queue is full",
                true,
            ));
        }
        if registry.active.contains_key(id) {
            return Err(host_error(
                "REQUEST_NOT_SENT",
                "Dubbing operation is already active",
                false,
            ));
        }
        let cancellation = Arc::new(DubbingCancellation::default());
        registry
            .active
            .insert(id.to_string(), Arc::clone(&cancellation));
        Ok(Self {
            id: id.to_string(),
            cancellation,
        })
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut registry) = operations().lock() {
            if registry
                .active
                .get(&self.id)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancellation))
            {
                registry.active.remove(&self.id);
            }
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, Value> {
    // Do not return serde diagnostics: they can contain caller-supplied text or URLs.
    serde_json::from_value(params.clone())
        .map_err(|_| invalid("Dubbing parameters are invalid or contain unsupported fields"))
}

fn invalid(message: &str) -> Value {
    host_error("INVALID_PARAMETERS", message, false)
}

fn validate_profile(profile: &str) -> Result<(), Value> {
    if is_profile_id(profile) {
        Ok(())
    } else {
        Err(invalid(
            "Dubbing connection must be an official Provider profile UUID",
        ))
    }
}

fn operation_id<'a>(id: Option<&'a str>, request_id: &'a str) -> Result<&'a str, Value> {
    if id.is_some_and(|id| !is_profile_id(id)) {
        return Err(invalid("Dubbing operation ID must be a UUID"));
    }
    Ok(id.unwrap_or(request_id))
}

pub(crate) fn handle(method: &str, params: &Value, request_id: &str) -> Result<Value, Value> {
    match method {
        "provider.dubbing.speech" => {
            let params: SpeechParams = decode(params)?;
            validate_speech(&params)?;
            let operation =
                Operation::register(operation_id(params.operation_id.as_deref(), request_id)?)?;
            speech(&params, &operation.cancellation)
        }
        "provider.dubbing.submit" => {
            let params: SubmitParams = decode(params)?;
            validate_profile(&params.provider_profile_id)?;
            if params.idempotency_key.is_empty()
                || params.idempotency_key.len() > 128
                || !params
                    .idempotency_key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'~' | b'-'))
            {
                return Err(invalid("Sync idempotency key is invalid"));
            }
            if params
                .speaker_coordinates
                .is_some_and(|xy| xy.iter().any(|n| *n > 8192))
            {
                return Err(invalid("Speaker coordinates must be source-frame pixels"));
            }
            let operation =
                Operation::register(operation_id(params.operation_id.as_deref(), request_id)?)?;
            submit(&params, &operation.cancellation)
        }
        "provider.dubbing.poll" => {
            let params: PollParams = decode(params)?;
            validate_profile(&params.provider_profile_id)?;
            validate_task_id(&params.provider_task_id)?;
            let operation = Operation::register_with_policy(
                operation_id(params.operation_id.as_deref(), request_id)?,
                false,
            )?;
            poll(&params, &operation.cancellation)
        }
        "provider.dubbing.cancel" => cancel(params),
        _ => Err(host_error(
            "METHOD_NOT_FOUND",
            "Unknown dubbing Provider method",
            false,
        )),
    }
}

fn validate_speech(params: &SpeechParams) -> Result<(), Value> {
    validate_profile(&params.provider_profile_id)?;
    if !matches!(params.model.as_str(), "speech-2.8-hd" | "speech-2.8-turbo")
        || params.voice_id.trim().is_empty()
        || params.voice_id.len() > 256
        || params.voice_id.chars().any(char::is_control)
        || params.text.trim().is_empty()
        || params.text.chars().count() > 4000
        || params.text.contains('\0')
        || !params.speed.is_finite()
        || !(0.5..=2.0).contains(&params.speed)
        || !(-12..=12).contains(&params.pitch)
        || params.emotion.as_deref().is_some_and(|e| {
            !matches!(
                e,
                "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised" | "calm"
            )
        })
    {
        return Err(invalid(
            "MiniMax model, voice, text, speed, pitch or emotion is unsupported",
        ));
    }
    validate_relative(&params.output_relative_path, true, ".mp3")
}

fn validate_task_id(id: &str) -> Result<(), Value> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        Err(invalid("Sync task ID is invalid"))
    } else {
        Ok(())
    }
}

fn cancel(params: &Value) -> Result<Value, Value> {
    let params: CancelParams = decode(params)?;
    if let Some(profile) = &params.provider_profile_id {
        validate_profile(profile)?;
    }
    if let Some(task) = &params.provider_task_id {
        validate_task_id(task)?;
    }
    if params
        .operation_id
        .as_deref()
        .is_some_and(|id| !is_profile_id(id))
    {
        return Err(invalid("Dubbing operation ID must be a UUID"));
    }
    let cancelled = if let Some(id) = &params.operation_id {
        cancel_operation(id)?
    } else {
        false
    };
    // Sync deletion is not cancellation of a running generation. Never pretend it is.
    Ok(json!({ "cancelled": cancelled, "remoteSupported": false }))
}

pub(crate) fn cancel_operation(id: &str) -> Result<bool, Value> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid("Native media operation ID is invalid"));
    }
    let mut registry = operations()
        .lock()
        .map_err(|_| invalid("Dubbing operation registry is unavailable"))?;
    let cancelled = registry.active.get(id).is_some_and(|cancellation| {
        cancellation.cancel();
        true
    });
    registry
        .cancelled
        .retain(|_, time| time.elapsed() < Duration::from_secs(3600));
    if registry.cancelled.len() >= 128 {
        if let Some(oldest) = registry
            .cancelled
            .iter()
            .min_by_key(|(_, time)| **time)
            .map(|(id, _)| id.clone())
        {
            registry.cancelled.remove(&oldest);
        }
    }
    registry.cancelled.insert(id.to_string(), Instant::now());
    Ok(cancelled)
}

fn transport_error(
    error: JsonHttpError,
    cancellation: &DubbingCancellation,
    submitting: bool,
) -> Value {
    let code = if submitting && !error.request_may_have_been_sent() {
        "REQUEST_NOT_SENT"
    } else if cancellation.is_cancelled() {
        "INTERRUPTED"
    } else if let Some(status) = error.rejected_http_status() {
        match status {
            401 | 403 => "AUTHENTICATION_FAILED",
            429 => "RATE_LIMITED",
            _ => "PROVIDER_FAILED",
        }
    } else {
        match error.kind() {
            JsonHttpErrorKind::Admission => "REQUEST_NOT_SENT",
            JsonHttpErrorKind::Timeout => "TIMEOUT",
            _ if submitting => "SUBMISSION_UNKNOWN",
            _ => "PROVIDER_FAILED",
        }
    };
    // WinHTTP diagnostics are locally generated; never include a response body or output URL.
    let mut value = host_error(code, error.to_string(), code == "REQUEST_NOT_SENT");
    if let Some(status) = error
        .rejected_http_status()
        .filter(|status| (100..=599).contains(status))
    {
        value["providerStatus"] = json!(status);
    }
    value
}

fn secret(profile: &str) -> Result<crate::CredentialSecret, Value> {
    credential_read(&profile.to_ascii_lowercase()).map_err(|_| {
        host_error(
            "PROVIDER_UNAVAILABLE",
            "Official dubbing connection credential is not configured",
            false,
        )
    })
}

fn parse_response(
    response: provider_http::RawHttpResponse,
    provider: &str,
) -> Result<Value, Value> {
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if !(200..=299).contains(&response.status) {
        let stable = body
            .get("errorCode")
            .and_then(Value::as_str)
            .filter(|code| {
                code.len() <= 128 && code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            });
        let code = match response.status {
            _ if stable == Some("IDEMPOTENCY_OUTCOME_UNKNOWN") => "SUBMISSION_UNKNOWN",
            401 | 403 => "AUTHENTICATION_FAILED",
            429 => "RATE_LIMITED",
            _ => "PROVIDER_FAILED",
        };
        let mut error = host_error(
            code,
            format!(
                "{provider} rejected the request (HTTP {}, {})",
                response.status,
                stable.unwrap_or("request_failed")
            ),
            false,
        );
        if (100..=599).contains(&response.status) {
            error["providerStatus"] = json!(response.status);
        }
        if let Some(id) = body
            .get("generationId")
            .and_then(Value::as_str)
            .filter(|id| validate_task_id(id).is_ok())
        {
            error["providerTaskId"] = json!(id);
        }
        if let Some(stable) = stable {
            error["providerErrorCode"] = json!(stable);
        }
        return Err(error);
    }
    if !body.is_object() {
        return Err(host_error(
            "PROVIDER_FAILED",
            "Dubbing Provider returned an invalid response",
            false,
        ));
    }
    Ok(body)
}

fn speech(params: &SpeechParams, cancellation: &DubbingCancellation) -> Result<Value, Value> {
    let project = ProjectFiles::open(&params.project_root)?;
    let output = project.output(&params.output_relative_path, ".mp3")?;
    let mut voice = json!({ "voice_id": params.voice_id, "speed": params.speed, "pitch": params.pitch, "vol": 1 });
    if let Some(emotion) = &params.emotion {
        voice["emotion"] = json!(emotion);
    }
    let payload = serde_json::to_vec(&json!({ "model": params.model, "text": params.text, "stream": false, "output_format": "hex", "voice_setting": voice,
        "audio_setting": { "format": "mp3", "sample_rate": 32000, "bitrate": 128000, "channel": 1 } }))
        .map_err(|_| invalid("Speech request could not be prepared"))?;
    let credentials = secret(&params.provider_profile_id)?;
    let mut reader = Cursor::new(&payload);
    let response = provider_http::request_dubbing_file(DubbingHttpRequest {
        target: DubbingHttpTarget::Speech,
        secret: Some(
            credentials
                .as_str()
                .map_err(|_| invalid("Provider credential is invalid"))?,
        ),
        idempotency_key: None,
        body: Some(DubbingHttpBody {
            reader: &mut reader,
            size: payload.len() as u32,
            content_type: "application/json",
        }),
        output: None,
        response_limit: (AUDIO_LIMIT * 2) as usize + JSON_LIMIT,
        cancellation,
    })
    .map_err(|error| transport_error(error, cancellation, true))?;
    let body = parse_response(response, "MiniMax")?;
    if body
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        != Some(0)
    {
        return Err(host_error(
            "PROVIDER_FAILED",
            "MiniMax speech synthesis did not succeed",
            false,
        ));
    }
    let hex = body
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .ok_or_else(|| host_error("PROVIDER_FAILED", "MiniMax returned no speech audio", false))?;
    let mut result = output;
    decode_hex_to_file(hex, &mut result, cancellation)?;
    result.file.sync_all().map_err(|_| {
        host_error(
            "PROVIDER_FAILED",
            "Speech audio could not be committed",
            false,
        )
    })?;
    let mime = inspect_media(&mut result.file, MediaKind::Audio)?;
    if mime != "audio/mpeg" {
        return Err(host_error(
            "PROVIDER_FAILED",
            "MiniMax did not return the requested MP3 audio format",
            false,
        ));
    }
    let size = result
        .file
        .metadata()
        .map_err(|_| invalid("Speech audio is unavailable"))?
        .len();
    result.committed = true;
    let mut value =
        json!({ "relativePath": params.output_relative_path, "mime": mime, "sizeBytes": size });
    if let Some(trace) = body
        .get("trace_id")
        .and_then(Value::as_str)
        .filter(|id| validate_task_id(id).is_ok())
    {
        value["providerTaskId"] = json!(trace);
    }
    Ok(value)
}

fn decode_hex_to_file(
    hex: &str,
    file: &mut dyn Write,
    cancellation: &DubbingCancellation,
) -> Result<(), Value> {
    if hex.is_empty() || hex.len() % 2 != 0 || hex.len() as u64 > AUDIO_LIMIT * 2 {
        return Err(host_error(
            "PROVIDER_FAILED",
            "Speech audio is empty, invalid or exceeds the size limit",
            false,
        ));
    }
    let mut buffer = Vec::with_capacity(64 * 1024);
    for pair in hex.as_bytes().chunks_exact(2) {
        let nibble = |value: u8| match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        };
        let high = nibble(pair[0]).ok_or_else(|| {
            host_error("PROVIDER_FAILED", "Speech audio encoding is invalid", false)
        })?;
        let low = nibble(pair[1]).ok_or_else(|| {
            host_error("PROVIDER_FAILED", "Speech audio encoding is invalid", false)
        })?;
        buffer.push(high * 16 + low);
        if buffer.len() == buffer.capacity() {
            if cancellation.is_cancelled() {
                return Err(host_error(
                    "INTERRUPTED",
                    "Speech operation was cancelled",
                    false,
                ));
            }
            file.write_all(&buffer).map_err(|_| {
                host_error("PROVIDER_FAILED", "Speech audio could not be saved", false)
            })?;
            buffer.clear();
        }
    }
    if cancellation.is_cancelled() {
        return Err(host_error(
            "INTERRUPTED",
            "Speech operation was cancelled",
            false,
        ));
    }
    file.write_all(&buffer)
        .map_err(|_| host_error("PROVIDER_FAILED", "Speech audio could not be saved", false))
}

fn submit(params: &SubmitParams, cancellation: &DubbingCancellation) -> Result<Value, Value> {
    let project = ProjectFiles::open(&params.project_root)?;
    let video = project.input(&params.video_relative_path, MediaKind::Video)?;
    let mut audio = project.input(&params.audio_relative_path, MediaKind::Audio)?;
    let mime = inspect_media(&mut audio, MediaKind::Audio)?;
    let credentials = secret(&params.provider_profile_id)?;
    // Stable boundary and neutral filenames make keyed replays byte-for-byte reproducible.
    let boundary = "XLNGAIDubbingMultipartV1";
    let mut options = json!({ "sync_mode": "silence" });
    if let Some(coordinates) = params.speaker_coordinates {
        options["active_speaker_detection"] =
            json!({ "auto_detect": false, "frame_number": 0, "coordinates": coordinates });
    }
    let mut multipart = MultipartReader::new(boundary, &options, video, audio, mime)?;
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let total = multipart.size;
    let response = provider_http::request_dubbing_file(DubbingHttpRequest {
        target: DubbingHttpTarget::SyncSubmit,
        secret: Some(
            credentials
                .as_str()
                .map_err(|_| invalid("Provider credential is invalid"))?,
        ),
        idempotency_key: Some(&params.idempotency_key),
        body: Some(DubbingHttpBody {
            reader: &mut multipart,
            size: total,
            content_type: &content_type,
        }),
        output: None,
        response_limit: JSON_LIMIT,
        cancellation,
    })
    .map_err(|error| transport_error(error, cancellation, true))?;
    let accepted = (200..=299).contains(&response.status);
    let body = parse_response(response, "Sync").map_err(|mut error| {
        if accepted {
            error["code"] = json!("SUBMISSION_UNKNOWN");
        }
        error
    })?;
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| validate_task_id(id).is_ok())
        .ok_or_else(|| {
            host_error(
                "SUBMISSION_UNKNOWN",
                "Sync accepted no identifiable task; submission result is unknown",
                false,
            )
        })?;
    // Do not return options/input: they contain asset URLs and potentially signed URLs.
    Ok(json!({ "providerTaskId": id }))
}

fn poll(params: &PollParams, cancellation: &DubbingCancellation) -> Result<Value, Value> {
    let project = ProjectFiles::open(&params.project_root)?;
    validate_relative(&params.output_relative_path, true, ".mp4")?;
    let credentials = secret(&params.provider_profile_id)?;
    let response = provider_http::request_dubbing_file(DubbingHttpRequest {
        target: DubbingHttpTarget::SyncPoll(&params.provider_task_id),
        secret: Some(
            credentials
                .as_str()
                .map_err(|_| invalid("Provider credential is invalid"))?,
        ),
        idempotency_key: None,
        body: None,
        output: None,
        response_limit: JSON_LIMIT,
        cancellation,
    })
    .map_err(|error| transport_error(error, cancellation, false))?;
    let body = parse_response(response, "Sync")?;
    match body.get("status").and_then(Value::as_str) {
        Some("PENDING") => Ok(json!({ "status": "pending" })),
        Some("PROCESSING") => Ok(json!({ "status": "running" })),
        Some("FAILED" | "REJECTED") => {
            let code = body
                .get("errorCode")
                .and_then(Value::as_str)
                .filter(|code| {
                    code.len() <= 128
                        && code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                })
                .unwrap_or("provider_failed");
            Ok(json!({ "status": "failed", "errorCode": code }))
        }
        Some("COMPLETED") => {
            let url = body
                .get("outputUrl")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    host_error(
                        "PROVIDER_FAILED",
                        "Completed Sync task has no output",
                        false,
                    )
                })?;
            let parsed = provider_http::parse_public_https_url(url)
                .map_err(|_| host_error("PROVIDER_FAILED", "Sync output URL is invalid", false))?;
            let mut output = project.output(&params.output_relative_path, ".mp4")?;
            let response = provider_http::request_dubbing_file(DubbingHttpRequest {
                target: DubbingHttpTarget::Output(&parsed),
                secret: None,
                idempotency_key: None,
                body: None,
                output: Some(&mut output),
                response_limit: VIDEO_LIMIT as usize,
                cancellation,
            })
            .map_err(|error| transport_error(error, cancellation, false))?;
            if !(200..=299).contains(&response.status) {
                return Err(host_error(
                    "PROVIDER_FAILED",
                    "Sync output download failed; no redirects are permitted",
                    false,
                ));
            }
            output.file.sync_all().map_err(|_| {
                host_error(
                    "PROVIDER_FAILED",
                    "Sync output could not be committed",
                    false,
                )
            })?;
            inspect_media(&mut output.file, MediaKind::Video)?;
            let size = output
                .file
                .metadata()
                .map_err(|_| invalid("Sync output is unavailable"))?
                .len();
            if cancellation.is_cancelled() {
                return Err(host_error(
                    "INTERRUPTED",
                    "Sync output download was cancelled",
                    false,
                ));
            }
            output.committed = true;
            Ok(
                json!({ "status": "complete", "relativePath": params.output_relative_path, "mime": "video/mp4", "sizeBytes": size }),
            )
        }
        _ => Err(host_error(
            "PROVIDER_FAILED",
            "Sync returned an unsupported task status",
            false,
        )),
    }
}

enum MultipartPart {
    Bytes(Cursor<Vec<u8>>),
    File(File),
}
struct MultipartReader {
    parts: Vec<MultipartPart>,
    index: usize,
    size: u32,
}

impl MultipartReader {
    fn new(
        boundary: &str,
        options: &Value,
        mut video: File,
        mut audio: File,
        mime: &str,
    ) -> Result<Self, Value> {
        reject_multipart_delimiter(&mut video, boundary)?;
        reject_multipart_delimiter(&mut audio, boundary)?;
        let prefix = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsync-3\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"options\"\r\n\r\n{options}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"video\"; filename=\"input.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").into_bytes();
        let extension = if mime == "audio/wav" { "wav" } else { "mp3" };
        let middle = format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"input.{extension}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
        let suffix = format!("\r\n--{boundary}--\r\n").into_bytes();
        let length = prefix.len() as u64
            + middle.len() as u64
            + suffix.len() as u64
            + video
                .metadata()
                .map_err(|_| invalid("Video input is unavailable"))?
                .len()
            + audio
                .metadata()
                .map_err(|_| invalid("Audio input is unavailable"))?
                .len();
        let size = u32::try_from(length)
            .map_err(|_| invalid("Multipart input exceeds the transport limit"))?;
        Ok(Self {
            parts: vec![
                MultipartPart::Bytes(Cursor::new(prefix)),
                MultipartPart::File(video),
                MultipartPart::Bytes(Cursor::new(middle)),
                MultipartPart::File(audio),
                MultipartPart::Bytes(Cursor::new(suffix)),
            ],
            index: 0,
            size,
        })
    }
}

fn reject_multipart_delimiter(file: &mut File, boundary: &str) -> Result<(), Value> {
    let delimiter = format!("\r\n--{boundary}").into_bytes();
    let mut buffer = vec![0_u8; 64 * 1024 + delimiter.len()];
    let mut prefix = 0;
    loop {
        let size = file
            .read(&mut buffer[prefix..])
            .map_err(|_| invalid("Multipart input could not be inspected"))?;
        if size == 0 {
            break;
        }
        let total = prefix + size;
        if buffer[..total]
            .windows(delimiter.len())
            .any(|bytes| bytes == delimiter)
        {
            return Err(invalid("Media contains an invalid multipart delimiter"));
        }
        prefix = total.min(delimiter.len() - 1);
        buffer.copy_within(total - prefix..total, 0);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid("Multipart input could not be inspected"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    const PROFILE: &str = "123e4567-e89b-42d3-a456-426614174000";

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "xlngai-dubbing-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("cache/dubbing/test")).unwrap();
            fs::create_dir_all(root.join("assets/audio/dialogue")).unwrap();
            fs::create_dir_all(root.join("assets/videos")).unwrap();
            fs::write(root.join("project.sqlite"), []).unwrap();
            Self(root)
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            fs::write(self.0.join(path), bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn speech_params() -> Value {
        json!({ "projectRoot": "E:/fixture", "providerProfileId": PROFILE, "model": "speech-2.8-hd", "voiceId": "Chinese (Mandarin)_Lyrical_Voice", "text": "固定角色的声音", "speed": 1, "pitch": 0, "outputRelativePath": "cache/dubbing/test/out.mp3" })
    }

    #[test]
    fn official_speech_contract_rejects_whisper_credentials_and_overlimits() {
        let value = speech_params();
        let params: SpeechParams = decode(&value).unwrap();
        assert!(validate_speech(&params).is_ok());
        for (field, changed) in [
            ("emotion", json!("whisper")),
            ("emotion", json!("fluent")),
            ("model", json!("speech-01-hd")),
            ("speed", json!(0.4)),
            ("pitch", json!(13)),
            ("providerProfileId", json!("vidu")),
            ("text", json!("中".repeat(4001))),
        ] {
            let mut value = speech_params();
            value[field] = changed;
            assert!(
                validate_speech(&decode::<SpeechParams>(&value).unwrap()).is_err(),
                "{field} must be rejected"
            );
        }
        let mut value = speech_params();
        value["secret"] = json!("must not cross IPC");
        assert!(decode::<SpeechParams>(&value).is_err());
    }

    #[test]
    fn project_paths_reject_traversal_reserved_names_and_arbitrary_outputs() {
        for path in [
            "../cache/dubbing/out.mp3",
            "cache/dubbing/../out.mp3",
            "cache/dubbing/CON.mp3",
            "cache/dubbing/LPT1.mp3",
            "cache/dubbing/a.mp3:stream",
            "cache\\dubbing\\out.mp3",
            "assets/audio/out.mp3",
            "cache/dubbing/out.mp3.",
            "/cache/dubbing/out.mp3",
            "cache/dubbing/out.mp4",
        ] {
            assert!(
                validate_relative(path, true, ".mp3").is_err(),
                "{path} must be rejected"
            );
        }
        assert!(validate_relative("cache/dubbing/test/take.mp3", true, ".mp3").is_ok());
    }

    #[test]
    fn controlled_handles_lock_inputs_and_remove_failed_outputs() {
        let fixture = Fixture::new();
        fixture.write("assets/audio/dialogue/take.mp3", b"ID3test-audio-payload");
        let project = ProjectFiles::open(fixture.0.to_str().unwrap()).unwrap();
        let input = project
            .input("assets/audio/dialogue/take.mp3", MediaKind::Audio)
            .unwrap();
        assert!(OpenOptions::new()
            .write(true)
            .open(fixture.0.join("assets/audio/dialogue/take.mp3"))
            .is_err());
        drop(input);
        {
            let mut output = project
                .output("cache/dubbing/test/out.mp3", ".mp3")
                .unwrap();
            output.file.write_all(b"partial").unwrap();
            assert!(project
                .output("cache/dubbing/test/out.mp3", ".mp3")
                .is_err());
        }
        assert!(!fixture.0.join("cache/dubbing/test/out.mp3").exists());
        let mut output = project
            .output("cache/dubbing/test/out.mp3", ".mp3")
            .unwrap();
        output.file.write_all(b"ID3test-audio-payload").unwrap();
        output.committed = true;
        drop(output);
        assert!(fixture.0.join("cache/dubbing/test/out.mp3").is_file());
    }

    #[test]
    fn output_writer_checks_live_free_space_and_keeps_a_sixteen_mib_reserve() {
        let chunk = 64 * 1024;
        assert!(check_disk_capacity(DISK_RESERVE_BYTES + chunk, chunk).is_ok());
        assert!(check_disk_capacity(DISK_RESERVE_BYTES + chunk - 1, chunk).is_err());
        assert!(check_disk_capacity(u64::MAX - 1, u64::MAX).is_err());
        let fixture = Fixture::new();
        let project = ProjectFiles::open(fixture.0.to_str().unwrap()).unwrap();
        assert!(available_disk_bytes(&fixture.0).unwrap() >= DISK_RESERVE_BYTES);
        let mut output = project
            .output("cache/dubbing/test/capacity.mp3", ".mp3")
            .unwrap();
        output.write_all(b"ID3capacity-checked-output").unwrap();
        output.flush().unwrap();
        assert_eq!(
            std::fs::read(&output.path).unwrap(),
            b"ID3capacity-checked-output"
        );
    }

    #[test]
    fn junction_inputs_are_rejected_even_when_target_is_inside_project() {
        let fixture = Fixture::new();
        fixture.write("assets/audio/dialogue/take.mp3", b"ID3test-audio-payload");
        let link = fixture.0.join("assets/audio/linked");
        let status = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(
                fixture
                    .0
                    .join("assets/audio/dialogue")
                    .to_string_lossy()
                    .replace('/', "\\"),
            )
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "Junction fixture must be available on Windows: {} {}",
            String::from_utf8_lossy(&status.stdout),
            String::from_utf8_lossy(&status.stderr)
        );
        let project = ProjectFiles::open(fixture.0.to_str().unwrap()).unwrap();
        assert!(project
            .input("assets/audio/linked/take.mp3", MediaKind::Audio)
            .is_err());
        fs::remove_dir(link).unwrap();
    }

    #[test]
    fn hex_audio_is_externalized_and_bad_encoding_never_succeeds() {
        let fixture = Fixture::new();
        let project = ProjectFiles::open(fixture.0.to_str().unwrap()).unwrap();
        let mut output = project
            .output("cache/dubbing/test/out.mp3", ".mp3")
            .unwrap();
        let cancellation = DubbingCancellation::default();
        decode_hex_to_file("494433746573742d617564696f", &mut output, &cancellation).unwrap();
        assert_eq!(
            inspect_media(&mut output.file, MediaKind::Audio).unwrap(),
            "audio/mpeg"
        );
        assert_eq!(fs::read(&output.path).unwrap(), b"ID3test-audio");
        assert!(decode_hex_to_file("xy", &mut output, &cancellation).is_err());
        assert!(decode_hex_to_file("a", &mut output, &cancellation).is_err());
        cancellation.cancel();
        assert_eq!(
            decode_hex_to_file("00", &mut output, &cancellation).unwrap_err()["code"],
            "INTERRUPTED"
        );
    }

    #[test]
    fn multipart_replay_stream_is_stable_and_preserves_source_bytes() {
        let fixture = Fixture::new();
        let video = b"\0\0\0\x18ftypisomvideo-bytes";
        let audio = b"ID3audio-bytes-data";
        fixture.write("assets/videos/clip.mp4", video);
        fixture.write("assets/audio/dialogue/take.mp3", audio);
        let project = ProjectFiles::open(fixture.0.to_str().unwrap()).unwrap();
        let generate = || {
            let mut body = MultipartReader::new(
                "XLNGAIDubbingMultipartV1",
                &json!({"sync_mode":"silence"}),
                project
                    .input("assets/videos/clip.mp4", MediaKind::Video)
                    .unwrap(),
                project
                    .input("assets/audio/dialogue/take.mp3", MediaKind::Audio)
                    .unwrap(),
                "audio/mpeg",
            )
            .unwrap();
            let expected = body.size;
            let mut output = Vec::new();
            body.read_to_end(&mut output).unwrap();
            assert_eq!(output.len(), expected as usize);
            output
        };
        let first = generate();
        assert_eq!(first, generate());
        assert!(first.windows(video.len()).any(|bytes| bytes == video));
        assert!(first.windows(audio.len()).any(|bytes| bytes == audio));
        assert!(String::from_utf8_lossy(&first).contains("\"sync_mode\":\"silence\""));
        fixture.write(
            "assets/audio/dialogue/take.mp3",
            b"ID3malicious\r\n--XLNGAIDubbingMultipartV1\r\n",
        );
        assert!(MultipartReader::new(
            "XLNGAIDubbingMultipartV1",
            &json!({}),
            project
                .input("assets/videos/clip.mp4", MediaKind::Video)
                .unwrap(),
            project
                .input("assets/audio/dialogue/take.mp3", MediaKind::Audio)
                .unwrap(),
            "audio/mpeg"
        )
        .is_err());
    }

    #[test]
    fn cancellation_is_local_bounded_and_does_not_claim_remote_abort() {
        let operation = Operation::register(PROFILE).unwrap();
        assert!(Operation::register(PROFILE).is_err());
        let value =
            cancel(&json!({ "operationId": PROFILE, "providerTaskId": "generation_123" })).unwrap();
        assert_eq!(
            value,
            json!({ "cancelled": true, "remoteSupported": false })
        );
        assert!(operation.cancellation.is_cancelled());
        drop(operation);
        assert_eq!(
            cancel(&json!({ "operationId": PROFILE })).unwrap()["cancelled"],
            false
        );
        assert!(cancel(&json!({ "secret": "blocked" })).is_err());
    }

    #[test]
    fn cancellation_before_network_thread_registration_prevents_late_submit() {
        let id = "123e4567-e89b-42d3-a456-426614174001";
        assert_eq!(
            cancel(&json!({"operationId": id})).unwrap()["cancelled"],
            false
        );
        assert_eq!(
            Operation::register(id).err().unwrap()["code"],
            "INTERRUPTED"
        );
        let recovered_poll = Operation::register_with_policy(id, false).unwrap();
        assert!(!recovered_poll.cancellation.is_cancelled());
    }

    #[test]
    fn provider_failures_keep_only_safe_codes_and_recovery_ids() {
        let response = provider_http::RawHttpResponse { status: 503, body: serde_json::to_vec(&json!({ "errorCode": "IDEMPOTENCY_OUTCOME_UNKNOWN", "generationId": "generation_123", "message": "secret https://private.example/?token=hidden", "outputUrl": "https://private.example/?sig=hidden" })).unwrap(), content_type: None, location: None, retry_after: None };
        let error = parse_response(response, "Sync").unwrap_err();
        assert_eq!(error["providerTaskId"], "generation_123");
        assert_eq!(error["providerErrorCode"], "IDEMPOTENCY_OUTCOME_UNKNOWN");
        assert_eq!(error["code"], "SUBMISSION_UNKNOWN");
        assert_eq!(error["providerStatus"], 503);
        let encoded = error.to_string();
        assert!(
            !encoded.contains("token")
                && !encoded.contains("private.example")
                && !encoded.contains("hidden")
        );
    }

    #[test]
    fn http_errors_preserve_only_numeric_status_for_safe_poll_retry_classification() {
        for status in [400, 429, 500, 503] {
            let response = provider_http::RawHttpResponse {
                status,
                body: b"private body https://output.example/?sig=hidden".to_vec(),
                content_type: None,
                location: None,
                retry_after: None,
            };
            let error = parse_response(response, "Sync").unwrap_err();
            assert_eq!(error["providerStatus"], status);
            assert_eq!(
                error["code"],
                if status == 429 {
                    "RATE_LIMITED"
                } else {
                    "PROVIDER_FAILED"
                }
            );
            assert!(!error.to_string().contains("hidden"));
            assert!(!error.to_string().contains("output.example"));
        }
        let error = transport_error(
            JsonHttpError::dubbing_test_error(JsonHttpErrorKind::Transport, true, Some(503)),
            &DubbingCancellation::default(),
            false,
        );
        assert_eq!(error["providerStatus"], 503);
    }

    #[test]
    fn submission_errors_distinguish_known_rejections_and_unknown_network_outcomes() {
        let flag = DubbingCancellation::default();
        for (kind, sent, status, expected) in [
            (
                JsonHttpErrorKind::Transport,
                false,
                None,
                "REQUEST_NOT_SENT",
            ),
            (
                JsonHttpErrorKind::Admission,
                false,
                None,
                "REQUEST_NOT_SENT",
            ),
            (
                JsonHttpErrorKind::Transport,
                true,
                None,
                "SUBMISSION_UNKNOWN",
            ),
            (
                JsonHttpErrorKind::ResponseTooLarge,
                true,
                None,
                "SUBMISSION_UNKNOWN",
            ),
            (JsonHttpErrorKind::Timeout, true, None, "TIMEOUT"),
            (
                JsonHttpErrorKind::Transport,
                true,
                Some(401),
                "AUTHENTICATION_FAILED",
            ),
            (
                JsonHttpErrorKind::Transport,
                true,
                Some(429),
                "RATE_LIMITED",
            ),
            (
                JsonHttpErrorKind::Transport,
                true,
                Some(503),
                "PROVIDER_FAILED",
            ),
        ] {
            assert_eq!(
                transport_error(
                    JsonHttpError::dubbing_test_error(kind, sent, status),
                    &flag,
                    true
                )["code"],
                expected
            );
        }
        flag.cancel();
        assert_eq!(
            transport_error(
                JsonHttpError::dubbing_test_error(JsonHttpErrorKind::Transport, true, None),
                &flag,
                true
            )["code"],
            "INTERRUPTED"
        );
        assert_eq!(
            transport_error(
                JsonHttpError::dubbing_test_error(JsonHttpErrorKind::Transport, false, None),
                &flag,
                true
            )["code"],
            "REQUEST_NOT_SENT"
        );
    }
}

impl Read for MultipartReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while let Some(part) = self.parts.get_mut(self.index) {
            let read = match part {
                MultipartPart::Bytes(cursor) => cursor.read(buffer)?,
                MultipartPart::File(file) => file.read(buffer)?,
            };
            if read > 0 {
                return Ok(read);
            }
            self.index += 1;
        }
        Ok(0)
    }
}

#[derive(Clone, Copy)]
enum MediaKind {
    Audio,
    Video,
}

fn validate_relative(relative: &str, output: bool, extension: &str) -> Result<(), Value> {
    let parts = relative.split('/').collect::<Vec<_>>();
    if relative.len() > 512
        || relative.contains(['\\', ':', '\0'])
        || parts.len() < 3
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.ends_with(['.', ' '])
                || part.chars().any(char::is_control)
        })
        || relative.contains(['<', '>', '"', '|', '?', '*'])
        || parts.iter().any(|part| {
            let name = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (name.len() == 4
                    && (name.starts_with("COM") || name.starts_with("LPT"))
                    && name.as_bytes()[3].is_ascii_digit())
        })
        || (output && (!relative.starts_with("cache/dubbing/") || !relative.ends_with(extension)))
        || (!output
            && !(relative.starts_with("cache/dubbing/")
                || relative.starts_with("assets/audio/")
                || relative.starts_with("assets/videos/")))
    {
        return Err(invalid(
            "Dubbing media path is outside the controlled project directories",
        ));
    }
    Ok(())
}

struct ProjectFiles {
    root: PathBuf,
    _root_handle: File,
}
struct OutputFile {
    file: ManuallyDrop<File>,
    path: PathBuf,
    _parent_handles: Vec<File>,
    committed: bool,
}

impl Drop for OutputFile {
    fn drop(&mut self) {
        // Close the exclusive output handle exactly once before removing partial data.
        unsafe { ManuallyDrop::drop(&mut self.file) };
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Write for OutputFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let final_path = final_handle_path(&self.file).map_err(|_| {
            std::io::Error::other("Dubbing output handle path could not be verified")
        })?;
        let directory = final_path
            .parent()
            .ok_or_else(|| std::io::Error::other("Dubbing output directory is unavailable"))?;
        let free_bytes = available_disk_bytes(directory)?;
        check_disk_capacity(free_bytes, bytes.len() as u64)?;
        self.file.write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn check_disk_capacity(free_bytes: u64, next_bytes: u64) -> std::io::Result<()> {
    if free_bytes < next_bytes.saturating_add(DISK_RESERVE_BYTES) {
        Err(std::io::Error::other(
            "Dubbing output has insufficient free disk space",
        ))
    } else {
        Ok(())
    }
}

fn available_disk_bytes(directory: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let directory = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            directory.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(std::io::Error::other(
            "Dubbing free disk space could not be verified",
        ))
    } else {
        Ok(available)
    }
}

impl ProjectFiles {
    fn open(root: &str) -> Result<Self, Value> {
        let path = Path::new(root);
        if !path.is_absolute() || !path.is_dir() {
            return Err(invalid("Project media root is unavailable"));
        }
        let handle = open_directory(path)?;
        let canonical = final_handle_path(&handle)?;
        if !canonical.join("project.sqlite").is_file() {
            return Err(invalid("Dubbing requires a current project root"));
        }
        Ok(Self {
            root: canonical,
            _root_handle: handle,
        })
    }

    fn parents(&self, relative: &str) -> Result<Vec<File>, Value> {
        let mut current = self.root.clone();
        let parts = relative.split('/').collect::<Vec<_>>();
        let mut handles = Vec::new();
        for part in &parts[..parts.len() - 1] {
            current.push(part);
            let handle = open_directory(&current)?;
            if !final_handle_path(&handle)?.starts_with(&self.root) {
                return Err(invalid("Dubbing path escapes the current project"));
            }
            handles.push(handle);
        }
        Ok(handles)
    }

    fn input(&self, relative: &str, kind: MediaKind) -> Result<File, Value> {
        validate_relative(relative, false, "")?;
        let _parents = self.parents(relative)?;
        let path = self.root.join(relative);
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| invalid("Dubbing input file is unavailable or in use"))?;
        verify_file(&file, &self.root)?;
        let mime = inspect_media(&mut file, kind)?;
        let valid_extension = match mime {
            "audio/wav" => relative.ends_with(".wav"),
            "audio/mpeg" => relative.ends_with(".mp3"),
            "video/mp4" => relative.ends_with(".mp4"),
            _ => false,
        };
        if !valid_extension {
            return Err(invalid(
                "Dubbing input extension does not match its media content",
            ));
        }
        Ok(file)
    }

    fn output(&self, relative: &str, extension: &str) -> Result<OutputFile, Value> {
        validate_relative(relative, true, extension)?;
        let handles = self.parents(relative)?;
        let path = self.root.join(relative);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(SHARE_READ)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| {
                invalid("Dubbing output cannot be created; outputs never overwrite existing files")
            })?;
        verify_file(&file, &self.root)?;
        Ok(OutputFile {
            file: ManuallyDrop::new(file),
            path,
            _parent_handles: handles,
            committed: false,
        })
    }
}

/// Open an input by controlled cache handle and retain an exclusive-to-writers file lease.
pub(crate) fn open_model_input(root: &Path, relative: &str) -> Result<File, String> {
    if !root.is_absolute()
        || !relative.starts_with("cache/media-inputs/")
        || relative.contains("..")
        || relative.contains(['\\', ':', '\0'])
    {
        return Err("Invalid model input handle".into());
    }
    let directory = open_directory(root).map_err(|_| "Model input directory unavailable")?;
    let root = final_handle_path(&directory).map_err(|_| "Model input directory unavailable")?;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(root.join(relative))
        .map_err(|_| "Model input file unavailable")?;
    verify_file(&file, &root).map_err(|_| "Model input escapes its controlled directory")?;
    Ok(file)
}

fn open_directory(path: &Path) -> Result<File, Value> {
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ)
        .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| invalid("Dubbing media directory is unavailable or in use"))?;
    let metadata = handle
        .metadata()
        .map_err(|_| invalid("Dubbing media directory is unavailable"))?;
    if !metadata.is_dir() || metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err(invalid(
            "Dubbing media directories cannot be symlinks or junctions",
        ));
    }
    Ok(handle)
}

fn final_handle_path(file: &File) -> Result<PathBuf, Value> {
    let mut buffer = vec![0_u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if size == 0 || size as usize >= buffer.len() {
        return Err(invalid("Dubbing file handle path could not be verified"));
    }
    String::from_utf16(&buffer[..size as usize])
        .map(PathBuf::from)
        .map_err(|_| invalid("Dubbing file handle path is invalid"))
}

fn verify_file(file: &File, root: &Path) -> Result<(), Value> {
    let metadata = file
        .metadata()
        .map_err(|_| invalid("Dubbing file metadata is unavailable"))?;
    if !metadata.is_file()
        || metadata.file_attributes() & REPARSE_POINT != 0
        || !final_handle_path(file)?.starts_with(root)
    {
        return Err(invalid("Dubbing file escapes the project or is a symlink"));
    }
    Ok(())
}

fn inspect_media(file: &mut File, kind: MediaKind) -> Result<&'static str, Value> {
    let size = file
        .metadata()
        .map_err(|_| invalid("Dubbing media metadata is unavailable"))?
        .len();
    let limit = match kind {
        MediaKind::Audio => AUDIO_LIMIT,
        MediaKind::Video => VIDEO_LIMIT,
    };
    if size < 12 || size > limit {
        return Err(invalid(
            "Dubbing media is empty, truncated or exceeds the size limit",
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid("Dubbing media could not be read"))?;
    let mut bytes = [0_u8; 12];
    file.read_exact(&mut bytes)
        .map_err(|_| invalid("Dubbing media is truncated"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid("Dubbing media could not be read"))?;
    match kind {
        MediaKind::Audio if &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" => Ok("audio/wav"),
        MediaKind::Audio
            if &bytes[..3] == b"ID3" || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0) =>
        {
            Ok("audio/mpeg")
        }
        MediaKind::Video if &bytes[4..8] == b"ftyp" => Ok("video/mp4"),
        _ => Err(invalid(
            "Dubbing media content is not an allowed MP3, WAV or MP4",
        )),
    }
}
