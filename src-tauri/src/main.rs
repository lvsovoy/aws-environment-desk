
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod config;
mod icons;
mod setup;
mod updates;
mod vpn;

/// Run the native tray application.
fn main() {
    app::run();
}
