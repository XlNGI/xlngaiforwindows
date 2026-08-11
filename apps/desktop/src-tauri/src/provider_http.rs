use std::fmt;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED, ERROR_WINHTTP_SECURE_FAILURE,
    ERROR_WINHTTP_TIMEOUT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_DISABLE_REDIRECTS,
    WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_FLAG_NUMBER,
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
}

pub(crate) struct RawHttpResponse {
    pub status: u32,
    pub body: Vec<u8>,
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
    let content_type = request.body.map(|_| "application/json");
    request_bytes_with_content_type(request, content_type)
}

fn request_bytes_with_content_type(
    request: JsonHttpRequest<'_>,
    content_type: Option<&str>,
) -> Result<RawHttpResponse, JsonHttpError> {
    validate_request(&request)?;
    let agent = wide("AI Video Workspace/0.1");
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
    if let Some(content_type) = content_type {
        headers.extend(format!("Content-Type: {content_type}\r\n").encode_utf16());
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
    })
}

pub(crate) fn request_json(
    request: JsonHttpRequest<'_>,
) -> Result<JsonHttpResponse, JsonHttpError> {
    parse_json_response(request_bytes(request)?)
}

pub(crate) fn request_multipart_json(
    request: JsonHttpRequest<'_>,
    boundary: &str,
) -> Result<JsonHttpResponse, JsonHttpError> {
    if request.body.is_none()
        || boundary.is_empty()
        || boundary.len() > 70
        || boundary
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-'))
    {
        return Err(JsonHttpError::new(
            JsonHttpErrorKind::InvalidRequest,
            "Provider multipart boundary is invalid",
        ));
    }
    let content_type = format!("multipart/form-data; boundary={boundary}");
    parse_json_response(request_bytes_with_content_type(
        request,
        Some(&content_type),
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
    })
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
    JsonHttpError::new(kind, format!("{operation} (Windows error {code})"))
}

#[cfg(test)]
mod tests {
    use super::{
        request_bytes, request_json, request_multipart_json, JsonHttpErrorKind, JsonHttpRequest,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
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
    fn sends_bounded_multipart_requests_with_an_internal_content_type() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock request should connect");
            let mut request = [0_u8; 4096];
            let read = stream
                .read(&mut request)
                .expect("mock request should be readable");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /v1/images/edits/ HTTP/1.1"));
            assert!(
                request.contains("Content-Type: multipart/form-data; boundary=safe-test-boundary")
            );
            assert!(request.contains("Authorization: Bearer local-test-key"));
            assert!(!request.contains("Content-Length: 0"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":[]}",
                )
                .expect("mock response should be written");
        });
        let body = b"--safe-test-boundary\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nedit\r\n--safe-test-boundary--\r\n";
        let response = request_multipart_json(
            JsonHttpRequest {
                host: "127.0.0.1",
                port,
                secure: false,
                method: "POST",
                path: "/v1/images/edits/",
                authorization_scheme: "Bearer",
                accept: "application/json",
                secret: "local-test-key",
                body: Some(body),
                request_body_limit: 1024,
                response_body_limit: 1024,
            },
            "safe-test-boundary",
        )
        .expect("mock multipart request should succeed");
        server.join().expect("mock provider should finish");
        assert_eq!(response.status, 200);
        assert_eq!(response.body["data"], serde_json::json!([]));
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
}
