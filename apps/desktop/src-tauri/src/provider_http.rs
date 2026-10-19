use std::{
    fmt,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, ToSocketAddrs},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use super::request_guard::{self, Outcome};
use windows_sys::Win32::Foundation::{GetLastError, SYSTEMTIME};
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, WinHttpTimeToSystemTime, WinHttpWriteData,
    ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED, ERROR_WINHTTP_SECURE_FAILURE, ERROR_WINHTTP_TIMEOUT,
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE,
    WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_RETRY_AFTER, WINHTTP_QUERY_STATUS_CODE,
};

pub(crate) const DEFAULT_RECEIVE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JsonHttpErrorKind {
    Admission,
    InvalidRequest,
    Timeout,
    Tls,
    Transport,
    InvalidResponse,
    ResponseTooLarge,
}

#[derive(Debug)]
pub(crate) struct JsonHttpError {
    kind: JsonHttpErrorKind,
    message: String,
    guard_outcome: Outcome,
    request_may_have_been_sent: bool,
    rejected_http_status: Option<u32>,
}

impl JsonHttpError {
    fn new(kind: JsonHttpErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            guard_outcome: Outcome::Neutral,
            request_may_have_been_sent: false,
            rejected_http_status: None,
        }
    }

    pub(crate) fn kind(&self) -> JsonHttpErrorKind {
        self.kind
    }

    pub(crate) fn request_may_have_been_sent(&self) -> bool {
        self.request_may_have_been_sent
    }

    pub(crate) fn rejected_http_status(&self) -> Option<u32> {
        self.rejected_http_status
    }

    #[cfg(test)]
    pub(crate) fn dubbing_test_error(
        kind: JsonHttpErrorKind,
        sent: bool,
        status: Option<u32>,
    ) -> Self {
        Self {
            kind,
            message: "Native fixture transport failure".into(),
            guard_outcome: Outcome::Neutral,
            request_may_have_been_sent: sent,
            rejected_http_status: status,
        }
    }

    fn with_request_sent(mut self) -> Self {
        self.request_may_have_been_sent = true;
        self
    }

    fn with_outcome(mut self, outcome: Outcome) -> Self {
        self.guard_outcome = outcome;
        self
    }
}

impl fmt::Display for JsonHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) struct JsonHttpRequest<'a> {
    pub host: &'a str,
    pub port: u16,
    pub secure: bool,
    pub method: &'a str,
    pub path: &'a str,
    pub authorization_scheme: &'a str,
    pub accept: &'a str,
    pub secret: &'a str,
    pub body: Option<&'a [u8]>,
    pub request_body_limit: usize,
    pub response_body_limit: usize,
}

#[derive(Debug)]
pub(crate) struct JsonHttpResponse {
    pub status: u32,
    pub body: serde_json::Value,
    pub retry_after_ms: Option<u64>,
}

pub(crate) struct RawHttpResponse {
    pub status: u32,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
    pub location: Option<String>,
    pub retry_after: Option<String>,
}

pub(crate) struct PublicHttpRequest<'a> {
    pub host: &'a str,
    pub path: &'a str,
    pub accept: &'a str,
    pub response_body_limit: usize,
    pub cancellation: Option<&'a AtomicBool>,
}

pub(crate) struct PublicHttpsUrl {
    pub host: String,
    pub path: String,
}

pub(crate) fn parse_public_https_url(value: &str) -> Result<PublicHttpsUrl, String> {
    let remainder = value
        .strip_prefix("https://")
        .ok_or("Public URLs must use HTTPS")?;
    if remainder.is_empty() || remainder.contains(['\\', '#', '\r', '\n', '\0', '@']) {
        return Err("Public URL is invalid".to_string());
    }
    let split = remainder.find(['/', '?']).unwrap_or(remainder.len());
    let host = &remainder[..split];
    if host.is_empty()
        || host.contains(':')
        || !host.is_ascii()
        || host
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
        || host.ends_with('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".local")
    {
        return Err("Public URL host is invalid".to_string());
    }
    let path = if split == remainder.len() {
        "/".to_string()
    } else if remainder.as_bytes()[split] == b'?' {
        format!("/{}", &remainder[split..])
    } else {
        remainder[split..].to_string()
    };
    if path.contains(['\r', '\n', '\0']) || path.starts_with("//") {
        return Err("Public URL path is invalid".to_string());
    }
    Ok(PublicHttpsUrl {
        host: host.to_ascii_lowercase(),
        path,
    })
}

pub(crate) fn assert_public_host(host: &str) -> Result<(), String> {
    let addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|_| "Public hostname could not be resolved safely".to_string())?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if addresses.is_empty() || !addresses.iter().all(is_public_address) {
        return Err("Hostname is outside the public network boundary".to_string());
    }
    Ok(())
}

/// Provider output domains can resolve through a local TUN proxy's fake-IP DNS.
/// Research requests keep the strict public-address policy above.
pub(crate) fn assert_provider_output_host(host: &str) -> Result<(), String> {
    let addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|_| format!("Provider output hostname {host} could not be resolved"))?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    validate_provider_output_addresses(host, &addresses)
}

fn validate_provider_output_addresses(host: &str, addresses: &[IpAddr]) -> Result<(), String> {
    // An exception for named Provider output domains only. Direct requests to
    // benchmark IPs, localhost, LAN addresses, or mixed unsafe answers stay blocked.
    let named_domain = host.parse::<IpAddr>().is_err()
        && host.contains('.')
        && !host.split('.').any(str::is_empty)
        && ![".local", ".localhost", ".lan", ".internal", ".home.arpa"]
            .iter()
            .any(|suffix| host.to_ascii_lowercase().ends_with(suffix));
    if !addresses.is_empty()
        && addresses.iter().all(|address| {
            is_public_address(address) || (named_domain && is_proxy_fake_ip(address))
        })
    {
        return Ok(());
    }
    let resolved = addresses
        .iter()
        .take(8)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Provider output host {host} is outside the supported network boundary ({resolved})"
    ))
}

fn is_proxy_fake_ip(address: &IpAddr) -> bool {
    let ipv4 = match address {
        IpAddr::V4(value) => Some(*value),
        IpAddr::V6(value) => value.to_ipv4_mapped(),
    };
    ipv4.is_some_and(|value| {
        let [first, second, ..] = value.octets();
        first == 198 && matches!(second, 18 | 19)
    })
}

fn is_public_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => is_public_ipv4(value),
        IpAddr::V6(value) => {
            if let Some(mapped) = value.to_ipv4_mapped() {
                return is_public_ipv4(&mapped);
            }
            let [first, second, ..] = value.segments();
            first & 0xe000 == 0x2000
                && !value.is_loopback()
                && !value.is_unspecified()
                && !value.is_multicast()
                && !value.is_unique_local()
                && !value.is_unicast_link_local()
                && !(first == 0x2001
                    && (second == 0
                        || second == 2
                        || (0x10..=0x1f).contains(&second)
                        || second == 0x0db8))
                && first != 0x2002
                && !(first == 0x3fff && second & 0xf000 == 0)
        }
    }
}

