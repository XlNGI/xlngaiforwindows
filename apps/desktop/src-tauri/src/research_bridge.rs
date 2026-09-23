use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

use crate::provider_http::{
    assert_public_host, parse_public_https_url, request_public_bytes, PublicHttpRequest,
};

const REQUEST_LIMIT: usize = 32 * 1024;
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_CONNECTION_READERS: usize = 16;
const MAX_ACTIVE_CANCELLATIONS: usize = 48;
const MAX_EARLY_CANCELLATIONS: usize = 256;
const EARLY_CANCELLATION_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
struct CancellationRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    early: HashMap<String, Instant>,
}

impl CancellationRegistry {
    fn validate_id(request_id: &str) -> Result<(), String> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err("Native research bridge request ID is invalid".to_string());
        }
        Ok(())
    }

    fn prune(&mut self, now: Instant) {
        self.early.retain(|_, expires| *expires > now);
    }

    fn cancel(&mut self, request_id: &str, now: Instant) -> Result<bool, String> {
        Self::validate_id(request_id)?;
        self.prune(now);
        if let Some(flag) = self.active.get(request_id) {
            flag.store(true, Ordering::Release);
            return Ok(true);
        }
        if !self.early.contains_key(request_id) && self.early.len() >= MAX_EARLY_CANCELLATIONS {
            return Err(crate::request_guard::AdmissionError::QueueFull.to_string());
        }
        // Keep a bounded tombstone for a cancellation that raced request parsing.
        self.early
            .insert(request_id.to_string(), now + EARLY_CANCELLATION_TTL);
        Ok(true)
    }

    fn register(&mut self, request_id: &str, now: Instant) -> Result<Arc<AtomicBool>, String> {
        Self::validate_id(request_id)?;
        self.prune(now);
        if self.active.contains_key(request_id) {
            return Err("Native research bridge request ID is already active".to_string());
        }
        if self.active.len() >= MAX_ACTIVE_CANCELLATIONS {
            return Err(crate::request_guard::AdmissionError::QueueFull.to_string());
        }
        let cancelled = self.early.remove(request_id).is_some();
        let flag = Arc::new(AtomicBool::new(cancelled));
        self.active
            .insert(request_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    fn complete(&mut self, request_id: &str, flag: &Arc<AtomicBool>) {
        if self
            .active
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(current, flag))
        {
            self.active.remove(request_id);
        }
    }
}

// Readers have a separate budget so cancellation can still be parsed while
// all outgoing request slots are occupied. Transfer this reservation to a
// dispatch slot before network work; one reservation lasts through response I/O.
struct ConnectionReader(Arc<AtomicUsize>);

impl ConnectionReader {
    fn acquire(active: &Arc<AtomicUsize>) -> Option<Self> {
        active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_CONNECTION_READERS).then_some(count + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(active)))
    }
}

impl Drop for ConnectionReader {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

enum ConnectionPermit {
    Reader {
        _reader: ConnectionReader,
    },
    Dispatch {
        _dispatch: crate::request_guard::DispatchPermit,
    },
}

pub(crate) struct NativeResearchBridge {
    url: String,
    token: String,
    stopped: Arc<AtomicBool>,
}

impl NativeResearchBridge {
    pub(crate) fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("Could not bind the Native research bridge: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the Native research bridge: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the Native research bridge: {error}"))?
            .port();
        let token = random_token()?;
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_token = token.clone();
        let worker_stopped = Arc::clone(&stopped);
        let cancellations = Arc::new(Mutex::new(CancellationRegistry::default()));
        let worker_cancellations = Arc::clone(&cancellations);
        let readers = Arc::new(AtomicUsize::new(0));
        thread::spawn(move || {
            while !worker_stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, address)) if address.ip().is_loopback() => {
                        let Some(reader) = ConnectionReader::acquire(&readers) else {
                            let _ = stream.set_write_timeout(Some(Duration::from_millis(50)));
                            write_json_response(
                                &mut stream,
                                503,
                                &serde_json::json!({
                                    "error": "REQUEST_QUEUE_FULL: 请求过多，请稍后重试；本次请求尚未发送。"
                                }),
                            );
                            continue;
                        };
                        let token = worker_token.clone();
                        let cancellations = Arc::clone(&worker_cancellations);
                        thread::spawn(move || {
                            handle_connection(stream, &token, cancellations, reader)
                        });
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            url: format!("http://127.0.0.1:{port}/research"),
            token,
            stopped,
        })
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for NativeResearchBridge {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

#[derive(Deserialize)]
struct BridgeRequest {
    url: String,
    accept: String,
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Deserialize)]
struct BridgeCancelRequest {
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    status: u32,
    content_type: Option<String>,
    location: Option<String>,
    body_base64: String,
}

