#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if ai_video_desktop_lib::project_directory::run_helper_if_requested() {
        return;
    }
    ai_video_desktop_lib::run();
}
