// tsc only emits JavaScript. Actor manifests are data, so copy them into dist/
// alongside their compiled main.js or the registry finds no Actors in a build.
import { cp } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let count = 0;

for await (const file of glob('actors/*/*/actor.json', { cwd: root })) {
    await cp(join(root, file), join(root, 'dist', file));
    count++;
}

console.log(`copied ${count} actor manifest(s) into dist/`);
