// Camera / file → a prepared JPEG at a canonical aspect (3:4 portrait or 4:3 landscape), ≤1536 px.
// Re-encoding through a canvas also drops all EXIF/GPS metadata.

const MAX_EDGE = 1536;

export type PreparedPhoto = { blob: Blob; width: number; height: number; url: string };

export async function prepare(source: ImageBitmap | HTMLVideoElement): Promise<PreparedPhoto> {
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const portrait = sh >= sw;
  const aspect = portrait ? 3 / 4 : 4 / 3; // width / height; Muse Image keeps it (spike)

  // Centre-crop to the canonical aspect.
  let cw = sw;
  let ch = sh;
  if (sw / sh > aspect) cw = Math.round(sh * aspect);
  else ch = Math.round(sw / aspect);
  const sx = Math.round((sw - cw) / 2);
  const sy = Math.round((sh - ch) / 2);

  const scale = Math.min(1, MAX_EDGE / Math.max(cw, ch));
  // Even dimensions in multiples of 16 keep the model's sizes happy.
  const width = Math.max(16, Math.round((cw * scale) / 16) * 16);
  const height = Math.max(16, Math.round(width / aspect / 16) * 16);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(source, sx, sy, cw, ch, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.9),
  );
  return { blob, width, height, url: URL.createObjectURL(blob) };
}

export async function fromFile(file: File): Promise<PreparedPhoto> {
  // iOS Safari converts HEIC to JPEG for file inputs; createImageBitmap applies EXIF orientation.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return await prepare(bitmap);
  } finally {
    bitmap.close();
  }
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}
