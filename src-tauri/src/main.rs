#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if buzz_foundation_lib::run_token_helper() {
        return;
    }
    buzz_foundation_lib::run();
}
