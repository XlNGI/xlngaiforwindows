//! Shared official contracts and bindings; no channel-specific model/schema copies.
use serde_json::Value;

pub(crate) fn is_contract_adapter(adapter_key: &str) -> bool {
    adapter_key.split(':').nth(3).is_some_and(|revision| {
        revision.strip_prefix("contract-").is_some_and(|value| {
            !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
        })
    })
}

const CONTRACTS: &str =
    include_str!("../../../../packages/contracts/src/official-video-contracts.json");
const IMAGE_CONTRACTS: &str =
    include_str!("../../../../packages/contracts/src/official-image-contracts.json");
const BINDINGS: &str = include_str!("../../../../packages/contracts/src/media-model-bindings.json");
const AUDIO_CONTRACTS: &str =
    include_str!("../../../../packages/contracts/src/official-video-audio-contracts.json");

pub(crate) fn contract(adapter_key: &str) -> Result<Value, String> {
    let parts: Vec<_> = adapter_key.split(':').collect();
    if parts.len() != 4 || !parts[3].starts_with("contract-") {
        return Err("Invalid contract adapter key".into());
    }
    let mut contracts: Vec<Value> =
        serde_json::from_str(CONTRACTS).map_err(|_| "Invalid official contract catalog")?;
    contracts.extend(
        serde_json::from_str::<Vec<Value>>(IMAGE_CONTRACTS)
            .map_err(|_| "Invalid official image contract catalog")?,
    );
    contracts.extend(
        serde_json::from_str::<Vec<Value>>(AUDIO_CONTRACTS)
            .map_err(|_| "Invalid audio video contract catalog")?,
    );
    let revision: u64 = parts[3]
        .trim_start_matches("contract-")
        .parse()
        .map_err(|_| "Invalid contract revision")?;
    let contract = contracts
        .into_iter()
        .find(|contract| {
            contract["contractId"].as_str() == Some(parts[2])
                && contract["contractRevision"].as_u64() == Some(revision)
                && contract["status"] == "enabled"
        })
        .ok_or("Official video contract is not enabled")?;
    let capability = contract["taskCapability"]
        .as_str()
        .ok_or("Missing contract task capability")?;
    if parts[0] != capability
        && !contract["taskCapabilities"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == parts[0]))
    {
        return Err("Capability does not match the official contract".into());
    }
    let bindings: Vec<Value> =
        serde_json::from_str(BINDINGS).map_err(|_| "Invalid model binding catalog")?;
    if !bindings.iter().any(|binding| {
        binding["contractId"] == contract["contractId"]
            && binding["providerType"] == parts[1]
            && binding["contractRevision"] == contract["contractRevision"]
            && binding["status"] == "enabled"
    }) {
        return Err("Provider has no enabled binding for the official contract".into());
    }
    Ok(contract)
}

pub(crate) fn matches_model(adapter_key: &str, remote_model_id: &str) -> bool {
    let Ok(contract) = contract(adapter_key) else {
        return false;
    };
    let parts: Vec<_> = adapter_key.split(':').collect();
    let Ok(bindings) = serde_json::from_str::<Vec<Value>>(BINDINGS) else {
        return false;
    };
    bindings.iter().any(|binding| {
        binding["contractId"] == contract["contractId"]
            && binding["providerType"] == parts[1]
            && binding["remoteModelId"] == remote_model_id
            && binding["contractRevision"] == contract["contractRevision"]
            && binding["status"] == "enabled"
    })
}

/// Validate using the same official Schema as Worker and Desktop.
pub(crate) fn validate_parameters(adapter_key: &str, parameters: &Value) -> Result<(), String> {
    let contract = contract(adapter_key)?;
    crate::schema_validation::validate(&contract["parameterSchema"], parameters)
}

