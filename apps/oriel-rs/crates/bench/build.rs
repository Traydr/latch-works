//! With the `avif` feature, compiles the small C shim over libavif and links Homebrew's libavif
//! (`brew install libavif`; another prefix through `LIBAVIF_PREFIX`). Without it, does nothing,
//! so a workspace build needs no C library.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=src/avif_shim.c");
    println!("cargo:rerun-if-env-changed=LIBAVIF_PREFIX");

    if env::var_os("CARGO_FEATURE_AVIF").is_none() {
        return;
    }

    let prefix =
        env::var("LIBAVIF_PREFIX").unwrap_or_else(|_| "/opt/homebrew/opt/libavif".to_string());

    cc::Build::new()
        .file("src/avif_shim.c")
        .include(format!("{prefix}/include"))
        .warnings(true)
        .compile("avif_shim");

    println!("cargo:rustc-link-search=native={prefix}/lib");
    println!("cargo:rustc-link-lib=dylib=avif");
}
