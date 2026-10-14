//! Official Wan / Seedance / MiniMax video transport. Credentials and upload grants stay Native.
use crate::{
    credential_store::credential_read,
    model_contract,
    provider_http::{
        self, DubbingCancellation, DubbingHttpBody, DubbingHttpRequest, DubbingHttpTarget,
        RawHttpResponse,
    },
    schema_validation,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::PathBuf;
use std::{
    collections::HashMap,
    fs::File,
    io::{Cursor, Read},
    time::{SystemTime, UNIX_EPOCH},
};

const JSON_LIMIT: usize = 2 * 1024 * 1024;
const REQUEST_LIMIT: usize = 64 * 1024 * 1024;
#[cfg(test)]
type FixtureTransport =
    Box<dyn for<'a> FnMut(&mut DubbingHttpRequest<'a>) -> Result<RawHttpResponse, Value>>;
#[cfg(test)]
thread_local! {
    static FIXTURE_HTTP: std::cell::RefCell<Option<FixtureTransport>> = const { std::cell::RefCell::new(None) };
    static FIXTURE_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
fn video_credential(subject: &str) -> Result<crate::credential_store::CredentialSecret, Value> {
    #[cfg(test)]
    if FIXTURE_HTTP.with(|fixture| fixture.borrow().is_some()) {
        return Ok(crate::credential_store::CredentialSecret::for_test(
            "official-fixture-key",
        ));
    }
    credential_read(subject).map_err(|_| invalid("官方连接密钥不可用。"))
}

pub(crate) fn family(adapter: &str) -> Option<&'static str> {
    match adapter.split(':').nth(1) {
        Some("wan-video") => Some("wan"),
        Some("seedance-video") => Some("seedance"),
        Some("minimax-video") => Some("minimax"),
        _ => None,
    }
}
fn error(code: &str, message: &str, retryable: bool) -> Value {
    json!({"code":code,"message":message,"retryable":retryable})
}
fn invalid(message: &str) -> Value {
    error("INVALID_PARAMETERS", message, false)
}
fn transport(request: DubbingHttpRequest<'_>, paid: bool) -> Result<RawHttpResponse, Value> {
    #[cfg(test)]
    let mut request = request;
    #[cfg(test)]
    if FIXTURE_HTTP.with(|fixture| fixture.borrow().is_some()) {
        return FIXTURE_HTTP.with(|fixture| fixture.borrow_mut().as_mut().unwrap()(&mut request));
    }
    provider_http::request_dubbing_file(request).map_err(|failure| {
        error(
            if paid && failure.request_may_have_been_sent() {
                "SUBMISSION_UNKNOWN"
            } else {
                "REQUEST_NOT_SENT"
            },
            "官方视频传输未完成，请按任务状态核对；不会自动重新提交。",
            true,
        )
    })
}
fn request_json(
    family: &str,
    operation: &str,
    id: &str,
    base_url: Option<&str>,
    secret: &str,
    body: Option<&Value>,
    cancellation: &DubbingCancellation,
) -> Result<RawHttpResponse, Value> {
    let bytes = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| invalid("官方视频请求编码失败。"))?;
    if bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > REQUEST_LIMIT)
    {
        return Err(invalid("官方视频请求超过 64 MiB，请减少输入素材。"));
    }
    let mut reader = Cursor::new(bytes.as_deref().unwrap_or_default());
    transport(
        DubbingHttpRequest {
            target: DubbingHttpTarget::OfficialVideo {
                family,
                operation,
                id,
                base_url,
            },
            secret: Some(secret),
            idempotency_key: None,
            body: bytes.as_ref().map(|bytes| DubbingHttpBody {
                reader: &mut reader,
                size: bytes.len() as u32,
                content_type: "application/json",
            }),
            output: None,
            response_limit: JSON_LIMIT,
            cancellation,
        },
        operation == "submit",
    )
}
fn json_body(response: &RawHttpResponse) -> Result<Value, Value> {
    if !(200..300).contains(&response.status) {
        return Err(error(
            "REQUEST_NOT_SENT",
            "官方素材上传或连接请求失败，生成请求尚未发送。",
            true,
        ));
    }
    serde_json::from_slice(&response.body).map_err(|_| invalid("官方接口没有返回合法 JSON。"))
}