/// Existing OpenAI video protocol projection, independent of the model family.
pub(crate) fn video_payload(
    adapter_key: &str,
    parameters: Value,
    remote_model_id: &str,
) -> Result<Vec<u8>, String> {
    if !matches_model(adapter_key, remote_model_id) {
        return Err("Remote model does not bind the selected official contract".into());
    }
    validate_parameters(adapter_key, &parameters)?;
    let mut object = parameters
        .as_object()
        .cloned()
        .ok_or("Invalid contract parameters")?;
    let contract = contract(adapter_key)?;
    let provider = adapter_key.split(':').nth(1).unwrap_or_default();
    let bindings: Vec<Value> =
        serde_json::from_str(BINDINGS).map_err(|_| "Invalid model binding catalog")?;
    let binding = bindings
        .iter()
        .find(|binding| {
            binding["providerType"] == provider
                && binding["remoteModelId"] == remote_model_id
                && binding["contractId"] == contract["contractId"]
                && binding["contractRevision"] == contract["contractRevision"]
                && binding["status"] == "enabled"
        })
        .ok_or("Missing channel binding")?;
    if let Some(mappings) = binding
        .pointer("/transportOverride/request")
        .and_then(Value::as_array)
    {
        let mut output = serde_json::json!({"model": remote_model_id});
        for mapping in mappings {
            if mapping["operation"] != "copy" {
                return Err("Unsupported channel request mapping".into());
            }
            let source = mapping["from"]
                .as_str()
                .ok_or("Missing channel mapping source")?;
            if let Some(value) = object.get(source) {
                let destination = mapping["to"]
                    .as_str()
                    .ok_or("Missing channel mapping target")?;
                let parts: Vec<_> = destination.split('.').collect();
                if parts.iter().any(|part| {
                    part.is_empty()
                        || ["__proto__", "constructor", "prototype", "model"].contains(part)
                }) {
                    return Err("Invalid channel mapping target".into());
                }
                let mut target = &mut output;
                for part in &parts[..parts.len() - 1] {
                    if target.get(*part).is_none() {
                        target[*part] = serde_json::json!({});
                    }
                    target = target
                        .get_mut(*part)
                        .ok_or("Invalid channel mapping path")?;
                }
                target[parts[parts.len() - 1]] = value.clone();
            }
        }
        return serde_json::to_vec(&output)
            .map_err(|error| format!("Unable to encode channel parameters: {error}"));
    }
    if adapter_key.starts_with("IMAGE_TO_VIDEO:") {
        let images = object.remove("images").ok_or("Missing first-frame image")?;
        object.insert("image".into(), images[0].clone());
    }
    object.insert("model".into(), Value::String(remote_model_id.into()));
    serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to encode contract parameters: {error}"))
}

pub(crate) fn image_payload(
    adapter_key: &str,
    parameters: Value,
    remote_model_id: &str,
) -> Result<Vec<u8>, String> {
    if !matches_model(adapter_key, remote_model_id) {
        return Err("Remote model does not bind the selected official image contract".into());
    }
    let contract = contract(adapter_key)?;
    if contract["taskCapability"] != "TEXT_TO_IMAGE" {
        return Err("Selected contract is not an official text-to-image contract".into());
    }
    validate_parameters(adapter_key, &parameters)?;
    let mut object = parameters
        .as_object()
        .cloned()
        .ok_or("Invalid contract parameters")?;
    if contract["taskCapabilities"]
        .as_array()
        .is_some_and(|modes| modes.iter().any(|mode| mode == "REFERENCE_TO_IMAGE"))
    {
        let references = adapter_key.starts_with("REFERENCE_TO_IMAGE:");
        if references != object.contains_key("images") {
            return Err("Image inputs must match the selected production mode".into());
        }
        if let Some(images) = object.get("images").and_then(Value::as_array) {
            for image in images {
                validate_image_source(image.as_str().ok_or("Invalid image source")?)?;
            }
        }
        if let Some(size) = object.get("size").and_then(Value::as_str) {
            if size != "auto" {
                let (width, height) = size.split_once('x').ok_or("Invalid image size")?;
                let width = width.parse::<u64>().map_err(|_| "Invalid image width")?;
                let height = height.parse::<u64>().map_err(|_| "Invalid image height")?;
                if !(512 * 512..=2048 * 2048).contains(&(width * height))
                    || (contract["transport"]["protocolFamily"] != "dashscope-image"
                        && (width > height * 8 || height > width * 8))
                {
                    return Err(
                        "Image size exceeds the official pixel or aspect ratio limits".into(),
                    );
                }
            }
        }
        // Domain image arrays become the official image field only at transport time.
        if let Some(images) = object.remove("images") {
            let images = images.as_array().ok_or("Invalid image array")?;
            object.insert(
                "image".into(),
                if images.len() == 1 {
                    images[0].clone()
                } else {
                    Value::Array(images.clone())
                },
            );
        }
    }
    // Current OpenAI image contracts preserve `x` and `auto`; old snapshots
    // and the DashScope 2.0 channel retain the existing `*` size projection.
    let dashscope_size = contract["taskCapabilities"].as_array().is_none()
        || contract["transport"]["protocolFamily"] == "dashscope-image";
    if dashscope_size {
        if let Some(size) = object.remove("size") {
            if let Some(value) = size.as_str() {
                if !value.eq_ignore_ascii_case("auto") {
                    let mapped = value
                        .split_once('x')
                        .map(|(width, height)| format!("{width}*{height}"))
                        .unwrap_or_else(|| value.to_string());
                    object.insert("size".into(), Value::String(mapped));
                }
            } else {
                object.insert("size".into(), size);
            }
        }
    }
    object.insert("model".into(), Value::String(remote_model_id.into()));
    serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to encode official image contract parameters: {error}"))
}

