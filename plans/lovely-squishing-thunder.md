# Native menu bar implementation plan

## Context

The app currently has zero native menu (`AppDelegate.swift`/`main.swift` never touch `NSApp.mainMenu`) — no File, no Security, not even Quit. The user wants a proper native macOS menu: an app menu with About (crediting Intel and the two origin GitHub repos) and Quit, a File menu (Add Computer / Load / Save / Scan), a Security menu (ignore TLS cert / skip TLS hostname check), and — if feasible — a Language menu.

**Key discovery from investigation**: the vendor JS already implements this *exact* menu, completely, in `NW_SetupMainMenu()` (`index.html` ~line 2416), built via NW.js's `require('nw.gui').Menu`/`MenuItem` API. It's rebuilt from scratch on every relevant state change (~11 call sites) and already correctly wires Security's checkboxes to the real TLS logic (`wsstack.comm.xtlsSkipHostCheck`, `xtlsFingerprint`) used elsewhere in the WSMAN stack. It's entirely inert today only because `node-shim.js`'s `Menu`/`MenuItem` (~line 375-408) are no-op stubs. The right approach is to bridge that existing, already-correct JS logic to a real `NSMenu`, not to hand-build a parallel menu in Swift — this reuses tested logic and automatically gets Tools/Script/Help menus too, consistent with this project's established pattern of reusing vendor JS wherever possible (see `plans/` history: excluding features that turn out to have hidden unconditional dependencies has repeatedly caused silent crashes; the inverse — enabling more of the existing, self-consistent vendor logic — has been comparatively low-risk throughout Phases 1-4).

One genuinely new piece of work falls out of this: **File > Save Computers...** needs a real native "Save As" dialog + real filesystem write, which doesn't exist anywhere in the app yet (only *opening* files works today, via the `WKUIDelegate` fix added earlier). This also requires extending the crypto shim to support AES-256-GCM + PBKDF2 (the password-protection scheme the vendor code already uses), since the current shim only supports the older AES-256-CTR mode.

## Architecture

### 1. Menu bridge (JS tree → native NSMenu)