pub(crate) fn test_connection(
    provider_type: &str,
    base_url: &str,
    secret: &str,
) -> Result<u32, String> {
    let (family, operation, id) = match provider_type {
        "wan-video" => ("wan", "policy", "wan3.0-video"),
        "seedance-video" => ("seedance", "test", ""),
        "minimax-video" => ("minimax", "test", ""),
        _ => return Err("Unknown official video provider".into()),
    };
    let response = request_json(
        family,
        operation,
        id,
        Some(base_url),
        secret,
        None,
        &DubbingCancellation::default(),
    )
    .map_err(|_| "Official video connection transport failed")?;
    if response.status == 200 {
        let body: Value = serde_json::from_slice(&response.body)
            .map_err(|_| "Official video connection returned invalid JSON")?;
        if body
            .pointer("/base_resp/status_code")
            .and_then(Value::as_u64)
            .is_some_and(|code| code != 0)
        {
            return Ok(401);
        }
    }
    Ok(response.status)
}

fn multipart(
    fields: &[(String, String)],
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<(String, Vec<u8>), Value> {
    let boundary = format!(
        "xlng{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    if bytes
        .windows(boundary.len())
        .any(|part| part == boundary.as_bytes())
    {
        return Err(invalid("输入文件包含无效上传分隔符。"));
    }
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}
fn upload(
    family: &str,
    model: &str,
    base_url: Option<&str>,
    secret: &str,
    mime: &str,
    bytes: &[u8],
    cancellation: &DubbingCancellation,
) -> Result<String, Value> {
    let extension = match mime {
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        _ => return Err(invalid("当前官方输入不支持这个媒体格式。")),
    };
    if family == "seedance" {
        if mime == "video/mp4" {
            return Err(invalid(
                "Seedance 参考视频请使用官方素材 ID 或公网 URL；音频和图片可直接使用本地文件。",
            ));
        }
        let inline_mime = if mime == "audio/mpeg" {
            "audio/mp3"
        } else {
            mime
        };
        return Ok(format!(
            "data:{inline_mime};base64,{}",
            STANDARD.encode(bytes)
        ));
    }
    let filename = format!(
        "{:x}-{:x}.{extension}",
        Sha256::digest(bytes),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    if family == "minimax" {
        let (content_type, body) = multipart(
            &[("purpose".into(), "video_generation_input".into())],
            &filename,
            mime,
            bytes,
        )?;
        let mut reader = Cursor::new(body.as_slice());
        let response = transport(
            DubbingHttpRequest {
                target: DubbingHttpTarget::OfficialVideo {
                    family,
                    operation: "upload",
                    id: "",
                    base_url,
                },
                secret: Some(secret),
                idempotency_key: None,
                body: Some(DubbingHttpBody {
                    reader: &mut reader,
                    size: body.len() as u32,
                    content_type: &content_type,
                }),
                output: None,
                response_limit: JSON_LIMIT,
                cancellation,
            },
            false,
        )?;
        let result = json_body(&response)?;
        let id = result
            .pointer("/file/file_id")
            .ok_or_else(|| invalid("MiniMax 上传没有返回文件 ID。"))?;
        let id = id
            .as_str()
            .map(str::to_string)
            .or_else(|| id.as_u64().map(|id| id.to_string()))
            .ok_or_else(|| invalid("MiniMax 文件 ID 无效。"))?;
        if id.is_empty()
            || id.len() > 160
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(invalid("MiniMax 文件 ID 无效。"));
        }
        return Ok(format!("mm_file://{id}"));
    }
    let policy = json_body(&request_json(
        family,
        "policy",
        model,
        base_url,
        secret,
        None,
        cancellation,
    )?)?;
    let policy = policy
        .get("data")
        .ok_or_else(|| invalid("百炼没有返回上传凭证。"))?;
    let get = |key: &str| -> Result<&str, Value> {
        policy[key]
            .as_str()
            .filter(|text| !text.is_empty() && text.len() < 65536 && !text.contains(['\r', '\n']))
            .ok_or_else(|| invalid("百炼上传凭证不完整。"))
    };
    let host = provider_http::parse_public_https_url(get("upload_host")?)
        .map_err(|_| invalid("百炼上传主机无效。"))?;
    let directory = get("upload_dir")?;
    if directory.contains("..")
        || directory.starts_with('/')
        || directory.contains(['\\', '?', '#'])
    {
        return Err(invalid("百炼上传目录无效。"));
    }
    let key = format!("{directory}/{filename}");
    let fields = vec![
        ("OSSAccessKeyId".into(), get("oss_access_key_id")?.into()),
        ("Signature".into(), get("signature")?.into()),
        ("policy".into(), get("policy")?.into()),
        ("x-oss-object-acl".into(), get("x_oss_object_acl")?.into()),
        (
            "x-oss-forbid-overwrite".into(),
            get("x_oss_forbid_overwrite")?.into(),
        ),
        ("key".into(), key.clone()),
        ("success_action_status".into(), "200".into()),
    ];
    let (content_type, body) = multipart(&fields, &filename, mime, bytes)?;
    let mut reader = Cursor::new(body.as_slice());
    let response = transport(
        DubbingHttpRequest {
            target: DubbingHttpTarget::OfficialStorage(&host),
            secret: None,
            idempotency_key: None,
            body: Some(DubbingHttpBody {
                reader: &mut reader,
                size: body.len() as u32,
                content_type: &content_type,
            }),
            output: None,
            response_limit: JSON_LIMIT,
            cancellation,
        },
        false,
    )?;
    if response.status != 200 || response.location.is_some() {
        return Err(error(
            "REQUEST_NOT_SENT",
            "百炼文件上传失败，生成请求尚未发送。",
            true,
        ));
    }
    Ok(format!("oss://{key}"))
}

fn walk_replace(value: &mut Value, replacements: &HashMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(replacement) = replacements.get(text) {
                *text = replacement.clone();
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| walk_replace(value, replacements)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| walk_replace(value, replacements)),
        _ => {}
    }
}
fn is_controlled(value: &Value) -> bool {
    match value {
        Value::String(text) => text.starts_with("controlled-file://"),
        Value::Array(values) => values.iter().any(is_controlled),
        Value::Object(values) => values.values().any(is_controlled),
        _ => false,
    }
}
fn canonical_request(adapter: &str, parameters: &Value, model: &str) -> Result<Value, Value> {
    if !model_contract::matches_model(adapter, model) {
        return Err(invalid("官方模型与合同绑定不匹配。"));
    }
    let contract = model_contract::contract(adapter).map_err(|_| invalid("官方合同尚未启用。"))?;
    schema_validation::validate(&contract["parameterSchema"], parameters)
        .map_err(|_| invalid("参数未通过官方合同校验。"))?;
    let mut body = json!({"model":model});
    for mapping in contract["transport"]["request"]
        .as_array()
        .ok_or_else(|| invalid("官方传输映射缺失。"))?
    {
        if mapping["operation"] != "copy" {
            return Err(invalid("官方传输映射不受支持。"));
        }
        let from = mapping["from"]
            .as_str()
            .ok_or_else(|| invalid("官方传输字段无效。"))?;
        let Some(value) = parameters.get(from) else {
            continue;
        };
        let path = mapping["to"]
            .as_str()
            .ok_or_else(|| invalid("官方传输字段无效。"))?;
        let mut target = &mut body;
        let parts: Vec<_> = path.split('.').collect();
        for part in &parts[..parts.len() - 1] {
            if target.get(*part).is_none() {
                target[*part] = json!({});
            }
            target = &mut target[*part];
        }
        target[parts[parts.len() - 1]] = value.clone();
    }
    Ok(body)
}

pub(crate) fn submit(params: &Value) -> Result<Value, Value> {
    let adapter = params["adapterKey"].as_str().unwrap_or_default();
    let family = family(adapter).ok_or_else(|| invalid("官方视频连接无效。"))?;
    let model = params["remoteModelId"].as_str().unwrap_or_default();
    let mut parameters = params["parameters"].clone();
    let operation = params["operationId"]
        .as_str()
        .unwrap_or(params["projectSessionId"].as_str().unwrap_or_default())
        .to_string();
    let operation = crate::dubbing_provider::Operation::register(&operation)?;
    let cancellation = operation.cancellation.clone();
    let result = (|| {
        let mut placeholders = HashMap::new();
        if let Some(inputs) = params["inputs"].as_array() {
            for input in inputs {
                if let Some(handle) = input["handle"].as_str() {
                    placeholders.insert(
                        format!("controlled-file://{handle}"),
                        "https://controlled-input.invalid/media".into(),
                    );
                }
            }
        }
        let mut validation = parameters.clone();
        walk_replace(&mut validation, &placeholders);
        canonical_request(adapter, &validation, model)?;
        let secret = video_credential(params["providerProfileId"].as_str().unwrap_or_default())?;
        let secret = secret.as_str().map_err(|_| invalid("官方连接密钥无效。"))?;
        let root = crate::model_input_root();
        #[cfg(test)]
        let root = FIXTURE_ROOT
            .with(|fixture| fixture.borrow().clone())
            .or(root);
        let mut handles: Vec<File> = Vec::new();
        let mut replacements = HashMap::new();
        if is_controlled(&parameters) {
            let root = root.ok_or_else(|| invalid("受控媒体根目录不可用。"))?;
            for input in params["inputs"]
                .as_array()
                .ok_or_else(|| invalid("受控媒体输入未登记。"))?
            {
                if input["type"] != "controlled_temporary_file" {
                    continue;
                }
                let relative = input["handle"]
                    .as_str()
                    .ok_or_else(|| invalid("受控媒体输入无效。"))?;
                let mut file = crate::dubbing_provider::open_model_input(&root, relative)
                    .map_err(|_| invalid("受控媒体文件不可用或路径越界。"))?;
                let size = file
                    .metadata()
                    .map_err(|_| invalid("无法检查媒体文件。"))?
                    .len();
                if size == 0
                    || size > 100 * 1024 * 1024
                    || input["sizeBytes"].as_u64() != Some(size)
                {
                    return Err(invalid("受控媒体文件大小已变化或超限。"));
                }
                let mut bytes = Vec::with_capacity(size as usize);
                file.read_to_end(&mut bytes)
                    .map_err(|_| invalid("读取受控媒体文件失败。"))?;
                if input["sha256"].as_str()
                    != Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
                {
                    return Err(invalid("媒体文件与已确认快照不一致。"));
                }
                let mime = input["contentType"]
                    .as_str()
                    .ok_or_else(|| invalid("媒体类型缺失。"))?;
                verify_signature(mime, &bytes)?;
                if cancellation.is_cancelled() {
                    return Err(error("CANCELLED", "制作已取消。", false));
                }
                let uri = upload(
                    family,
                    model,
                    params["baseUrl"].as_str(),
                    secret,
                    mime,
                    &bytes,
                    &cancellation,
                )?;
                replacements.insert(format!("controlled-file://{relative}"), uri);
                handles.push(file);
            }
            walk_replace(&mut parameters, &replacements);
            if is_controlled(&parameters) {
                return Err(invalid("存在未登记的媒体文件引用。"));
            }
        }
        if cancellation.is_cancelled() {
            return Err(error("CANCELLED", "制作已取消，生成请求尚未发送。", false));
        }
        let body = canonical_request(adapter, &parameters, model)?;
        let response = request_json(
            family,
            "submit",
            "",
            params["baseUrl"].as_str(),
            secret,
            Some(&body),
            &cancellation,
        )?;
        if response.status == 408 || response.status >= 500 {
            return Err(error(
                "SUBMISSION_UNKNOWN",
                "官方提交响应超时或异常，请先核对远端任务。",
                false,
            ));
        }
        if !(200..300).contains(&response.status) {
            return Ok(
                json!({"status":response.status,"taskId":null,"errorMessage":"官方供应商拒绝视频请求，请检查连接权限和模型参数。"}),
            );
        }
        let result: Value = serde_json::from_slice(&response.body).map_err(|_| {
            error(
                "SUBMISSION_UNKNOWN",
                "供应商返回无效响应，请先核对远端任务。",
                false,
            )
        })?;
        if result
            .pointer("/base_resp/status_code")
            .and_then(Value::as_u64)
            .is_some_and(|code| code != 0)
        {
            return Ok(
                json!({"status":400,"taskId":null,"errorMessage":"MiniMax 明确拒绝视频请求，请核对账号权限、模型和输入素材。"}),
            );
        }
        let task_id = match family {
            "wan" => result.pointer("/output/task_id"),
            "seedance" => result.get("id"),
            _ => result.get("task_id"),
        }
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 160
                && !id.contains("..")
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .ok_or_else(|| {
            error(
                "SUBMISSION_UNKNOWN",
                "供应商没有返回安全任务 ID，请先核对远端任务。",
                false,
            )
        })?;
        Ok(json!({"status":response.status,"taskId":task_id,"state":"queued"}))
    })();
    result
}

fn verify_signature(mime: &str, bytes: &[u8]) -> Result<(), Value> {
    let valid = match mime {
        "audio/wav" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || bytes.len() > 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0
        }
        "video/mp4" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid("媒体文件签名与类型不一致。"))
    }
}