fn is_public_ipv4(value: &Ipv4Addr) -> bool {
    let [a, b, ..] = value.octets();
    !value.is_private()
        && !value.is_loopback()
        && !value.is_link_local()
        && !value.is_unspecified()
        && !value.is_multicast()
        && !value.is_broadcast()
        && a != 0
        && a < 224
        && !(a == 100 && (64..=127).contains(&b))
        && !(a == 192 && (b == 0 || b == 88 || b == 168))
        && !(a == 198 && (b == 18 || b == 19 || b == 51))
        && !(a == 203 && b == 0)
}

struct WinHttpHandle(*mut core::ffi::c_void);

impl WinHttpHandle {
    fn new(handle: *mut core::ffi::c_void, operation: &str) -> Result<Self, JsonHttpError> {
        if handle.is_null() {
            Err(winhttp_error(operation).with_outcome(Outcome::Neutral))
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

pub(crate) fn request_bytes(
    request: JsonHttpRequest<'_>,
) -> Result<RawHttpResponse, JsonHttpError> {
    request_bytes_with_admission(request, |origin| request_guard::acquire(origin, || false))
}

pub(crate) fn request_bytes_with_admission<F>(
    request: JsonHttpRequest<'_>,
    acquire: F,
) -> Result<RawHttpResponse, JsonHttpError>
where
    F: FnOnce(&str) -> Result<request_guard::Permit, request_guard::AdmissionError>,
{
    request_bytes_with_receive_timeout(request, DEFAULT_RECEIVE_TIMEOUT, acquire)
}

fn request_bytes_with_receive_timeout<F>(
    request: JsonHttpRequest<'_>,
    receive_timeout: Duration,
    acquire: F,
) -> Result<RawHttpResponse, JsonHttpError>
where
    F: FnOnce(&str) -> Result<request_guard::Permit, request_guard::AdmissionError>,
{
    validate_request(&request)?;
    let receive_timeout_ms = i32::try_from(receive_timeout.as_millis())
        .ok()
        .filter(|value| (1..=600_000).contains(value))
        .ok_or_else(|| {
            JsonHttpError::new(
                JsonHttpErrorKind::InvalidRequest,
                "Provider receive timeout must be between 1 ms and 10 minutes",
            )
        })?;
    let origin = request_guard::origin_key(request.secure, request.host, request.port);
    let permit = acquire(&origin)
        .map_err(|error| JsonHttpError::new(JsonHttpErrorKind::Admission, error.to_string()))?;
    let result = request_bytes_admitted(request, receive_timeout_ms);
    permit.finish(request_outcome(&result));
    result
}

fn request_bytes_admitted(
    request: JsonHttpRequest<'_>,
    receive_timeout_ms: i32,
) -> Result<RawHttpResponse, JsonHttpError> {
    let agent = wide("unicomp/0.1");
    let host = wide(request.host);
    let verb = wide(request.method);
    let path = wide(request.path);
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
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, receive_timeout_ms) } == 0 {
        return Err(
            winhttp_error("Unable to configure provider timeouts").with_outcome(Outcome::Neutral)
        );
    }
    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.0, host.as_ptr(), request.port, 0) },
        "Unable to connect provider transport",
    )?;
    let flags = if request.secure {
        WINHTTP_FLAG_SECURE
    } else {
        0
    };
    let native_request = WinHttpHandle::new(
        unsafe {
            WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                flags,
            )
        },
        "Unable to create provider request",
    )?;
    let disabled_features = WINHTTP_DISABLE_REDIRECTS;
    if unsafe {
        WinHttpSetOption(
            native_request.0,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disabled_features as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(
            winhttp_error("Unable to disable provider redirects").with_outcome(Outcome::Neutral)
        );
    }

    let mut headers: Vec<u16> = format!(
        "Accept: {}\r\nAuthorization: {} ",
        request.accept, request.authorization_scheme
    )
    .encode_utf16()
    .collect();
    headers.extend(request.secret.encode_utf16());
    headers.extend("\r\n".encode_utf16());
    if request.body.is_some() {
        headers.extend("Content-Type: application/json\r\n".encode_utf16());
    }
    let sent = unsafe {
        WinHttpSendRequest(
            native_request.0,
            headers.as_ptr(),
            headers.len() as u32,
            request
                .body
                .map(|value| value.as_ptr().cast())
                .unwrap_or(std::ptr::null()),
            request.body.map_or(0, |value| value.len() as u32),
            request.body.map_or(0, |value| value.len() as u32),
            0,
        )
    };
    headers.fill(0);
    if sent == 0 {
        return Err(winhttp_error("Provider request could not be sent"));
    }
    if unsafe { WinHttpReceiveResponse(native_request.0, std::ptr::null_mut()) } == 0 {
        return Err(winhttp_error("Provider response could not be received"));
    }

    let mut status = 0_u32;
    let mut status_size = std::mem::size_of::<u32>() as u32;
    let mut header_index = 0_u32;
    if unsafe {
        WinHttpQueryHeaders(
            native_request.0,
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

    let retry_after = query_optional_header(native_request.0, WINHTTP_QUERY_RETRY_AFTER);
    let mut response = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        let mut read = 0_u32;
        if unsafe {
            WinHttpReadData(
                native_request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(response_error(
                winhttp_error("Provider response body could not be read"),
                status,
                retry_after.as_deref(),
            ));
        }
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read as usize]);
        if response.len() > request.response_body_limit {
            return Err(response_error(
                JsonHttpError::new(
                    JsonHttpErrorKind::ResponseTooLarge,
                    "Provider response exceeds the native transport limit",
                ),
                status,
                retry_after.as_deref(),
            ));
        }
    }
    Ok(RawHttpResponse {
        status,
        body: response,
        content_type: query_optional_header(native_request.0, WINHTTP_QUERY_CONTENT_TYPE),
        location: query_optional_header(native_request.0, WINHTTP_QUERY_LOCATION),
        retry_after,
    })
}

pub(crate) fn request_public_bytes(
    request: PublicHttpRequest<'_>,
) -> Result<RawHttpResponse, JsonHttpError> {
    validate_public_request(&request)?;
    let origin = request_guard::origin_key(true, request.host, 443);
    let cancellation = request.cancellation;
    let permit = request_guard::acquire(&origin, || {
        cancellation.is_some_and(|flag| flag.load(Ordering::Acquire))
    })
    .map_err(|error| JsonHttpError::new(JsonHttpErrorKind::Admission, error.to_string()))?;
    let result = request_public_bytes_admitted(request);
    let outcome = if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        Outcome::Neutral
    } else {
        request_outcome(&result)
    };
    permit.finish(outcome);
    result
}

fn validate_public_request(request: &PublicHttpRequest<'_>) -> Result<(), JsonHttpError> {
    if request.host.is_empty()
        || !request.host.is_ascii()
        || request
            .host
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
        || !request.path.starts_with('/')
        || request.path.contains(['\r', '\n', '\0'])
        || request.path.contains("//")
        || !matches!(
            request.accept,
            "text/html,application/xhtml+xml,application/json;q=0.8"
                | "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.5"
                | "video/mp4"
                | "image/png,image/jpeg,image/webp"
        )
        || request.response_body_limit == 0
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Public request is invalid",
        ));
    }
    Ok(())
}

