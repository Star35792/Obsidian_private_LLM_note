import { cp, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, '..');
const sourceFiles = ['main.js', 'manifest.json', 'styles.css'];
const targetRoot = resolve(pluginRoot, 'dev-vault', '.obsidian', 'plugins', 'ai-note-assistant');

await access(resolve(pluginRoot, 'main.js'), constants.F_OK);
await mkdir(targetRoot, { recursive: true });

await Promise.all(sourceFiles.map(async (fileName) => {
	const source = resolve(pluginRoot, fileName);
	const target = resolve(targetRoot, fileName);
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target);
}));

console.log(`已同步插件到 ${targetRoot}`);
