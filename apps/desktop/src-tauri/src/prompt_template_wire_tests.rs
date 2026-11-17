//! Opt-in actual HTTP verification of requests captured from a packaged Worker.
use super::*;
use sha2::Digest;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
    time::Duration,
};

#[test]
#[ignore = "Requires P22_TEMPLATE_CAPTURE_DIR from the two offline sidecar validators"]
fn packaged_worker_templates_survive_native_http() {
    let directory = std::path::PathBuf::from(std::env::var("P22_TEMPLATE_CAPTURE_DIR").unwrap());
    let mut reports = Vec::new();
    for entry in std::fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        if !path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ordinary-")
            && !path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("bundle-")
        {
            continue;
        }
        let capture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut runtime: LlmRuntimeRequest =
            serde_json::from_value(capture["params"].clone()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        runtime.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let protocol = runtime.protocol.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut wire = Vec::new();
            let mut chunk = [0; 8192];
            let received = loop {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                wire.extend_from_slice(&chunk[..n]);
                if let Some(end) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&wire[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if wire.len() >= end + 4 + length {
                        break wire[end + 4..end + 4 + length].to_vec();
                    }
                }
            };
            let payload = if protocol == "openai-chat-completions" {
                "data: {\"choices\":[{\"delta\":{\"content\":\"哈哈110\\n\\n\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            } else {
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"哈哈110\\n\\n\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_local\",\"status\":\"completed\"}}\n\n"
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",payload.len()).unwrap();
            received
        });
        let mut reported_hash = None;
        let mut text = String::new();
        let scheduler = request_guard::isolated_for_tests();
        stream_provider_with_admission(
            runtime,
            CredentialSecret::for_test("local-dummy-key"),
            Arc::new(LlmCancellation::default()),
            |event| {
                match event {
                    LlmStreamEvent::RequestProgress {
                        request_body_hash: Some(hash),
                        ..
                    } => reported_hash = Some(hash),
                    LlmStreamEvent::Delta { delta } => text.push_str(&delta),
                    _ => {}
                };
                Ok(())
            },
            true,
            |origin, cancelled| scheduler.acquire(origin, || cancelled.is_cancelled()),
        )
        .unwrap();
        assert_eq!(text, "哈哈110\n\n");
        let received = server.join().unwrap();
        let hash = format!("{:x}", sha2::Sha256::digest(&received));
        assert_eq!(reported_hash.as_deref(), Some(hash.as_str()));
        let body: serde_json::Value = serde_json::from_slice(&received).unwrap();
        let input = body.get("messages").or_else(|| body.get("input")).unwrap();
        let empty = Vec::new();
        let messages = input.as_array().unwrap_or(&empty);
        let mut texts: Vec<String> = messages
            .iter()
            .filter(|m| m["role"] == "user")
            .map(|m| {
                m["content"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    m["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
            })
            .collect();
        if let Some(text) = input.as_str() {
            texts.push(text.to_string());
        }
        let user = texts.join("\n");
        let expected = &capture["expected"];
        let general = expected["general"].as_str().unwrap();
        if !general.is_empty() {
            assert_eq!(
                user.matches(general).count(),
                1,
                "{} general",
                path.display()
            );
        }
        for (kind, value) in expected["templates"].as_object().unwrap() {
            let template = value.as_str().unwrap();
            if template.is_empty() {
                continue;
            }
            assert_eq!(
                user.matches(template).count(),
                usize::from(expected["purpose"].as_str() == Some(kind.as_str())),
                "{} {kind}",
                path.display()
            );
        }
        std::fs::write(path.with_extension("http-body"), &received).unwrap();
        reports.push(serde_json::json!({"capture":path.file_name().unwrap().to_string_lossy(),"protocol":capture["params"]["protocol"],"bodyHash":hash,"bytes":received.len(),"purpose":expected["purpose"],"exactTemplates":true,"exactResponse":true}));
    }
    assert!(
        reports.len() >= 20,
        "Run both sidecar validators with capture enabled"
    );
    std::fs::write(
        directory.join("http-verification-report.json"),
        serde_json::to_vec_pretty(&reports).unwrap(),
    )
    .unwrap();
}