fn request_public_bytes_admitted(
    request: PublicHttpRequest<'_>,
) -> Result<RawHttpResponse, JsonHttpError> {
    let check_cancelled = || {
        request
            .cancellation
            .is_some_and(|flag| flag.load(Ordering::Acquire))
    };
    let cancelled = || {
        Err(JsonHttpError::new(
            JsonHttpErrorKind::Transport,
            "Public request was cancelled",
        ))
    };
    if check_cancelled() {
        return cancelled();
    }
    let agent = wide("XLNGAI/1.0");
    let host = wide(request.host);
    let path = wide(request.path);
    let verb = wide("GET");
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
        "Unable to initialize public transport",
    )?;
    let receive_timeout = if request.accept == "image/png,image/jpeg,image/webp" {
        60_000
    } else {
        15_000
    };
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, receive_timeout) } == 0 {
        return Err(winhttp_error("Unable to configure public request timeouts")
            .with_outcome(Outcome::Neutral));
    }
    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.0, host.as_ptr(), 443, 0) },
        "Unable to connect public transport",
    )?;
    let native_request = WinHttpHandle::new(
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
        "Unable to create public request",
    )?;
    let disabled_features = WINHTTP_DISABLE_REDIRECTS;
    if unsafe {
        WinHttpSetOption(
            native_request.0,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disabled_features as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(
            winhttp_error("Unable to disable public redirects").with_outcome(Outcome::Neutral)
        );
    }
    let mut headers: Vec<u16> = format!("Accept: {}\r\n", request.accept)
        .encode_utf16()
        .collect();
    if check_cancelled() {
        return cancelled();
    }
    let sent = unsafe {
        WinHttpSendRequest(
            native_request.0,
            headers.as_ptr(),
            headers.len() as u32,
            std::ptr::null(),
            0,
            0,
            0,
        )
    };
    if check_cancelled() {
        return cancelled();
    }
    headers.fill(0);
    if sent == 0 {
        return Err(winhttp_error("Public request could not be sent"));
    }
    if unsafe { WinHttpReceiveResponse(native_request.0, std::ptr::null_mut()) } == 0 {
        return Err(winhttp_error("Public response could not be received"));
    }
    if check_cancelled() {
        return cancelled();
    }
    let mut status = 0_u32;
    let mut status_size = std::mem::size_of::<u32>() as u32;
    let mut header_index = 0_u32;
    if unsafe {
        WinHttpQueryHeaders(
            native_request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut status_size,
            &mut header_index,
        )
    } == 0
    {
        return Err(winhttp_error("Public response status could not be read"));
    }
    let content_type = query_optional_header(native_request.0, WINHTTP_QUERY_CONTENT_TYPE);
    let location = query_optional_header(native_request.0, WINHTTP_QUERY_LOCATION);
    let retry_after = query_optional_header(native_request.0, WINHTTP_QUERY_RETRY_AFTER);
    let mut body = Vec::new();
    loop {
        if check_cancelled() {
            return cancelled();
        }
        let mut chunk = [0_u8; 8192];
        let mut read = 0_u32;
        if unsafe {
            WinHttpReadData(
                native_request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(response_error(
                winhttp_error("Public response body could not be read"),
                status,
                retry_after.as_deref(),
            ));
        }
        if read == 0 {
            break;
        }
        if check_cancelled() {
            return cancelled();
        }
        body.extend_from_slice(&chunk[..read as usize]);
        if body.len() > request.response_body_limit {
            return Err(response_error(
                JsonHttpError::new(
                    JsonHttpErrorKind::ResponseTooLarge,
                    "Public response exceeds the native transport limit",
                ),
                status,
                retry_after.as_deref(),
            ));
        }
    }
    Ok(RawHttpResponse {
        status,
        body,
        content_type,
        location,
        retry_after,
    })
}

/// Dedicated file transport. Its target enum cannot be supplied by IPC callers.
/// It intentionally does not add arbitrary headers/hosts to the JSON bridge.
#[derive(Clone, Copy)]
pub(crate) enum DubbingHttpTarget<'a> {
    OfficialVideo {
        family: &'a str,
        operation: &'a str,
        id: &'a str,
        base_url: Option<&'a str>,
    },
    OfficialStorage(&'a PublicHttpsUrl),
    Speech,
    SyncSubmit,
    SyncModels,
    SyncPoll(&'a str),
    Output(&'a PublicHttpsUrl),
}

#[derive(Default)]
pub(crate) struct DubbingCancellation {
    cancelled: AtomicBool,
    request_handle: AtomicUsize,
}

impl DubbingCancellation {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.close_request();
    }

    fn close_request(&self) {
        let handle = self.request_handle.swap(0, Ordering::AcqRel);
        if handle != 0 {
            unsafe { WinHttpCloseHandle(handle as *mut core::ffi::c_void) };
        }
    }
}

struct DubbingRequestHandle<'a>(&'a DubbingCancellation);

impl Drop for DubbingRequestHandle<'_> {
    fn drop(&mut self) {
        self.0.close_request();
    }
}

pub(crate) struct DubbingHttpBody<'a> {
    pub reader: &'a mut dyn Read,
    pub size: u32,
    pub content_type: &'a str,
}

pub(crate) struct DubbingHttpRequest<'a> {
    pub target: DubbingHttpTarget<'a>,
    pub secret: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub body: Option<DubbingHttpBody<'a>>,
    pub output: Option<&'a mut dyn Write>,
    pub response_limit: usize,
    pub cancellation: &'a DubbingCancellation,
}

pub(crate) fn request_dubbing_file(
    request: DubbingHttpRequest<'_>,
) -> Result<RawHttpResponse, JsonHttpError> {
    let (host, path, method, auth) = match request.target {
        DubbingHttpTarget::OfficialVideo {
            family,
            operation,
            id,
            base_url,
        } => official_video_target(family, operation, id, base_url)?,
        DubbingHttpTarget::OfficialStorage(url) => {
            if ![
                ".oss-cn-beijing.aliyuncs.com",
                ".oss-cn-shanghai.aliyuncs.com",
            ]
            .iter()
            .any(|suffix| url.host.ends_with(suffix))
                || !url.path.starts_with('/')
            {
                return Err(JsonHttpError::new(
                    JsonHttpErrorKind::InvalidRequest,
                    "Official storage host is invalid",
                ));
            }
            (url.host.as_str(), url.path.clone(), "POST", "storage")
        }
        DubbingHttpTarget::Speech => ("api.minimax.cn", "/v1/t2a_v2".into(), "POST", "Bearer"),
        DubbingHttpTarget::SyncSubmit => {
            ("api.sync.so", "/v2/generate".into(), "POST", "x-api-key")
        }
        DubbingHttpTarget::SyncModels => ("api.sync.so", "/v2/models".into(), "GET", "x-api-key"),
        DubbingHttpTarget::SyncPoll(id) => {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            {
                return Err(JsonHttpError::new(
                    JsonHttpErrorKind::InvalidRequest,
                    "Invalid Sync task ID",
                ));
            }
            (
                "api.sync.so",
                format!("/v2/generate/{id}"),
                "GET",
                "x-api-key",
            )
        }
        DubbingHttpTarget::Output(url) => {
            assert_provider_output_host(&url.host).map_err(|_| {
                JsonHttpError::new(
                    JsonHttpErrorKind::InvalidRequest,
                    "Provider output host is outside the network boundary",
                )
            })?;
            (url.host.as_str(), url.path.clone(), "GET", "")
        }
    };
    validate_dubbing_request(&request, method, auth)?;
    let origin = request_guard::origin_key(true, host, 443);
    let cancellation = request.cancellation;
    let permit = request_guard::acquire(&origin, || cancellation.is_cancelled())
        .map_err(|error| JsonHttpError::new(JsonHttpErrorKind::Admission, error.to_string()))?;
    let result = request_dubbing_admitted(request, host, 443, true, &path, method, auth);
    permit.finish(if cancellation.is_cancelled() {
        Outcome::Neutral
    } else {
        request_outcome(&result)
    });
    result
}

