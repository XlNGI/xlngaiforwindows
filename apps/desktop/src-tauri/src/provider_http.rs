use std::{
    fmt,
    net::{IpAddr, Ipv4Addr, ToSocketAddrs},
    sync::atomic::{AtomicBool, Ordering},
};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED, ERROR_WINHTTP_SECURE_FAILURE,
    ERROR_WINHTTP_TIMEOUT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_DISABLE_REDIRECTS,
    WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_CONTENT_TYPE,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_RETRY_AFTER,
    WINHTTP_QUERY_STATUS_CODE,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JsonHttpErrorKind {
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
}

impl JsonHttpError {
    fn new(kind: JsonHttpErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> JsonHttpErrorKind {
        self.kind
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

pub(crate) fn request_bytes(
    request: JsonHttpRequest<'_>,
) -> Result<RawHttpResponse, JsonHttpError> {
    validate_request(&request)?;
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
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 30_000) } == 0 {
        return Err(winhttp_error("Unable to configure provider timeouts"));
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
        return Err(winhttp_error("Unable to disable provider redirects"));
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
            return Err(winhttp_error("Provider response body could not be read"));
        }
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read as usize]);
        if response.len() > request.response_body_limit {
            return Err(JsonHttpError::new(
                JsonHttpErrorKind::ResponseTooLarge,
                "Provider response exceeds the native transport limit",
            ));
        }
    }
    Ok(RawHttpResponse {
        status,
        body: response,
        content_type: query_optional_header(native_request.0, WINHTTP_QUERY_CONTENT_TYPE),
        location: query_optional_header(native_request.0, WINHTTP_QUERY_LOCATION),
        retry_after: query_optional_header(native_request.0, WINHTTP_QUERY_RETRY_AFTER),
    })
}

pub(crate) fn request_public_bytes(
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
        )
        || request.response_body_limit == 0
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Public request is invalid",
        ));
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
    if unsafe { WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 15_000) } == 0 {
        return Err(winhttp_error("Unable to configure public request timeouts"));
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
        return Err(winhttp_error("Unable to disable public redirects"));
    }
    let mut headers: Vec<u16> = format!("Accept: {}\r\n", request.accept)
        .encode_utf16()
        .collect();
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
            return Err(winhttp_error("Public response body could not be read"));
        }
        if read == 0 {
            break;
        }
        if check_cancelled() {
            return cancelled();
        }
        body.extend_from_slice(&chunk[..read as usize]);
        if body.len() > request.response_body_limit {
            return Err(JsonHttpError::new(
                JsonHttpErrorKind::ResponseTooLarge,
                "Public response exceeds the native transport limit",
            ));
        }
    }
    Ok(RawHttpResponse {
        status,
        body,
        content_type,
        location,
        retry_after: query_optional_header(native_request.0, WINHTTP_QUERY_RETRY_AFTER),
    })
}

fn query_optional_header(request: *mut core::ffi::c_void, header: u32) -> Option<String> {
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

fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<u64>().ok()?;
    Some(seconds.saturating_mul(1_000).min(30 * 60 * 1_000))
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
    JsonHttpError::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::{
        is_public_address, parse_retry_after_ms, request_bytes, request_json, JsonHttpErrorKind,
        JsonHttpRequest,
    };
    use std::{
        io::{Read, Write},
        net::{IpAddr, TcpListener},
        thread,
    };

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
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT"), None);
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
