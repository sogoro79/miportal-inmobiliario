import { pipeline } from "node:stream";
import { v2 as defaultCloudinary } from "cloudinary";
import {
  CLOUDINARY_UPLOAD_OPTIONS,
  CloudinaryServiceError,
  destroyByPublicId,
  isValidCloudinaryPublicId
} from "./cloudinaryService.js";

function createOnceCallback(callback) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    callback(...args);
  };
}

function buildUploadedFile(result) {
  if (!result?.secure_url || !result?.public_id) {
    throw new CloudinaryServiceError("Cloudinary devolvió una imagen incompleta");
  }

  return {
    path: result.secure_url,
    filename: result.public_id,
    public_id: result.public_id,
    secure_url: result.secure_url,
    size: result.bytes
  };
}

export class CloudinaryStreamStorage {
  constructor({ client = defaultCloudinary } = {}) {
    this.client = client;
  }

  _handleFile(req, file, callback) {
    const done = createOnceCallback(callback);
    let uploadStream;
    let uploadResult;
    let streamFinished = false;

    const completeIfReady = () => {
      if (!uploadResult || !streamFinished) return;

      try {
        done(null, buildUploadedFile(uploadResult));
      } catch (err) {
        done(err);
      }
    };

    try {
      uploadStream = this.client.uploader.upload_stream(
        { ...CLOUDINARY_UPLOAD_OPTIONS },
        (error, result) => {
          if (error) {
            done(new CloudinaryServiceError("No se pudo subir la imagen"));
            return;
          }

          uploadResult = result;
          completeIfReady();
        }
      );
    } catch {
      done(new CloudinaryServiceError("No se pudo preparar la subida de la imagen"));
      return;
    }

    pipeline(file.stream, uploadStream, error => {
      if (error) {
        done(new CloudinaryServiceError("No se pudo subir la imagen"));
        return;
      }

      streamFinished = true;
      completeIfReady();
    });
  }

  _removeFile(req, file, callback) {
    const done = createOnceCallback(callback);
    const publicId = [file?.public_id, file?.publicId, file?.filename]
      .find(isValidCloudinaryPublicId);

    if (!publicId) {
      done(null);
      return;
    }

    destroyByPublicId(publicId, { client: this.client })
      .then(() => done(null))
      .catch(() => {
        console.warn("No se pudo limpiar una imagen subida durante la petición.");
        done(null);
      });
  }
}

export function createCloudinaryStreamStorage(options = {}) {
  return new CloudinaryStreamStorage(options);
}
