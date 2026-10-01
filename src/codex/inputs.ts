import fs from 'node:fs/promises';
import type { MessageSource } from '../shared/types.js';
import { withSourcePrefix } from './mapping.js';

export type UserInput = { type: 'text'; text: string } | { type: 'image'; url: string };

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function textInput(content: string, source?: MessageSource): UserInput[] {
  return [{ type: 'text', text: withSourcePrefix(content, source) }];
}

// Codex reads a localImage path only when it builds the model request, and the hub deletes uploads after 5 minutes, so the bytes go inline.
export async function imageInput(imagePath: string, mimeType: string, caption: string | undefined, source?: MessageSource): Promise<UserInput[]> {
  if (!IMAGE_TYPES.has(mimeType)) throw new Error(`unsupported image type ${mimeType}`);
  const data = await fs.readFile(imagePath);
  return [
    { type: 'text', text: withSourcePrefix(caption?.trim() || '(image)', source) },
    { type: 'image', url: `data:${mimeType};base64,${data.toString('base64')}` },
  ];
}