pub(crate) fn wan_video_host(base_url: &str) -> Option<&str> {
    let host = base_url.strip_prefix("https://")?;
    if host == "dashscope.aliyuncs.com" {
        return Some(host);
    }
    let workspace = host.strip_suffix(".cn-beijing.maas.aliyuncs.com")?;
    if workspace.is_empty()
        || workspace.len() > 63
        || workspace.starts_with('-')
        || workspace.ends_with('-')
        || !workspace
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }
    Some(host)
}

fn official_video_target<'a>(
    family: &str,
    operation: &str,
    id: &str,
    base_url: Option<&'a str>,
) -> Result<(&'a str, String, &'a str, &'a str), JsonHttpError> {
    if id.len() > 160
        || id.contains("..")
        || matches!(operation, "poll" | "cancel" | "policy") && id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Official model or task identity is invalid",
        ));
    }
    let wan_host = if family == "wan" {
        wan_video_host(base_url.unwrap_or("https://dashscope.aliyuncs.com")).ok_or_else(|| {
            JsonHttpError::new(
                JsonHttpErrorKind::InvalidRequest,
                "Invalid official Wan workspace endpoint",
            )
        })?
    } else {
        "dashscope.aliyuncs.com"
    };
    let target = match (family, operation) {
        ("wan", "submit") => (
            wan_host,
            "/api/v1/services/aigc/video-generation/video-synthesis".to_string(),
            "POST",
            "Bearer",
        ),
        ("wan", "policy") => (
            wan_host,
            format!("/api/v1/uploads?action=getPolicy&model={id}"),
            "GET",
            "Bearer",
        ),
        ("wan", "poll") => (wan_host, format!("/api/v1/tasks/{id}"), "GET", "Bearer"),
        ("wan", "cancel") => (
            wan_host,
            format!("/api/v1/tasks/{id}/cancel"),
            "POST",
            "Bearer",
        ),
        ("seedance", "submit") => (
            "ark.cn-beijing.volces.com",
            "/api/v3/contents/generations/tasks".to_string(),
            "POST",
            "Bearer",
        ),
        ("seedance", "poll") => (
            "ark.cn-beijing.volces.com",
            format!("/api/v3/contents/generations/tasks/{id}"),
            "GET",
            "Bearer",
        ),
        ("seedance", "cancel") => (
            "ark.cn-beijing.volces.com",
            format!("/api/v3/contents/generations/tasks/{id}"),
            "DELETE",
            "Bearer",
        ),
        ("seedance", "test") => (
            "ark.cn-beijing.volces.com",
            "/api/v3/contents/generations/tasks?page_size=1".to_string(),
            "GET",
            "Bearer",
        ),
        ("minimax", "submit") => (
            "api.minimax.cn",
            "/v2/video_generation".to_string(),
            "POST",
            "Bearer",
        ),
        ("minimax", "poll") => (
            "api.minimax.cn",
            format!("/v2/query/video_generation/{id}"),
            "GET",
            "Bearer",
        ),
        ("minimax", "upload") => (
            "api.minimax.cn",
            "/v1/files/upload".to_string(),
            "POST",
            "Bearer",
        ),
        ("minimax", "test") => (
            "api.minimax.cn",
            "/v1/files/list?purpose=video_generation_input".to_string(),
            "GET",
            "Bearer",
        ),
        _ => {
            return Err(JsonHttpError::new(
                JsonHttpErrorKind::InvalidRequest,
                "Official video operation is unsupported",
            ))
        }
    };
    Ok(target)
}

fn validate_dubbing_request(
    request: &DubbingHttpRequest<'_>,
    method: &str,
    auth: &str,
) -> Result<(), JsonHttpError> {
    let invalid = || {
        JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Invalid dedicated dubbing transport request",
        )
    };
    if request.response_limit == 0 || request.response_limit > 512 * 1024 * 1024 {
        return Err(invalid());
    }
    if auth.is_empty() {
        if request.secret.is_some()
            || request.idempotency_key.is_some()
            || request.body.is_some()
            || request.output.is_none()
        {
            return Err(invalid());
        }
    } else if auth == "storage" {
        if request.secret.is_some() || request.output.is_some() {
            return Err(invalid());
        }
    } else if request.secret.is_none_or(|secret| {
        secret.is_empty() || !secret.is_ascii() || secret.bytes().any(|c| c.is_ascii_control())
    }) {
        return Err(invalid());
    }
    if let Some(key) = request.idempotency_key {
        if !matches!(request.target, DubbingHttpTarget::SyncSubmit)
            || key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'~' | b'-'))
        {
            return Err(invalid());
        }
    }
    if (method == "POST") != request.body.is_some() {
        return Err(invalid());
    }
    if let Some(body) = &request.body {
        let content_type_valid = match request.target {
            DubbingHttpTarget::OfficialVideo { operation, .. } => {
                (matches!(operation, "submit" | "cancel")
                    && body.content_type == "application/json"
                    && body.size <= 64 * 1024 * 1024)
                    || (operation == "upload"
                        && body
                            .content_type
                            .starts_with("multipart/form-data; boundary=")
                        && body.size <= 150 * 1024 * 1024)
            }
            DubbingHttpTarget::OfficialStorage(_) => {
                body.content_type
                    .starts_with("multipart/form-data; boundary=")
                    && body.size <= 150 * 1024 * 1024
            }
            DubbingHttpTarget::Speech => {
                body.content_type == "application/json" && body.size <= 64 * 1024
            }
            DubbingHttpTarget::SyncSubmit => {
                body.size <= 560 * 1024 * 1024
                    && body
                        .content_type
                        .strip_prefix("multipart/form-data; boundary=")
                        .is_some_and(|b| {
                            !b.is_empty()
                                && b.len() <= 80
                                && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                        })
            }
            _ => false,
        };
        if body.size == 0 || !content_type_valid {
            return Err(invalid());
        }
    }
    Ok(())
}

