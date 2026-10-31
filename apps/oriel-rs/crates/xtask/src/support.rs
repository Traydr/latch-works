//! What the commands share: the workspace's folders, running a step with its output in a log,
//! pinned downloads, unpacking, reading Mach-O load commands, and the manifest's JSON layout.
//!
//! Every system tool is run by absolute path, so nothing on the caller's `PATH` can stand in for
//! it; only meson, ninja and pkgconf, which the libmpv build needs from Homebrew, are looked up.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use serde::ser::{Serialize, SerializeMap as _, Serializer};
use sha2::{Digest as _, Sha256};

/// Libraries every Mac has, which a set may link without carrying them.
const SYSTEM_PREFIXES: [&str; 2] = ["/usr/lib/", "/System/Library/"];

/// How long one download may take before the next try.
const DOWNLOAD_TIMEOUT_SECONDS: &str = "120";

/// `apps/oriel-rs`, found from this crate's folder at compile time.
pub fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/xtask sits two folders under the workspace")
        .to_path_buf()
}

/// Whether this is the one platform the sets and the bundle are made for.
pub fn is_mac_arm64() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

pub fn log(message: impl AsRef<str>) {
    println!("{}", message.as_ref());
}

/// One step's command, run in an environment of its own with its output in a log file.
pub struct Step<'a> {
    pub label: String,
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: &'a Path,
    /// The whole environment the command sees: nothing is inherited.
    pub env: &'a [(String, OsString)],
    pub log: PathBuf,
}

/// Runs a step, printing the end of its log if it fails.
pub fn run(step: &Step<'_>) -> Result<()> {
    let started = Instant::now();
    if let Some(folder) = step.log.parent() {
        fs::create_dir_all(folder)?;
    }
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&step.log)
        .with_context(|| format!("opening {}", step.log.display()))?;
    let status = Command::new(&step.program)
        .args(&step.args)
        .current_dir(step.cwd)
        .env_clear()
        .envs(step.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .status()
        .with_context(|| format!("{}: starting {}", step.label, step.program.display()))?;

    if !status.success() {
        let text = String::from_utf8_lossy(&fs::read(&step.log).unwrap_or_default()).into_owned();
        let lines: Vec<&str> = text.split('\n').collect();
        eprintln!("{}", lines[lines.len().saturating_sub(40)..].join("\n"));
        bail!(
            "{} failed ({status}); the full log is {}",
            step.label,
            step.log.display()
        );
    }

    log(format!(
        "    {}: done in {:.1} s",
        step.label,
        started.elapsed().as_secs_f64()
    ));
    Ok(())
}

/// Output of a short command whose failure stops the command that asked.
pub fn capture(program: impl AsRef<OsStr>, args: &[&OsStr]) -> Result<String> {
    let program = program.as_ref();
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("starting {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "{} {} failed ({}): {}",
            program.display(),
            args.iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs a command with its output on this terminal; a failure stops the command that asked.
pub fn run_here(program: impl AsRef<OsStr>, args: &[&OsStr], cwd: &Path) -> Result<()> {
    let program = program.as_ref();
    log(format!(
        "$ {} {}",
        program.display(),
        args.iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
    ));
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .with_context(|| format!("starting {}", program.display()))?;
    if !status.success() {
        bail!("{} failed ({status})", program.display());
    }
    Ok(())
}

/// Lowercase hex SHA-256 of a file.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn sha256_text(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A download and the SHA-256 it must hash to before anything unpacks it.
pub struct Download<'a> {
    /// Where it is published, then mirrors serving the same file, tried in turn.
    pub urls: &'a [&'a str],
    pub sha256: &'a str,
    /// The name it is kept under in the download cache.
    pub file: &'a str,
    /// Request headers, such as the anonymous token GitHub's container registry asks for.
    pub headers: &'a [&'a str],
}

