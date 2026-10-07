//! Version-pinned local LiveChess adapter. No arbitrary executable or HTTP target is accepted.
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const PORT: u16 = 1983;
const PACKAGE_SHA256: &str = "9a57916ca020f8745cefaa1a85f29b7d04d08511c8ff856d5150909b602754de";
const MAX_PGN: usize = 1024 * 1024;

#[derive(Default)]
pub struct BridgeState(pub Arc<Mutex<()>>);

#[derive(Clone, Copy, Debug)]
enum Platform {
    Windows,
    Mac,
    Linux,
}

fn platform() -> Result<Platform, String> {
    if cfg!(windows) {
        Ok(Platform::Windows)
    } else if cfg!(target_os = "macos") {
        Ok(Platform::Mac)
    } else if cfg!(target_os = "linux") {
        Ok(Platform::Linux)
    } else {
        Err("LiveChess startup supports Windows, macOS and Linux.".into())
    }
}

fn data_directory(
    platform: Platform,
    home: &Path,
    appdata: Option<&Path>,
) -> Result<PathBuf, String> {
    match platform {
        Platform::Windows => Ok(appdata
            .ok_or("APPDATA is unavailable")?
            .join("DGT LiveChess/data")),
        Platform::Mac => Ok(home.join("Library/Application Support/DGT LiveChess")),
        Platform::Linux => {
            let current = home.join(".dgt_livechess");
            let legacy = home.join(".dgt livechess");
            // The loader migrates the legacy directory. Check it before that migration.
            if legacy.exists() {
                if current.exists() {
                    return Err("Both legacy and current LiveChess data directories exist; reconcile them before startup.".into());
                }
                Ok(legacy)
            } else {
                Ok(current)
            }
        }
    }
}

fn check_layout_lock(layout: &Path) -> Result<Option<fs::File>, String> {
    if !layout.exists() {
        return Ok(None);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(layout)
        .map_err(|_| {
            "Cannot open LiveChess data. Close the existing instance and check permissions."
        })?;
    #[cfg(windows)]
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "LiveChess data is locked. Close the existing instance first.")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // Java FileChannel uses POSIX record locks; flock does not detect them on Linux.
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        lock.l_start = 0;
        lock.l_len = 0;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == -1 {
            return Err(
                "LiveChess data is locked or cannot be locked. Close the existing instance first."
                    .into(),
            );
        }
    }
    Ok(Some(file))
}

