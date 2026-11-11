use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=DESK_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=DESK_UPDATE_REPOSITORY");
    println!("cargo:rerun-if-changed=../config/config.json");
    println!("cargo:rerun-if-changed=../config/config.example.json");
    println!("cargo:rerun-if-changed=../config/apps.json");
    println!("cargo:rerun-if-changed=../dist-tauri/config.json");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest_path = out_dir.join("bundled_config.json");

    let candidates = [
        PathBuf::from("../dist-tauri/config.json"),
        PathBuf::from("../config/config.json"),
        PathBuf::from("../config/apps.json"),
        PathBuf::from("../config/config.example.json"),
    ];

    let mut found = false;
    for candidate in &candidates {
        if candidate.is_file() {
            if let Ok(content) = fs::read_to_string(candidate) {
                if fs::write(&dest_path, content).is_ok() {
                    found = true;
                    break;
                }
            }
        }
    }

    if !found {
        let fallback = r#"{"schemaVersion":1,"name":"AWS Environment Desk","productName":"AWS Environment Desk","apps":[]}"#;
        let _ = fs::write(&dest_path, fallback);
    }

    tauri_build::build();
}
