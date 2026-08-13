use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use windows_sys::Win32::{
    Foundation::GetLastError,
    Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_DISABLE_REDIRECTS,
        WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_QUERY_STATUS_CODE,
    },
};

use super::{
    credential_store::{credential_read, ensure_credential_subject, CredentialSecret},
    WorkerState,
};

const REQUEST_BODY_LIMIT: usize = 4 * 1024 * 1024;
const ERROR_BODY_LIMIT: usize = 64 * 1024;
const STREAM_BUFFER_LIMIT: usize = 2 * 1024 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlmStreamStart {
    generation_id: String,
    attempt_id: String,
    project_id: String,
    conversation_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmRuntimeRequest {
    generation_id: String,
    attempt_id: String,
    project_id: String,
    conversation_id: String,
    provider_profile_id: String,
    model_id: String,
    remote_model_id: String,
    protocol: String,
    base_url: String,
    system_instruction: String,
    context: String,
    prompt: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderReportedCost {
    amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormalizedUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_reported_cost: Option<ProviderReportedCost>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LlmStreamEvent {
    Started,
    Delta {
        delta: String,
    },
    Complete {
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_response_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<NormalizedUsage>,
    },
    Failed {
        error: String,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<NormalizedUsage>,
    },
    Cancelled,
}

#[derive(Default)]
pub(crate) struct LlmStreamState {
    active: Mutex<HashMap<String, Arc<LlmCancellation>>>,
}

impl LlmStreamState {
    fn register(&self, attempt_id: &str) -> Result<Arc<LlmCancellation>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "LLM stream registry lock is poisoned".to_string())?;
        if active.contains_key(attempt_id) {
            return Err("The LLM attempt is already streaming.".to_string());
        }
        let cancellation = Arc::new(LlmCancellation::default());
        active.insert(attempt_id.to_string(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    fn unregister(&self, attempt_id: &str, cancellation: &Arc<LlmCancellation>) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .get(attempt_id)
                .is_some_and(|current| Arc::ptr_eq(current, cancellation))
            {
                active.remove(attempt_id);
            }
        }
    }

    fn cancel(&self, attempt_id: &str) -> bool {
        let cancellation = self
            .active
            .lock()
            .ok()
            .and_then(|active| active.get(attempt_id).cloned());
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct LlmCancellation {
    cancelled: AtomicBool,
    request_handle: AtomicUsize,
}

impl LlmCancellation {
    fn attach(&self, handle: *mut core::ffi::c_void) {
        self.request_handle
            .store(handle as usize, Ordering::Release);
        if self.cancelled.load(Ordering::Acquire) {
            self.close_request();
        }
    }

    fn request(&self) -> Result<*mut core::ffi::c_void, StreamFailure> {
        let handle = self.request_handle.load(Ordering::Acquire);
        if handle == 0 || self.cancelled.load(Ordering::Acquire) {
            Err(StreamFailure::cancelled())
        } else {
            Ok(handle as *mut core::ffi::c_void)
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.close_request();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn close_request(&self) {
        let handle = self.request_handle.swap(0, Ordering::AcqRel);
        if handle != 0 {
            unsafe {
                WinHttpCloseHandle(handle as *mut core::ffi::c_void);
            }
        }
    }
}

struct RequestGuard(Arc<LlmCancellation>);

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.close_request();
    }
}

#[derive(Clone, Debug, PartialEq)]
struct StreamFailure {
    message: String,
    retryable: bool,
    cancelled: bool,
    usage: Option<NormalizedUsage>,
}

impl StreamFailure {
    fn new(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            message: sanitize_error(&message.into()),
            retryable,
            cancelled: false,
            usage: None,
        }
    }

    fn cancelled() -> Self {
        Self {
            message: "Generation was cancelled.".to_string(),
            retryable: true,
            cancelled: true,
            usage: None,
        }
    }
}

struct WinHttpHandle(*mut core::ffi::c_void);

impl WinHttpHandle {
    fn new(handle: *mut core::ffi::c_void, operation: &str) -> Result<Self, StreamFailure> {
        if handle.is_null() {
            Err(StreamFailure::new(winhttp_error(operation), true))
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

#[derive(Clone, Debug)]
struct ProviderEndpoint {
    host: String,
    port: u16,
    secure: bool,
    base_path: String,
}

impl ProviderEndpoint {
    fn path(&self, suffix: &str) -> String {
        if self.base_path.is_empty() {
            format!("/{suffix}")
        } else {
            format!("/{}/{suffix}", self.base_path)
        }
    }
}

#[tauri::command]
pub(crate) async fn llm_stream(
    request: LlmStreamStart,
    on_event: Channel<LlmStreamEvent>,
    worker: tauri::State<'_, WorkerState>,
    streams: tauri::State<'_, LlmStreamState>,
) -> Result<(), String> {
    let runtime = match resolve_runtime(&request, &worker) {
        Ok(runtime) => runtime,
        Err(error) => {
            send_failure(&on_event, StreamFailure::new(error, false))?;
            return Ok(());
        }
    };
    if let Err(error) = ensure_credential_subject(&runtime.provider_profile_id, &worker) {
        send_failure(&on_event, StreamFailure::new(error, false))?;
        return Ok(());
    }
    let secret = match credential_read(&runtime.provider_profile_id) {
        Ok(secret) => secret,
        Err(_) => {
            send_failure(
                &on_event,
                StreamFailure::new("Provider credential is not configured.", false),
            )?;
            return Ok(());
        }
    };
    let cancellation = match streams.register(&runtime.attempt_id) {
        Ok(cancellation) => cancellation,
        Err(error) => {
            send_failure(&on_event, StreamFailure::new(error, false))?;
            return Ok(());
        }
    };
    let attempt_id = runtime.attempt_id.clone();
    let native_cancellation = Arc::clone(&cancellation);
    let native_channel = on_event.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        stream_provider(runtime, secret, native_cancellation, native_channel, false)
    })
    .await
    .map_err(|_| "LLM stream task could not be joined".to_string());
    streams.unregister(&attempt_id, &cancellation);

    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => send_failure(&on_event, error),
        Err(error) => send_failure(&on_event, StreamFailure::new(error, true)),
    }
}

#[tauri::command]
pub(crate) fn llm_stream_cancel(
    attempt_id: String,
    streams: tauri::State<'_, LlmStreamState>,
) -> bool {
    streams.cancel(&attempt_id)
}

fn resolve_runtime(
    request: &LlmStreamStart,
    worker: &WorkerState,
) -> Result<LlmRuntimeRequest, String> {
    let response = worker.request(&serde_json::json!({
        "id": format!("llm-runtime-{}", request.attempt_id),
        "protocolVersion": 1,
        "method": "llm.generation.runtime",
        "params": request,
    }))?;
    let result = worker_result(response)?;
    let runtime: LlmRuntimeRequest = serde_json::from_value(result)
        .map_err(|_| "Worker returned an invalid LLM runtime request".to_string())?;
    if runtime.generation_id != request.generation_id
        || runtime.attempt_id != request.attempt_id
        || runtime.project_id != request.project_id
        || runtime.conversation_id != request.conversation_id
    {
        return Err("Worker returned a mismatched LLM runtime request".to_string());
    }
    Ok(runtime)
}

fn stream_provider(
    runtime: LlmRuntimeRequest,
    secret: CredentialSecret,
    cancellation: Arc<LlmCancellation>,
    channel: Channel<LlmStreamEvent>,
    allow_http_for_test: bool,
) -> Result<(), StreamFailure> {
    if cancellation.is_cancelled() {
        return Err(StreamFailure::cancelled());
    }
    if runtime.model_id.trim().is_empty() {
        return Err(StreamFailure::new("Provider model ID is invalid.", false));
    }
    let endpoint = parse_base_url(&runtime.base_url, allow_http_for_test)?;
    let suffix = match runtime.protocol.as_str() {
        "openai-responses" => "responses",
        "openai-chat-completions" => "chat/completions",
        _ => {
            return Err(StreamFailure::new(
                "The selected provider protocol does not support LLM streaming.",
                false,
            ))
        }
    };
    let body = build_request_body(&runtime)?;
    if body.len() > REQUEST_BODY_LIMIT {
        return Err(StreamFailure::new(
            "LLM request exceeds the native transport limit.",
            false,
        ));
    }
    let secret = secret
        .as_str()
        .map_err(|message| StreamFailure::new(message, false))?;

    let agent = wide("unicomp/0.1");
    let host = wide(&endpoint.host);
    let verb = wide("POST");
    let path_value = endpoint.path(suffix);
    let path = wide(&path_value);
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
        "Unable to initialize LLM transport",
    )?;
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 30_000) } == 0 {
        return Err(StreamFailure::new(
            winhttp_error("Unable to configure LLM timeouts"),
            true,
        ));
    }
    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.0, host.as_ptr(), endpoint.port, 0) },
        "Unable to connect LLM transport",
    )?;
    let flags = if endpoint.secure {
        WINHTTP_FLAG_SECURE
    } else {
        0
    };
    let request_handle = unsafe {
        WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            flags,
        )
    };
    if request_handle.is_null() {
        return Err(StreamFailure::new(
            winhttp_error("Unable to create LLM request"),
            true,
        ));
    }
    cancellation.attach(request_handle);
    let _request_guard = RequestGuard(Arc::clone(&cancellation));
    let disabled_features = WINHTTP_DISABLE_REDIRECTS;
    if unsafe {
        WinHttpSetOption(
            cancellation.request()?,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disabled_features as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(transport_failure(
            &cancellation,
            "Unable to disable LLM redirects",
        ));
    }

    let mut headers: Vec<u16> = "Accept: text/event-stream\r\nAuthorization: Bearer "
        .encode_utf16()
        .collect();
    headers.extend(secret.encode_utf16());
    headers.extend("\r\nContent-Type: application/json\r\n".encode_utf16());
    let sent = unsafe {
        WinHttpSendRequest(
            cancellation.request()?,
            headers.as_ptr(),
            headers.len() as u32,
            body.as_ptr().cast(),
            body.len() as u32,
            body.len() as u32,
            0,
        )
    };
    headers.fill(0);
    if sent == 0 {
        return Err(transport_failure(
            &cancellation,
            "LLM request could not be sent",
        ));
    }
    if unsafe { WinHttpReceiveResponse(cancellation.request()?, std::ptr::null_mut()) } == 0 {
        return Err(transport_failure(
            &cancellation,
            "LLM response headers could not be received",
        ));
    }
    let status = query_status(cancellation.request()?)?;
    if !(200..=299).contains(&status) {
        let error_body = read_bounded_body(&cancellation, ERROR_BODY_LIMIT)?;
        return Err(classify_http_error(status, &error_body));
    }

    channel
        .send(LlmStreamEvent::Started)
        .map_err(|_| StreamFailure::cancelled())?;
    let started_at = Instant::now();
    let mut parser = SseParser::new(&runtime.protocol);
    loop {
        if cancellation.is_cancelled() {
            return Err(StreamFailure::cancelled());
        }
        if started_at.elapsed() > TOTAL_TIMEOUT {
            return Err(StreamFailure::new(
                "LLM stream exceeded the total timeout.",
                true,
            ));
        }
        let mut chunk = [0_u8; 8192];
        let mut read = 0_u32;
        if unsafe {
            WinHttpReadData(
                cancellation.request()?,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(transport_failure(
                &cancellation,
                "LLM response stream could not be read",
            ));
        }
        if read == 0 {
            break;
        }
        parser.feed(&chunk[..read as usize], |event| {
            channel.send(event).map_err(|_| StreamFailure::cancelled())
        })?;
    }
    let completed =
        parser.finish(|event| channel.send(event).map_err(|_| StreamFailure::cancelled()))?;
    channel
        .send(LlmStreamEvent::Complete {
            provider_response_id: completed.provider_response_id,
            finish_reason: completed.finish_reason,
            usage: completed.usage,
        })
        .map_err(|_| StreamFailure::cancelled())?;
    Ok(())
}

fn build_request_body(runtime: &LlmRuntimeRequest) -> Result<Vec<u8>, StreamFailure> {
    let context = format!(
        "# Project context\n\n{}\n\n# User request\n\n{}",
        runtime.context, runtime.prompt
    );
    let value = if runtime.protocol == "openai-responses" {
        serde_json::json!({
            "model": runtime.remote_model_id,
            "instructions": runtime.system_instruction,
            "input": context,
            "store": false,
            "stream": true
        })
    } else {
        let system = if runtime.context.trim().is_empty() {
            runtime.system_instruction.clone()
        } else {
            format!(
                "{}\n\n# Project context\n\n{}",
                runtime.system_instruction, runtime.context
            )
        };
        serde_json::json!({
            "model": runtime.remote_model_id,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": runtime.prompt }
            ],
            "stream": true,
            "stream_options": { "include_usage": true }
        })
    };
    serde_json::to_vec(&value)
        .map_err(|_| StreamFailure::new("LLM request could not be serialized.", false))
}

