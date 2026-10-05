import { lstat } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { DownloadQualitySchema, type SavedFile, type SavedVariant } from "./protocol";
import { qualityHeight } from "./quality";

const SidecarSchema = DownloadQualitySchema.extend({ version: z.literal(1) });

type PublishedFile = SavedFile & { modifiedAt: string };

// Callers validate the video ID and finite variant before constructing paths.
export function savedDirectory(mediaRoot: string, id: string, variant: SavedVariant): string {
  return join(mediaRoot, id, `q-${variant}`);
}

export async function readSavedFile(
  mediaRoot: string,
  id: string,
  variant: SavedVariant,
): Promise<PublishedFile | null> {
  try {
    if (!(await lstat(join(mediaRoot, id))).isDirectory()) {
      return null;
    }
    const dir = savedDirectory(mediaRoot, id, variant);
    if (!(await lstat(dir)).isDirectory()) {
      return null;
    }
    const stat = await lstat(join(dir, "video.mp4"));
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const quality = await readQuality(dir, variant);

    return { variant, ...quality, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
}

async function readQuality(dir: string, variant: SavedVariant) {
  const unknown = { requested: null, height: null };
  const path = join(dir, "quality.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4096) {
      return unknown;
    }
    // Bound the read too: an external replacement may race the stat.
    const bytes = await Bun.file(path).slice(0, 4097).arrayBuffer();
    if (bytes.byteLength > 4096) {
      return unknown;
    }
    const parsed = SidecarSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success || parsed.data.requested !== variant) {
      return unknown;
    }
    const cap = qualityHeight(variant);
    if (cap !== null && parsed.data.height !== null && parsed.data.height > cap) {
      return unknown;
    }
    return { requested: variant, height: parsed.data.height };
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) {
      return unknown;
    }
    throw error;
  }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
