use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{Manager, AppHandle};

#[derive(Serialize, Deserialize, Debug)]
pub struct CoverCandidate {
    pub url: String,
    pub title: String,
}

#[derive(Deserialize, Debug)]
struct JikanResponse {
    data: Vec<JikanAnime>,
}

#[derive(Deserialize, Debug)]
struct JikanAnime {
    title: String,
    images: JikanImages,
}

#[derive(Deserialize, Debug)]
struct JikanImages {
    jpg: JikanJpg,
}

#[derive(Deserialize, Debug)]
struct JikanJpg {
    large_image_url: String,
}

#[derive(Deserialize, Debug)]
struct OpenLibraryResponse {
    docs: Vec<OpenLibraryDoc>,
}

#[derive(Deserialize, Debug)]
struct OpenLibraryDoc {
    title: String,
    cover_i: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct ItunesResponse {
    results: Vec<ItunesResult>,
}

#[derive(Deserialize, Debug)]
struct ItunesResult {
    #[serde(alias = "trackName", alias = "collectionName")]
    name: Option<String>,
    #[serde(alias = "artworkUrl100", alias = "artworkUrl512")]
    artwork: Option<String>,
}

#[derive(Deserialize, Debug)]
struct SteamApp {
    appid: u64,
    name: String,
}

fn get_covers_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let covers_dir = app_data_dir.join("Covers");
    if !covers_dir.exists() {
        fs::create_dir_all(&covers_dir).map_err(|e| e.to_string())?;
    }
    Ok(covers_dir)
}

// GET with one retry on transient failure. Surfaces a real error string instead of
// silently swallowing network/parse failures (which previously masqueraded as
// "no covers found").
async fn get_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let mut last = String::new();
    for attempt in 0..2 {
        match client.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return Err(format!("Cover provider returned HTTP {}.", resp.status().as_u16()));
                }
                return resp.text().await.map_err(|e| e.to_string());
            }
            Err(e) => {
                last = e.to_string();
                if attempt == 0 { continue; }
            }
        }
    }
    Err(format!("Couldn't reach the cover provider: {}", last))
}

#[tauri::command]
pub async fn fetch_cover_candidates(query: String, media_type: String, page: Option<u32>) -> Result<Vec<CoverCandidate>, String> {
    if query.trim().is_empty() {
        return Err("Search query is empty.".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("LOOM/1.0 (media library)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    let page = page.unwrap_or(1).max(1);

    match media_type.as_str() {
        "anime" | "manga" | "manhwa" | "manhua" => {
            let kind = if media_type == "anime" { "anime" } else { "manga" };
            let url = format!("https://api.jikan.moe/v4/{}?q={}&limit=10&page={}", kind, urlencoding::encode(&query), page);
            let body = get_text(&client, &url).await?;
            let json: JikanResponse = serde_json::from_str(&body)
                .map_err(|e| format!("Jikan response could not be parsed: {e}"))?;
            for item in json.data {
                candidates.push(CoverCandidate { url: item.images.jpg.large_image_url, title: item.title });
            }
        }
        "book" => {
            let url = format!("https://openlibrary.org/search.json?q={}&limit=10&page={}", urlencoding::encode(&query), page);
            let body = get_text(&client, &url).await?;
            let json: OpenLibraryResponse = serde_json::from_str(&body)
                .map_err(|e| format!("OpenLibrary response could not be parsed: {e}"))?;
            for doc in json.docs {
                if let Some(cover_i) = doc.cover_i {
                    candidates.push(CoverCandidate {
                        url: format!("https://covers.openlibrary.org/b/id/{}-L.jpg", cover_i),
                        title: doc.title,
                    });
                }
            }
        }
        "movie" => {
            let offset = (page - 1) * 10;
            let url = format!("https://itunes.apple.com/search?term={}&entity=movie&limit=10&offset={}", urlencoding::encode(&query), offset);
            let body = get_text(&client, &url).await?;
            let json: ItunesResponse = serde_json::from_str(&body)
                .map_err(|e| format!("iTunes response could not be parsed: {e}"))?;
            for result in json.results {
                if let (Some(name), Some(artwork)) = (result.name, result.artwork) {
                    candidates.push(CoverCandidate { url: artwork.replace("100x100bb", "600x600bb"), title: name });
                }
            }
        }
        "tv" => {
            let offset = (page - 1) * 10;
            let url = format!("https://itunes.apple.com/search?term={}&entity=tvSeason&limit=10&offset={}", urlencoding::encode(&query), offset);
            let body = get_text(&client, &url).await?;
            let json: ItunesResponse = serde_json::from_str(&body)
                .map_err(|e| format!("iTunes response could not be parsed: {e}"))?;
            for result in json.results {
                if let (Some(name), Some(artwork)) = (result.name, result.artwork) {
                    candidates.push(CoverCandidate { url: artwork.replace("100x100bb", "600x600bb"), title: name });
                }
            }
        }
        "game" => {
            // Steam Community search - free, no key, returns appid + name.
            // library_600x900.jpg is the 2:3 portrait capsule, ideal for card UI.
            let url = format!("https://steamcommunity.com/actions/SearchApps/{}", urlencoding::encode(&query));
            let body = get_text(&client, &url).await?;
            let all: Vec<SteamApp> = serde_json::from_str(&body)
                .map_err(|e| format!("Steam response could not be parsed: {e}"))?;
            let start = ((page - 1) * 10) as usize;
            for app in all.iter().skip(start).take(10) {
                candidates.push(CoverCandidate {
                    url: format!("https://cdn.akamai.steamstatic.com/steam/apps/{}/library_600x900.jpg", app.appid),
                    title: app.name.clone(),
                });
            }
        }
        other => {
            return Err(format!("No cover provider configured for media type '{}'.", other));
        }
    }

    // Empty is a valid, real result (no matches) - not an error. The frontend handles
    // the empty case distinctly from a thrown error.
    Ok(candidates)
}

#[tauri::command]
pub async fn download_and_cache_cover(app_handle: AppHandle, url: String) -> Result<String, String> {
    let covers_dir = get_covers_dir(&app_handle)?;
    let client = reqwest::Client::new();
    
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    
    let ext = if url.to_lowercase().ends_with(".png") { "png" } else { "jpg" };
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let target_path = covers_dir.join(&filename);
    
    fs::write(&target_path, bytes).map_err(|e| e.to_string())?;
    
    Ok(target_path.to_string_lossy().to_string())
}
