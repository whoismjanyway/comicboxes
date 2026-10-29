# Comic Boxes

A simple comic reader for **iPhone, iPad, Android phones and Android tablets** (and Mac/PC browsers).
Your comics live in **boxes**, like real comic shop long boxes, and boxes can hold other
boxes (for example a *Fantastic Four* box inside a *Marvel* box).

- **Add a whole folder.** Pick a folder like `Fantastic Four comics` and every comic inside it
  goes into a box with that name. Folders inside it become boxes inside that box.
- **Many formats:** CBZ, CBR (RAR 4 and RAR 5), CB7 (7-Zip), CBT (tar), PDF, EPUB, ZIP,
  and folders of pictures (JPG, PNG, WebP, GIF, AVIF).
- Boxes show the covers of the comics inside them peeking out, plus divider tabs for the boxes inside.
- Issues hang in their bags on a slatwall, with a sticker showing **NEW**, the page you're on, or **READ**.
- **Black or white theme** with the switch at the top. It remembers your choice.
- Reader with **pinch-to-zoom**, **double-tap zoom**, swipe or tap to turn pages, a page slider,
  **two-page view** on tablets in landscape, and **Manga** (right-to-left) mode.
- **Keep reading** row on the home screen picks up where you stopped.
- **Settings** page: reorder or hide home sections, sorting, cover size, theme and reader options.
- Works fully offline. Comics are stored only on the device. Nothing is uploaded anywhere.

---

## What's in this folder

```
comic-boxes/
├── README.md               ← this file
├── package.json            ← Capacitor (turns the app into real iOS/Android apps)
├── capacitor.config.json   ← app name and app id
└── www/                    ← the app itself (HTML, CSS, JavaScript)
    ├── index.html
    ├── css/styles.css      ← look and feel, both themes
    ├── js/app.js           ← boxes, issues, menus, theme switch
    ├── js/importer.js      ← adding files and folders (folders → boxes)
    ├── js/comic.js         ← reading every comic format
    ├── js/reader.js        ← the reader: paging and zoom
    ├── js/db.js            ← on-device storage (IndexedDB)
    ├── fonts/              ← Barlow Condensed + Permanent Marker (free licenses included)
    ├── vendor/             ← JSZip, libarchive.js (RAR/7z/tar), pdf.js (PDF), with licenses
    ├── manifest.webmanifest, sw.js  ← home-screen install and offline use
    └── icons/
```

---

## Three ways to get it onto your phone or tablet

Pick the one that fits you. **Option 1 is the easiest** and works on both iOS and Android
without any developer accounts.

| | What you need | Result |
|---|---|---|
| **1. Home-screen app** | A free web host (e.g. Netlify) | Icon on home screen, works offline, iOS + Android |
| **2. Install the real app on your own device** | A computer + Android Studio (Android) or a Mac + Xcode (iOS) | A real app installed from your computer |
| **3. Publish to the App Store / Google Play** | Developer accounts (Apple $99/year, Google $25 once) | Anyone can download it from the stores |

---

### Option 1 — Home-screen app (easiest, no app store)

The app needs to be served over **https** once; after that it works offline.

**Step 1: put the `www` folder online (free)**

Easiest way, no tools needed:

1. Go to **https://app.netlify.com/drop** (create a free account if asked).
2. Drag the **`www` folder** (not the whole project folder) onto the page.
3. Netlify gives you a link like `https://something-random.netlify.app`. Open it to check it works.

Other free hosts work the same way: Cloudflare Pages, Vercel.

**Or use GitHub Pages** (the project already includes the setup):

1. Upload the **whole project** to a GitHub repository, so `.github/workflows/pages.yml`
   and the `www` folder are both there. Upload the contents of the `comic-boxes` folder, not the
   folder itself: `README.md` should be at the top of the repository.
   The `.github` folder is hidden on a Mac; press **Cmd + Shift + .** in Finder to see it.
2. In the repository go to **Settings → Pages**. Under **Build and deployment → Source**, choose
   **GitHub Actions** (not "Deploy from a branch").
3. Go to the **Actions** tab, open **Deploy to GitHub Pages**, and click **Run workflow**
   (it also runs by itself on every push to `main`).
4. When it turns green, your app is at `https://YOUR-NAME.github.io/REPOSITORY-NAME/`.

> If you see `Build with Jekyll … No such file or directory … /docs`, Pages is still set to
> "Deploy from a branch". Switch the Source to **GitHub Actions** (step 2).

**Step 2: install it on the device**

- **iPhone / iPad (Safari):** open the link in **Safari** → tap the **Share** button →
  **Add to Home Screen** → **Add**.
- **Android (Chrome):** open the link in **Chrome** → tap the **⋮** menu →
  **Add to home screen** or **Install app** → **Install**.

Open it from the new icon. It runs full screen like a normal app.

> Each device keeps its own library. Comics you add on your iPad don't appear on your phone.

**Using it without internet:** after adding the icon, open the app **from the icon once while
online** and wait a few seconds; that saves it for offline use. Check **Settings → Library →
Offline use**: a green dot means it's ready. After that it opens with no Wi-Fi or data.

