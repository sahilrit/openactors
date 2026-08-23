import type { ActorContext } from '../../../../src/types.js';
/** Allocates until the heap ceiling stops it. */
export async function run(_input: unknown, ctx: ActorContext): Promise<void> {
    ctx.log('allocating');
    const held: string[][] = [];
    for (;;) {
        held.push(new Array(200_000).fill('xxxxxxxxxxxxxxxxxxxx'));
    }
}