fn parse_base_url(
    value: &str,
    allow_http_for_test: bool,
) -> Result<ProviderEndpoint, StreamFailure> {
    if !value.is_ascii() || value.chars().any(char::is_control) || value.contains(['?', '#', '\\'])
    {
        return Err(StreamFailure::new(
            "Provider Base URL contains unsupported characters.",
            false,
        ));
    }
    let (remainder, secure) = if let Some(remainder) = value.strip_prefix("https://") {
        (remainder, true)
    } else if allow_http_for_test {
        value
            .strip_prefix("http://")
            .map(|remainder| (remainder, false))
            .ok_or_else(|| StreamFailure::new("Provider Base URL must use HTTPS.", false))?
    } else {
        return Err(StreamFailure::new(
            "Provider Base URL must use HTTPS.",
            false,
        ));
    };
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, ""), |(authority, path)| (authority, path));
    if authority.is_empty() || authority.contains('@') || authority.starts_with('[') {
        return Err(StreamFailure::new(
            "Provider Base URL authority is invalid.",
            false,
        ));
    }
    let default_port = if secure { 443 } else { 80 };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port
                .parse::<u16>()
                .map_err(|_| StreamFailure::new("Provider Base URL port is invalid.", false))?;
            if port == 0 {
                return Err(StreamFailure::new(
                    "Provider Base URL port is invalid.",
                    false,
                ));
            }
            (host, port)
        }
        None => (authority, default_port),
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
        return Err(StreamFailure::new(
            "Provider Base URL host is invalid.",
            false,
        ));
    }
    let base_path = path.trim_matches('/');
    if base_path.split('/').any(|segment| segment == "..")
        || base_path.to_ascii_lowercase().contains("%2e")
    {
        return Err(StreamFailure::new(
            "Provider Base URL path cannot contain parent traversal.",
            false,
        ));
    }
    Ok(ProviderEndpoint {
        host: host.to_ascii_lowercase(),
        port,
        secure,
        base_path: base_path.to_string(),
    })
}

