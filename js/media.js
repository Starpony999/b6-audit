export const MEDIA_MAX_VIDEO_BYTES = 8 * 1024 * 1024;
export const MEDIA_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function validateLocalFile(file) {
  const type = String((file && file.type) || "");
  const size = Number(file && file.size) || 0;
  if (type === "image/svg+xml") return { ok: false, message: "SVG files are not allowed." };
  if (type.startsWith("image/")) return { ok: true };
  if (type.startsWith("video/")) {
    if (size > MEDIA_MAX_VIDEO_BYTES) {
      return {
        ok: false,
        message: "Video is too large (max about 8 MB). Record a shorter clip or lower quality.",
      };
    }
    return { ok: true };
  }
  return { ok: false, message: "Please select a photo or video." };
}

export function newClientUploadId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return ("u" + Date.now().toString(36) + rand).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

export function compressImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) {
            reject(new Error("Could not compress that photo."));
            return;
          }
          const base = String(file.name || "photo.jpg").replace(/\.[^.]+$/, "");
          resolve({
            blob,
            mimeType: "image/jpeg",
            fileName: base + ".jpg",
            previewUrl: URL.createObjectURL(blob),
          });
        }, "image/jpeg", quality);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that photo."));
    };
    img.src = url;
  });
}

export async function putPresigned(uploadUrl, contentType, blob) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    mode: "cors",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!response.ok) {
    throw new Error("The file did not upload (storage said " + response.status + ").");
  }
}

export async function uploadAuditFile(api, file, meta) {
  const check = validateLocalFile(file);
  if (!check.ok) throw new Error(check.message);
  let blob = file;
  let mimeType = file.type;
  let fileName = file.name || "upload";
  let previewUrl = "";
  if (String(file.type || "").startsWith("image/")) {
    const packed = await compressImageFile(file, 1600, 0.72);
    if (packed.blob.size > MEDIA_MAX_IMAGE_BYTES) {
      URL.revokeObjectURL(packed.previewUrl);
      throw new Error("Photo is still too large after compression. Try a smaller picture.");
    }
    blob = packed.blob;
    mimeType = packed.mimeType;
    fileName = packed.fileName;
    previewUrl = packed.previewUrl;
  }
  const signed = await api("signMediaUpload", {
    auditId: meta.auditId,
    questionId: meta.questionId,
    store: meta.store,
    fileName,
    mimeType,
    byteLength: blob.size,
    clientUploadId: newClientUploadId(),
    existingKeys: meta.existingKeys || [],
  });
  try {
    await putPresigned(signed.uploadUrl, (signed.headers && signed.headers["Content-Type"]) || mimeType, blob);
  } catch (err) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    throw err;
  }
  return {
    objectKey: signed.objectKey,
    fileName,
    mimeType,
    previewUrl,
    clientUploadId: signed.objectKey,
  };
}
