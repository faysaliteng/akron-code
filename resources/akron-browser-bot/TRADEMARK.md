# Name and logo

"Akron Browser Bot", "Akron", the Akron logo and the icons in `icons/` belong
to **akronlogic.com**. The [LICENSE](LICENSE) does not allow anyone else to
change, remove or reuse them.

## How the name and logo are protected

There are three layers. Each one stops a different kind of change.

| Layer | What it stops | How strong it is |
|---|---|---|
| **The check inside the extension** | A copy whose name, maker or logo was edited | It stops casual edits. Someone who reads the code can remove the check, so it is a lock on the door, not a wall. |
| **The licence** | Renaming, re-selling, publishing a changed copy | It is the legal ground for a takedown request or a claim. |
| **The signed store package** | Any change to an installed copy | Strong. Chrome itself checks a Web Store package and switches off a copy whose files were altered. |

### 1. The check inside the extension

When a task starts (from the chat or on a schedule), the extension compares its
own files with the sealed originals:

- `manifest.json` still takes its name from the language files and points at
  the original icon files.
- Every language file in `_locales/` still says **Akron Browser Bot**.
- The side panel, Settings and Welcome pages still carry the name in their
  title and name **akronlogic.com**.
- Each logo file (`icons/icon16.png`, `icon32.png`, `icon48.png`,
  `icon128.png`, `logo.svg`) still has the SHA-256 fingerprint stored in
  `shared/brand-seal.js`.

If anything differs, the task is refused with this message:

> This copy of Akron Browser Bot has been changed: its name or logo is not the
> original from akronlogic.com, so it will not run tasks. Install the original
> copy again.

Code: `shared/brand.js` (the check), `shared/brand-seal.js` (the fingerprints),
`background/brand-guard.js` (runs the check in the extension).

### 2. The licence

See [LICENSE](LICENSE). It was written as a starting point and is not legal
advice: have a lawyer read it before you rely on it. Registering "Akron" as a
trademark in the countries you sell in makes it much easier to act against a
copy.

### 3. The signed store package (the real lock)

Source code that someone can edit can always be changed. To make the name and
logo truly fixed for the people who use Akron:

1. Keep this repository **private**.
2. Publish the extension on the **Chrome Web Store** (Brave and Edge install
   from it too) and send users the store link, not the folder.
3. Do not hand out the unpacked folder.

A store package is signed. Chrome verifies its files and disables a copy that
was changed after installation.

## For the owner: changing the logo

1. Replace the files in `icons/`.
2. Run `npm run brand:seal`. It writes the new fingerprints to
   `shared/brand-seal.js`.
3. Run `npm test`. The check "this copy passes its own check" must be green.
4. Reload the extension.

If you forget step 2, the extension refuses tasks and `npm test` fails, so the
mistake cannot ship unnoticed.