**`node-shim.js`** — replace `MenuStub`/`MenuItemStub`/`nwGuiStub.Menu`:
- `MenuItem` constructor assigns each instance a unique numeric id, stores its `click` callback in a global map `window.__mcMenuCallbacks[id] = click`, and keeps `{id, label, type, checked, enabled, submenu}` as plain fields (no functions — those can't cross the bridge).
- `Menu.append`/`insert` push into a `.items` array as before.
- `Menu.createMacBuiltin` becomes a true no-op (`return this`) — the native app menu is owned permanently by Swift (see below), not driven by JS.
- The real trigger: `Window.get().menu = tree` setter serializes the whole tree (walking `.items`/`.submenu`, dropping the `click` functions, keeping ids) to JSON and does `window.webkit.messageHandlers.mcMenu.postMessage({op:'setMenu', tree})`.
- Add `window.__mcMenuClick = function(id) { var fn = window.__mcMenuCallbacks[id]; if (fn) fn(); }` — invoked by Swift when a native menu item is clicked.

**New `MeshCommanderMac/MenuBridge.swift`** (`NSObject, WKScriptMessageHandler`, follows the same shape as `NetworkBridge`/`DatagramBridge`):
- On `setMenu`, rebuild `NSApp.mainMenu`: keep index 0 (the native app menu, built once by `AppDelegate` at launch — see below), remove everything after it, then recursively build `NSMenu`/`NSMenuItem` from the JSON tree. Each leaf item's `NSMenuItem.tag = id`, `.target = self`, `.action = #selector(itemClicked:)`, `.state = checked ? .on : .off` for checkbox types, separators via `NSMenuItem.separator()`.
- `itemClicked:` reads `sender.tag`, calls `webView.evaluateJavaScript("window.__mcMenuClick(\(tag))")`.

**`WebViewController.swift`**: register `MenuBridge` the same way as the other two bridges (`contentController.add(WeakScriptMessageHandler(target: menuBridge), name: "mcMenu")`).

**`project.yml`**: add `- path: MeshCommanderMac/MenuBridge.swift` to `sources:`.

### 2. Native app menu + About panel

Build once in `AppDelegate.applicationDidFinishLaunching`, **not** JS-driven (this is what `createMacBuiltin` becoming a no-op replaces): a standard "MeshCommanderAS" app menu — About MeshCommanderAS, separator, Hide/Hide Others/Show All, separator, Quit MeshCommanderAS (`#selector(NSApplication.terminate(_:))`). Set as `NSApp.mainMenu`'s first item before the window is shown; `MenuBridge` must preserve this item when later rebuilding the rest of the bar.

About action calls `NSApp.orderFrontStandardAboutPanel(options:)` with a custom `.credits` `NSAttributedString` crediting Intel Corporation and linking both `https://github.com/Ylianst/MeshCommander` (original) and `https://github.com/snibbo71/MeshCommander` (this fork), plus `.applicationName: "MeshCommanderAS"`.

### 3. File > Save Computers... (the one real new bridge)

The vendor's `saveComputerList()` → `saveComputerListOk()` (index.html ~3718-3750, `FileSaver`-gated) does, on its Mode-NodeWebkit path:
```js
var chooser = document.createElement('input');
chooser.setAttribute('type', 'file');
chooser.setAttribute('nwsaveas', 'computerlist.json'); // NW.js-proprietary, not real HTML
chooser.addEventListener('change', function() { ...require('fs').writeFile(this.value, data, cb)... }, false);
chooser.click();
```
`nwsaveas` is meaningless to real WebKit (a plain file-open input results), and a real `<input type=file>.value` can never be assigned an arbitrary path (browser security). Rather than duplicating this logic elsewhere, shim the two primitives it actually needs — zero vendor edits:

**`node-shim.js` additions**:
- Override `HTMLInputElement.prototype.click` (once, globally): if `this.type === 'file' && this.hasAttribute('nwsaveas')`, intercept — post `{op:'savePanel', id, suggestedName: this.getAttribute('nwsaveas')}` to a new `mcFile` handler instead of calling the real click. On the async callback with a chosen path, do `Object.defineProperty(this, 'value', {value: path, configurable:true})` (an own-instance property; this shadows the browser's read-only `value` accessor via ordinary JS prototype-chain lookup rules — own properties win over inherited accessors regardless of the accessor's configurability) then `this.dispatchEvent(new Event('change'))` to fire the vendor's existing listener normally. If the user cancels, don't dispatch anything (matches the vendor's expectation of just not proceeding).
- `fs.writeFile(path, data, cb)` becomes real: posts `{op:'writeFile', path, dataB64: btoa(data)}` to `mcFile`, calls `cb` on the async response.

**New `MeshCommanderMac/FileBridge.swift`** (same `WKScriptMessageHandler` pattern):
- `savePanel`: shows `NSSavePanel` with the suggested filename, replies with the chosen path (or nil if cancelled) via `evaluateJavaScript`.
- `writeFile`: base64-decodes and writes to the given path, replies success/error.

**`WebViewController.swift`/`project.yml`**: register/add `FileBridge` the same way as the others.

Load side needs **no** new bridge work — `openComputerList()`'s Mode-NodeWebkit branch already uses a plain `<input type=file accept=".json,.csv">` + `FileReader`, which already works today via the existing `WKUIDelegate` open-panel fix. It only needs the crypto additions below to fully round-trip password-protected files.

### 4. Crypto shim extension (AES-256-GCM + PBKDF2)

`getEncryptedData`/`getDecryptedData` (index.html ~3752-3773) need `crypto.pbkdf2Sync`, `createCipheriv`/`createDecipheriv('aes-256-gcm', ...)`, `cipher.getAuthTag()`/`decipher.setAuthTag()` — none exist in the current `cryptoStub` (only `randomBytes`/`createCipher`/`createDecipher` for older non-GCM modes, via the existing forge-backed `CipherShim`).

Add to `node-shim.js`, following `CipherShim`'s existing forge-usage shape:
- `pbkdf2Sync(password, salt, iterations, keylen, digest)` → `forge.pkcs5.pbkdf2(...)` (confirmed present in `forge.bundle.js`, supports a synchronous no-callback form).
- `createCipheriv`/`createDecipheriv('aes-256-gcm', key, iv)` → extend `CipherShim` with a GCM mode flag, backed by `forge.cipher.createCipher('AES-GCM', key)` / `createDecipher(...)`, `.start({iv, additionalData:'', tagLength:128})` (decrypt side additionally takes `tag` at `start()` — since the vendor code always calls `setAuthTag()` before `update()`, buffer the tag and defer the real forge `.start()` call until the first `update()`).
- `getAuthTag()` reads the forge cipher's `.mode.tag` bytes; `setAuthTag(buf)` stores for the deferred `start()` above.

**One flagged risk, not a blocker**: `forge.pbkdf2` has an internal Node-detection fast path (`if (process.versions.node) { crypto = require('crypto'); ... }`) that could misfire since `node-shim.js` sets `window.process.versions.node` truthy — but forge's internal `require` is its own bundled AMD loader in a separate closure, not the global shim, so it likely resolves against forge's own modules regardless. Verify early and cheaply: after wiring `pbkdf2Sync`, do one manual smoke test via Safari Web Inspector's console against the running Debug build (`crypto.pbkdf2Sync('test','salt',1000,16,'sha512')`) before relying on it inside the full save/load flow.

### 5. Language menu

Build the menu UI for all 10 available languages (`index_de/es/fr/it/ja/ko/nl/pt/ru/zh-chs.html`) — confirmed structurally compatible with `build-html.js`'s existing marker parser (same `###BEGIN###{Name}` convention), and `build-html.js` already accepts `--input`/`--output`, so no script rewrite needed for the core generation.

Two build-time additions:
- **`Scripts/build-html.js`**: after normal marker processing, add one narrow, scoped regex postprocess (same category as the existing "insert md5-shim.js after Certificates" step) that rewrites the Language submenu's `window.location.href = 'commander_XX.htm'` / `'commander.htm'` literals (vendor's Windows-"website-compiler" output naming — not ours) to the real generated filenames, e.g. `index-mac_de.html` / `index-mac.html`.
- **`Scripts/build-release.sh`**: loop `node Scripts/build-html.js --input index_XX.html --output MeshCommanderMac/Resources/index-mac_XX.html --features Scripts/features-phase4.json` for each of the 10 languages in addition to the existing English build. All bundles + their per-language vendor JS (e.g. `amt-0.2.0_fr.js`, auto-copied by the existing asset-copy logic) land in the same `Resources/` folder — no subdirectories needed, matching how `index-mac.html` and `index-mac_fr.html` etc. can all sit side by side and `window.location.href = 'index-mac_fr.html'` navigates between them fine under `file://` (same origin, same directory).

**Verification approach, scoped deliberately**: doing deep interactive QA across 10 full localized builds isn't practical for this task. Use the same fast check already established in this project for newly-included vendor code paths — build each language variant, launch the app pointed at that bundle directly from Terminal, and confirm no `jserror` appears on `node-shim.js`'s existing `window.onerror` → stdout hook (catches the "unconditional reference to a stripped feature" class of bug that's bitten this project before, per Findings history). Full interactive per-language testing is out of scope for this pass; flag any language that fails the smoke test rather than silently shipping it.

### 6. File menu — Scan / Add Computer / Load Computers

No new bridge work: these just wire the already-existing vendor functions (`showScanDialog`, `addComputer`, `NW_LoadComputers`) as menu actions once the menu bridge itself exists — `NW_LoadComputers` already uses the working open-panel-backed file input.

### 7. Feature flag change

Add `FileSaver` to `Scripts/features-phase4.json` (currently excluded — required for `saveComputerList`/`getEncryptedData`/`getDecryptedData`/the Save Computers dialog to ship at all). Checked: `FileSaver` is a broad, heavily-used marker (~40 pairs across the file — terminal capture, session-recording-adjacent UI, script logging, plus the save-file logic needed here), but per this project's established risk model, *including* a previously-excluded feature is low-risk compared to *excluding* one (the documented crash pattern in this codebase is always "code elsewhere unconditionally references something that got stripped," not "newly-included code crashes on its own"). Verify the same way as every other phase in this project: build, launch the Debug binary directly from Terminal, confirm no `jserror` on startup and after opening each new dialog this unlocks.

## Implementation order

1. `node-shim.js`: menu tree serialization (`Menu`/`MenuItem`/`Window.get().menu` setter) + `window.__mcMenuClick`.
2. `MenuBridge.swift` + registration in `WebViewController.swift` + `project.yml`. Build native app menu in `AppDelegate.swift` (About + Quit). Get the menu rendering and clickable end-to-end first (Tools/Script/Help/File-without-Save/Security all "just work" once this lands, since none of them need new bridges).
3. Native About panel content (Intel + both GitHub repo credits).
4. Add `FileSaver` to `features-phase4.json`, rebuild, smoke-test for `jserror`.
5. `FileBridge.swift` (`savePanel`/`writeFile`) + `node-shim.js`'s `HTMLInputElement.prototype.click` override + real `fs.writeFile`. Verify Save Computers (unencrypted case first).
6. Crypto shim GCM/PBKDF2 additions. Verify `pbkdf2Sync` via Web Inspector console smoke test, then verify password-protected save + load round-trip.
7. Language menu: `build-html.js` link-rewrite postprocess, `build-release.sh` per-language build loop, smoke-test each of the 10 for `jserror`.

## Verification

- After step 2: launch the app, confirm menu bar shows MeshCommanderAS/File/Tools/Security/Language/Help, Quit works, no `jserror`.
- After step 3: Menu > About shows Intel + both repo links, links are clickable.
- After step 5: File > Save Computers with no password writes a valid `computerlist.json` readable by File > Load Computers.
- After step 6: File > Save Computers with a password produces a file that correctly prompts for and validates the password on load; wrong password is rejected; `crypto.pbkdf2Sync` smoke-tested standalone first per the note above.
- After step 7: each language's menu item loads its bundle without a blank/hung window or `jserror`; language selection persists/reflects correctly in the menu's checkmark state.
