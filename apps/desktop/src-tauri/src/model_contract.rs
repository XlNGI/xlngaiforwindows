//! Shared official contracts and bindings; no channel-specific model/schema copies.
use serde_json::Value;

const CONTRACTS: &str =
    include_str!("../../../../packages/contracts/src/official-video-contracts.json");
const IMAGE_CONTRACTS: &str =
    include_str!("../../../../packages/contracts/src/official-image-contracts.json");
const BINDINGS: &str = include_str!("../../../../packages/contracts/src/media-model-bindings.json");

pub(crate) fn contract(adapter_key: &str) -> Result<Value, String> {
    let parts: Vec<_> = adapter_key.split(':').collect();
    if parts.len() != 4 || parts[3] != "contract-1" {
        return Err("Invalid contract adapter key".into());
    }
    let mut contracts: Vec<Value> =
        serde_json::from_str(CONTRACTS).map_err(|_| "Invalid official contract catalog")?;
    contracts.extend(
        serde_json::from_str::<Vec<Value>>(IMAGE_CONTRACTS)
            .map_err(|_| "Invalid official image contract catalog")?,
    );
    let contract = contracts
        .into_iter()
        .find(|contract| {
            contract["contractId"].as_str() == Some(parts[2]) && contract["status"] == "enabled"
        })
        .ok_or("Official video contract is not enabled")?;
    let capability = contract["taskCapability"]
        .as_str()
        .ok_or("Missing contract task capability")?;
    if parts[0] != capability {
        return Err("Capability does not match the official contract".into());
    }
    let bindings: Vec<Value> =
        serde_json::from_str(BINDINGS).map_err(|_| "Invalid model binding catalog")?;
    if !bindings.iter().any(|binding| {
        binding["contractId"] == contract["contractId"]
            && binding["providerType"] == parts[1]
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
    let schema = &contract["parameterSchema"];
    let object = parameters
        .as_object()
        .ok_or("Contract parameters must be an object")?;
    let properties = schema["properties"]
        .as_object()
        .ok_or("Contract properties are invalid")?;
    for key in schema["required"]
        .as_array()
        .ok_or("Contract required fields are invalid")?
    {
        let key = key.as_str().ok_or("Invalid required field")?;
        if !object.contains_key(key) {
            return Err(format!("Missing required contract parameter: {key}"));
        }
    }
    for (key, value) in object {
        let property = properties
            .get(key)
            .ok_or_else(|| format!("Unknown contract parameter: {key}"))?;
        let valid = match property["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.as_i64().is_some(),
            Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            Some("array") => value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string)),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid contract parameter type: {key}"));
        }
        if let Some(choices) = property["enum"].as_array() {
            if !choices.contains(value) {
                return Err(format!("Invalid contract parameter choice: {key}"));
            }
        }
        if let Some(text) = value.as_str() {
            if let Some(pattern) = property["pattern"].as_str() {
                if !regex::Regex::new(pattern)
                    .map_err(|_| "Invalid contract pattern")?
                    .is_match(text)
                {
                    return Err(format!(
                        "Contract parameter does not match its official constraint: {key}"
                    ));
                }
            }
            let length = text.chars().count() as u64;
            if property["minLength"]
                .as_u64()
                .is_some_and(|min| length < min)
                || property["maxLength"]
                    .as_u64()
                    .is_some_and(|max| length > max)
            {
                return Err(format!("Contract parameter length is out of range: {key}"));
            }
        }
        if let Some(number) = value.as_f64() {
            if property["minimum"].as_f64().is_some_and(|min| number < min)
                || property["maximum"].as_f64().is_some_and(|max| number > max)
            {
                return Err(format!("Contract parameter value is out of range: {key}"));
            }
        }
        if let Some(items) = value.as_array() {
            if property["minItems"]
                .as_u64()
                .is_some_and(|min| (items.len() as u64) < min)
                || property["maxItems"]
                    .as_u64()
                    .is_some_and(|max| (items.len() as u64) > max)
                || items
                    .iter()
                    .any(|item| item.as_str().is_none_or(str::is_empty))
            {
                return Err(format!("Contract input count is out of range: {key}"));
            }
            if let Some(pattern) = property["items"]["pattern"].as_str() {
                let pattern =
                    regex::Regex::new(pattern).map_err(|_| "Invalid contract image pattern")?;
                if items
                    .iter()
                    .any(|item| item.as_str().is_none_or(|url| !pattern.is_match(url)))
                {
                    return Err(format!(
                        "Contract image does not match its official constraint: {key}"
                    ));
                }
            }
        }
    }
    Ok(())
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
    // Qwen Image's official OpenAI-compatible contract uses `1024x1024`.
    // UniComp's image transport accepts the equivalent DashScope spelling
    // `1024*1024`; `auto` is represented by omitting the optional field.
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
    object.insert("model".into(), Value::String(remote_model_id.into()));
    serde_json::to_vec(&object)
        .map_err(|error| format!("Unable to encode official image contract parameters: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
