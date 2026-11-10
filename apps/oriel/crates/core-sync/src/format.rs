//! Text as lockstep-core writes it: Node's file errors, push errors, and numbers in JSON.

use std::io;

use oriel_core_domain::number::js_integer;
use serde::Serializer;

/// The message Node gives a failed file call: `ENOENT: no such file or directory, stat
/// '/a/b'`. lockstep-core shows these as they are, so the doctor's details read the same.
pub(crate) fn node_error_message(error: &io::Error, syscall: &str, path: &str) -> String {
    match node_code(error) {
        Some((code, description)) => format!("{code}: {description}, {syscall} '{path}'"),
        None => format!("{error}, {syscall} '{path}'"),
    }
}

/// Node's code and text for an error: by the OS's own number where std has no kind for it (or
/// folds two into one, as `EACCES` and `EPERM`), else by its kind. libuv reports Windows'
/// `ERROR_ACCESS_DENIED` as `EPERM`.
fn node_code(error: &io::Error) -> Option<(&'static str, &'static str)> {
    #[cfg(unix)]
    match error.raw_os_error() {
        Some(libc::EPERM) => return Some(("EPERM", "operation not permitted")),
        Some(libc::ELOOP) => return Some(("ELOOP", "too many symbolic links encountered")),
        Some(libc::ENAMETOOLONG) => return Some(("ENAMETOOLONG", "name too long")),
        Some(libc::EIO) => return Some(("EIO", "i/o error")),
        _ => {}
    }
    Some(match error.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::PermissionDenied if cfg!(unix) => ("EACCES", "permission denied"),
        io::ErrorKind::PermissionDenied => ("EPERM", "operation not permitted"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => return None,
    })
}

/// `formatPushError`: the error's message, with its cause's in brackets when it has one.
pub(crate) fn format_push_error(error: &anyhow::Error) -> String {
    let message = error.to_string();
    match error.chain().nth(1) {
        Some(cause) => format!("{message} ({cause})"),
        None => message,
    }
}

/// Writes a number as `JSON.stringify` does: whole numbers without a fraction.
pub(crate) fn serialize_js_number<S: Serializer>(
    value: &f64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match js_integer(*value) {
        Some(integer) => serializer.serialize_i64(integer),
        None => serializer.serialize_f64(*value),
    }
}

pub(crate) fn serialize_optional_js_number<S: Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serialize_js_number(value, serializer),
        None => serializer.serialize_none(),
    }
}
