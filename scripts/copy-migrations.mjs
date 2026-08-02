// tsc only emits .js, so the .sql migrations need copying into dist by hand.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'dist', 'migrations');

await mkdir(dest, { recursive: true });
await cp(join(root, 'src', 'migrations'), dest, { recursive: true });
process.stdout.write('copied migrations -> dist/migrations\n');
