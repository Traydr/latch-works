# UI Component & Screen Breakdown

## 1. Main Window

### 1.1 Header
- Application title / current folder label
- Theme toggle (dark/light)
- Settings / preferences access
- Optional toolbar buttons
  - Back to parent folder
  - Recursive toggle
  - Refresh folder

### 1.2 Sidebar (Left)
- Folder tree view
  - Expand/collapse folders
  - Current folder highlighted
- Button to toggle subfolder inclusion
- Optional quick actions area
  - Open folder
  - Recent folders

### 1.3 Thumbnail Grid View
- Grid container showing thumbnails of images and videos together
  - Each thumbnail component includes:
    - Image or video frame preview
    - Video auto-play + loop
    - Overlay indicator for video content
    - Selection highlight
- Scroll support for a large number of files
- Placeholder for empty states (no supported files)

### 1.4 Footer (Optional)
- Status bar showing:
  - Number of items in folder
  - Filter indicator
  - Current sort mode

---

## 2. Fullscreen Viewer / Carousel

### 2.1 Viewer Controls Overlay
- Central display area showing:
  - Full image
  - Full video playback (HTML5 video)
- Controls floating over content:
  - Previous / Next buttons
  - Play / Pause (for video)
  - Seek bar
  - Volume control
  - Playback speed control
  - Close / Exit fullscreen
  - Fullscreen toggle (if using windowed playback)

### 2.2 Metadata Overlay Panel
- Optional semi-transparent overlay
  - File name
  - Resolution (image/video)
  - Video duration + codec info
  - Date/time
  - File size

---

## 3. Settings / Preferences Panel

### 3.1 General Options
- Remember last opened directory (on/off)
- Default video loop / autoplay settings
- File filter configuration
- Thumbnail size / grid density
- Theme (dark/light)

### 3.2 Advanced
- Thumbnail cache management
- Reset preferences

---

## 4. Dialogs

### 4.1 Folder Selection Dialog
- Native folder picker

### 4.2 Confirm Action Dialog
- Confirm before destructive actions (optional future)

---

## 5. Component Breakdown (Reusable UI Parts)

### 5.1 Thumbnail Item
- Renders image or video
- Handles hover and selection states
- Click / double-click behavior

### 5.2 Video Player Component
- Autoplay/loop support
- Controls for seek, volume, speed

### 5.3 Sidebar Folder Tree
- Expandable tree nodes
- Click to select folder
- UI for toggling recursive mode

### 5.4 Toolbar
- Buttons with icons
- Theme switch

---

## 6. States

### 6.1 Loading State
- Spinner or skeleton loader when folder is loading

### 6.2 Empty State
- Message when no supported files found

### 6.3 Error State
- Feedback if folder cannot be read