fn query_status(request: *mut core::ffi::c_void) -> Result<u32, StreamFailure> {
    let mut status = 0_u32;
    let mut status_size = std::mem::size_of::<u32>() as u32;
    let mut header_index = 0_u32;
    if unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut status_size,
            &mut header_index,
        )
    } == 0
    {
        Err(StreamFailure::new(
            winhttp_error("LLM response status could not be read"),
            true,
        ))
    } else {
        Ok(status)
    }
}

fn read_bounded_body(
    cancellation: &LlmCancellation,
    limit: usize,
) -> Result<Vec<u8>, StreamFailure> {
    let mut response = Vec::new();
    loop {
        let mut chunk = [0_u8; 4096];
        let mut read = 0_u32;
        if unsafe {
            WinHttpReadData(
                cancellation.request()?,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(transport_failure(
                cancellation,
                "LLM error response could not be read",
            ));
        }
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read as usize]);
        if response.len() > limit {
            response.truncate(limit);
            break;
        }
    }
    Ok(response)
}

fn classify_http_error(status: u32, body: &[u8]) -> StreamFailure {
    let provider_message = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .map(sanitize_error)
        });
    let fallback = match status {
        401 | 403 => "Provider rejected the configured credential.".to_string(),
        429 => "Provider rate-limited the LLM request.".to_string(),
        500..=599 => format!("Provider returned HTTP {status}."),
        _ => format!("LLM request failed with HTTP {status}."),
    };
    StreamFailure::new(
        provider_message
            .filter(|message| !message.is_empty())
            .unwrap_or(fallback),
        status == 408 || status == 429 || status >= 500,
    )
}

