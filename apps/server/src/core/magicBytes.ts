export type SupportedFileType = {
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  extension: 'pdf' | 'png' | 'jpg';
};

/**
 * Inspects the raw magic-byte signature of a file buffer.
 * Rejects spoofed file extensions or unsupported formats.
 */
export function inspectMagicBytes(buffer: Buffer): SupportedFileType {
  if (!buffer || buffer.length < 8) {
    throw new Error('INVALID_FILE_MAGIC_BYTES:BUFFER_TOO_SHORT');
  }

  // PDF: %PDF- (25 50 44 46 2D)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return { mimeType: 'application/pdf', extension: 'pdf' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  throw new Error('INVALID_FILE_MAGIC_BYTES:UNSUPPORTED_SIGNATURE');
}
