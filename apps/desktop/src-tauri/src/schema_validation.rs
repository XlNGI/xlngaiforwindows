//! Bounded validation for the data-only JSON Schema subset used by media contracts.
use serde_json::Value;

pub(crate) fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    if matches(schema, value, 0) {
        Ok(())
    } else {
        Err("Parameters do not match the official contract Schema".into())
    }
}

fn matches(schema: &Value, value: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    let next = depth + 1;
    if let Some(expected) = schema.get("const") {
        if expected != value {
            return false;
        }
    }
    if let Some(choices) = schema["enum"].as_array() {
        if !choices.contains(value) {
            return false;
        }
    }
    let valid_type = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("number") => value.is_number(),
        Some("null") => value.is_null(),
        None => true,
        _ => false,
    };
    if !valid_type {
        return false;
    }
    if let Some(all) = schema["allOf"].as_array() {
        if !all.iter().all(|s| matches(s, value, next)) {
            return false;
        }
    }
    if let Some(any) = schema["anyOf"].as_array() {
        if !any.iter().any(|s| matches(s, value, next)) {
            return false;
        }
    }
    if let Some(one) = schema["oneOf"].as_array() {
        if one.iter().filter(|s| matches(s, value, next)).count() != 1 {
            return false;
        }
    }
    if let Some(not) = schema.get("not") {
        if matches(not, value, next) {
            return false;
        }
    }
    if let Some(condition) = schema.get("if") {
        let branch = if matches(condition, value, next) {
            "then"
        } else {
            "else"
        };
        if let Some(branch) = schema.get(branch) {
            if !matches(branch, value, next) {
                return false;
            }
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            if required
                .iter()
                .any(|key| key.as_str().is_none_or(|key| !object.contains_key(key)))
            {
                return false;
            }
        }
        if let Some(properties) = schema["properties"].as_object() {
            for (key, item) in object {
                if let Some(property) = properties.get(key) {
                    if !matches(property, item, next) {
                        return false;
                    }
                } else if schema["additionalProperties"] == false {
                    return false;
                }
            }
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|min| length < min)
            || schema["maxLength"].as_u64().is_some_and(|max| length > max)
        {
            return false;
        }
        if let Some(pattern) = schema["pattern"].as_str() {
            if !regex::Regex::new(pattern)
                .map(|pattern| pattern.is_match(text))
                .unwrap_or(false)
            {
                return false;
            }
        }
    }
    if let Some(number) = value.as_f64() {
        if schema["minimum"].as_f64().is_some_and(|min| number < min)
            || schema["maximum"].as_f64().is_some_and(|max| number > max)
        {
            return false;
        }
    }
    if let Some(items) = value.as_array() {
        if schema["minItems"]
            .as_u64()
            .is_some_and(|min| items.len() < min as usize)
            || schema["maxItems"]
                .as_u64()
                .is_some_and(|max| items.len() > max as usize)
        {
            return false;
        }
        if let Some(item_schema) = schema.get("items") {
            if !items.iter().all(|item| matches(item_schema, item, next)) {
                return false;
            }
        }
        if let Some(contains) = schema.get("contains") {
            let count = items
                .iter()
                .filter(|item| matches(contains, item, next))
                .count() as u64;
            if count < schema["minContains"].as_u64().unwrap_or(1)
                || schema["maxContains"]
                    .as_u64()
                    .is_some_and(|max| count > max)
            {
                return false;
            }
        }
        if schema["uniqueItems"] == true {
            for (index, item) in items.iter().enumerate() {
                if items[..index].contains(item) {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn catalog() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/src/official-video-audio-contracts.json"
        ))
        .unwrap()
    }
    #[test]
    fn all_official_requests_pass_and_unknown_fields_fail() {
        for contract in catalog() {
            let request = &contract["transport"]["samples"][0]["request"];
            let mut params = serde_json::Map::new();
            for mapping in contract["transport"]["request"].as_array().unwrap() {
                let mut value = request;
                for part in mapping["to"].as_str().unwrap().split('.') {
                    value = &value[part];
                }
                if !value.is_null() {
                    params.insert(mapping["from"].as_str().unwrap().into(), value.clone());
                }
            }
            assert!(
                validate(&contract["parameterSchema"], &Value::Object(params.clone())).is_ok(),
                "{}",
                contract["contractId"]
            );
            params.insert("api_key".into(), json!("forbidden"));
            assert!(validate(&contract["parameterSchema"], &Value::Object(params)).is_err());
        }
    }
    #[test]
    fn nested_credentials_and_mixed_reference_modes_fail() {
        let contracts = catalog();
        let schema = &contracts
            .iter()
            .find(|c| c["contractId"] == "cn.qwen.wan3-0-video")
            .unwrap()["parameterSchema"];
        for value in [
            json!({"media":[{"type":"reference_audio","url":"https://example.com/a.wav","api_key":"forbidden"}]}),
            json!({"media":[{"type":"first_frame","url":"https://example.com/a.png"},{"type":"reference_audio","url":"https://example.com/a.wav"}]}),
            json!({"media":[{"type":"reference_audio","url":"C:/private/a.wav"}]}),
        ] {
            assert!(validate(schema, &value).is_err());
        }
        assert!(validate(schema, &json!({"prompt":"hello", "prompt_extend":false})).is_ok());
    }
}