fn transport_failure(cancellation: &LlmCancellation, operation: &str) -> StreamFailure {
    if cancellation.is_cancelled() {
        StreamFailure::cancelled()
    } else {
        StreamFailure::new(winhttp_error(operation), true)
    }
}

#[derive(Debug, Default)]
struct CompletedStream {
    provider_response_id: Option<String>,
    finish_reason: Option<String>,
    usage: Option<NormalizedUsage>,
}

struct SseParser {
    protocol: String,
    buffer: Vec<u8>,
    completed: bool,
    provider_response_id: Option<String>,
    finish_reason: Option<String>,
    usage: Option<NormalizedUsage>,
}

impl SseParser {
    fn new(protocol: &str) -> Self {
        Self {
            protocol: protocol.to_string(),
            buffer: Vec::new(),
            completed: false,
            provider_response_id: None,
            finish_reason: None,
            usage: None,
        }
    }

    fn feed<F>(&mut self, chunk: &[u8], mut emit: F) -> Result<(), StreamFailure>
    where
        F: FnMut(LlmStreamEvent) -> Result<(), StreamFailure>,
    {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > STREAM_BUFFER_LIMIT {
            return Err(StreamFailure::new(
                "LLM stream event exceeds the parser limit.",
                false,
            ));
        }
        while let Some((position, delimiter_length)) = event_boundary(&self.buffer) {
            let event = self.buffer[..position].to_vec();
            self.buffer.drain(..position + delimiter_length);
            self.parse_event(&event, &mut emit)?;
        }
        Ok(())
    }

