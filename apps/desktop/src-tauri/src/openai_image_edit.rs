use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

static MULTIPART_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct RequestBody {
    pub body: Vec<u8>,
    pub boundary: String,
}

pub(super) fn build(adapter: &str, model: &str, payload: Value) -> Result<RequestBody, String> {
    build_with(adapter, model, payload, |source| {
        let response = super::download_remote_image(source)?;
        if !(200..300).contains(&response.status) {
            return Err("Unable to download an input reference image".into());
        }
        Ok(response.body)
    })
}

fn build_with<F>(
    adapter: &str,
    model: &str,
    mut payload: Value,
    mut download: F,
) -> Result<RequestBody, String>
where
    F: FnMut(&str) -> Result<Vec<u8>, String>,
{
    if !adapter.starts_with("REFERENCE_TO_IMAGE:")
        || super::openai_images_provider(adapter).is_none()
    {
        return Err("Selected adapter is not an OpenAI Images edit adapter".into());
    }
    let object = payload
        .as_object_mut()
        .ok_or("Image edit payload must be an object")?;
    let sources = object
        .remove("images")
        .ok_or("Reference images are required")?;
    let sources = sources
        .as_array()
        .filter(|images| (1..=16).contains(&images.len()))
        .ok_or("Image editing requires between 1 and 16 reference images")?;
    if object.contains_key("style") {
        return Err("Image editing does not support the generation-only style option".into());
    }
    // Reuse the existing scalar option checks and inject the frozen model ID.
    let generation = adapter.replacen("REFERENCE_TO_IMAGE:", "TEXT_TO_IMAGE:", 1);
    let fields: Value =
        serde_json::from_slice(&super::openai_images_payload(&generation, model, payload)?)
            .map_err(|_| "Unable to encode image editing options")?;
    // Reject all malformed sources before downloading any remote input.
    for source in sources {
        let source = source.as_str().ok_or("Reference image must be a URL")?;
        if source.starts_with("https://") {
            super::parse_public_https_url(source)?;
        } else if source.starts_with("data:image/") {
            super::decode_embedded_image(source, "input reference")?;
        } else {
            return Err("Reference images must be HTTPS URLs or controlled image data".into());
        }
    }
    let mut images = Vec::new();
    let mut total_bytes = 0;
    for source in sources {
        let source = source.as_str().unwrap();
        let (bytes, mime, extension) = if source.starts_with("https://") {
            let bytes = download(source)?;
            if bytes.is_empty() || bytes.len() > super::NATIVE_IMAGE_OUTPUT_LIMIT {
                return Err("Reference image exceeds the application upload limit".into());
            }
            let (mime, extension) = super::decoded_image_type(&bytes, None)?;
            (bytes, mime, extension)
        } else {
            super::decode_embedded_image(source, "input reference")?
        };
        total_bytes += bytes.len();
        if total_bytes > super::PROVIDER_REQUEST_BODY_LIMIT {
            return Err("Reference images exceed the native transport limit".into());
        }
        images.push((bytes, mime, extension));
    }
    let fields = fields.as_object().unwrap();
    let boundary = loop {
        let id = MULTIPART_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("xln-image-edit-{}-{id}", std::process::id());
        let marker = format!("--{candidate}");
        if !images.iter().any(|(bytes, _, _)| {
            bytes
                .windows(marker.len())
                .any(|chunk| chunk == marker.as_bytes())
        }) && !fields
            .values()
            .any(|value| value.as_str().is_some_and(|text| text.contains(&marker)))
        {
            break candidate;
        }
    };
    let mut body = Vec::new();
    for (name, value) in fields {
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    for (i, (bytes, mime, extension)) in images.iter().enumerate() {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"reference-{i}.{extension}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    if body.len() > super::PROVIDER_REQUEST_BODY_LIMIT {
        return Err("Provider payload exceeds the native transport limit".into());
    }
    Ok(RequestBody { body, boundary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &str = "data:image/png;base64,iVBORw0KGgo=";
    const ADAPTER: &str = "REFERENCE_TO_IMAGE:custom:openai-images:v1";

    #[test]
    fn uploads_ordered_reference_files_with_the_frozen_model_and_options() {
        let result = build_with(
            ADAPTER,
            "gpt-image-2",
            json!({
                "prompt":"保留蓝衣服\n融合场景", "images":[PNG,"https://example.com/ref.png"],
                "size":"1920x1080", "n":2, "quality":"high"
            }),
            |source| {
                assert_eq!(source, "https://example.com/ref.png");
                Ok(b"\x89PNG\r\n\x1a\nsecond".to_vec())
            },
        )
        .unwrap();
        let text = String::from_utf8_lossy(&result.body);
        assert!(text.contains("name=\"model\"\r\n\r\ngpt-image-2\r\n"));
        assert!(text.contains("name=\"n\"\r\n\r\n2\r\n"));
        assert!(text.contains("name=\"size\"\r\n\r\n1920x1080\r\n"));
        assert!(text.contains("保留蓝衣服\n融合场景"));
        assert_eq!(text.matches("name=\"image[]\"").count(), 2);
        assert!(text.find("reference-0.png").unwrap() < text.find("reference-1.png").unwrap());
        assert!(result
            .body
            .windows(8)
            .any(|bytes| bytes == b"\x89PNG\r\n\x1a\n"));
        assert!(text.ends_with(&format!("--{}--\r\n", result.boundary)));
        assert!(!text.contains("https://example.com"));
        assert!(!text.contains("base64"));
    }

    #[test]
    fn rejects_invalid_edit_inputs_and_options_before_fetching_or_submitting() {
        for payload in [
            json!({"prompt":"edit"}),
            json!({"prompt":"edit","images":[]}),
            json!({"prompt":"edit","images":vec![PNG;17]}),
            json!({"prompt":"edit","images":["file:///private.png"]}),
            json!({"prompt":"edit","images":["http://example.com/a.png"]}),
            json!({"prompt":"edit","images":["https://example.com/a.png","data:image/png;base64,bad!"]}),
            json!({"prompt":"edit","images":[PNG],"model":"override"}),
            json!({"prompt":"edit","images":[PNG],"style":"vivid"}),
            json!({"prompt":"edit","images":[PNG],"output_format":"png","output_compression":20}),
        ] {
            assert!(build_with(ADAPTER, "gpt-image-2", payload, |_| panic!(
                "invalid input must not fetch"
            ))
            .is_err());
        }
        assert!(build_with(
            ADAPTER,
            "gpt-image-2",
            json!({"prompt":"edit","images":["https://example.com/not-image"]}),
            |_| Ok(b"not an image".to_vec())
        )
        .is_err());
        assert!(build_with(
            "TEXT_TO_IMAGE:custom:openai-images:v1",
            "gpt-image-2",
            json!({"prompt":"edit","images":[PNG]}),
            |_| unreachable!()
        )
        .is_err());
    }

    #[test]
    fn reference_edit_endpoint_preserves_the_provider_root_and_rejects_unsafe_roots() {
        let custom = super::super::openai_compatible_target(
            "https://gateway.example/prefix/v1",
            "custom",
            "/images/edits",
        )
        .unwrap();
        assert_eq!(custom.path, "/prefix/v1/images/edits");
        assert!(super::super::openai_compatible_target(
            "https://api.openai.com/v1",
            "openai",
            "/images/edits"
        )
        .is_ok());
        assert!(super::super::openai_compatible_target(
            "https://other.example/v1",
            "openai",
            "/images/edits"
        )
        .is_err());
        assert!(super::super::openai_compatible_target(
            "http://gateway.example/v1",
            "custom",
            "/images/edits"
        )
        .is_err());
        assert!(super::super::openai_compatible_target(
            "https://user:secret@gateway.example/v1",
            "custom",
            "/images/edits"
        )
        .is_err());
    }

    #[test]
    fn rejects_oversized_individual_and_combined_reference_uploads() {
        for (size, expected_fetches) in [
            (super::super::NATIVE_IMAGE_OUTPUT_LIMIT + 1, 1),
            (super::super::PROVIDER_REQUEST_BODY_LIMIT / 2 + 1, 2),
        ] {
            let mut fetches = 0;
            let result = build_with(
                ADAPTER,
                "gpt-image-2",
                json!({"prompt":"edit","images":["https://example.com/a.png","https://example.com/b.png"]}),
                |_| {
                    fetches += 1;
                    let mut bytes = vec![0; size];
                    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
                    Ok(bytes)
                },
            );
            assert!(result.is_err());
            assert_eq!(fetches, expected_fetches);
        }
    }
}
