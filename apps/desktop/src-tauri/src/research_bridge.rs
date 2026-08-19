use std::{
    io::{Read, Write},
    net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

use crate::provider_http::{request_public_bytes, PublicHttpRequest};

const REQUEST_LIMIT: usize = 32 * 1024;
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

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
        let cancellations = Arc::new(Mutex::new(std::collections::HashMap::<
            String,
            Arc<AtomicBool>,
        >::new()));
        let worker_cancellations = Arc::clone(&cancellations);
        thread::spawn(move || {
            while !worker_stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, address)) if address.ip().is_loopback() => {
                        let token = worker_token.clone();
                        let cancellations = Arc::clone(&worker_cancellations);
                        thread::spawn(move || handle_connection(stream, &token, cancellations));
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
    mut stream: TcpStream,
    token: &str,
    cancellations: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let result = (|| -> Result<BridgeResponse, String> {
        let (path, body) = read_request(&mut stream, token)?;
        if path == "/research/cancel" {
            let request: BridgeCancelRequest = serde_json::from_slice(&body)
                .map_err(|_| "Native research bridge body is invalid")?;
            let cancelled = {
                let mut state = cancellations
                    .lock()
                    .map_err(|_| "Native research bridge cancellation state is unavailable")?;
                let flag = state
                    .entry(request.request_id)
                    .or_insert_with(|| Arc::new(AtomicBool::new(false)));
                flag.store(true, Ordering::Release);
                true
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
        let request: BridgeRequest =
            serde_json::from_slice(&body).map_err(|_| "Native research bridge body is invalid")?;
        let target = parse_public_https_url(&request.url)?;
        assert_public_host(&target.host)?;
        let cancellation = {
            let mut state = cancellations
                .lock()
                .map_err(|_| "Native research bridge cancellation state is unavailable")?;
            Arc::clone(
                state
                    .entry(request.request_id.clone())
                    .or_insert_with(|| Arc::new(AtomicBool::new(false))),
            )
        };
        let response = request_public_bytes(PublicHttpRequest {
            host: &target.host,
            path: &target.path,
            accept: &request.accept,
            response_body_limit: RESPONSE_LIMIT,
            cancellation: Some(cancellation.as_ref()),
        });
        let _ = cancellations
            .lock()
            .map_err(|_| "Native research bridge cancellation state is unavailable")?
            .remove(&request.request_id);
        let response = response.map_err(|error| error.to_string())?;
        Ok(BridgeResponse {
            status: response.status,
            content_type: response.content_type,
            location: response.location,
            body_base64: URL_SAFE_NO_PAD.encode(response.body),
        })
    })();
    match result {
        Ok(response) => write_json_response(&mut stream, 200, &response),
        Err(error) => write_json_response(
            &mut stream,
            400,
            &serde_json::json!({ "error": normalize_error(&error) }),
        ),
    }
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
        if status == 200 { "OK" } else { "Bad Request" },
        body.len(),
    );
    let _ = stream.write_all(&body);
}

struct PublicHttpsUrl {
    host: String,
    path: String,
}

fn parse_public_https_url(value: &str) -> Result<PublicHttpsUrl, String> {
    let remainder = value
        .strip_prefix("https://")
        .ok_or("Research URLs must use HTTPS")?;
    if remainder.is_empty() || remainder.contains(['\\', '#', '\r', '\n', '\0', '@']) {
        return Err("Research URL is invalid".to_string());
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
        return Err("Research URL host is invalid".to_string());
    }
    let path = if split == remainder.len() {
        "/".to_string()
    } else if remainder.as_bytes()[split] == b'?' {
        format!("/{}", &remainder[split..])
    } else {
        remainder[split..].to_string()
    };
    if path.contains(['\r', '\n', '\0']) || path.starts_with("//") {
        return Err("Research URL path is invalid".to_string());
    }
    Ok(PublicHttpsUrl {
        host: host.to_ascii_lowercase(),
        path,
    })
}

fn assert_public_host(host: &str) -> Result<(), String> {
    let addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|_| "Research hostname could not be resolved safely".to_string())?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if addresses.is_empty() || !addresses.iter().all(is_public_address) {
        return Err("Research hostname is outside the public network boundary".to_string());
    }
    Ok(())
}

fn is_public_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let [a, b, ..] = value.octets();
            !value.is_private()
                && !value.is_loopback()
                && !value.is_link_local()
                && !value.is_unspecified()
                && !value.is_multicast()
                && !value.is_broadcast()
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && (b == 0 || b == 168))
                && !(a == 198 && (b == 18 || b == 19 || b == 51))
                && !(a == 203 && b == 0)
        }
        IpAddr::V6(value) => {
            !value.is_loopback()
                && !value.is_unspecified()
                && !value.is_multicast()
                && !value.is_unique_local()
                && !value.is_unicast_link_local()
                && !value.to_string().starts_with("2001:db8:")
        }
    }
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
