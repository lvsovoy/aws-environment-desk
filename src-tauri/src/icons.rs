use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::PathBuf,
    time::Duration,
};

/// Fetch, sanitize, and cache allowlisted Dashboard Icons raster images, returning base64 data URLs.
pub async fn get(url: String, cache_directory: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || fetch_icon(&url, &cache_directory))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_icon(url: &str, cache_directory: &PathBuf) -> Result<String, String> {
    if !crate::config::dashboard_icon(url) {
        return Err(format!("Unsupported Dashboard Icons URL: {url}"));
    }

    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let filename = format!("{:x}.png", hasher.finalize());
    let cached = cache_directory.join(&filename);

    if let Ok(metadata) = fs::metadata(&cached) {
        if metadata.len() <= 2_097_152 {
            if let Ok(bytes) = fs::read(&cached) {
                if let Ok(img) = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png) {
                    if img.width() <= 128 && img.height() <= 128 {
                        let encoded = STANDARD.encode(&bytes);
                        return Ok(format!("data:image/png;base64,{encoded}"));
                    }
                }
            }
        }
        let _ = fs::remove_file(&cached);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Icon download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Icon download failed ({}): {url}", response.status()));
    }

    let mut body = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut total = 0;
    loop {
        let read = response.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        total += read;
        if total > 2_097_152 {
            return Err(format!("Icon exceeds 2 MiB: {url}"));
        }
        body.extend_from_slice(&chunk[..read]);
    }

    let format = image::guess_format(&body).map_err(|e| format!("Invalid icon format: {e}"))?;
    if format != image::ImageFormat::Png && format != image::ImageFormat::WebP {
        return Err(format!("Expected PNG or WebP icon: {url}"));
    }

    let img = image::load_from_memory(&body).map_err(|e| format!("Cannot decode icon: {e}"))?;
    let resized = if img.width() > 128 || img.height() > 128 {
        img.thumbnail(128, 128)
    } else {
        img
    };

    let mut buffer = Cursor::new(Vec::new());
    resized
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Cannot encode PNG icon: {e}"))?;
    let png_bytes = buffer.into_inner();

    let _ = fs::create_dir_all(cache_directory);
    let pending = cache_directory.join(format!("{filename}.{}.pending", std::process::id()));
    if fs::write(&pending, &png_bytes).is_ok() {
        let _ = fs::rename(&pending, &cached);
    }
    let _ = fs::remove_file(&pending);

    let encoded = STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_arbitrary_urls() {
        let dir = std::env::temp_dir().join("test-icons");
        let result = fetch_icon("https://example.com/icon.png", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported Dashboard Icons URL"));
    }
}