    fn finish<F>(mut self, mut emit: F) -> Result<CompletedStream, StreamFailure>
    where
        F: FnMut(LlmStreamEvent) -> Result<(), StreamFailure>,
    {
        if !self.buffer.iter().all(u8::is_ascii_whitespace) {
            let final_event = std::mem::take(&mut self.buffer);
            self.parse_event(&final_event, &mut emit)?;
        }
        if !self.completed {
            return Err(StreamFailure::new(
                "LLM stream ended before a protocol success event.",
                true,
            ));
        }
        Ok(CompletedStream {
            provider_response_id: self.provider_response_id,
            finish_reason: self.finish_reason,
            usage: self.usage,
        })
    }

    fn parse_event<F>(&mut self, event: &[u8], emit: &mut F) -> Result<(), StreamFailure>
    where
        F: FnMut(LlmStreamEvent) -> Result<(), StreamFailure>,
    {
        let event = std::str::from_utf8(event)
            .map_err(|_| StreamFailure::new("LLM stream contains invalid UTF-8.", false))?;
        let normalized = event.replace("\r\n", "\n");
        let data = normalized
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("");
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            if self.protocol == "openai-chat-completions" {
                self.completed = true;
            }
            return Ok(());
        }
        let value: serde_json::Value = serde_json::from_str(&data)
            .map_err(|_| StreamFailure::new("LLM stream returned invalid JSON.", false))?;
        if let Some(message) = value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .and_then(serde_json::Value::as_str)
        {
            if value.get("error").is_some()
                || value.get("type").and_then(serde_json::Value::as_str) == Some("error")
            {
                return Err(StreamFailure::new(message, true));
            }
        }
        if self.protocol == "openai-responses" {
            self.parse_responses_event(&value, emit)
        } else {
            self.parse_chat_event(&value, emit)
        }
    }

    fn parse_responses_event<F>(
        &mut self,
        value: &serde_json::Value,
        emit: &mut F,
    ) -> Result<(), StreamFailure>
    where
        F: FnMut(LlmStreamEvent) -> Result<(), StreamFailure>,
    {
        let event_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if let Some(id) = value
            .pointer("/response/id")
            .and_then(serde_json::Value::as_str)
        {
            self.provider_response_id = normalize_optional(id, 256);
        }
        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(serde_json::Value::as_str) {
                    if !delta.is_empty() {
                        emit(LlmStreamEvent::Delta {
                            delta: delta.to_string(),
                        })?;
                    }
                }
            }
            "response.completed" => {
                self.completed = true;
                self.finish_reason = Some("completed".to_string());
                self.usage = value
                    .pointer("/response/usage")
                    .and_then(parse_responses_usage);
            }
            "response.failed" | "response.incomplete" => {
                let message = value
                    .pointer("/response/error/message")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("LLM stream ended with {event_type}."));
                let mut failure = StreamFailure::new(message, true);
                failure.usage = value
                    .pointer("/response/usage")
                    .and_then(parse_responses_usage);
                return Err(failure);
            }
            _ => {}
        }
        Ok(())
    }

    fn parse_chat_event<F>(
        &mut self,
        value: &serde_json::Value,
        emit: &mut F,
    ) -> Result<(), StreamFailure>
    where
        F: FnMut(LlmStreamEvent) -> Result<(), StreamFailure>,
    {
        if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
            self.provider_response_id = normalize_optional(id, 256);
        }
        if let Some(usage) = value.get("usage").and_then(parse_chat_usage) {
            self.usage = Some(usage);
        }
        if let Some(choices) = value.get("choices").and_then(serde_json::Value::as_array) {
            for choice in choices {
                if let Some(delta) = choice
                    .pointer("/delta/content")
                    .and_then(serde_json::Value::as_str)
                {
                    if !delta.is_empty() {
                        emit(LlmStreamEvent::Delta {
                            delta: delta.to_string(),
                        })?;
                    }
                }
                if let Some(reason) = choice
                    .get("finish_reason")
                    .and_then(serde_json::Value::as_str)
                {
                    self.finish_reason = normalize_optional(reason, 80);
                }
            }
        }
        Ok(())
    }
}