fn handle_connection(
    stream: TcpStream,
    token: &str,
    cancellations: Arc<Mutex<CancellationRegistry>>,
    reader: ConnectionReader,
) {
    handle_connection_with_response(stream, token, cancellations, reader, |stream, result| {
        match result {
            Ok(response) => write_json_response(stream, 200, &response),
            Err(error) => write_json_response(
                stream,
                if crate::request_guard::is_admission_error(&error) {
                    503
                } else {
                    400
                },
                &serde_json::json!({ "error": normalize_error(&error) }),
            ),
        }
    });
}

fn handle_connection_with_response<F>(
    mut stream: TcpStream,
    token: &str,
    cancellations: Arc<Mutex<CancellationRegistry>>,
    reader: ConnectionReader,
    respond: F,
) where
    F: FnOnce(&mut TcpStream, Result<BridgeResponse, String>),
{
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut connection_permit = ConnectionPermit::Reader { _reader: reader };
    let result = (|| -> Result<BridgeResponse, String> {
        let (path, body) = read_request(&mut stream, token)?;
        if path == "/research/cancel" {
            let request: BridgeCancelRequest = serde_json::from_slice(&body)
                .map_err(|_| "Native research bridge body is invalid")?;
            let cancelled = {
                let mut state = cancellations
                    .lock()
                    .map_err(|_| "Native research bridge cancellation state is unavailable")?;
                state.cancel(&request.request_id, Instant::now())?
            };
            return Ok(BridgeResponse {
                status: 200,
                content_type: Some("application/json".to_string()),
                location: None,
                body_base64: URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&serde_json::json!({ "cancelled": cancelled }))
                        .map_err(|_| "Native research bridge response is invalid")?,
                ),
            });
        }
        if path != "/research" {
            return Err("Native research bridge route is invalid".to_string());
        }
        // Acquire before releasing the reader reservation. On rejection, keep
        // the reader reservation until the error response has been written.
        connection_permit = ConnectionPermit::Dispatch {
            _dispatch: crate::request_guard::try_dispatch().map_err(|error| error.to_string())?,
        };
        let request: BridgeRequest =
            serde_json::from_slice(&body).map_err(|_| "Native research bridge body is invalid")?;
        let target = parse_public_https_url(&request.url)?;
        let cancellation = {
            let mut state = cancellations
                .lock()
                .map_err(|_| "Native research bridge cancellation state is unavailable")?;
            state.register(&request.request_id, Instant::now())?
        };
        // Register before DNS so cancellation during resolution belongs to an
        // active request and cannot expire as an early-cancellation tombstone.
        let response = (|| {
            if cancellation.load(Ordering::Acquire) {
                return Err(crate::request_guard::AdmissionError::Cancelled.to_string());
            }
            assert_public_host(&target.host)?;
            request_public_bytes(PublicHttpRequest {
                host: &target.host,
                path: &target.path,
                accept: &request.accept,
                response_body_limit: RESPONSE_LIMIT,
                cancellation: Some(cancellation.as_ref()),
            })
            .map_err(|error| error.to_string())
        })();
        cancellations
            .lock()
            .map_err(|_| "Native research bridge cancellation state is unavailable")?
            .complete(&request.request_id, &cancellation);
        let response = response?;
        Ok(BridgeResponse {
            status: response.status,
            content_type: response.content_type,
            location: response.location,
            body_base64: URL_SAFE_NO_PAD.encode(response.body),
        })
    })();
    respond(&mut stream, result);
    // A client that does not read its response must still consume a slot.
    drop(connection_permit);
}

