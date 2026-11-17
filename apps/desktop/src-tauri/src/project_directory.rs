//! Keep the Windows shell picker (including installed shell extensions) outside the app process.
use std::path::Path;

#[cfg(windows)]
use std::{
    io::Write,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(windows)]
const HELPER_ARGUMENT: &str = "--project-directory-picker";
#[cfg(windows)]
static PICKER_BUSY: AtomicBool = AtomicBool::new(false);

fn validate_selection(path: Option<String>) -> Result<Option<String>, String> {
    if let Some(path) = &path {
        if path.is_empty() || !Path::new(path).is_absolute() || !Path::new(path).is_dir() {
            return Err("选择的项目目录不可用，请重新选择或直接输入绝对路径。".into());
        }
    }
    Ok(path)
}

#[cfg(windows)]
fn decode_output(output: Output) -> Result<Option<String>, String> {
    if !output.status.success() {
        return Err(format!(
            "系统目录选择器异常退出（{}）。请重试，或直接输入项目绝对目录。",
            output.status
        ));
    }
    let path = serde_json::from_slice::<Option<String>>(&output.stdout)
        .map_err(|_| "系统目录选择器未返回有效路径，请重试或直接输入项目绝对目录。".to_string())?;
    validate_selection(path)
}

/// Called before Tauri starts. The helper must never open a WebView, Worker, or project database.
pub fn run_helper_if_requested() -> bool {
    #[cfg(windows)]
    {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() != Some(std::ffi::OsStr::new(HELPER_ARGUMENT)) {
            return false;
        }
        let owner = args
            .next()
            .and_then(|value| value.to_str().and_then(|value| value.parse::<isize>().ok()))
            .and_then(std::num::NonZeroIsize::new);
        let open_existing = args.next().as_deref() == Some(std::ffi::OsStr::new("open"));
        let result = std::panic::catch_unwind(|| {
            let owner = owner.map(PickerOwner);
            let mut picker = rfd::FileDialog::new().set_title(if open_existing {
                "选择要打开的项目目录"
            } else {
                "选择项目目录"
            });
            if let Some(owner) = &owner {
                picker = picker.set_parent(owner);
            }
            picker
                .pick_folder()
                .map(|path| {
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| "项目目录包含不支持的字符")
                })
                .transpose()
        });
        let Ok(Ok(path)) = result else {
            std::process::exit(1);
        };
        if serde_json::to_writer(std::io::stdout().lock(), &path).is_err()
            || std::io::stdout().flush().is_err()
        {
            std::process::exit(1);
        }
        return true;
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
struct PickerOwner(std::num::NonZeroIsize);

#[cfg(windows)]
impl raw_window_handle::HasWindowHandle for PickerOwner {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        let handle = raw_window_handle::Win32WindowHandle::new(self.0);
        // The parent is the requesting Tauri window, kept alive while awaiting this helper.
        Ok(unsafe {
            raw_window_handle::WindowHandle::borrow_raw(raw_window_handle::RawWindowHandle::Win32(
                handle,
            ))
        })
    }
}

#[cfg(windows)]
impl raw_window_handle::HasDisplayHandle for PickerOwner {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(raw_window_handle::DisplayHandle::windows())
    }
}

#[tauri::command]
pub async fn project_directory_pick(
    window: tauri::Window,
    open_existing: bool,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        if PICKER_BUSY.swap(true, Ordering::AcqRel) {
            return Err("目录选择器已打开，请先完成当前选择。".into());
        }
        struct PickerGuard;
        impl Drop for PickerGuard {
            fn drop(&mut self) {
                PICKER_BUSY.store(false, Ordering::Release);
            }
        }
        let _guard = PickerGuard;
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            let output = Command::new(executable)
                .args([
                    HELPER_ARGUMENT,
                    &owner.to_string(),
                    if open_existing { "open" } else { "create" },
                ])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW: only the native picker is visible.
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .map_err(|error| {
                    format!("无法打开目录选择器：{error}。可直接输入项目绝对目录。")
                })?;
            decode_output(output)
        })
        .await
        .map_err(|error| format!("目录选择器运行失败：{error}"));
        // A crashing shell extension must not leave its owner disabled.
        let _ = window.set_enabled(true);
        let _ = window.set_focus();
        result?
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_dialog::DialogExt;
        let path = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(if open_existing {
                "选择要打开的项目目录"
            } else {
                "选择项目目录"
            })
            .blocking_pick_folder()
            .map(|path| {
                path.into_path()
                    .map_err(|error| error.to_string())?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "项目目录包含不支持的字符".to_string())
            })
            .transpose()?;
        validate_selection(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_requires_an_existing_absolute_directory() {
        assert_eq!(validate_selection(None).unwrap(), None);
        for path in ["", "relative-project", file!()] {
            assert!(validate_selection(Some(path.into())).is_err());
        }
        assert!(validate_selection(Some(
            std::env::current_exe().unwrap().to_str().unwrap().into()
        ))
        .is_err());
        let path = std::env::temp_dir().to_str().unwrap().to_string();
        assert_eq!(validate_selection(Some(path.clone())).unwrap(), Some(path));
    }

    #[cfg(windows)]
    fn successful_output(stdout: &[u8]) -> Output {
        use std::os::windows::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    #[cfg(windows)]
    fn helper_cancel_and_unicode_directory_return_without_starting_a_project() {
        assert_eq!(decode_output(successful_output(b"null")).unwrap(), None);
        let root = std::env::temp_dir().join(format!("项目目录选择-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.to_str().unwrap().to_string();
        let result = decode_output(successful_output(&serde_json::to_vec(&path).unwrap()));
        std::fs::remove_dir(&root).unwrap();
        assert_eq!(result.unwrap(), Some(path));
        assert!(decode_output(successful_output(b"invalid-json")).is_err());
        assert!(decode_output(successful_output(b"\"relative\"")).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn picker_process_failure_is_returned_as_an_error_to_the_surviving_host() {
        use std::os::windows::process::CommandExt;
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "project_directory::tests::crashing_picker_fixture",
                "--ignored",
            ])
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(29));
        assert!(decode_output(output)
            .unwrap_err()
            .contains("目录选择器异常退出"));
    }

    #[test]
    #[ignore = "Subprocess failure fixture; invoked by the host-survival test"]
    fn crashing_picker_fixture() {
        std::process::exit(29);
    }
}