fn parse_responses_usage(value: &serde_json::Value) -> Option<NormalizedUsage> {
    usage_if_present(NormalizedUsage {
        input_tokens: value
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64),
        cached_input_tokens: value
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(serde_json::Value::as_u64),
        output_tokens: value
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64),
        reasoning_tokens: value
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(serde_json::Value::as_u64),
        total_tokens: value
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64),
        provider_reported_cost: parse_provider_reported_cost(value),
    })
}

fn parse_chat_usage(value: &serde_json::Value) -> Option<NormalizedUsage> {
    usage_if_present(NormalizedUsage {
        input_tokens: value
            .get("prompt_tokens")
            .and_then(serde_json::Value::as_u64),
        cached_input_tokens: value
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(serde_json::Value::as_u64),
        output_tokens: value
            .get("completion_tokens")
            .and_then(serde_json::Value::as_u64),
        reasoning_tokens: value
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(serde_json::Value::as_u64),
        total_tokens: value
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64),
        provider_reported_cost: parse_provider_reported_cost(value),
    })
}

fn parse_provider_reported_cost(value: &serde_json::Value) -> Option<ProviderReportedCost> {
    let amount = value
        .get("cost")
        .or_else(|| value.get("total_cost"))
        .or_else(|| value.pointer("/cost_details/total_cost"))
        .and_then(normalize_reported_decimal)?;
    let currency = value
        .get("currency")
        .or_else(|| value.pointer("/cost_details/currency"))
        .and_then(serde_json::Value::as_str)
        .and_then(normalize_reported_currency);
    Some(ProviderReportedCost { amount, currency })
}