fn read_request(stream: &mut TcpStream, token: &str) -> Result<(String, Vec<u8>), String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "Could not read a Native research bridge request".to_string())?;
        if read == 0 || bytes.len() + read > REQUEST_LIMIT {
            return Err("Native research bridge request is invalid".to_string());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "Native research bridge request is invalid".to_string())?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or("Native research bridge route is invalid")?;
    let path = request_line
        .strip_prefix("POST ")
        .and_then(|value| value.strip_suffix(" HTTP/1.1"))
        .ok_or("Native research bridge route is invalid")?
        .to_string();
    if path != "/research" && path != "/research/cancel" {
        return Err("Native research bridge route is invalid".to_string());
    }
    let mut authorized = false;
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("x-ai-video-research-token") && constant_time_eq(value, token)
        {
            authorized = true;
        }
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().ok();
        }
    }
    if !authorized {
        return Err("Native research bridge authorization failed".to_string());
    }
    let content_length = content_length
        .filter(|length| *length <= REQUEST_LIMIT - header_end)
        .ok_or("Native research bridge body is invalid")?;
    while bytes.len() < header_end + content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "Could not read a Native research bridge request".to_string())?;
        if read == 0 || bytes.len() + read > REQUEST_LIMIT {
            return Err("Native research bridge body is invalid".to_string());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok((
        path.to_string(),
        bytes[header_end..header_end + content_length].to_vec(),
    ))
}