fn request_dubbing_admitted(
    mut request: DubbingHttpRequest<'_>,
    host: &str,
    port: u16,
    secure: bool,
    path: &str,
    method: &str,
    auth: &str,
) -> Result<RawHttpResponse, JsonHttpError> {
    let started = Instant::now();
    let check_cancelled = || {
        if request.cancellation.is_cancelled() {
            Err(JsonHttpError::new(
                JsonHttpErrorKind::Transport,
                "Dubbing request interrupted",
            ))
        } else if started.elapsed() >= Duration::from_secs(10 * 60) {
            Err(JsonHttpError::new(
                JsonHttpErrorKind::Timeout,
                "Dubbing transfer exceeded its 10 minute deadline",
            )
            .with_outcome(Outcome::Failure))
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let session = WinHttpHandle::new(
        unsafe {
            WinHttpOpen(
                wide("XLNGAI/1.0").as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        },
        "Unable to initialize dubbing transport",
    )?;
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 120_000) } == 0 {
        return Err(winhttp_error("Unable to configure dubbing timeouts"));
    }
    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.0, wide(host).as_ptr(), port, 0) },
        "Unable to connect dubbing transport",
    )?;
    let native_request = unsafe {
        WinHttpOpenRequest(
            connection.0,
            wide(method).as_ptr(),
            wide(path).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            if secure { WINHTTP_FLAG_SECURE } else { 0 },
        )
    };
    if native_request.is_null() {
        return Err(winhttp_error("Unable to create dubbing request"));
    }
    request
        .cancellation
        .request_handle
        .store(native_request as usize, Ordering::Release);
    let _request_handle = DubbingRequestHandle(request.cancellation);
    check_cancelled()?;
    let disabled_features = WINHTTP_DISABLE_REDIRECTS;
    if unsafe {
        WinHttpSetOption(
            native_request,
            WINHTTP_OPTION_DISABLE_FEATURE,
            (&disabled_features as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(winhttp_error("Unable to disable dubbing redirects"));
    }
    let mut headers = if auth.is_empty() {
        "Accept: video/mp4\r\n".encode_utf16().collect::<Vec<_>>()
    } else {
        "Accept: application/json\r\n"
            .encode_utf16()
            .collect::<Vec<_>>()
    };
    if let DubbingHttpTarget::OfficialVideo {
        family: "wan",
        operation: "submit",
        ..
    } = request.target
    {
        headers.extend(
            "X-DashScope-Async: enable\r\nX-DashScope-OssResourceResolve: enable\r\n"
                .encode_utf16(),
        );
    }
    if let Some(secret) = request.secret {
        headers.extend(
            if auth == "Bearer" {
                "Authorization: Bearer "
            } else {
                "x-api-key: "
            }
            .encode_utf16(),
        );
        headers.extend(secret.encode_utf16());
        headers.extend("\r\n".encode_utf16());
    }
    if let Some(key) = request.idempotency_key {
        headers.extend(format!("Idempotency-Key: {key}\r\n").encode_utf16());
    }
    if let Some(body) = &request.body {
        headers.extend(format!("Content-Type: {}\r\n", body.content_type).encode_utf16());
    }
    if let Err(error) = check_cancelled() {
        headers.fill(0);
        return Err(error);
    }
    // Once WinHttpSendRequest is invoked, a transport failure can no longer
    // prove that the remote service did not accept the paid request.
    let result = (|| {
        let sent = unsafe {
            WinHttpSendRequest(
                native_request,
                headers.as_ptr(),
                headers.len() as u32,
                std::ptr::null(),
                0,
                request.body.as_ref().map_or(0, |body| body.size),
                0,
            )
        };
        headers.fill(0);
        if sent == 0 {
            return Err(winhttp_error("Dubbing request could not be sent"));
        }
        if let Some(body) = &mut request.body {
            let mut remaining = u64::from(body.size);
            let mut buffer = [0_u8; 64 * 1024];
            while remaining > 0 {
                check_cancelled()?;
                let max_read = remaining.min(buffer.len() as u64) as usize;
                let size = body.reader.read(&mut buffer[..max_read]).map_err(|_| {
                    JsonHttpError::new(
                        JsonHttpErrorKind::Transport,
                        "Dubbing input file could not be read",
                    )
                })?;
                if size == 0 {
                    return Err(JsonHttpError::new(
                        JsonHttpErrorKind::Transport,
                        "Dubbing input file was truncated",
                    ));
                }
                let mut written = 0;
                while written < size {
                    check_cancelled()?;
                    let mut bytes_written = 0;
                    if unsafe {
                        WinHttpWriteData(
                            native_request,
                            buffer[written..size].as_ptr().cast(),
                            (size - written) as u32,
                            &mut bytes_written,
                        )
                    } == 0
                        || bytes_written == 0
                    {
                        return Err(winhttp_error("Dubbing upload could not be written"));
                    }
                    written += bytes_written as usize;
                }
                remaining -= size as u64;
            }
        }
        check_cancelled()?;
        if unsafe { WinHttpReceiveResponse(native_request, std::ptr::null_mut()) } == 0 {
            return Err(winhttp_error("Dubbing response could not be received"));
        }
        check_cancelled()?;
        let mut status = 0_u32;
        let mut status_size = std::mem::size_of::<u32>() as u32;
        let mut index = 0_u32;
        if unsafe {
            WinHttpQueryHeaders(
                native_request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                std::ptr::null(),
                (&mut status as *mut u32).cast(),
                &mut status_size,
                &mut index,
            )
        } == 0
        {
            return Err(winhttp_error("Dubbing response status could not be read"));
        }
        let retry_after = query_optional_header(native_request, WINHTTP_QUERY_RETRY_AFTER);
        let mut response = Vec::new();
        let mut total = 0_usize;
        loop {
            check_cancelled()?;
            let mut buffer = [0_u8; 64 * 1024];
            let mut read = 0_u32;
            if unsafe {
                WinHttpReadData(
                    native_request,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                )
            } == 0
            {
                return Err(response_error(
                    winhttp_error("Dubbing response could not be read"),
                    status,
                    retry_after.as_deref(),
                ));
            }
            if read == 0 {
                break;
            }
            total += read as usize;
            if total > request.response_limit
                || (!(200..=299).contains(&status) && total > 2 * 1024 * 1024)
            {
                return Err(response_error(
                    JsonHttpError::new(
                        JsonHttpErrorKind::ResponseTooLarge,
                        "Dubbing result exceeds the file limit",
                    ),
                    status,
                    retry_after.as_deref(),
                ));
            }
            check_cancelled()?;
            if (200..=299).contains(&status) {
                if let Some(output) = &mut request.output {
                    output.write_all(&buffer[..read as usize]).map_err(|_| {
                        JsonHttpError::new(
                            JsonHttpErrorKind::Transport,
                            "Dubbing result could not be saved",
                        )
                    })?;
                    continue;
                }
            }
            response.extend_from_slice(&buffer[..read as usize]);
        }
        Ok(RawHttpResponse {
            status,
            body: response,
            content_type: query_optional_header(native_request, WINHTTP_QUERY_CONTENT_TYPE),
            location: query_optional_header(native_request, WINHTTP_QUERY_LOCATION),
            retry_after,
        })
    })();
    result.map_err(JsonHttpError::with_request_sent)
}

pub(crate) fn query_optional_header(
    request: *mut core::ffi::c_void,
    header: u32,
) -> Option<String> {
    let mut size = 0_u32;
    let mut index = 0_u32;
    unsafe {
        WinHttpQueryHeaders(
            request,
            header,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
            &mut index,
        );
    }
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0_u16; (size as usize).div_ceil(2)];
    if unsafe {
        WinHttpQueryHeaders(
            request,
            header,
            std::ptr::null(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            &mut index,
        )
    } == 0
    {
        return None;
    }
    let value = String::from_utf16_lossy(&buffer)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn request_json(
    request: JsonHttpRequest<'_>,
) -> Result<JsonHttpResponse, JsonHttpError> {
    parse_json_response(request_bytes(request)?)
}

pub(crate) fn request_json_with_receive_timeout(
    request: JsonHttpRequest<'_>,
    receive_timeout: Duration,
) -> Result<JsonHttpResponse, JsonHttpError> {
    parse_json_response(request_bytes_with_receive_timeout(
        request,
        receive_timeout,
        |origin| request_guard::acquire(origin, || false),
    )?)
}

fn parse_json_response(response: RawHttpResponse) -> Result<JsonHttpResponse, JsonHttpError> {
    let body = if response.body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(&response.body) {
            Ok(body) => body,
            Err(_) if !(200..=299).contains(&response.status) => serde_json::Value::Null,
            Err(_) => {
                return Err(JsonHttpError::new(
                    JsonHttpErrorKind::InvalidResponse,
                    "Provider returned a non-JSON success response",
                ));
            }
        }
    };
    Ok(JsonHttpResponse {
        status: response.status,
        body,
        retry_after_ms: response
            .retry_after
            .as_deref()
            .and_then(parse_retry_after_ms),
    })
}

pub(crate) fn parse_retry_after_ms(value: &str) -> Option<u64> {
    parse_retry_after_at(value, SystemTime::now())
}

fn parse_retry_after_at(value: &str, now: SystemTime) -> Option<u64> {
    const MAX_DELAY_MS: u64 = 30 * 60 * 1_000;
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(seconds.saturating_mul(1_000).min(MAX_DELAY_MS));
    }
    if value.len() > 128 || value.contains('\0') {
        return None;
    }
    let value = wide(value.trim());
    let mut date = SYSTEMTIME::default();
    if unsafe { WinHttpTimeToSystemTime(value.as_ptr(), &mut date) } == 0
        || date.wYear < 1970
        || !(1..=12).contains(&date.wMonth)
        || !(1..=31).contains(&date.wDay)
        || date.wHour > 23
        || date.wMinute > 59
        || date.wSecond > 59
    {
        return None;
    }
    // Convert the parsed UTC civil date to days since the Unix epoch.
    let year = i64::from(date.wYear) - i64::from(date.wMonth <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(date.wMonth) + if date.wMonth > 2 { -3 } else { 9 };
    let day_of_year = (153 * month + 2) / 5 + i64::from(date.wDay) - 1;
    let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + day_of_year
        - 719_468;
    let seconds = days * 86_400
        + i64::from(date.wHour) * 3_600
        + i64::from(date.wMinute) * 60
        + i64::from(date.wSecond);
    let target = UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(seconds).ok()?))?;
    Some(
        target
            .duration_since(now)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(MAX_DELAY_MS)) as u64,
    )
}

