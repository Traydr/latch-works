//! What Oriel and the tools that build it agree on, so neither spells it alone:
//!
//! - [`DataRoot`]: every folder and file the app keeps in its data root;
//! - [`Package`] and the workspace's folders: where xtask puts the libraries, programs and
//!   notices it packs or fetches, and where the app looks for them;
//! - [`NativeSet`]: the one search for libvips, libavif, libmpv, ffmpeg and ffprobe;
//! - [`NoticeIndex`]: the licence notices' index, which xtask writes and the About dialog reads;
//! - the app's name and bundle id.
//!
//! It depends on nothing of the app's but `oriel-core-domain`'s `.latch-works` folder name, so
//! xtask builds without GPUI.

mod data;
mod layout;
mod native;
mod notices;

pub use data::{APP_DIRECTORY_NAME, DataRoot};
pub use layout::{
    APP_NAME, BUNDLE_ID, CURRENT, MAC_EXECUTABLE, NOTICE_INDEX_FILE, Package, WINDOWS_EXECUTABLE,
    libmpv_root, media_tools_cache, vendor_root, vendored_libavif_windows, vendored_set, workspace,
};
pub use native::{
    LocateError, Located, MEDIA_TOOLS_VERSION, MediaToolsMarker, NativeSet, NativeSource, Places,
    media_tools_files, media_tools_platform,
};
pub use notices::{Notice, NoticeIndex};
