import { execFile } from "node:child_process";

// Clipboard access needs an STA thread, hence -STA; the PNG comes back as base64 on stdout.
const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if (-not $img) { exit 3 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
`;

/** The image on the clipboard of the machine running this server, as a PNG. */
export function readClipboardPng(): Promise<Blob> {
  // shortcut: Windows only (the server runs next to Claude Desktop there), add pngpaste/xclip if needed elsewhere.
  if (process.platform !== "win32") return Promise.reject(new Error("Clipboard images are only supported on Windows."));
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", SCRIPT],
      { maxBuffer: 100 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          return reject(new Error(code === 3 ? "The clipboard has no image. Copy the screenshot again." : `Reading the clipboard failed: ${err.message}`));
        }
        resolve(new Blob([new Uint8Array(Buffer.from(stdout.trim(), "base64"))], { type: "image/png" }));
      },
    );
  });
}