fn validate_image_source(value: &str) -> Result<(), String> {
    use base64::Engine;
    if value.starts_with("http://") || value.starts_with("https://") {
        let url = tauri::Url::parse(value).map_err(|_| "Invalid reference image URL")?;
        if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err("Invalid reference image URL".into());
        }
        return Ok(());
    }
    let (header, encoded) = value
        .split_once(',')
        .ok_or("Invalid reference image Data URL")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid reference image Base64")?;
    if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
        return Err("Reference image exceeds the official 10 MB limit".into());
    }
    let valid = match header {
        "data:image/png;base64" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "data:image/jpeg;base64" | "data:image/jpg;base64" => {
            bytes.starts_with(&[0xff, 0xd8, 0xff])
        }
        "data:image/webp;base64" => {
            bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        }
        "data:image/bmp;base64" => bytes.starts_with(b"BM"),
        "data:image/tiff;base64" => {
            bytes.starts_with(b"II\x2a\x00") || bytes.starts_with(b"MM\x00\x2a")
        }
        "data:image/gif;base64" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if !valid {
        return Err("Reference image content does not match its format".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn qwen_image_modes_project_ordered_references_and_enforce_official_limits() {
        for (id, model, revision, max) in [
            ("cn.qwen.qwen-image-3-0", "qwen-image-3.0", 2, 3),
            ("cn.qwen.qwen-image-3-0-pro", "qwen-image-3.0-pro", 2, 3),
            ("cn.qwen.qwen-image-2-1-pro", "qwen-image-2.1-pro", 2, 10),
            (
                "cn.qwen.qwen-image-2-1-turbo",
                "qwen-image-2.1-turbo",
                2,
                10,
            ),
            ("cn.qwen.qwen-image-2-0", "qwen-image-2.0", 1, 3),
            ("cn.qwen.qwen-image-2-0-pro", "qwen-image-2.0-pro", 1, 3),
        ] {
            let key = format!("REFERENCE_TO_IMAGE:unicompapi:{id}:contract-{revision}");
            let images: Vec<_> = (0..max)
                .map(|i| format!("https://example.com/{i}.png"))
                .collect();
            let payload: Value = serde_json::from_slice(
                &image_payload(
                    &key,
                    json!({"prompt":"融合人物与场景","images":images,"size":"1024x1024","n":2}),
                    model,
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(payload["model"], model);
            assert_eq!(payload["image"], json!(images));
            assert_eq!(
                payload["size"],
                if revision == 2 {
                    "1024x1024"
                } else {
                    "1024*1024"
                }
            );
            assert!(payload.get("images").is_none());
            assert!(payload.get("response_format").is_none());
            let single: Value = serde_json::from_slice(
                &image_payload(&key, json!({"prompt":"换背景","images":[images[0]]}), model)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(single["image"], images[0]);
            for parameters in [
                json!({"prompt":"test"}),
                json!({"prompt":"test","images":[]}),
                json!({"prompt":"test","images":vec!["https://example.com/x.png"; max+1]}),
                json!({"prompt":"test","images":images,"prompt_extend_mode":"agent"}),
                json!({"prompt":"test","images":images,"mask":"https://example.com/mask.png"}),
                json!({"prompt":"test","images":images,"model":"forged"}),
                json!({"prompt":"test","images":images,"size":"4096x4096"}),
                json!({"prompt":"test","images":["file:///C:/secret.png"]}),
                json!({"prompt":"test","images":["data:image/png;base64,YWJj"]}),
            ] {
                assert!(image_payload(&key, parameters, model).is_err());
            }
            if revision == 2 {
                assert!(image_payload(
                    &key,
                    json!({"prompt":"test","images":images,"size":"8192x64"}),
                    model
                )
                .is_err());
                let auto: Value = serde_json::from_slice(
                    &image_payload(
                        &key,
                        json!({"prompt":"test","images":images,"size":"auto"}),
                        model,
                    )
                    .unwrap(),
                )
                .unwrap();
                assert_eq!(auto["size"], "auto");
            }
            assert!(image_payload(
                &key,
                json!({"prompt":"test","images":images}),
                "other-model"
            )
            .is_err());
            let text = format!("TEXT_TO_IMAGE:unicompapi:{id}:contract-{revision}");
            assert!(image_payload(&text, json!({"prompt":"test","images":images}), model).is_err());
            assert!(image_payload(&text, json!({"prompt":"test"}), model).is_ok());
        }
    }

    #[test]
    fn qwen_image_accepts_real_inline_images_and_rejects_oversized_inputs() {
        use base64::Engine;
        let key = "REFERENCE_TO_IMAGE:unicompapi:cn.qwen.qwen-image-3-0:contract-2";
        let model = "qwen-image-3.0";
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xn6pAAAAAElFTkSuQmCC";
        assert!(image_payload(key, json!({"prompt":"test","images":[image]}), model).is_ok());
        let image = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0; 10 * 1024 * 1024 + 1])
        );
        assert!(image_payload(key, json!({"prompt":"test","images":[image]}), model).is_err());
    }

    #[test]
    fn wan_channel_preserves_audio_semantics_in_metadata_and_keeps_legacy_tasks_readable() {
        for (id, model) in [
            ("cn.qwen.wan3-0-video", "wan3.0-video"),
            ("cn.qwen.wan3-0-video-prime", "wan3.0-video-prime"),
        ] {
            let key = format!("REFERENCE_TO_VIDEO:unicompapi:{id}:contract-3");
            let media = json!([{ "type":"reference_image", "url":"https://example.com/actor.png" }, { "type":"reference_audio", "url":"https://example.com/voice.wav" }]);
            let body: Value = serde_json::from_slice(&video_payload(&key, json!({"prompt":"图1的人用音频1的音色说你好", "media":media, "audio":true, "resolution":"720P", "ratio":"16:9", "duration":5, "seed":-1, "watermark":false}),model).unwrap()).unwrap();
            assert_eq!(
                body,
                json!({"model":model,"prompt":"图1的人用音频1的音色说你好","metadata":{"input":{"media":media},"parameters":{"audio":true,"resolution":"720P","ratio":"16:9","duration":5,"seed":-1,"watermark":false}}})
            );
            assert!(video_payload(
                &key,
                json!({"prompt":"test","audio":"https://example.com/voice.wav"}),
                model
            )
            .is_err());
            assert!(video_payload(
                &key,
                json!({"prompt":"test","metadata":{"model":"forged"}}),
                model
            )
            .is_err());
            assert!(video_payload(
                &key,
                json!({"prompt":"test","media":[{"type":"reference_audio","url":"C:\\voice.wav"}]}),
                model
            )
            .is_err());
            assert!(contract(&format!("TEXT_TO_VIDEO:unicompapi:{id}:contract-1")).is_ok());
            assert!(video_payload(&key, json!({"prompt":"test"}), "different-model").is_err());
            let silent: Value = serde_json::from_slice(
                &video_payload(
                    &format!("TEXT_TO_VIDEO:unicompapi:{id}:contract-3"),
                    json!({"prompt":"test","audio":false}),
                    model,
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                silent.pointer("/metadata/parameters/audio"),
                Some(&json!(false))
            );
        }
    }

    #[test]
    fn binds_the_exact_official_contract_and_rejects_other_models() {
        let key = "TEXT_TO_VIDEO:unicompapi:cn.happyhorse.1.1.t2v:contract-1";
        assert!(matches_model(key, "happyhorse-1.1-t2v"));
        assert!(!matches_model(key, "happyhorse-1.1-r2v"));
        assert!(video_payload(
            key,
            json!({"prompt":"test", "duration":5,"seed":2147483647,"resolution":"1080P"}),
            "happyhorse-1.1-t2v"
        )
        .is_ok());
        for parameters in [
            json!({"prompt":"test","duration":2}),
            json!({"prompt":"test","duration":16}),
            json!({"prompt":"test","seed":2147483648u64}),
            json!({"prompt":"test","resolution":"4K"}),
            json!({"prompt":"test","seconds":"5"}),
            json!({"prompt":"test","generate_audio":true}),
        ] {
            assert!(validate_parameters(key, &parameters).is_err());
        }
    }

    #[test]
    fn uses_official_image_counts_and_optional_image_prompt() {
        let i2v = "IMAGE_TO_VIDEO:unicompapi:cn.happyhorse.1.1.i2v:contract-1";
        let body = video_payload(
            i2v,
            json!({"images":["https://example.com/a.png"]}),
            "happyhorse-1.1-i2v",
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["image"],
            "https://example.com/a.png"
        );
        assert!(validate_parameters(i2v, &json!({"images":["a","b"]})).is_err());
        assert!(validate_parameters(i2v, &json!({"images":["a"],"ratio":"16:9"})).is_err());
        let r2v = "REFERENCE_TO_VIDEO:unicompapi:cn.happyhorse.1.1.r2v:contract-1";
        assert!(validate_parameters(
            r2v,
            &json!({"prompt":"test","images":vec!["https://example.com/a.png";9]})
        )
        .is_ok());
        assert!(validate_parameters(
            r2v,
            &json!({"prompt":"test","images":vec!["https://example.com/a.png";10]})
        )
        .is_err());
    }
}
