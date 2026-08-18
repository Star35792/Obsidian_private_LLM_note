import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PluginManifest {
	id: string;
	name: string;
	version: string;
	isDesktopOnly: boolean;
}

const manifest = JSON.parse(
	readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
) as PluginManifest;

describe('plugin manifest', () => {
	it('keeps the published identity stable', () => {
		expect(manifest).toMatchObject({
			id: 'ai-note-assistant',
			name: 'AI 笔记助手',
			version: '0.1.0',
			isDesktopOnly: false,
		});
	});
});