pub(crate) fn http_outcome(status: u32, retry_after: Option<&str>) -> Outcome {
    match status {
        200..=399 => Outcome::Success,
        429 => Outcome::RateLimited(Duration::from_millis(
            retry_after.and_then(parse_retry_after_ms).unwrap_or(30_000),
        )),
        408 | 500..=599 => Outcome::Failure,
        _ => Outcome::Neutral,
    }
}

fn request_outcome(result: &Result<RawHttpResponse, JsonHttpError>) -> Outcome {
    match result {
        Ok(response) => http_outcome(response.status, response.retry_after.as_deref()),
        Err(error) => error.guard_outcome,
    }
}

fn response_error(
    mut error: JsonHttpError,
    status: u32,
    retry_after: Option<&str>,
) -> JsonHttpError {
    // Preserve an observed rejection even if its body is truncated or unreadable.
    if status >= 400 {
        error.rejected_http_status = Some(status);
        error.with_outcome(http_outcome(status, retry_after))
    } else {
        error
    }
}

fn validate_request(request: &JsonHttpRequest<'_>) -> Result<(), JsonHttpError> {
    if request.host.is_empty()
        || !request.host.is_ascii()
        || request
            .host
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider host is invalid",
        ));
    }
    if !matches!(request.method, "GET" | "POST" | "DELETE") {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider HTTP method is unsupported",
        ));
    }
    if !request.path.starts_with('/')
        || request.path.contains(['\r', '\n', '\0'])
        || request.path.contains("//")
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider request path is invalid",
        ));
    }
    if request.authorization_scheme != "Bearer" && request.authorization_scheme != "Token" {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider authorization scheme is unsupported",
        ));
    }
    if !matches!(request.accept, "application/json" | "video/mp4") {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider response media type is unsupported",
        ));
    }
    if request.secret.is_empty()
        || !request.secret.is_ascii()
        || request.secret.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider credential is invalid",
        ));
    }
    if request.request_body_limit == 0 || request.response_body_limit == 0 {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider transport body limit is invalid",
        ));
    }
    if request
        .body
        .is_some_and(|body| body.len() > request.request_body_limit)
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider request exceeds the native transport limit",
        ));
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn winhttp_error(operation: &str) -> JsonHttpError {
    let code = unsafe { GetLastError() };
    let kind = match code {
        ERROR_WINHTTP_TIMEOUT => JsonHttpErrorKind::Timeout,
        ERROR_WINHTTP_SECURE_FAILURE | ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED => {
            JsonHttpErrorKind::Tls
        }
        _ => JsonHttpErrorKind::Transport,
    };
    let message = if code == ERROR_WINHTTP_TIMEOUT {
        format!(
            "{operation}（超时：服务端在限定时间内未返回响应，请检查网络/代理、模型端点或凭据后重试）"
        )
    } else {
        format!("{operation} (Windows error {code})")
    };
    JsonHttpError::new(kind, message).with_outcome(Outcome::Failure)
}

#[cfg(test)]
mod dubbing_transport_tests {
    use super::*;
    use std::{
        io::Cursor,
        net::{TcpListener, TcpStream},
        sync::{mpsc, Arc},
        thread,
    };