fn normalize_reported_decimal(value: &serde_json::Value) -> Option<String> {
    let rendered = if let Some(value) = value.as_str() {
        value.trim().to_string()
    } else {
        let value = value.as_f64()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        format!("{value:.12}")
    };
    if rendered.is_empty() || rendered.len() > 64 || !rendered.is_ascii() {
        return None;
    }
    let (integer, fraction) = rendered
        .split_once('.')
        .map_or((rendered.as_str(), None), |(integer, fraction)| {
            (integer, Some(fraction))
        });
    if integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || fraction
            .is_some_and(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let fraction = fraction.unwrap_or_default().trim_end_matches('0');
    Some(if fraction.is_empty() {
        integer.to_string()
    } else {
        format!("{integer}.{fraction}")
    })
}

fn normalize_reported_currency(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() >= 3
        && value.len() <= 8
        && value.is_ascii()
        && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
    .then(|| value.to_ascii_uppercase())
}

fn usage_if_present(usage: NormalizedUsage) -> Option<NormalizedUsage> {
    if usage.input_tokens.is_some()
        || usage.cached_input_tokens.is_some()
        || usage.output_tokens.is_some()
        || usage.reasoning_tokens.is_some()
        || usage.total_tokens.is_some()
        || usage.provider_reported_cost.is_some()
    {
        Some(usage)
    } else {
        None
    }
}

fn event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(left), None) => Some((left, 2)),
        (None, Some(right)) => Some((right, 4)),
        (None, None) => None,
    }
}

fn worker_result(response: serde_json::Value) -> Result<serde_json::Value, String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return response
            .get("result")
            .cloned()
            .ok_or("Worker response is missing a result".to_string());
    }
    Err(response
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .map(sanitize_error)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "Worker rejected the LLM runtime request".to_string()))
}

fn send_failure(channel: &Channel<LlmStreamEvent>, failure: StreamFailure) -> Result<(), String> {
    let event = if failure.cancelled {
        LlmStreamEvent::Cancelled
    } else {
        LlmStreamEvent::Failed {
            error: failure.message,
            retryable: failure.retryable,
            usage: failure.usage,
        }
    };
    channel
        .send(event)
        .map_err(|_| "LLM event channel is unavailable".to_string())
}

