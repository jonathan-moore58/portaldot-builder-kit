// The knowledge files as MCP resources, portaldot://guide/<name>, for clients that let people attach a
// resource to a conversation. It is the same text read_guide serves by section. There are no
// subscriptions: the files are part of the server and do not change while it runs.
import type { McpServer } from '@modelcontextprotocol/server';
import { GUIDE_FILES, type GuideFile } from '../generated/guide.ts';

export const GUIDE_URI = 'portaldot://guide/';
export const MARKDOWN = 'text/markdown';

export interface GuideResource {
  uri: string;
  /** The file's id, as in read_guide: "errors", "recipes", "portaldot-v3". */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Bytes of UTF-8 text. */
  size: number;
  text: string;
}

/** One line on what the file holds, as a sentence. */
function describe(f: GuideFile): string {
  const s = f.summary.trim();
  const sentence = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** One resource per knowledge file, in the order of read_guide's table of contents. */
export function guideResources(files: GuideFile[] = GUIDE_FILES): GuideResource[] {
  return files.map((f) => ({
    uri: `${GUIDE_URI}${f.id}`,
    name: f.id,
    title: f.title,
    description: describe(f),
    mimeType: MARKDOWN,
    size: Buffer.byteLength(f.text, 'utf8'),
    text: f.text,
  }));
}

/** Registers the knowledge files as resources. Returns how many. */
export function registerGuideResources(server: McpServer, files: GuideFile[] = GUIDE_FILES): number {
  const list = guideResources(files);
  for (const r of list) {
    server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: r.mimeType, size: r.size }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: r.mimeType, text: r.text }],
    }));
  }
  return list.length;
}
