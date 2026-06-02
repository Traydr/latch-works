# Feature Specification — Image & Video Viewer

## Gallery and Navigation
- Grid thumbnail view showing images and video thumbnails mixed together.
- Videos autoplay and loop in thumbnails.
- Smooth keyboard navigation (left/right for previous/next).
- Double-click to enter fullscreen viewer.
- Drag-and-drop support for opening folders/files.

## Folder Handling
- Scan and load files only when a folder is explicitly opened.
- Remember the last opened folder between sessions.
- Sidebar with folder tree showing current directory structure.
- Toggle button to include subfolders recursively.
- Filter to show only images and videos, with optional custom filter configuration.

## UI Elements
- Sidebar for folder navigation and key actions (recursive toggle, refresh).
- Toolbar with Next/Previous buttons and recursive mode toggle.
- Dark and light theme options.
- Right-click context menus are optional for later.

## Video Playback Controls
- Fullscreen viewer with:
  - Seek bar
  - Play/Pause
  - Volume control
  - Skip forward/backward (5s/10s)
  - Playback speed control
  - Fullscreen toggle

## Performance Features
- Seamless transition between images and videos without delay.
- Optional transparent overlay for metadata display (e.g., resolution, duration).
- Thumbnail caching for faster loading in large folders.

## Settings
- Persist last opened folder and window size/position.
- Preferences including:
  - Default video autoplay/loop behavior
  - Thumbnail sizing
  - File filter settings
  - Theme selection
- English language only.

## Platform Targets
- Primary support: Windows.
- macOS and Linux support stubbed in, implemented later.
- No mobile support planned.

## Non-Functional Requirements
- Native desktop look and performance prioritized.
- Fast startup performance is more important than minimal app size.
- Personal use project (not distributed publicly).

## UI Inspirations
- Clean, native UI similar to Apple video player, ImageGlass, Raycast, and Codex.