    fn read_http_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0_u8];
            socket.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
        }
        let headers = String::from_utf8(headers).unwrap();
        let size: usize = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0_u8; size];
        socket.read_exact(&mut body).unwrap();
        (headers, body)
    }

    #[test]
    fn dedicated_transport_streams_x_api_key_body_and_idempotency_header() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let payload = vec![b'v'; 200_000];
        let expected = payload.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, body) = read_http_request(&mut socket);
            assert!(headers.contains("x-api-key: fixture-secret"));
            assert!(headers.contains("Idempotency-Key: fixed-key"));
            assert!(!headers.contains("Authorization:"));
            assert_eq!(body, expected);
            socket.write_all(b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"id\":\"task123\"}").unwrap();
        });
        let cancellation = DubbingCancellation::default();
        let mut reader = Cursor::new(&payload);
        let request = DubbingHttpRequest {
            target: DubbingHttpTarget::SyncSubmit,
            secret: Some("fixture-secret"),
            idempotency_key: Some("fixed-key"),
            body: Some(DubbingHttpBody {
                reader: &mut reader,
                size: payload.len() as u32,
                content_type: "multipart/form-data; boundary=fixture",
            }),
            output: None,
            response_limit: 1024,
            cancellation: &cancellation,
        };
        validate_dubbing_request(&request, "POST", "x-api-key").unwrap();
        let response = request_dubbing_admitted(
            request,
            "127.0.0.1",
            port,
            false,
            "/fixture",
            "POST",
            "x-api-key",
        )
        .unwrap();
        assert_eq!(response.status, 201);
        assert_eq!(response.body, b"{\"id\":\"task123\"}");
        server.join().unwrap();
    }

    #[test]
    fn output_stream_omits_credentials_and_enforces_download_limit() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, body) = read_http_request(&mut socket);
            assert!(
                !headers.to_ascii_lowercase().contains("api-key")
                    && !headers.contains("Authorization")
                    && body.is_empty()
            );
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 20\r\nConnection: close\r\n\r\n01234567890123456789").unwrap();
        });
        let cancellation = DubbingCancellation::default();
        let url = PublicHttpsUrl {
            host: "fixture.example".into(),
            path: "/output?sig=native-only".into(),
        };
        let mut output = Vec::new();
        let request = DubbingHttpRequest {
            target: DubbingHttpTarget::Output(&url),
            secret: None,
            idempotency_key: None,
            body: None,
            output: Some(&mut output),
            response_limit: 12,
            cancellation: &cancellation,
        };
        validate_dubbing_request(&request, "GET", "").unwrap();
        let error =
            request_dubbing_admitted(request, "127.0.0.1", port, false, "/fixture", "GET", "")
                .err()
                .unwrap();
        assert_eq!(error.kind(), JsonHttpErrorKind::ResponseTooLarge);
        assert!(output.len() <= 12);
        server.join().unwrap();
    }

    #[test]
    fn local_cancel_closes_blocked_winhttp_without_waiting_for_provider() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started_tx, started_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_http_request(&mut socket);
            started_tx.send(()).unwrap();
            finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let cancellation = Arc::new(DubbingCancellation::default());
        let flag = Arc::clone(&cancellation);
        let worker = thread::spawn(move || {
            request_dubbing_admitted(
                DubbingHttpRequest {
                    target: DubbingHttpTarget::SyncModels,
                    secret: Some("fixture-secret"),
                    idempotency_key: None,
                    body: None,
                    output: None,
                    response_limit: 1024,
                    cancellation: &flag,
                },
                "127.0.0.1",
                port,
                false,
                "/fixture",
                "GET",
                "x-api-key",
            )
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        cancellation.cancel();
        assert!(worker.join().unwrap().is_err());
        finish_tx.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn dedicated_contract_never_attaches_api_key_to_output_or_unknown_headers() {
        let cancellation = DubbingCancellation::default();
        let url = PublicHttpsUrl {
            host: "fixture.example".into(),
            path: "/output".into(),
        };
        let mut output = Vec::new();
        let request = DubbingHttpRequest {
            target: DubbingHttpTarget::Output(&url),
            secret: Some("blocked"),
            idempotency_key: None,
            body: None,
            output: Some(&mut output),
            response_limit: 1024,
            cancellation: &cancellation,
        };
        assert!(validate_dubbing_request(&request, "GET", "").is_err());
        for key in ["injected\r\nx-api-key: secret", "", "key/invalid"] {
            let mut reader = Cursor::new(b"{}");
            let request = DubbingHttpRequest {
                target: DubbingHttpTarget::SyncSubmit,
                secret: Some("fixture"),
                idempotency_key: Some(key),
                body: Some(DubbingHttpBody {
                    reader: &mut reader,
                    size: 2,
                    content_type: "multipart/form-data; boundary=fixture",
                }),
                output: None,
                response_limit: 1024,
                cancellation: &cancellation,
            };
            assert!(validate_dubbing_request(&request, "POST", "x-api-key").is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn official_video_endpoints_preserve_workspace_and_use_documented_read_only_checks() {
        let endpoint = "https://workspace-123.cn-beijing.maas.aliyuncs.com";
        for (operation, id) in [
            ("policy", "wan3.0-video"),
            ("submit", ""),
            ("poll", "task-123"),
        ] {
            let target =
                super::official_video_target("wan", operation, id, Some(endpoint)).unwrap();
            assert_eq!(target.0, "workspace-123.cn-beijing.maas.aliyuncs.com");
        }
        for endpoint in [
            "https://workspace.cn-beijing.maas.aliyuncs.com.evil.example",
            "https://workspace.ap-southeast-1.maas.aliyuncs.com",
            "https://workspace.cn-beijing.maas.aliyuncs.com/path",
            "https://-workspace.cn-beijing.maas.aliyuncs.com",
        ] {
            assert!(super::official_video_target("wan", "submit", "", Some(endpoint)).is_err());
        }
        let minimax = super::official_video_target("minimax", "test", "", None).unwrap();
        assert_eq!(minimax.1, "/v1/files/list?purpose=video_generation_input");
        assert_eq!(minimax.2, "GET");
    }
    use super::{
        is_public_address, parse_retry_after_ms, request_bytes, request_json, JsonHttpErrorKind,
        JsonHttpRequest,
    };
    use std::{
        io::{Read, Write},
        net::{IpAddr, TcpListener},
        thread,
        time::{Duration, UNIX_EPOCH},
    };

    #[test]
    fn retry_after_supports_http_dates_without_unbounded_cooldown() {
        let target = UNIX_EPOCH + Duration::from_secs(1_445_412_480);
        assert_eq!(
            super::parse_retry_after_at(
                "Wed, 21 Oct 2015 07:28:00 GMT",
                target - Duration::from_secs(7)
            ),
            Some(7_000)
        );
        assert_eq!(
            super::parse_retry_after_at(
                "Wed, 21 Oct 2015 07:28:00 GMT",
                target + Duration::from_secs(1)
            ),
            Some(0)
        );
        assert_eq!(
            super::parse_retry_after_at("Wed, 21 Oct 2015 07:28:00 GMT", UNIX_EPOCH),
            Some(1_800_000)
        );
        assert_eq!(super::parse_retry_after_at("not a date", target), None);
    }

    #[test]
    fn interrupted_rejection_bodies_preserve_http_circuit_classification() {
        use crate::request_guard::Outcome;
        let transport = || {
            super::JsonHttpError::new(JsonHttpErrorKind::Transport, "read failed")
                .with_outcome(Outcome::Failure)
        };
        assert_eq!(
            super::response_error(transport(), 401, None).guard_outcome,
            Outcome::Neutral
        );
        assert_eq!(
            super::response_error(transport(), 429, Some("17")).guard_outcome,
            Outcome::RateLimited(Duration::from_secs(17))
        );
        assert_eq!(
            super::response_error(transport(), 503, None).guard_outcome,
            Outcome::Failure
        );
        assert_eq!(
            super::response_error(transport(), 200, None).guard_outcome,
            Outcome::Failure
        );
    }

    #[test]
    fn sends_authorized_json_requests_to_a_local_mock_provider() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = [0_u8; 4096];
            let read = stream
                .read(&mut request)
                .expect("mock request should be readable");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/models HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer local-test-key"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{\"data\":[{\"id\":\"mock-model\"}]}",
                )
                .expect("mock response should be written");
        });

        let response = request_json(JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "GET",
            path: "/v1/models",
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: "local-test-key",
            body: None,
            request_body_limit: 1024,
            response_body_limit: 1024,
        })
        .expect("mock provider request should succeed");
        server.join().expect("mock provider should finish");
        assert_eq!(response.status, 200);
        assert_eq!(response.body["data"][0]["id"], "mock-model");
    }

    fn assert_slow_submission_response(path: &'static str, response_body: &'static str) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock image provider should bind");
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0_u8; 4096];
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            assert!(String::from_utf8_lossy(&bytes).starts_with(&format!("POST {path} HTTP/1.1")));
            thread::sleep(super::DEFAULT_RECEIVE_TIMEOUT + Duration::from_secs(2));
            let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len()).as_bytes());
        });
        let response = super::request_json_with_receive_timeout(
            JsonHttpRequest {
                host: "127.0.0.1",
                port,
                secure: false,
                method: "POST",
                path,
                authorization_scheme: "Bearer",
                accept: "application/json",
                secret: "local-image-key",
                body: Some(b"{}"),
                request_body_limit: 1024,
                response_body_limit: 1024,
            },
            crate::unicompapi_receive_timeout("POST", path),
        );
        server.join().unwrap();
        let response = response.expect("paid submission must not time out at 30 seconds");
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body,
            serde_json::from_str::<serde_json::Value>(response_body).unwrap()
        );
    }

    #[test]
    fn synchronous_image_submission_can_wait_beyond_the_default_receive_timeout() {
        assert_slow_submission_response("/v1/images/generations", "{}");
    }

    #[test]
    fn video_submission_can_wait_beyond_the_default_receive_timeout() {
        assert_slow_submission_response(
            "/v1/videos",
            r#"{"id":"slow-video-task","status":"queued"}"#,
        );
    }

    #[test]
    fn streams_authorized_binary_responses_without_json_parsing() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = [0_u8; 4096];
            let read = stream
                .read(&mut request)
                .expect("mock request should be readable");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/videos/task/content HTTP/1.1"));
            assert!(request.contains("Accept: video/mp4"));
            assert!(request.contains("Authorization: Bearer local-test-key"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 4\r\nConnection: close\r\n\r\nftyp",
                )
                .expect("mock response should be written");
        });

        let response = request_bytes(JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "GET",
            path: "/v1/videos/task/content",
            authorization_scheme: "Bearer",
            accept: "video/mp4",
            secret: "local-test-key",
            body: None,
            request_body_limit: 1,
            response_body_limit: 1024,
        })
        .expect("mock binary provider request should succeed");
        server.join().expect("mock provider should finish");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"ftyp");
    }

    #[test]
    fn rejects_request_bodies_over_the_explicit_transport_limit() {
        let body = [0_u8; 2];
        let error = request_json(JsonHttpRequest {
            host: "127.0.0.1",
            port: 1,
            secure: false,
            method: "POST",
            path: "/v1/models",
            authorization_scheme: "Bearer",
            accept: "application/json",
            secret: "local-test-key",
            body: Some(&body),
            request_body_limit: 1,
            response_body_limit: 1024,
        })
        .expect_err("oversized requests must fail before transport");
        assert_eq!(error.kind(), JsonHttpErrorKind::InvalidRequest);
    }

    #[test]
    fn preserves_non_json_error_statuses_for_provider_classification() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = [0_u8; 4096];
            stream
                .read(&mut request)
                .expect("mock request should be readable");
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found",
                )
                .expect("mock response should be written");
        });

        let response = request_json(JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "GET",
            path: "/ent/v2/models",
            authorization_scheme: "Token",
            accept: "application/json",
            secret: "local-test-key",
            body: None,
            request_body_limit: 1,
            response_body_limit: 1024,
        })
        .expect("non-JSON error response should preserve its status");
        server.join().expect("mock provider should finish");
        assert_eq!(response.status, 404);
        assert!(response.body.is_null());
    }

    #[test]
    fn captures_delta_seconds_retry_after_and_caps_untrusted_values() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = [0_u8; 4096];
            stream
                .read(&mut request)
                .expect("mock request should be readable");
            stream
                .write_all(
                    b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 17\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .expect("mock response should be written");
        });

        let response = request_json(JsonHttpRequest {
            host: "127.0.0.1",
            port,
            secure: false,
            method: "GET",
            path: "/ent/v2/tasks/task/creations",
            authorization_scheme: "Token",
            accept: "application/json",
            secret: "local-test-key",
            body: None,
            request_body_limit: 1,
            response_body_limit: 1024,
        })
        .expect("Retry-After response should remain classifiable");
        server.join().expect("mock provider should finish");
        assert_eq!(response.status, 429);
        assert_eq!(response.retry_after_ms, Some(17_000));
        assert_eq!(parse_retry_after_ms("999999999"), Some(30 * 60 * 1_000));
        assert_eq!(
            parse_retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(0)
        );
    }

    #[test]
    fn provider_output_domains_support_proxy_fake_ip_without_relaxing_research() {
        let fake = "198.18.0.174".parse::<IpAddr>().unwrap();
        assert!(!is_public_address(&fake));
        for address in ["198.18.0.174", "198.19.255.254", "::ffff:198.18.0.174"] {
            assert!(super::validate_provider_output_addresses(
                "cdn.example.com",
                &[address.parse().unwrap()]
            )
            .is_ok());
        }
        for host in [
            "198.18.0.174",
            "localhost",
            "host.local",
            "host.localhost",
            "host.lan",
            "host.internal",
            "host.home.arpa",
        ] {
            assert!(super::validate_provider_output_addresses(host, &[fake]).is_err());
        }
        for address in [
            "127.0.0.1",
            "192.168.1.1",
            "10.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
        ] {
            let blocked = address.parse::<IpAddr>().unwrap();
            assert!(
                super::validate_provider_output_addresses("cdn.example.com", &[blocked]).is_err()
            );
            assert!(
                super::validate_provider_output_addresses("cdn.example.com", &[fake, blocked])
                    .is_err()
            );
        }
        assert!(super::validate_provider_output_addresses("cdn.example.com", &[]).is_err());
        assert!(super::validate_provider_output_addresses(
            "cdn.example.com",
            &["8.8.8.8".parse().unwrap()]
        )
        .is_ok());
    }

    #[test]
    fn public_address_filter_rejects_reserved_and_tunneled_ranges() {
        for address in ["8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public_address(
                &address.parse::<IpAddr>().expect("public IP")
            ));
        }
        for address in [
            "0.1.2.3",
            "192.88.99.1",
            "240.0.0.1",
            "::ffff:127.0.0.1",
            "fec0::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(!is_public_address(
                &address.parse::<IpAddr>().expect("reserved IP")
            ));
        }
    }
}
