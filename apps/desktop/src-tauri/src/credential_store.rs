use serde::Serialize;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NOT_FOUND},
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    },
};

use super::WorkerState;

const CREDENTIAL_SERVICE: &str = "com.ai-video.workspace";
const SUPPORTED_CREDENTIAL_PROVIDERS: &[&str] = &["vidu", "vidu-cn"];
const PROFILE_CREDENTIAL_PREFIX: &str = "provider-profile";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStatus {
    provider: String,
    configured: bool,
}

pub(crate) fn validate_credential_provider(provider: &str) -> Result<(), String> {
    if SUPPORTED_CREDENTIAL_PROVIDERS.contains(&provider) || is_profile_id(provider) {
        Ok(())
    } else {
        Err("Unsupported credential provider".to_string())
    }
}

pub(crate) fn credential_target(provider: &str) -> Result<Vec<u16>, String> {
    validate_credential_provider(provider)?;
    let target = if is_profile_id(provider) {
        format!("{CREDENTIAL_SERVICE}:{PROFILE_CREDENTIAL_PREFIX}:{provider}\0")
    } else {
        format!("{CREDENTIAL_SERVICE}:{provider}\0")
    };
    Ok(target.encode_utf16().collect())
}

pub(crate) fn credential_exists(provider: &str) -> Result<bool, String> {
    let target = credential_target(provider)?;
    let mut credential = std::ptr::null_mut::<CREDENTIALW>();
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) != 0 {
            CredFree(credential.cast());
            Ok(true)
        } else if GetLastError() == ERROR_NOT_FOUND {
            Ok(false)
        } else {
            Err("Unable to read Windows secure credential status".to_string())
        }
    }
}

pub(crate) fn is_profile_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 || !value.is_ascii() {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    bytes[14] == b'4' && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

pub(crate) fn ensure_credential_subject(provider: &str, state: &WorkerState) -> Result<(), String> {
    validate_credential_provider(provider)?;
    if SUPPORTED_CREDENTIAL_PROVIDERS.contains(&provider) {
        return Ok(());
    }
    let request = serde_json::json!({
        "id": format!("credential-profile-check-{provider}"),
        "protocolVersion": 1,
        "method": "provider.profile.get",
        "params": { "profileId": provider }
    });
    let response = state.request(&request)?;
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("Unable to validate provider profile".to_string());
    }
    if response
        .get("result")
        .is_none_or(serde_json::Value::is_null)
    {
        return Err("Provider profile does not exist or is archived".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn credential_status(
    provider: String,
    state: tauri::State<'_, WorkerState>,
) -> Result<CredentialStatus, String> {
    ensure_credential_subject(&provider, &state)?;
    let configured = credential_exists(&provider)?;
    Ok(CredentialStatus {
        provider,
        configured,
    })
}

#[tauri::command]
pub(crate) fn credential_set(
    provider: String,
    secret: String,
    state: tauri::State<'_, WorkerState>,
) -> Result<CredentialStatus, String> {
    ensure_credential_subject(&provider, &state)?;
    let value = secret.trim();
    if value.is_empty()
        || value.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("Credential length is outside the Windows secure storage limit".to_string());
    }
    if (value.len() >= 6 && value[..6].eq_ignore_ascii_case("token "))
        || (value.len() >= 7 && value[..7].eq_ignore_ascii_case("bearer "))
    {
        return Err("Enter the raw API key without a Token or Bearer prefix".to_string());
    }
    credential_write(&provider, value.as_bytes())?;
    Ok(CredentialStatus {
        provider,
        configured: true,
    })
}

fn credential_write(provider: &str, value: &[u8]) -> Result<(), String> {
    let mut target = credential_target(provider)?;
    let mut username: Vec<u16> = provider.encode_utf16().chain(std::iter::once(0)).collect();
    let mut credential_blob = value.to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: credential_blob.len() as u32,
        CredentialBlob: credential_blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    let written = unsafe { CredWriteW(&credential, 0) } != 0;
    credential_blob.fill(0);
    if !written {
        return Err("Unable to write Windows secure credential".to_string());
    }
    Ok(())
}

pub(crate) struct CredentialSecret(Vec<u8>);

impl CredentialSecret {
    pub(crate) fn as_str(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.0).map_err(|_| "Stored credential is not valid UTF-8".to_string())
    }

    #[cfg(test)]
    pub(crate) fn for_test(value: &str) -> Self {
        Self(value.as_bytes().to_vec())
    }
}

impl Drop for CredentialSecret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(crate) fn credential_read(provider: &str) -> Result<CredentialSecret, String> {
    let target = credential_target(provider)?;
    let mut credential = std::ptr::null_mut::<CREDENTIALW>();
    let read = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } != 0;
    if !read {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Err("Provider credential is not configured".to_string())
        } else {
            Err("Unable to read Windows secure credential".to_string())
        };
    }
    let value = unsafe { &*credential };
    if value.CredentialBlob.is_null() || value.CredentialBlobSize == 0 {
        unsafe { CredFree(credential.cast()) };
        return Err("Stored provider credential is empty".to_string());
    }
    let secret = unsafe {
        std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize).to_vec()
    };
    unsafe { CredFree(credential.cast()) };
    Ok(CredentialSecret(secret))
}

pub(crate) fn credential_copy(source: &str, destination: &str) -> Result<bool, String> {
    if !credential_exists(source)? {
        return Ok(false);
    }
    let secret = credential_read(source)?;
    credential_write(destination, &secret.0)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn credential_delete(
    provider: String,
    state: tauri::State<'_, WorkerState>,
) -> Result<CredentialStatus, String> {
    ensure_credential_subject(&provider, &state)?;
    let target = credential_target(&provider)?;
    let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0;
    let missing = !deleted && unsafe { GetLastError() } == ERROR_NOT_FOUND;
    if !deleted && !missing {
        return Err("Unable to delete Windows secure credential".to_string());
    }
    Ok(CredentialStatus {
        provider,
        configured: false,
    })
}