> On iPhone and iPad, the home-screen app and Safari keep **separate** libraries. Add your
> comics from inside the home-screen app, not from a Safari tab.

---

### Option 2 — Build the real app and install it on your own device

This uses **Capacitor**, which wraps the `www` folder into a native iOS and Android app.

**You need**

- **Node.js 22 or newer** — download from https://nodejs.org
- **Android:** Android Studio (2025.2.1 "Otter" or newer) — https://developer.android.com/studio
- **iOS / iPadOS:** a **Mac** with **Xcode 26 or newer** (free on the Mac App Store).
  Building iOS apps requires a Mac.

**1. Install the project's tools** (once). Open a terminal in the `comic-boxes` folder:

```bash
npm install
```

**2. Create the native projects** (once):

```bash
npx cap add android     # creates the android/ folder
npx cap add ios         # creates the ios/ folder (Mac only)
```

**3a. Run on Android**

```bash
npm run android
```

This copies the app into the Android project and opens **Android Studio**.
1. On your Android phone or tablet, turn on **Developer options** (Settings → About phone →
   tap **Build number** 7 times) and then **USB debugging**.
2. Plug the device into your computer and allow the connection on the device.
3. In Android Studio, pick your device at the top and press the green **▶ Run** button.

To get an installable file instead: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.
Send the `.apk` to the device and open it (Android will ask you to allow installing from that source).

**3b. Run on iPhone / iPad**

```bash
npm run ios
```

This opens **Xcode**.
1. Click **App** in the left sidebar → **Signing & Capabilities** → choose your **Team**
   (sign in with your Apple ID; a free Apple ID works for your own devices).
2. If Xcode complains about the bundle id, change `com.example.comicboxes` to something
   unique like `com.yourname.comicboxes` (also change `appId` in `capacitor.config.json`).
3. Plug in your iPhone/iPad, select it at the top, and press **▶ Run**.
4. First time only, on the device: **Settings → General → VPN & Device Management** →
   trust your developer certificate. On iOS 16+, also turn on
   **Settings → Privacy & Security → Developer Mode**.

> With a free Apple ID the app stops opening after 7 days and needs to be run again from Xcode.
> A paid developer account removes that limit.

**After you change anything in `www/`**, run `npx cap sync` and press Run again.

---

### Option 3 — Publish to the App Store and Google Play

Do Option 2 first, then:

**Google Play**
1. Create a developer account at https://play.google.com/console ($25, one time).
2. In Android Studio: **Build → Generate Signed App Bundle / APK → Android App Bundle**,
   create a signing key and **keep it safe** (you need the same key for every update).
3. In Play Console create the app, upload the `.aab`, fill in the store listing, content rating
   and privacy form (this app collects no data), and send it for review.

**Apple App Store**
1. Join the Apple Developer Program at https://developer.apple.com/programs ($99/year).
2. In Xcode set your Team, then **Product → Archive** → **Distribute App** → **App Store Connect**.
3. In https://appstoreconnect.apple.com create the app, add screenshots
   (iPhone 6.9" and iPad 13" sizes are required), description and privacy details, then submit.

Before publishing, change `appId` in `capacitor.config.json` to your own
(e.g. `com.yourname.comicboxes`), and use `www/icons/icon-1024.png` as the store icon.
Tip: the free `@capacitor/assets` tool can generate all native icon sizes from that file.

---

## Using the app

### Adding comics