fn normalize_optional(value: &str, limit: usize) -> Option<String> {
    let value = sanitize_error(value);
    let value: String = value.chars().take(limit).collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn sanitize_error(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if matches!(character, '\r' | '\n' | '\0') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(500)
        .collect()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn winhttp_error(operation: &str) -> String {
    format!("{operation} (Windows error {})", unsafe { GetLastError() })
}

#[cfg(test)]
mod tests {
    use super::{
        event_boundary, parse_base_url, stream_provider, LlmCancellation, LlmRuntimeRequest,
        LlmStreamEvent, LlmStreamState, NormalizedUsage, ProviderReportedCost, SseParser,
    };
    use crate::credential_store::CredentialSecret;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };
    use tauri::ipc::Channel;

    #[test]
    fn parses_responses_deltas_usage_and_requires_completion() {
        let mut parser = SseParser::new("openai-responses");
        let mut events = Vec::new();
        parser
            .feed(
                b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"total_tokens\":14,\"cost\":\"0.00120\",\"currency\":\"usd\"}}}\n\n",
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .expect("responses stream should parse");
        let completed = parser
            .finish(|_| Ok(()))
            .expect("completion should be accepted");
        assert_eq!(
            events,
            vec![LlmStreamEvent::Delta {
                delta: "hello".to_string()
            }]
        );
        assert_eq!(completed.provider_response_id.as_deref(), Some("resp_1"));
        assert_eq!(
            completed.usage,
            Some(NormalizedUsage {
                input_tokens: Some(10),
                output_tokens: Some(4),
                total_tokens: Some(14),
                provider_reported_cost: Some(ProviderReportedCost {
                    amount: "0.0012".to_string(),
                    currency: Some("USD".to_string()),
                }),
                ..NormalizedUsage::default()
            })
        );
    }

    #[test]
    fn rejects_truncated_responses_streams() {
        let mut parser = SseParser::new("openai-responses");
        parser
            .feed(
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                |_| Ok(()),
            )
            .expect("partial event should parse");
        let error = parser
            .finish(|_| Ok(()))
            .expect_err("truncated stream must fail");
        assert!(error.message.contains("before a protocol success event"));
    }

    #[test]
    fn preserves_usage_from_failed_responses_events() {
        let mut parser = SseParser::new("openai-responses");
        let failure = parser
            .feed(
                b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"mock failure\"},\"usage\":{\"input_tokens\":7,\"output_tokens\":2,\"total_tokens\":9}}}\n\n",
                |_| Ok(()),
            )
            .expect_err("failed response should terminate the stream");
        assert_eq!(
            failure.usage,
            Some(NormalizedUsage {
                input_tokens: Some(7),
                output_tokens: Some(2),
                total_tokens: Some(9),
                ..NormalizedUsage::default()
            })
        );
        let serialized = serde_json::to_value(LlmStreamEvent::Failed {
            error: failure.message,
            retryable: failure.retryable,
            usage: failure.usage,
        })
        .expect("failed event should serialize");
        assert_eq!(serialized["usage"]["totalTokens"], 9);
    }

    #[test]
    fn parses_chat_completion_done_and_usage() {
        let mut parser = SseParser::new("openai-chat-completions");
        let mut events = Vec::new();
        parser
            .feed(
                b"data: {\"id\":\"chat_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n",
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .expect("chat stream should parse");
        let completed = parser
            .finish(|_| Ok(()))
            .expect("done should complete chat stream");
        assert_eq!(
            events,
            vec![LlmStreamEvent::Delta {
                delta: "hi".to_string()
            }]
        );
        assert_eq!(completed.finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            completed.usage.and_then(|usage| usage.total_tokens),
            Some(4)
        );
    }

    #[test]
    fn validates_stream_endpoints_and_suffixes() {
        let endpoint = parse_base_url("https://api.openai.com/v1", false)
            .expect("official endpoint should parse");
        assert_eq!(endpoint.path("responses"), "/v1/responses");
        assert!(parse_base_url("http://api.openai.com/v1", false).is_err());
        assert!(parse_base_url("https://example.com/v1/../admin", false).is_err());
    }

    #[test]
    fn cancellation_registry_is_attempt_scoped() {
        let registry = LlmStreamState::default();
        let first = registry
            .register("attempt-a")
            .expect("attempt should register");
        assert!(registry.register("attempt-a").is_err());
        assert!(!registry.cancel("attempt-b"));
        assert!(registry.cancel("attempt-a"));
        assert!(first.is_cancelled());
        registry.unregister("attempt-a", &first);
        assert!(!registry.cancel("attempt-a"));
    }

    #[test]
    fn event_boundaries_handle_lf_and_crlf() {
        assert_eq!(event_boundary(b"one\n\ntwo"), Some((3, 2)));
        assert_eq!(event_boundary(b"one\r\n\r\ntwo"), Some((3, 4)));
        let cancellation = Arc::new(LlmCancellation::default());
        cancellation.cancel();
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn streams_against_a_local_mock_provider_without_exposing_the_secret_in_events() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = stream
                    .read(&mut chunk)
                    .expect("mock request should be readable");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                let Some(headers_end) = request.windows(4).position(|value| value == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..headers_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= headers_end + 4 + content_length {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer local-mock-key"));
            assert!(request.contains("\"model\":\"mock-model\""));
            let payload = concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_mock\"}}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"mock delta\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":2,\"total_tokens\":4}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            )
            .expect("mock response should be written");
        });
        let runtime = LlmRuntimeRequest {
            generation_id: "generation".to_string(),
            attempt_id: "attempt".to_string(),
            project_id: "project".to_string(),
            conversation_id: "conversation".to_string(),
            provider_profile_id: "profile".to_string(),
            model_id: "model".to_string(),
            remote_model_id: "mock-model".to_string(),
            protocol: "openai-responses".to_string(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            system_instruction: "System".to_string(),
            context: "Context".to_string(),
            prompt: "Prompt".to_string(),
        };
        let cancellation = Arc::new(LlmCancellation::default());
        let channel = Channel::new(|_| Ok(()));

        stream_provider(
            runtime,
            CredentialSecret::for_test("local-mock-key"),
            cancellation,
            channel,
            true,
        )
        .expect("mock stream should complete");
        server.join().expect("mock provider should finish");
    }
}
