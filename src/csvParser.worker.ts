import { parseDelimitedFile } from "./csvParser";

self.onmessage = async (
  event: MessageEvent<{ file: File; delimiter: string }>,
) => {
  try {
    const data = await parseDelimitedFile(
      event.data.file,
      event.data.delimiter,
      (progress) => self.postMessage({ type: "progress", progress }),
    );
    self.postMessage({ type: "complete", data });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
