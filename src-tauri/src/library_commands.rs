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

// Movies — community IMDb mirror. Apple removed video from the iTunes Search API
// (movie/tvSeason queries now return 0), and TMDB/OMDb both require an API key, so this
// keyless endpoint is the only no-key movie-poster source. Rows look like
// { "#TITLE": "...", "#IMG_POSTER": "https://m.media-amazon.com/.../._V1_.jpg" }.
#[derive(Deserialize, Debug)]
struct ImdbResponse {
    #[serde(default)]
    description: Vec<ImdbRow>,
}
#[derive(Deserialize, Debug)]
struct ImdbRow {
    #[serde(rename = "#TITLE")]
    title: Option<String>,
    #[serde(rename = "#IMG_POSTER")]
    poster: Option<String>,
}

// TV — TVMaze: keyless, official, returns portrait show posters. Response is a bare
// array of { show: { name, image: { medium, original } } }.
#[derive(Deserialize, Debug)]
struct TvMazeWrap {
    show: TvMazeShow,
}
#[derive(Deserialize, Debug)]
struct TvMazeShow {
    name: String,
    image: Option<TvMazeImage>,
}
#[derive(Deserialize, Debug)]
struct TvMazeImage {
    original: Option<String>,
    medium: Option<String>,
}

// Games — Steam Community SearchApps. NOTE: appid comes back as a JSON *string*
// (`"appid":"620"`), not a number — declaring it u64 made every game search fail to
// parse. Keep it a String.
#[derive(Deserialize, Debug)]
struct SteamApp {
    appid: String,
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
            // Keyless IMDb mirror. It returns the full match set in one response (no
            // server paging), so we slice client-side to match the picker's "next set".
            // ponytail: single community endpoint — if it goes down, swap to TMDB with a
            // user-supplied key; the candidate shape ({url,title}) stays identical.
            let url = format!("https://imdb.iamidiotareyoutoo.com/search?q={}", urlencoding::encode(&query));
            let body = get_text(&client, &url).await?;
            let json: ImdbResponse = serde_json::from_str(&body)
                .map_err(|e| format!("Movie provider response could not be parsed: {e}"))?;
            let start = ((page - 1) * 10) as usize;
            for row in json.description.into_iter().skip(start).take(10) {
                if let (Some(title), Some(poster)) = (row.title, row.poster) {
                    if !poster.is_empty() {
                        candidates.push(CoverCandidate { url: poster, title });
                    }
                }
            }
        }
        "tv" => {
            // TVMaze returns up to ~10 shows in one call; slice client-side for paging.
            let url = format!("https://api.tvmaze.com/search/shows?q={}", urlencoding::encode(&query));
            let body = get_text(&client, &url).await?;
            let shows: Vec<TvMazeWrap> = serde_json::from_str(&body)
                .map_err(|e| format!("TVMaze response could not be parsed: {e}"))?;
            let start = ((page - 1) * 10) as usize;
            for wrap in shows.into_iter().skip(start).take(10) {
                if let Some(img) = wrap.show.image {
                    // original is full-res portrait; medium is the fallback.
                    if let Some(u) = img.original.or(img.medium) {
                        candidates.push(CoverCandidate { url: u, title: wrap.show.name });
                    }
                }
            }
        }
        "game" => {
            // Steam Community search - free, no key, returns appid (as a string) + name.
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
    // A UA is required: the Amazon image CDN (movie posters) 403s requests without one.
    let client = reqwest::Client::builder()
        .user_agent("LOOM/1.0 (media library)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Cover download failed (HTTP {}).", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    
    let ext = if url.to_lowercase().ends_with(".png") { "png" } else { "jpg" };
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let target_path = covers_dir.join(&filename);
    
    fs::write(&target_path, bytes).map_err(|e| e.to_string())?;
    
    Ok(target_path.to_string_lossy().to_string())
}