/// Downloads into `downloads` unless a file there already has the pinned hash, and returns its
/// path. A file with another hash is refused and deleted, whichever URL it came from.
pub fn download(downloads: &Path, pin: &Download<'_>) -> Result<PathBuf> {
    let target = downloads.join(pin.file);
    if target.exists() {
        if sha256_file(&target)? == pin.sha256 {
            return Ok(target);
        }
        log(format!(
            "    {}: cached copy has another hash; downloading it again",
            pin.file
        ));
        fs::remove_file(&target)?;
    }

    fs::create_dir_all(downloads)?;
    let partial = downloads.join(format!("{}.part", pin.file));
    fetch_first(pin, &partial)?;
    let actual = sha256_file(&partial)?;
    if actual != pin.sha256 {
        let _ = fs::remove_file(&partial);
        bail!(
            "{} hashes to {actual}, not the pinned {}; refusing to use it",
            pin.file,
            pin.sha256
        );
    }
    fs::rename(&partial, &target)?;
    Ok(target)
}

/// The first of the pin's URLs that answers, each tried twice: some publishers' servers
/// (savannah, for FreeType) are often unreachable for a while. Uses the system's curl, over
/// HTTPS only, redirects included.
fn fetch_first(pin: &Download<'_>, partial: &Path) -> Result<()> {
    let mut failures = Vec::new();
    for url in pin.urls {
        for _attempt in 0..2 {
            log(format!("    downloading {url}"));
            let mut command = Command::new(system_tool("curl"));
            command
                .args(["--fail", "--location", "--silent", "--show-error"])
                .args(["--proto", "=https", "--proto-redir", "=https"])
                .args(["--max-time", DOWNLOAD_TIMEOUT_SECONDS]);
            for header in pin.headers {
                // curl sends a header given this way to the first host only, not on a redirect.
                command.args(["--header", header]);
            }
            let output = command
                .arg("--output")
                .arg(partial)
                .arg(url)
                .stdin(Stdio::null())
                .output()
                .context("starting curl")?;
            if output.status.success() {
                return Ok(());
            }
            failures.push(format!(
                "{url}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    let _ = fs::remove_file(partial);
    bail!("could not download:\n  {}", failures.join("\n  "))
}

/// One of the system's own tools both systems carry, by absolute path: `/usr/bin/<name>` on
/// macOS, `System32\<name>.exe` on Windows, where curl and bsdtar ship since Windows 10 1803.
pub fn system_tool(name: &str) -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        PathBuf::from(root)
            .join("System32")
            .join(format!("{name}.exe"))
    } else {
        Path::new("/usr/bin").join(name)
    }
}

/// Unpacks an archive into an empty folder of its own, dropping `strip` leading folders.
/// bsdtar refuses `..` and absolute paths.
pub fn unpack(archive: &Path, folder: &Path, strip: u32, log_file: PathBuf) -> Result<()> {
    if folder.exists() {
        fs::remove_dir_all(folder)?;
    }
    fs::create_dir_all(folder)?;
    let label = format!(
        "unpack {}",
        archive.file_name().unwrap_or_default().to_string_lossy()
    );
    run(&Step {
        label,
        program: system_tool("tar").into(),
        args: vec![
            "-xf".into(),
            archive.into(),
            "-C".into(),
            folder.into(),
            format!("--strip-components={strip}").into(),
        ],
        cwd: folder,
        env: &[("PATH".into(), "/usr/bin:/bin".into())],
        log: log_file,
    })
}

/// Finds the first of `names` on the caller's `PATH`, as a shell would.
pub fn find_on_path(names: &[&str]) -> Result<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for name in names {
        for folder in std::env::split_paths(&path) {
            let candidate = folder.join(name);
            if is_executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    bail!(
        "{} is not on PATH; see docs/runbooks/oriel-rs.md",
        names.join(" or ")
    )
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// What a Mach-O file's load commands say about it.
#[derive(Debug, Default)]
pub struct MachO {
    pub id: Option<String>,
    pub links: Vec<String>,
    pub rpaths: Vec<String>,
    pub minos: Option<String>,
}

/// Reads the install name, linked libraries, rpaths and minimum macOS from `otool -l`.
pub fn read_macho(file: &Path) -> Result<MachO> {
    let mut macho = MachO::default();
    let mut command = String::new();
    for line in capture("/usr/bin/otool", &["-l".as_ref(), file.as_os_str()])?.lines() {
        let Some((key, rest)) = line.trim().split_once(' ') else {
            continue;
        };
        let value = strip_offset(rest).to_owned();
        match key {
            "cmd" => command = value,
            "name" if command == "LC_ID_DYLIB" => macho.id = Some(value),
            "name" if command.starts_with("LC_") && command.contains("DYLIB") => {
                macho.links.push(value);
            }
            "path" if command == "LC_RPATH" => macho.rpaths.push(value),
            "minos" if command == "LC_BUILD_VERSION" => macho.minos = Some(value),
            _ => {}
        }
    }
    Ok(macho)
}

/// `otool -l` ends a name with ` (offset N)`.
fn strip_offset(value: &str) -> &str {
    match value.rfind(" (offset ") {
        Some(start)
            if value.ends_with(')')
                && value[start + 9..value.len() - 1]
                    .chars()
                    .all(|c| c.is_ascii_digit()) =>
        {
            &value[..start]
        }
        _ => value,
    }
}

pub fn is_system(link: &str) -> bool {
    SYSTEM_PREFIXES
        .iter()
        .any(|prefix| link.starts_with(prefix))
}

/// Compares dotted versions number by number, a missing number counting as 0.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |text: &str| -> Vec<u64> {
        text.split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (left, right) = (parse(a), parse(b));
    for index in 0..left.len().max(right.len()) {
        let order = left
            .get(index)
            .unwrap_or(&0)
            .cmp(right.get(index).unwrap_or(&0));
        if order.is_ne() {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

/// Gives a copied library the install name `@rpath/<file>`, points each of `relink`'s links at
/// `@rpath/<its file>`, leaves `@loader_path` its only rpath, and signs it ad hoc.
pub fn relocate(target: &Path, file: &str, relink: &[(String, String)]) -> Result<()> {
    let macho = read_macho(target)?;
    let mut args: Vec<OsString> = vec!["-id".into(), format!("@rpath/{file}").into()];
    for (link, member) in relink {
        if *link != format!("@rpath/{member}") {
            args.extend([
                "-change".into(),
                link.into(),
                format!("@rpath/{member}").into(),
            ]);
        }
    }
    for rpath in macho.rpaths.iter().filter(|rpath| *rpath != "@loader_path") {
        args.extend(["-delete_rpath".into(), rpath.into()]);
    }
    if !macho.rpaths.iter().any(|rpath| rpath == "@loader_path") {
        args.extend(["-add_rpath".into(), "@loader_path".into()]);
    }
    args.push(target.into());
    let args: Vec<&OsStr> = args.iter().map(OsString::as_os_str).collect();
    capture("/usr/bin/install_name_tool", &args)?;
    sign_ad_hoc(target)
}

pub fn sign_ad_hoc(target: &Path) -> Result<()> {
    capture(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            target.as_os_str(),
        ],
    )?;
    Ok(())
}

/// The problems that keep a relocated library out of a set: an install name other than
/// `@rpath/<file>`, a link to anything but the set and the system, or another rpath.
pub fn set_member_problems(macho: &MachO, file: &str, members: &[String]) -> Vec<String> {
    let mut problems = Vec::new();
    if macho.id.as_deref() != Some(format!("@rpath/{file}").as_str()) {
        problems.push(format!("its install name is {:?}", macho.id));
    }
    for link in &macho.links {
        if !is_system(link)
            && !members
                .iter()
                .any(|member| *link == format!("@rpath/{member}"))
        {
            problems.push(format!("it links {link}"));
        }
    }
    if macho.rpaths.join(" ") != "@loader_path" {
        problems.push(format!("its rpaths are {}", macho.rpaths.join(", ")));
    }
    problems
}

/// Points `<root>/current` at `id`, replacing the link in one rename.
pub fn point_current_at(root: &Path, id: &str) -> Result<()> {
    let current = root.join("current");
    let next = root.join("current.next");
    let _ = fs::remove_file(&next);
    symlink(Path::new(id), &next)?;
    fs::rename(&next, &current)?;
    Ok(())
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// A folder holding only the named tools, as links, for a `PATH` that holds nothing else.
pub fn link_tools(folder: &Path, tools: &[(&str, PathBuf)]) -> Result<()> {
    if folder.exists() {
        fs::remove_dir_all(folder)?;
    }
    fs::create_dir_all(folder)?;
    for (link, target) in tools {
        symlink(target, &folder.join(link))?;
    }
    Ok(())
}

/// Every regular file's size under `folder`, not following links.
pub fn folder_bytes(folder: &Path) -> io::Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_file() {
            total += entry.metadata()?.len();
        } else if kind.is_dir() {
            total += folder_bytes(&entry.path())?;
        }
    }
    Ok(total)
}

pub fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// Copies a folder's files and folders into `to`, links as links.
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            symlink(&fs::read_link(entry.path())?, &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The time as `JSON.stringify(new Date())` writes it: UTC, to the millisecond.
pub fn iso_now() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = since.as_secs();
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        since.subsec_millis()
    )
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// String pairs written as a JSON object in their order, as `Object.fromEntries` writes a `Map`.
#[derive(Debug, Default)]
pub struct Pairs(pub Vec<(String, String)>);

impl Pairs {
    /// Sets `key`, keeping its first place if it is already there, as `Map.set` does.
    pub fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(existing, _)| existing == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }
}

impl Serialize for Pairs {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// `value` as `JSON.stringify(value, null, 2)` lays it out, with each array of plain values on
/// one line when it fits in 100 columns, which is how the repository's Biome lays JSON out.
pub fn format_json(value: &impl Serialize) -> Result<String> {
    let text = serde_json::to_string_pretty(value)?;
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if line.ends_with('[') {
            let values: Vec<&str> = lines[index + 1..]
                .iter()
                .take_while(|item| is_plain_value_line(item))
                .copied()
                .collect();
            let closing = lines.get(index + 1 + values.len()).copied();
            if let Some(comma) = closing.and_then(closing_bracket)
                && !values.is_empty()
            {
                let items: Vec<&str> = values
                    .iter()
                    .map(|item| {
                        let item = item.trim();
                        item.strip_suffix(',').unwrap_or(item)
                    })
                    .collect();
                let joined = format!("{line}{}]{comma}", items.join(", "));
                if joined.chars().count() <= 100 {
                    out.push(joined);
                    index += values.len() + 2;
                    continue;
                }
            }
        }
        out.push(line.to_owned());
        index += 1;
    }
    Ok(format!("{}\n", out.join("\n")))
}

/// A line of spaces then `]`, and the comma after it if there is one.
fn closing_bracket(line: &str) -> Option<&'static str> {
    match line.trim_start_matches(' ') {
        "]" => Some(""),
        "]," => Some(","),
        _ => None,
    }
}

/// Spaces, then a string, number, `true`, `false` or `null`, then an optional comma.
fn is_plain_value_line(line: &str) -> bool {
    let item = line.trim_start_matches(' ');
    let item = item.strip_suffix(',').unwrap_or(item);
    if matches!(item, "true" | "false" | "null") {
        return true;
    }
    if !item.is_empty()
        && item
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        return true;
    }
    let mut chars = item.chars();
    if chars.next() != Some('"') {
        return false;
    }
    let mut escaped = false;
    let mut rest = chars.as_str().char_indices();
    for (at, c) in rest.by_ref() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return at + 1 == chars.as_str().len();
        } else if c == '\n' {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_utc_to_the_millisecond() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_389), (2025, 10, 28));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        let now = iso_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'));
    }

    #[test]
    fn json_keeps_short_arrays_of_plain_values_on_one_line() {
        let value = serde_json::json!({
            "short": ["-Ddocs=false", "-Dbin=false"],
            "numbers": [1, 2.5, -3],
            "nested": [{ "a": 1 }],
            "long": ["a".repeat(60), "b".repeat(60)],
            "quoted": ["say \"hi\", then go"],
        });
        let text = format_json(&value).unwrap();
        assert!(
            text.contains("\"short\": [\"-Ddocs=false\", \"-Dbin=false\"],"),
            "{text}"
        );
        assert!(text.contains("\"numbers\": [1, 2.5, -3],"), "{text}");
        assert!(
            text.contains("\"quoted\": [\"say \\\"hi\\\", then go\"]\n"),
            "{text}"
        );
        assert!(text.contains("\"nested\": [\n"), "{text}");
        assert!(text.contains("\"long\": [\n"), "{text}");
    }

    #[test]
    fn otool_offsets_come_off_names() {
        assert_eq!(
            strip_offset("@rpath/libmpv.2.dylib (offset 24)"),
            "@rpath/libmpv.2.dylib"
        );
        assert_eq!(strip_offset("@loader_path"), "@loader_path");
    }
}