Tap the red **+** button. You get three choices, and everything goes into the box you're looking at
(or the top level, if you're on **My boxes**):

**A folder**: adds everything in a folder, keeping its layout.

```
Fantastic Four comics/          →  box  "Fantastic Four comics"
├── Fantastic Four 001.cbz      →    comic
├── Fantastic Four 004.cbr      →    comic
├── Annuals/                    →    box "Annuals" inside it
│   └── FF Annual 01.cb7        →      comic
└── FF 050 scans/               →    a folder with only pictures becomes one comic
    ├── 001.jpg
    └── 002.jpg ...
```

- On a **Mac**: in Safari or Chrome, choose **A folder**, select the folder, and click **Upload**
  (the browser asks to confirm; nothing leaves your Mac). You can also **drag a folder** from
  Finder onto the window.
- On **iPhone / iPad** (iOS / iPadOS 18.4 or newer): choose **A folder**, browse to the folder in
  the Files picker, and tap **Open**.
- On **Android** (recent Chrome): choose **A folder** and pick the folder, then allow access.
- Adding the same folder again is safe. Existing boxes are reused and comics that are already
  there are skipped, so you can re-add a folder after putting new issues in it.
- Hidden files (`.DS_Store`, `__MACOSX`), text files, and stray pictures next to comics
  (like `folder.jpg`) are ignored. Empty folders don't make boxes.

**Can't pick a folder?** Older phones and the installed Android app (Option 2) may not let you pick
folders. Zip the folder instead (on a Mac: right-click → **Compress**), then add the `.zip`
with **Comic files**. A zip that contains comics turns into boxes exactly the same way.

**Comic files**: pick one or many files.
- **iPhone / iPad:** the Files app opens. Your comics can be in *On My iPhone*, iCloud Drive,
  Google Drive, Dropbox, etc. Tap **Select** to choose several.
- **Android:** the file picker opens. Look in **Downloads**, Google Drive, or your SD card.
  Tap and hold to select several.

**New empty box**: name it now, fill it later.

**Getting comics onto the device first:** AirDrop them to an iPhone/iPad and save to Files,
put them in iCloud Drive / Google Drive / Dropbox, or copy them to an Android device's
Downloads folder over USB.

### Boxes inside boxes

- Tap a box to open it. The back button and the path above the title (**My boxes / Marvel**)
  take you back up. Android's back button works too.
- Tap **⋯** on a box or issue to **rename**, **move to another box**, **mark as read/unread**,
  or **delete**. (Right-click or long-press on Android also opens this menu.)
- Deleting a box deletes everything inside it.

### Black or white theme

The switch next to the **+** button changes between the white and the black theme.
The first time, the app follows your device's light/dark setting. After you flip the switch,
it remembers your choice. The reader always uses a black background so pages stand out.

### Settings

Tap the **gear** button at the top. Everything here is saved on the device.

- **Home screen:** change the order of **Boxes**, **Keep reading** and **Not in a box** with the
  arrows, and hide Keep reading or Not in a box with the switch. Choose how many comics Keep reading shows.
- **Inside a box:** choose whether the boxes inside it or its issues come first.
- **Look:** White, Black or Match device theme, and Small / Medium / Large covers.
- **Sorting:** issues by name, newest added or last read; boxes by name or newest.
- **Reader:** Manga mode by default, two-page view, tap the edges to turn pages, and keep the
  screen on while reading.
- **Library:** see how much space your comics use, mark everything as unread, reset settings,
  or delete everything.

### Reading

| Do this | To |
|---|---|
| Swipe left / right | Turn the page |
| Tap the right or left edge | Next / previous page |
| Tap the middle | Show or hide the controls |
| Pinch out / in | Zoom in / out (up to 6×) |
| Double-tap | Zoom in on that spot; double-tap again to zoom back out |
| Drag (while zoomed) | Move around the page |
| Page slider | Jump to any page |
| Two-page button | Two pages side by side (tablets and wide screens, landscape) |
| **Manga** | Read right to left |

On a computer: arrow keys turn pages, `+` / `-` zoom, `0` resets zoom,
mouse wheel or trackpad pinch zooms, `Esc` goes back.

### Supported formats

| Format | Notes |
|---|---|
| `.cbz`, `.zip` | Read directly |
| `.cbr`, `.rar` | RAR 4 and RAR 5. Kept as they are; pages are unpacked one at a time while you read, so even 1 GB files work on a phone |
| `.cb7`, `.7z` | Converted to CBZ when added |
| `.cbt`, `.tar` | Converted to CBZ when added |
| `.pdf` | Read in pieces and drawn sharp at your screen's resolution |
| `.epub` | Comic/manga EPUBs with one picture per page, in the book's reading order |
| Folder of pictures | JPG, PNG, WebP, GIF, AVIF, BMP. Becomes one comic |

Not supported: password-protected archives and PDFs, and text-only (novel) EPUBs.
A badly damaged file is skipped and the app tells you which one.

### Very large files on a phone

CBZ, CBR and PDF files of any size work, because pages are read one at a time. Three rare kinds
have to be unpacked whole, so on phones and tablets they're limited to about 250 MB:
**CB7/7z**, **CBT/tar**, and **"solid" RAR files**. Bigger ones are skipped with a message, and
the rest of the import carries on.

To add one anyway, unpack it on your Mac first (double-click it, or use the free app
**The Unarchiver** for RAR/7z), then add the resulting **folder of pictures** with **+ → A folder**.
A folder of pictures becomes one comic.

### Storage

Comics are copied into the app's private storage on the device (CBR/CB7/CBT/EPUB are
stored as CBZ), so you can delete the
original file afterwards if you want. A typical issue is 20–80 MB, so watch your free space.
Deleting the app (or, for the home-screen version, clearing the browser's website data)
deletes your library.

---

## Trying it on a computer

```bash
npm start
```

Then open http://localhost:5173 in Chrome, Edge or Safari. Use your browser's device toolbar
to preview phone and tablet sizes.

## Customizing

- **Colors:** the variables at the top of `www/css/styles.css` (`--kraft`, `--red`, …).
- **App name / id:** `capacitor.config.json`, `www/manifest.webmanifest` and `<title>` in `www/index.html`.
- **Icons:** replace the PNGs in `www/icons/`.
- If you host Option 1 and change files, bump `VERSION` in `www/sw.js` so devices pick up the update.

## Credits

Bundled open-source parts (licenses are in the same folders):
JSZip (MIT), libarchive.js (MIT, a WebAssembly build of libarchive), pdf.js (Apache 2.0),
Barlow Condensed (SIL Open Font License), Permanent Marker (Apache 2.0).
