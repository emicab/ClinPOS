// lib/saveFile.ts

export interface SaveFileResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
  path?: string;
}

/**
 * Guarda un archivo de forma robusta:
 * - En la app de escritorio (Tauri) abre el diálogo "Guardar como" vía el
 *   backend (comando `save_report_file`) y escribe el archivo.
 * - En web/dev descarga por blob/anchor.
 */
export async function saveFile(
  bytes: Uint8Array,
  fileName: string,
  mime: string
): Promise<SaveFileResult> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ext = fileName.includes(".")
        ? fileName.split(".").pop() as string
        : "";

      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const contentB64 = btoa(binary);

      return await invoke<SaveFileResult>("save_report_file", {
        contentB64,
        fileName,
        ext,
      });
    } catch (err: unknown) {
      // Tauri rechaza invoke() con un string (no un Error): sin esto el motivo real se pierde.
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string" && err
            ? err
            : err && typeof err === "object"
              ? JSON.stringify(err)
              : "No se pudo guardar el archivo.";
      console.error("[saveFile] save_report_file falló, se intenta la descarga del navegador:", message);
      // Plan B: descarga del WebView. Si también falla, se informan ambos motivos.
      const fallback = downloadViaBrowser(bytes, fileName, mime);
      return fallback.success
        ? fallback
        : { success: false, error: `${message} (descarga alternativa: ${fallback.error})` };
    }
  }

  return downloadViaBrowser(bytes, fileName, mime);
}

function downloadViaBrowser(bytes: Uint8Array, fileName: string, mime: string): SaveFileResult {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "No se pudo descargar el archivo.";
    return { success: false, error: message };
  }
}
