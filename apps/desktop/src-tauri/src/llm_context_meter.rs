use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModelCapabilities {
    pub model_id: String,
    pub context_window: usize,
    pub max_input_tokens: Option<usize>,
    pub max_output_tokens: Option<usize>,
    pub tokenizer: Option<String>,
    // Provider feature metadata; local projection does not invoke provider compaction yet.
    #[allow(dead_code)]
    pub supports_compaction: Option<bool>,
    pub capability_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireContext {
    pub limit_enforcement: String,
    pub estimated_input_tokens: usize,
    pub meter: String,
    pub protocol: String,
    pub request_body_bytes: usize,
    pub system_tokens: usize,
    pub tool_schema_tokens: usize,
    pub message_tokens: usize,
    pub image_tokens: usize,
    pub reserved_output_tokens: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_output_tokens: Option<usize>,
    pub capability_source: String,
}

/// Counts the final protocol body. Even a known encoding is a local estimate:
/// provider framing, hidden reasoning and image tokenization remain provider-specific.
pub(super) fn inspect(
    body: &[u8],
    protocol: &str,
    capabilities: Option<&ModelCapabilities>,
) -> Result<WireContext, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid protocol body")?;
    static O200K: std::sync::OnceLock<Result<tiktoken_rs::CoreBPE, String>> =
        std::sync::OnceLock::new();
    static CL100K: std::sync::OnceLock<Result<tiktoken_rs::CoreBPE, String>> =
        std::sync::OnceLock::new();
    let encoder = match capabilities.and_then(|c| c.tokenizer.as_deref()) {
        Some("o200k_base") => Some(
            O200K
                .get_or_init(|| tiktoken_rs::o200k_base().map_err(|e| e.to_string()))
                .as_ref()
                .map_err(Clone::clone)?,
        ),
        Some("cl100k_base") => Some(
            CL100K
                .get_or_init(|| tiktoken_rs::cl100k_base().map_err(|e| e.to_string()))
                .as_ref()
                .map_err(Clone::clone)?,
        ),
        _ => None,
    };
    let count = |v: &Value| -> usize {
        let text = v.to_string();
        if let Some(encoder) = &encoder {
            encoder.encode_with_special_tokens(&text).len()
        } else {
            text.chars()
                .map(|c| if c.is_ascii() { 1 } else { 6 })
                .sum::<usize>()
                .div_ceil(3)
        }
    };
    fn strip_images(value: &mut Value) -> usize {
        match value {
            Value::Array(items) => items.iter_mut().map(strip_images).sum(),
            Value::Object(map) => {
                if matches!(
                    map.get("type").and_then(Value::as_str),
                    Some("input_image" | "image_url")
                ) {
                    *value = json!({"type":"image_reference"});
                    return 4096;
                }
                map.values_mut().map(strip_images).sum()
            }
            _ => 0,
        }
    }
    let mut metered = value.clone();
    let image_tokens = strip_images(&mut metered);
    let system = if protocol == "openai-responses" {
        metered.get("instructions").cloned().unwrap_or(Value::Null)
    } else {
        Value::Array(
            metered["messages"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter(|v| v["role"] == "system" || v["role"] == "developer")
                .cloned()
                .collect(),
        )
    };
    let tools = metered.get("tools").cloned().unwrap_or(Value::Null);
    let system_tokens = count(&system);
    let tool_schema_tokens = count(&tools);
    let estimated_input_tokens = count(&metered) + image_tokens;
    let reserved_output_tokens = value
        .get("max_output_tokens")
        .or_else(|| value.get("max_completion_tokens"))
        .or_else(|| value.get("max_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(16384) as usize;
    Ok(WireContext {
        limit_enforcement: capabilities
            .map(|c| {
                if c.capability_source == "fallback" {
                    "advisory_fallback"
                } else {
                    "verified_capability"
                }
            })
            .unwrap_or("legacy_unmanaged")
            .into(),
        estimated_input_tokens,
        meter: if encoder.is_some() {
            "local_encoding_estimate"
        } else {
            "local_heuristic_estimate"
        }
        .into(),
        protocol: protocol.into(),
        request_body_bytes: body.len(),
        system_tokens,
        tool_schema_tokens,
        message_tokens: estimated_input_tokens
            .saturating_sub(system_tokens + tool_schema_tokens + image_tokens),
        image_tokens,
        reserved_output_tokens,
        requested_output_tokens: None,
        capability_source: capabilities
            .map(|c| c.capability_source.clone())
            .unwrap_or_else(|| "legacy_unmanaged".into()),
    })
}

/// Reconcile the output allowance against the final protocol body, before HTTP
/// admission. Worker estimates are useful for projection, but cannot authorize a
/// body that the native meter rejects. No input, schema, or capability is changed.
pub(super) fn fit_output_budget(
    body: &mut Vec<u8>,
    protocol: &str,
    capabilities: Option<&ModelCapabilities>,
) -> Result<WireContext, String> {
    let mut wire = inspect(body, protocol, capabilities)?;
    let Some(c) = capabilities else {
        return Ok(wire);
    };
    if c.capability_source == "fallback" {
        return Ok(wire);
    }
    // Invalid capabilities and independent input/output limits cannot be repaired
    // by borrowing capacity from the output allowance.
    if validate(&wire, capabilities).is_ok()
        || c.max_input_tokens
            .is_some_and(|limit| wire.estimated_input_tokens > limit)
        || c.max_output_tokens
            .is_some_and(|limit| wire.reserved_output_tokens > limit)
    {
        return Ok(wire);
    }
    if let Err(error) = validate(&wire, capabilities) {
        if !error.starts_with("CONTEXT_BUDGET_EXCEEDED") {
            return Ok(wire);
        }
    }
    let requested = wire.reserved_output_tokens;
    let minimum = requested.min(2048);
    let safety = 256.max(c.context_window.div_ceil(20));
    let mut value: Value = serde_json::from_slice(body).map_err(|_| "Invalid protocol body")?;
    let Some(parameter) = ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .into_iter()
        .find(|key| value.get(key).and_then(Value::as_u64).is_some())
    else {
        // Legacy unmanaged requests have no negotiated transport output setting.
        return Ok(wire);
    };
    // Re-serialize and re-meter: changing the number can change encoding length.
    // Strictly decreasing allowances and a bounded pass count prevent a fit loop.
    for _ in 0..3 {
        let available = c
            .context_window
            .saturating_sub(safety + wire.estimated_input_tokens);
        if available < minimum || available >= wire.reserved_output_tokens {
            break;
        }
        value[parameter] = json!(available);
        *body = serde_json::to_vec(&value).map_err(|_| "Invalid protocol body")?;
        wire = inspect(body, protocol, capabilities)?;
        wire.requested_output_tokens = Some(requested);
        if validate(&wire, capabilities).is_ok() {
            break;
        }
    }
    Ok(wire)
}

pub(super) fn validate(
    wire: &WireContext,
    capabilities: Option<&ModelCapabilities>,
) -> Result<(), String> {
    if let Some(c) = capabilities {
        if c.model_id.trim().is_empty()
            || c.context_window < 1
            || c.max_input_tokens
                .is_some_and(|v| v == 0 || v > c.context_window)
            || c.max_output_tokens
                .is_some_and(|v| v == 0 || v > c.context_window)
            || !["provider", "model_registry", "manual_config", "fallback"]
                .contains(&c.capability_source.as_str())
        {
            return Err("INVALID_MODEL_CAPABILITIES".into());
        }
        let safety = 256.max(c.context_window.div_ceil(20));
        let input_limit = c.max_input_tokens.unwrap_or(c.context_window).min(
            c.context_window
                .saturating_sub(wire.reserved_output_tokens + safety),
        );
        if c.capability_source != "fallback"
            && (wire.estimated_input_tokens > input_limit
                || c.max_output_tokens
                    .is_some_and(|v| wire.reserved_output_tokens > v))
        {
            return Err(format!("CONTEXT_BUDGET_EXCEEDED: native protocol estimate {} > input budget {input_limit}; output reserve {}; source {}", wire.estimated_input_tokens, wire.reserved_output_tokens, c.capability_source));
        }
    }
    Ok(())
}

#[cfg(test)]
fn measure(
    body: &[u8],
    protocol: &str,
    capabilities: Option<&ModelCapabilities>,
) -> Result<WireContext, String> {
    let wire = inspect(body, protocol, capabilities)?;
    validate(&wire, capabilities)?;
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capabilities(window: usize) -> ModelCapabilities {
        serde_json::from_value(json!({"modelId":"m","contextWindow":window,"maxOutputTokens":4096,"capabilitySource":"manual_config"})).unwrap()
    }
    fn large_request(protocol: &str, parameter: &str, tokens: usize) -> Vec<u8> {
        let mut value = if protocol == "openai-responses" {
            json!({"model":"m","instructions":"阶段策略".repeat(1800),"input":[{"role":"user","content":"约".repeat(8547)}],"tools":[{"type":"function","name":"save","description":"工具定义".repeat(1200),"parameters":{"type":"object"}}]})
        } else {
            json!({"model":"m","messages":[{"role":"system","content":"阶段策略".repeat(1800)},{"role":"user","content":"约".repeat(8547)}],"tools":[{"type":"function","function":{"name":"save","description":"工具定义".repeat(1200),"parameters":{"type":"object"}}}]})
        };
        value[parameter] = json!(16000);
        value["padding"] = json!("");
        let initial = inspect(&serde_json::to_vec(&value).unwrap(), protocol, None).unwrap();
        value["padding"] = json!("x".repeat((tokens - initial.estimated_input_tokens) * 3));
        let body = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            inspect(&body, protocol, None)
                .unwrap()
                .estimated_input_tokens,
            tokens
        );
        body
    }
    #[test]
    fn final_budget_fits_large_initial_requirements_without_a_model_retry() {
        for (protocol, parameter) in [
            ("openai-responses", "max_output_tokens"),
            ("openai-chat-completions", "max_completion_tokens"),
            ("openai-chat-completions", "max_tokens"),
        ] {
            let mut c = capabilities(64000);
            c.max_output_tokens = Some(16000);
            for tokens in [45106, 51891] {
                let mut body = large_request(protocol, parameter, tokens);
                let before: Value = serde_json::from_slice(&body).unwrap();
                let original_wire = inspect(&body, protocol, Some(&c)).unwrap();
                assert!(validate(&original_wire, Some(&c)).is_err());
                let fitted = fit_output_budget(&mut body, protocol, Some(&c)).unwrap();
                validate(&fitted, Some(&c)).unwrap();
                assert_eq!(fitted.requested_output_tokens, Some(16000));
                assert_eq!(fitted.reserved_output_tokens, 60800 - tokens);
                assert!(fitted.estimated_input_tokens <= tokens);
                assert!(fitted.estimated_input_tokens + fitted.reserved_output_tokens <= 60800);
                let mut after: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(after[parameter], fitted.reserved_output_tokens);
                after[parameter] = before[parameter].clone();
                assert_eq!(
                    after, before,
                    "All requirements, history and schemas stay intact"
                );
            }
        }
    }
    #[test]
    fn final_fit_preserves_hard_limits_and_impossible_original_data() {
        let protocol = "openai-responses";
        let mut c = capabilities(64000);
        c.max_output_tokens = Some(16000);
        for tokens in [45106, 59000] {
            let original = large_request(protocol, "max_output_tokens", tokens);
            let mut body = original.clone();
            if tokens == 45106 {
                c.max_input_tokens = Some(44000);
            } else {
                c.max_input_tokens = None;
            }
            let wire = fit_output_budget(&mut body, protocol, Some(&c)).unwrap();
            assert!(validate(&wire, Some(&c)).is_err());
            assert_eq!(body, original);
        }
        c.max_input_tokens = None;
        c.context_window = 128000;
        let original = large_request(protocol, "max_output_tokens", 70000);
        for window in [128000, 1000000] {
            c.context_window = window;
            let mut body = original.clone();
            let wire = fit_output_budget(&mut body, protocol, Some(&c)).unwrap();
            validate(&wire, Some(&c)).unwrap();
            assert_eq!(body, original);
            assert_eq!(wire.requested_output_tokens, None);
        }
    }
    #[test]
    fn final_wire_enforces_each_model_window() {
        let body = serde_json::to_vec(&json!({"model":"m","messages":[{"role":"system","content":"policy"},{"role":"user","content":"文".repeat(35000)}],"tools":[{"name":"read","parameters":{"type":"object"}}],"max_tokens":4096})).unwrap();
        assert!(
            measure(&body, "openai-chat-completions", Some(&capabilities(64000)))
                .unwrap_err()
                .contains("CONTEXT_BUDGET_EXCEEDED")
        );
        for window in [128000, 1000000] {
            let m = measure(
                &body,
                "openai-chat-completions",
                Some(&capabilities(window)),
            )
            .unwrap();
            assert!(m.estimated_input_tokens > 64000);
            assert!(m.tool_schema_tokens > 0);
            assert!(m.system_tokens > 0);
        }
    }
    #[test]
    fn fallback_estimates_do_not_claim_an_unknown_provider_hard_limit() {
        let mut c = capabilities(64000);
        c.max_output_tokens = Some(16000);
        c.capability_source = "fallback".into();
        let mut body = large_request("openai-responses", "max_output_tokens", 70000);
        let mut value: Value = serde_json::from_slice(&body).unwrap();
        value["max_output_tokens"] = json!(80000);
        body = serde_json::to_vec(&value).unwrap();
        let original = body.clone();
        let wire = fit_output_budget(&mut body, "openai-responses", Some(&c)).unwrap();
        validate(&wire, Some(&c)).unwrap();
        assert_eq!(wire.limit_enforcement, "advisory_fallback");
        assert_eq!(wire.estimated_input_tokens, 70000);
        assert_eq!(wire.reserved_output_tokens, 80000);
        assert_eq!(body, original);
        c.capability_source = "manual_config".into();
        assert!(validate(&wire, Some(&c)).is_err());
    }
    #[test]
    fn input_and_output_limits_are_independent() {
        let body = serde_json::to_vec(&json!({"input":"x".repeat(9000),"max_output_tokens":4000}))
            .unwrap();
        let mut c = capabilities(128000);
        c.max_input_tokens = Some(2000);
        assert!(measure(&body, "openai-responses", Some(&c)).is_err());
        c.max_input_tokens = None;
        c.max_output_tokens = Some(1000);
        assert!(measure(&body, "openai-responses", Some(&c)).is_err());
    }
    #[test]
    fn images_do_not_count_base64_as_text() {
        let body=serde_json::to_vec(&json!({"instructions":"system","input":[{"type":"input_image","image_url":format!("data:image/png;base64,{}","a".repeat(100000))}],"max_output_tokens":2048})).unwrap();
        let m = measure(&body, "openai-responses", Some(&capabilities(64000))).unwrap();
        assert_eq!(m.image_tokens, 4096);
        assert!(m.estimated_input_tokens < 5000);
    }
    #[test]
    fn known_encoding_measures_final_protocol_structure_without_claiming_provider_usage() {
        for protocol in ["openai-responses", "openai-chat-completions"] {
            let mut c = capabilities(128000);
            c.tokenizer = Some("o200k_base".into());
            let system = "Keep explicit requirements";
            let body = if protocol == "openai-responses" {
                json!({"model":"m","instructions":system,"input":[{"role":"user","content":"任务"}],"tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],"max_output_tokens":4096})
            } else {
                json!({"model":"m","messages":[{"role":"system","content":system},{"role":"user","content":"任务"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"max_completion_tokens":4096})
            };
            let bytes = serde_json::to_vec(&body).unwrap();
            let wire = measure(&bytes, protocol, Some(&c)).unwrap();
            assert_eq!(wire.meter, "local_encoding_estimate");
            assert_eq!(wire.protocol, protocol);
            assert_eq!(wire.request_body_bytes, bytes.len());
            assert!(
                wire.system_tokens > 0 && wire.tool_schema_tokens > 0 && wire.message_tokens > 0
            );
            assert_eq!(
                wire.estimated_input_tokens,
                wire.system_tokens
                    + wire.tool_schema_tokens
                    + wire.message_tokens
                    + wire.image_tokens
            );
        }
    }
    #[test]
    fn failed_validation_preserves_inspectable_final_request_diagnostics() {
        let body = serde_json::to_vec(
            &json!({"instructions":"system","input":"文".repeat(35000),"max_output_tokens":4096}),
        )
        .unwrap();
        let c = capabilities(64000);
        let wire = inspect(&body, "openai-responses", Some(&c)).unwrap();
        assert!(wire.estimated_input_tokens > 64000);
        assert!(validate(&wire, Some(&c))
            .unwrap_err()
            .starts_with("CONTEXT_BUDGET_EXCEEDED"));
        let mut invalid = c;
        invalid.max_input_tokens = Some(1000000);
        assert_eq!(
            validate(&wire, Some(&invalid)).unwrap_err(),
            "INVALID_MODEL_CAPABILITIES"
        );
    }
}
