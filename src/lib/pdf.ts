import { api } from "../api";

/**
 * Rasterises a PDF into the pages of a presentation.
 *
 * Rendering happens once, at import, and the result is stored as PNGs. That
 * costs a little disk but means a deck that imported cleanly can never render
 * differently later — no renderer version, missing font or lazy page load can
 * surprise anyone mid-service. It also makes reordering and projection
 * identical to a deck built from photographs.
 */

/** Wide enough for a 4K projector without making a 200-slide deck enormous. */
const TARGET_WIDTH = 2560;

export async function importPdf(
  presentationId: string,
  path: string,
  onProgress?: (page: number, total: number) => void,
): Promise<void> {
  // Loaded lazily: pdf.js is over a megabyte, and most services never open a
  // PDF at all.
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const bytes = decodeBase64(await api.readFileBase64(path));
  const document = await pdfjs.getDocument({ data: bytes }).promise;

  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      onProgress?.(number, document.numPages);
      const page = await document.getPage(number);

      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, TARGET_WIDTH / base.width) });

      const canvas = window.document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("could not create a canvas to render the PDF");

      // Slides are usually white; without this, transparent areas would come
      // out black on the projector.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("could not encode page " + number);
      await api.addPresentationPage(presentationId, await encodeBase64(blob));

      page.cleanup();
      // Free the backing store straight away; a long deck would otherwise
      // hold every page's bitmap until the import finished.
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await document.destroy();
  }
}


function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** FileReader keeps the encode off the main thread for a multi-megabyte page. */
function encodeBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the page"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