fn token(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("livechess-bridge-token");
    #[cfg(unix)]
    if path.exists() {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "LiveChess credential must be a private regular file (permissions 0600).".into(),
            );
        }
    }
    match fs::read_to_string(&path) {
        Ok(value) if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(value),
        Ok(_) => {
            Err("Invalid LiveChess bridge credential file; restore it before reconnecting.".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            use std::io::Write;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path).map_err(|e| e.to_string())?;
            file.write_all(value.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn request(
    app: &AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .request(method, format!("http://127.0.0.1:{PORT}{path}"))
        .bearer_auth(token(app)?);
    if let Some(value) = body {
        request = request.json(&value);
    }
    let response = request.send().map_err(|_| {
        "Cannot reach the managed LiveChess add-on. Start LiveChess from Pairing sync settings."
            .to_string()
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|_| "Invalid response from LiveChess add-on.".to_string())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("LiveChess rejected the request.")
            .to_string());
    }
    Ok(value)
}

fn health(app: &AppHandle) -> Result<Value, String> {
    // Prove the listener knows our credential BEFORE sending any bearer credential.
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(250))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("http://127.0.0.1:{PORT}/health?nonce={nonce}"))
        .send()
        .map_err(|_| "LiveChess add-on is not connected.".to_string())?;
    if !response.status().is_success() {
        return Err("LiveChess add-on could not authenticate itself.".into());
    }
    let value: Value = response
        .json()
        .map_err(|_| "Invalid LiveChess health response.".to_string())?;
    let proof = value["serverProof"]
        .as_str()
        .ok_or("Missing LiveChess server proof")?;
    if proof.len() != 64 || !proof.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid LiveChess server proof".into());
    }
    let bytes = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&proof[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token(app)?.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(nonce.as_bytes());
    mac.verify_slice(&bytes)
        .map_err(|_| "The local listener is not this app's LiveChess add-on.".to_string())?;
    if value["ready"] != true
        || value["supported"] != true
        || value["protocolVersion"] != 1
        || !((value["version"] == "2.2" && value["build"] == 18071800)
            || (value["version"] == "2.2.11" && value["build"] == 26052800))
    {
        return Err("Unsupported LiveChess bridge version; use the bundled add-on and supported LiveChess 2.2 build.".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn livechess_status(
    app: AppHandle,
    state: State<'_, BridgeState>,
) -> Result<Value, String> {
    let lock = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Bridge state unavailable")?;
        match health(&app) {
            Ok(value) => Ok(json!({"connected":true,"managed":true,"supportedVersion":value})),
            Err(error) => Ok(json!({"connected":false,"managed":false,"message":error})),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn installation_paths(install: &Path, platform: Platform) -> (PathBuf, PathBuf) {
    match platform {
        Platform::Windows => (
            install.join("runtime/bin/java.exe"),
            install.join("app/package.jar"),
        ),
        Platform::Linux => (
            install.join("DGTLiveChess"),
            install.join("app/package.jar"),
        ),
        Platform::Mac => (
            install.join("Contents/MacOS/DGT LiveChess"),
            install.join("Contents/Java/package.jar"),
        ),
    }
}

fn verify_install_for(install: &Path, platform: Platform) -> Result<(PathBuf, PathBuf), String> {
    let (executable, package) = installation_paths(install, platform);
    if !executable.is_file() {
        return Err(format!(
            "Select the installed LiveChess folder containing {}.",
            executable.display()
        ));
    }
    let bytes =
        fs::read(&package).map_err(|_| "Cannot read the LiveChess package.jar.".to_string())?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    if hash != PACKAGE_SHA256 {
        return Err("Unsupported LiveChess package. This integration is pinned to the tested 2.2 build 18071800.".into());
    }
    Ok((executable, package))
}

fn verify_install(install: &Path) -> Result<(PathBuf, PathBuf), String> {
    verify_install_for(install, platform()?)
}

fn tool_options(agent: &Path, credential: &Path, home: &Path) -> Result<String, String> {
    let option = format!(
        "-javaagent:{}={PORT},@{}",
        agent.display(),
        credential.display()
    );
    // HotSpot parses JAVA_TOOL_OPTIONS with quoted whitespace. Reject characters
    // that would alter its tokenization instead of building a shell command.
    let user_home = format!("-Duser.home={}", home.display());
    if option.contains(['"', '\'', '\n', '\r']) || user_home.contains(['"', '\'', '\n', '\r']) {
        return Err("LiveChess add-on paths cannot contain quotes or newlines.".into());
    }
    Ok(format!(
        "\"{option}\" \"{user_home}\" -Dfile.encoding=UTF-8"
    ))
}

fn agent_resource(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(directory) = app.path().resource_dir() {
        let bundled = directory.join("resources/livechess-agent.jar");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    // Portable CI builds keep resources alongside the executable. Installed
    // bundles use Tauri's platform resource directory above.
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(parent) = executable.parent() {
        let portable = parent.join("resources/livechess-agent.jar");
        if portable.is_file() {
            return Ok(portable);
        }
    }
    Err("The bundled LiveChess add-on is missing. Reinstall this Lichess Broadcaster build.".into())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn livechess_start(
    app: AppHandle,
    state: State<'_, BridgeState>,
    install_directory: String,
) -> Result<Value, String> {
    let lock = state.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Bridge state unavailable")?;
        if let Ok(value) = health(&app) { return Ok(json!({"connected":true,"managed":true,"supportedVersion":value})); }
        let platform = platform()?;
        let (executable, package) = verify_install(Path::new(&install_directory))?;
        for port in [1982, PORT] {
            if TcpStream::connect_timeout(&SocketAddr::from(([127,0,0,1],port)),Duration::from_millis(250)).is_ok() {
                return Err(format!("Port {port} is in use. Close the existing LiveChess instance first; the app will not stop it or start a second copy."));
            }
        }
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
        let data = data_directory(platform, &home, appdata.as_deref())?;
        let layout = data.join("layout.bin");
        // JavaFX's layout store locks this file for the process lifetime.
        let layout_guard = check_layout_lock(&layout)?;
        let agent = agent_resource(&app)?;
        token(&app)?;
        let working = app.path().app_local_data_dir().map_err(|e|e.to_string())?;
        let credential = working.join("livechess-bridge-token");
        let output = fs::OpenOptions::new().create(true).append(true).open(working.join("livechess.log")).map_err(|e|e.to_string())?;
        let errors = output.try_clone().map_err(|e|e.to_string())?;
        let mut command = Command::new(executable);
        match platform {
            Platform::Windows => {
                command.arg(format!("-javaagent:{}={PORT},@{}",agent.display(),credential.display()))
                    .arg("-Dcom.novotea.livechess.loader.directory=user").arg("-Dfile.encoding=UTF-8").arg("-cp").arg(package)
                    .arg("com.novotea.livechess.loader.LiveChessLoader");
            }
            Platform::Mac | Platform::Linux => {
                // Unix installers contain a trimmed runtime without bin/java.
                // Their native launcher supplies its own JVM/classpath/config.
                command.env("JAVA_TOOL_OPTIONS",tool_options(&agent, &credential, &home)?);
            }
        }
        command.env_remove("_JAVA_OPTIONS").env_remove("JDK_JAVA_OPTIONS");
        if matches!(platform, Platform::Windows) { command.env_remove("JAVA_TOOL_OPTIONS"); }
        command.current_dir(working).stdout(output).stderr(errors);
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW; JavaFX's main window still appears.
        }
        drop(layout_guard);
        let mut child = command.spawn().map_err(|e|format!("Cannot start LiveChess: {e}"))?;
        let deadline=std::time::Instant::now()+Duration::from_secs(60);
        while std::time::Instant::now()<deadline {
            if let Ok(value) = health(&app) { return Ok(json!({"connected":true,"managed":true,"supportedVersion":value})); }
            if child.try_wait().map_err(|e|e.to_string())?.is_some() { return Err("LiveChess exited during startup; see livechess.log in the app's local data folder.".into()); }
            std::thread::sleep(Duration::from_secs(1));
        }
        Err("LiveChess started but its add-on is not ready. Check livechess.log; do not launch another copy.".into())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn livechess_tournaments(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        health(&app)?;
        request(&app, reqwest::Method::GET, "/tournaments", None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn livechess_import(
    app: AppHandle,
    tournament_id: String,
    round_number: u32,
    pgn: String,
    request_id: String,
) -> Result<Value, String> {
    if uuid::Uuid::parse_str(&tournament_id).is_err()
        || request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || round_number == 0
        || round_number > 100
        || pgn.is_empty()
        || pgn.len() > MAX_PGN
    {
        return Err("Invalid pairing import parameters.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        health(&app)?;
        request(
            &app,
            reqwest::Method::POST,
            "/pairings",
            Some(json!({"tournamentId":tournament_id,
            "roundNumber":round_number,"pgn":pgn,"requestId":request_id})),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_install_before_launch() {
        assert!(verify_install(Path::new("definitely-not-livechess")).is_err());
    }
    #[test]
    fn altered_application_is_rejected_before_execution() {
        let root = std::env::temp_dir().join(format!(
            "broadcaster-install-check-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("runtime/bin")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("runtime/bin/java.exe"), b"not executable").unwrap();
        fs::write(root.join("app/package.jar"), b"unexpected application").unwrap();
        assert!(verify_install_for(&root, Platform::Windows)
            .unwrap_err()
            .contains("Unsupported LiveChess package"));
        fs::remove_file(root.join("app/package.jar")).unwrap();
        fs::remove_file(root.join("runtime/bin/java.exe")).unwrap();
        fs::remove_dir(root.join("app")).unwrap();
        fs::remove_dir(root.join("runtime/bin")).unwrap();
        fs::remove_dir(root.join("runtime")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn resolves_platform_installation_and_data_paths() {
        let root = Path::new("installed");
        assert_eq!(
            installation_paths(root, Platform::Mac),
            (
                root.join("Contents/MacOS/DGT LiveChess"),
                root.join("Contents/Java/package.jar")
            )
        );
        assert_eq!(
            installation_paths(root, Platform::Linux),
            (root.join("DGTLiveChess"), root.join("app/package.jar"))
        );
        let home = std::env::temp_dir().join(format!("broadcaster-home-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        assert_eq!(
            data_directory(Platform::Mac, &home, None).unwrap(),
            home.join("Library/Application Support/DGT LiveChess")
        );
        assert_eq!(
            data_directory(Platform::Linux, &home, None).unwrap(),
            home.join(".dgt_livechess")
        );
        let legacy = home.join(".dgt livechess");
        fs::create_dir(&legacy).unwrap();
        assert_eq!(
            data_directory(Platform::Linux, &home, None).unwrap(),
            legacy
        );
        fs::create_dir(home.join(".dgt_livechess")).unwrap();
        assert!(data_directory(Platform::Linux, &home, None).is_err());
        fs::remove_dir(home.join(".dgt_livechess")).unwrap();
        fs::remove_dir(legacy).unwrap();
        fs::remove_dir(home).unwrap();
    }

    #[test]
    fn tool_options_quote_paths_and_reject_option_injection() {
        let options = tool_options(
            Path::new("app path/agent.jar"),
            Path::new("private path/token"),
            Path::new("user home"),
        )
        .unwrap();
        assert_eq!(
            options,
            "\"-javaagent:app path/agent.jar=1983,@private path/token\" \"-Duser.home=user home\" -Dfile.encoding=UTF-8"
        );
        assert!(tool_options(
            Path::new("bad\"path"),
            Path::new("token"),
            Path::new("home")
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "subprocess fixture for POSIX record-lock compatibility"]
    fn posix_lock_holder() {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        let path = std::env::var_os("BROADCASTER_TEST_LOCK_PATH").unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        // Java FileChannel's whole-file lock is the same POSIX record-lock range.
        assert_ne!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) },
            -1
        );
        println!("record lock acquired");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_secs(30));
        drop(file);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_existing_posix_record_lock_from_another_process() {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        let path = std::env::temp_dir().join(format!("broadcaster-lock-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"layout").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "livechess::tests::posix_lock_holder",
                "--ignored",
                "--nocapture",
            ])
            .env("BROADCASTER_TEST_LOCK_PATH", &path)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut acquired = false;
        let mut line = String::new();
        while output.read_line(&mut line).unwrap() != 0 {
            if line.contains("record lock acquired") {
                acquired = true;
                break;
            }
            line.clear();
        }
        let locked = if acquired {
            check_layout_lock(&path).is_err()
        } else {
            false
        };
        let _ = child.kill();
        child.wait().unwrap();
        let released = check_layout_lock(&path).unwrap();
        drop(released);
        fs::remove_file(path).unwrap();
        assert!(acquired, "Subprocess did not acquire the POSIX record lock");
        assert!(
            locked,
            "Startup must detect Java-compatible locks, rather than flock locks"
        );
    }
}