fn write_json_response(stream: &mut TcpStream, status: u16, body: &impl Serialize) {
    let Ok(body) = serde_json::to_vec(body) else {
        return;
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        match status { 200 => "OK", 503 => "Service Unavailable", _ => "Bad Request" },
        body.len(),
    );
    let _ = stream.write_all(&body);
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err("Could not generate a Native research bridge capability".to_string());
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for (left, right) in left.bytes().zip(right.bytes()) {
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

fn normalize_error(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{assert_public_host, parse_public_https_url, NativeResearchBridge};
    use std::{
        io::{Read, Write},
        net::TcpStream,
    };

    #[test]
    fn bounds_connection_reader_threads_and_releases_reservations() {
        let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut readers = (0..super::MAX_CONNECTION_READERS)
            .map(|_| super::ConnectionReader::acquire(&active).expect("reader slot"))
            .collect::<Vec<_>>();
        assert!(super::ConnectionReader::acquire(&active).is_none());
        drop(readers.pop());
        let reader = super::ConnectionReader::acquire(&active).expect("released reader slot");
        drop(reader);
        drop(readers);
        assert_eq!(active.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn early_cancellations_are_bounded_expire_and_preserve_active_requests() {
        use std::sync::atomic::Ordering;

        let now = std::time::Instant::now();
        let mut state = super::CancellationRegistry::default();
        let active = state.register("active", now).unwrap();
        for index in 0..super::MAX_EARLY_CANCELLATIONS {
            assert!(state.cancel(&format!("early-{index}"), now).unwrap());
        }
        assert!(state
            .cancel("overflow", now)
            .unwrap_err()
            .starts_with("REQUEST_QUEUE_FULL"));
        assert_eq!(state.early.len(), super::MAX_EARLY_CANCELLATIONS);
        assert!(state.cancel("active", now).unwrap());
        assert!(active.load(Ordering::Acquire));
        let cancelled_before_start = state.register("early-0", now).unwrap();
        assert!(cancelled_before_start.load(Ordering::Acquire));
        assert_eq!(state.early.len(), super::MAX_EARLY_CANCELLATIONS - 1);
        state.complete("early-0", &cancelled_before_start);

        let expired = now + super::EARLY_CANCELLATION_TTL;
        let formerly_cancelled = state.register("early-1", expired).unwrap();
        assert!(!formerly_cancelled.load(Ordering::Acquire));
        assert!(state.early.is_empty());
        assert!(
            active.load(Ordering::Acquire),
            "active cancellations never expire"
        );
        assert!(state.active.contains_key("active"));
        state.complete("active", &active);
        assert!(!state.active.contains_key("active"));
    }

    #[test]
    fn cancellation_registry_validates_keys_and_rejects_duplicate_active_ids() {
        use std::sync::{atomic::AtomicBool, Arc};

        let now = std::time::Instant::now();
        let mut state = super::CancellationRegistry::default();
        for invalid in [
            "",
            "bad key",
            "with/slash",
            "控制",
            "line\nfeed",
            &"a".repeat(129),
        ] {
            assert!(state.cancel(invalid, now).is_err());
            assert!(state.register(invalid, now).is_err());
        }
        assert!(state.early.is_empty());
        assert!(state.active.is_empty());
        let flag = state.register("valid_Base64url-123", now).unwrap();
        assert!(state.register("valid_Base64url-123", now).is_err());
        state.complete("valid_Base64url-123", &Arc::new(AtomicBool::new(false)));
        assert_eq!(
            state.active.len(),
            1,
            "unrelated completions cannot remove an active request"
        );
        state.complete("valid_Base64url-123", &flag);
        assert!(state.active.is_empty());
    }

    #[test]
    fn active_cancellation_entries_have_a_separate_bound() {
        let now = std::time::Instant::now();
        let mut state = super::CancellationRegistry::default();
        let flags: Vec<_> = (0..super::MAX_ACTIVE_CANCELLATIONS)
            .map(|index| state.register(&format!("active-{index}"), now).unwrap())
            .collect();
        assert!(state
            .register("overflow", now)
            .unwrap_err()
            .starts_with("REQUEST_QUEUE_FULL"));
        state.complete("active-0", &flags[0]);
        assert!(state.register("next", now).is_ok());
        assert_eq!(state.active.len(), super::MAX_ACTIVE_CANCELLATIONS);
    }

    #[test]
    fn cancellation_and_invalid_requests_hold_reader_until_response_finishes() {
        use std::sync::{atomic::AtomicUsize, atomic::Ordering, Arc, Mutex};

        for authorized in [true, false] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (server, _) = listener.accept().unwrap();
            let body = r#"{"requestId":"cancelled-before-start"}"#;
            write!(
                client,
                "POST /research/cancel HTTP/1.1\r\nHost: localhost\r\nx-ai-video-research-token: {}\r\nContent-Length: {}\r\n\r\n{}",
                if authorized { "test-capability" } else { "wrong-capability" },
                body.len(),
                body,
            )
            .unwrap();
            let readers = Arc::new(AtomicUsize::new(0));
            let reader = super::ConnectionReader::acquire(&readers).unwrap();
            let cancellations = Arc::new(Mutex::new(super::CancellationRegistry::default()));
            super::handle_connection_with_response(
                server,
                "test-capability",
                Arc::clone(&cancellations),
                reader,
                |_, result| {
                    assert_eq!(result.is_ok(), authorized);
                    assert_eq!(
                        readers.load(Ordering::Acquire),
                        1,
                        "parsed requests still occupy a slot during response I/O"
                    );
                    if authorized {
                        assert!(cancellations
                            .lock()
                            .unwrap()
                            .early
                            .contains_key("cancelled-before-start"));
                    }
                },
            );
            assert_eq!(readers.load(Ordering::Acquire), 0);
        }
    }

    #[test]
    fn rejects_private_and_credentialed_research_targets() {
        assert!(parse_public_https_url("http://example.com/").is_err());
        assert!(parse_public_https_url("https://user@example.com/").is_err());
        assert!(parse_public_https_url("https://example.com:444/").is_err());
        assert!(assert_public_host("localhost").is_err());
    }

    #[test]
    fn bridge_requires_its_process_scoped_capability() {
        let bridge = NativeResearchBridge::start().expect("bridge should start");
        let address = bridge
            .url()
            .strip_prefix("http://")
            .expect("bridge URL should be HTTP");
        let mut stream = TcpStream::connect(address.split('/').next().expect("bridge host"))
            .expect("bridge should accept loopback connections");
        let body = r#"{"url":"https://localhost/","accept":"text/html,application/xhtml+xml,application/json;q=0.8","requestId":"test"}"#;
        write!(
            stream,
            "POST /research HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body,
        )
        .expect("bridge request should be written");
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("bridge response should be readable");
        assert!(response.starts_with("HTTP/1.1 400"));
    }
}