pub(crate) fn poll(params: &Value) -> Result<Value, Value> {
    let family = family(params["adapterKey"].as_str().unwrap_or_default())
        .ok_or_else(|| invalid("官方视频连接无效。"))?;
    let secret = video_credential(params["providerProfileId"].as_str().unwrap_or_default())?;
    let cancellation = DubbingCancellation::default();
    let response = request_json(
        family,
        "poll",
        params["providerTaskId"].as_str().unwrap_or_default(),
        params["baseUrl"].as_str(),
        secret.as_str().map_err(|_| invalid("官方连接密钥无效。"))?,
        None,
        &cancellation,
    )?;
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let (state, url) = status_output(family, &body);
    let mut result = json!({"providerStatus":response.status,"state":if response.status==429||response.status>=500{"running"}else if !(200..300).contains(&response.status){"failed"}else{state},"providerState":state});
    if let Some(retry_after) = response
        .retry_after
        .as_deref()
        .and_then(provider_http::parse_retry_after_ms)
    {
        result["retryAfterMs"] = json!(retry_after);
    }
    if state == "succeeded" && (200..300).contains(&response.status) {
        let url =
            url.ok_or_else(|| error("PROVIDER_FAILED", "供应商报告成功但没有视频地址。", false))?;
        let output = crate::provider_download_remote_video_blocking(url).map_err(|_| {
            error(
                "PROVIDER_FAILED",
                "官方视频下载或验证失败，可恢复查询原任务。",
                true,
            )
        })?;
        result["output"] = json!({"type":"native_temporary_file","path":output.path,"contentType":output.content_type});
    } else if result["state"] == "failed" || result["state"] == "cancelled" {
        result["error"] = json!({"message":"官方视频任务失败、过期或取消，请查看任务日志并核对供应商记录。","retryable":false});
    }
    Ok(result)
}
fn status_output<'a>(family: &str, body: &'a Value) -> (&'static str, Option<&'a str>) {
    let raw = match family {
        "wan" => body.pointer("/output/task_status"),
        "seedance" => body.get("status"),
        _ => body.pointer("/task/status"),
    }
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_ascii_lowercase();
    let state = match raw.as_str() {
        "pending" | "queued" => "queued",
        "running" | "processing" => "running",
        "succeeded" | "completed" => "succeeded",
        "cancelled" | "canceled" => "cancelled",
        _ => "failed",
    };
    let url = match family {
        "wan" => body.pointer("/output/video_url"),
        "seedance" => body.pointer("/content/video_url"),
        _ => body.pointer("/task/content/url"),
    }
    .and_then(Value::as_str);
    (state, url)
}
pub(crate) fn cancel(params: &Value) -> Result<Value, Value> {
    if let Some(operation) = params["operationId"].as_str() {
        crate::dubbing_provider::cancel_operation(operation)?;
    }
    // Running video tasks are not guaranteed remotely cancellable; never claim a refund or deletion.
    Ok(json!({"supported":false,"cancelled":false,"status":200}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_dispatch_prevents_upload_and_paid_submission() {
        let (_guard, mut params, seen) = install("wan", false);
        params["operationId"] = json!("official-video-cancel-before-dispatch");
        assert_eq!(cancel(&params).unwrap()["supported"], false);
        assert_eq!(submit(&params).unwrap_err()["code"], "INTERRUPTED");
        assert!(seen.borrow().is_empty());
    }
    fn raw(status: u32, body: Value) -> RawHttpResponse {
        RawHttpResponse {
            status,
            body: serde_json::to_vec(&body).unwrap(),
            content_type: Some("application/json".into()),
            location: None,
            retry_after: None,
        }
    }
    struct FixtureGuard {
        root: PathBuf,
    }
    impl Drop for FixtureGuard {
        fn drop(&mut self) {
            FIXTURE_HTTP.with(|fixture| *fixture.borrow_mut() = None);
            FIXTURE_ROOT.with(|fixture| *fixture.borrow_mut() = None);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn install(
        family: &str,
        fail_submit: bool,
    ) -> (
        FixtureGuard,
        Value,
        std::rc::Rc<std::cell::RefCell<Vec<Value>>>,
    ) {
        let root = std::env::temp_dir().join(format!(
            "xlng-official-fixture-{family}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("cache/media-inputs")).unwrap();
        let bytes = b"RIFFxxxxWAVEfixture-audio";
        std::fs::write(root.join("cache/media-inputs/input.wav"), bytes).unwrap();
        FIXTURE_ROOT.with(|fixture| *fixture.borrow_mut() = Some(root.clone()));
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let captured = seen.clone();
        FIXTURE_HTTP.with(|fixture|*fixture.borrow_mut()=Some(Box::new(move|request|{
            let mut bytes=Vec::new();if let Some(body)=request.body.as_mut(){body.reader.read_to_end(&mut bytes).unwrap();}
            match request.target {
                DubbingHttpTarget::OfficialVideo{family,operation:"policy",id,base_url}=>{assert_eq!(family,"wan");assert_eq!(id,"wan3.0-video");assert_eq!(base_url,Some("https://fixture-space.cn-beijing.maas.aliyuncs.com"));Ok(raw(200,json!({"data":{"upload_host":"https://fixture.oss-cn-beijing.aliyuncs.com/","upload_dir":"dashscope-instant/fixture","oss_access_key_id":"fixture-access","signature":"private-upload-signature","policy":"fixture-policy","x_oss_object_acl":"private","x_oss_forbid_overwrite":"true"}})))},
                DubbingHttpTarget::OfficialStorage(_)=>{assert!(request.secret.is_none());assert!(String::from_utf8_lossy(&bytes).contains("name=\"OSSAccessKeyId\""));Ok(raw(200,json!({})))},
                DubbingHttpTarget::OfficialVideo{operation:"upload",..}=>{assert!(String::from_utf8_lossy(&bytes).contains("video_generation_input"));Ok(raw(200,json!({"file":{"file_id":42},"base_resp":{"status_code":0}})))},
                DubbingHttpTarget::OfficialVideo{family,operation:"submit",..}=>{captured.borrow_mut().push(serde_json::from_slice(&bytes).unwrap());if fail_submit{return Ok(raw(500,json!({})));}Ok(raw(200,match family{"wan"=>json!({"output":{"task_id":"task-wan"}}),"seedance"=>json!({"id":"task-seedance"}),_=>json!({"task_id":"task-minimax"})}))},
                DubbingHttpTarget::OfficialVideo{family,operation:"poll",id,base_url}=>{assert!(id.starts_with("task-"));if family=="wan"{assert_eq!(base_url,Some("https://fixture-space.cn-beijing.maas.aliyuncs.com"));}Ok(raw(200,match family{"wan"=>json!({"output":{"task_status":"PENDING"}}),"seedance"=>json!({"status":"running"}),_=>json!({"task":{"status":"queued"}})}))},
                _=>panic!("Unexpected official operation"),
            }
        })));
        let (provider, contract, revision, model) = match family {
            "wan" => ("wan-video", "cn.qwen.wan3-0-video", 3, "wan3.0-video"),
            "seedance" => (
                "seedance-video",
                "cn.bytedance.seedance2-5.video",
                2,
                "doubao-seedance-2-5-260628",
            ),
            _ => ("minimax-video", "cn.minimax.h3.video", 2, "MiniMax-H3"),
        };
        let uri = "controlled-file://cache/media-inputs/input.wav";
        let parameters = match family {
            "wan" => {
                json!({"prompt":"角色说你好，音色参考音频1。","media":[{"type":"reference_audio","url":uri}],"duration":5})
            }
            _ => {
                json!({"content":[{"type":"text","text":"角色说你好，音色参考音频1。"},{"type":"audio_url","role":"reference_audio","audio_url":{"url":uri}}],"duration":5,"resolution":if family=="minimax"{"768P"}else{"720p"}})
            }
        };
        let mut params = json!({"adapterKey":format!("REFERENCE_TO_VIDEO:{provider}:{contract}:contract-{revision}"),"remoteModelId":model,"providerProfileId":"11111111-1111-4111-8111-111111111111","projectSessionId":"fixture-session","operationId":format!("fixture-{family}-{}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()),"parameters":parameters,"inputs":[{"type":"controlled_temporary_file","handle":"cache/media-inputs/input.wav","contentType":"audio/wav","sizeBytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"durationMs":3000}]});
        if family == "wan" {
            params["baseUrl"] = json!("https://fixture-space.cn-beijing.maas.aliyuncs.com");
        }
        (FixtureGuard { root }, params, seen)
    }
    #[test]
    fn three_official_submissions_materialize_local_audio_and_resume_the_same_task() {
        for family in ["wan", "seedance", "minimax"] {
            let (_guard, params, seen) = install(family, false);
            let result = submit(&params).unwrap();
            assert_eq!(result["status"], 200);
            assert!(!result.to_string().contains("signature"));
            let body = seen.borrow()[0].clone();
            match family {
                "wan" => assert!(body["input"]["media"][0]["url"]
                    .as_str()
                    .unwrap()
                    .starts_with("oss://")),
                "seedance" => assert!(body["content"][1]["audio_url"]["url"]
                    .as_str()
                    .unwrap()
                    .starts_with("data:audio/wav;base64,")),
                _ => assert_eq!(body["content"][1]["audio_url"]["url"], "mm_file://42"),
            }
            let mut poll_params = params.clone();
            poll_params["providerTaskId"] = result["taskId"].clone();
            let state = poll(&poll_params).unwrap();
            assert!(state["state"] == "queued" || state["state"] == "running");
            assert_eq!(seen.borrow().len(), 1);
        }
    }
    #[test]
    fn changed_input_never_submits_and_server_failures_remain_unknown() {
        let (_guard, mut params, seen) = install("seedance", false);
        params["inputs"][0]["sha256"] = json!("f".repeat(64));
        assert_eq!(submit(&params).unwrap_err()["code"], "INVALID_PARAMETERS");
        assert!(seen.borrow().is_empty());
        drop(_guard);
        let (_guard, params, seen) = install("minimax", true);
        assert_eq!(submit(&params).unwrap_err()["code"], "SUBMISSION_UNKNOWN");
        assert_eq!(seen.borrow().len(), 1);
    }
    #[test]
    fn official_status_and_output_paths_are_distinct() {
        assert_eq!(
            status_output(
                "wan",
                &json!({"output":{"task_status":"SUCCEEDED","video_url":"https://example.com/a.mp4"}})
            ),
            ("succeeded", Some("https://example.com/a.mp4"))
        );
        assert_eq!(
            status_output("seedance", &json!({"status":"expired"})),
            ("failed", None)
        );
        assert_eq!(
            status_output("minimax", &json!({"task":{"status":"running"}})),
            ("running", None)
        );
    }
    #[test]
    fn source_type_signature_is_rechecked() {
        assert!(verify_signature("audio/wav", b"RIFFxxxxWAVEpayload").is_ok());
        assert!(verify_signature("audio/wav", b"ID3wrong").is_err());
    }
    #[test]
    fn multipart_uses_official_file_field_without_credentials() {
        let (_, body) = multipart(
            &[("purpose".into(), "video_generation_input".into())],
            "input.wav",
            "audio/wav",
            b"RIFFxxxxWAVEpayload",
        )
        .unwrap();
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("name=\"file\""));
        assert!(body.contains("video_generation_input"));
        assert!(!body.contains("Authorization"));
    }
}
